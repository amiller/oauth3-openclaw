/**
 * HTTP API Server for Execution Proxy
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import { ProxyDatabase, SessionPolicy } from './database.js';
import { executeSkill, hashCode, parseMetadata, EXECUTOR_MODE } from './executor.js';
import { analyzeCode, CodeAnalysis, reviewCode, CodeReview, reviewInvocation, checkPolicyCompliance, reviewArgs, tokenUsage } from './analyzer.js';
import { PolicyConstraint, enforceStrict, enforceSoft, isStructuredConstraint, splitConstraints } from './policy.js';
import { requireTenant, handleSignup, TenantContext } from './auth.js';
import * as pgLog from './postgres.js';
import { randomBytes } from 'crypto';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((_req, res, next) => { res.setHeader('Referrer-Policy', 'no-referrer'); next(); });

// CORS for web client (oauth3.app or custom origin)
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://oauth3.app';
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (CORS_ORIGIN === '*' || CORS_ORIGIN.split(',').includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Sync tenant context to db + Postgres after auth
function syncTenant(req: Request, _res: Response, next: () => void) {
  const tenant = (req as any).tenant as TenantContext | undefined;
  if (tenant) {
    db.tenantId = tenant.tenant_id;
    pgLog.ensureTenant(tenant.tenant_id, tenant.plan);
  }
  next();
}

// Config from environment
const PORT = parseInt(process.env.PORT || '3737');
const DB_PATH = process.env.DB_PATH || './proxy.db';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const API_BEARER_TOKEN = process.env.API_BEARER_TOKEN || '';

// Initialize database
const db = new ProxyDatabase(DB_PATH);

import { TelegramApprovalBot } from './telegram.js';

// Load secrets from DB into memory (telegram.ts still uses the object reference)
const secrets: Record<string, string> = db.getAllSecrets();
console.log(`🔑 Loaded ${Object.keys(secrets).length} secrets from database`);

// Session tracking for pending requests
// Helper: reconstruct scope request data from DB (survives restarts)
function getScopeRequest(requestId: string): { sessionId: string; description: string; constraints: string[]; structuredConstraints: PolicyConstraint[]; secrets: string[]; networks: string[]; skill_code?: string; codeHash?: string; analysisSummary?: string } | null {
  const request = db.getRequest(requestId);
  if (!request || request.skill_url !== 'scope') return null;
  try {
    const code = db.getCode(requestId);
    if (!code) return null;
    const data = JSON.parse(code);
    const args = request.args ? JSON.parse(request.args) : {};
    // Separate typed constraints from legacy string constraints
    const rawConstraints: any[] = data.constraints || [];
    const structuredConstraints: PolicyConstraint[] = rawConstraints.filter(isStructuredConstraint);
    const legacyConstraints: string[] = rawConstraints.filter((c: any) => typeof c === 'string');
    return { sessionId: args.sessionId || '', description: data.description || '', constraints: legacyConstraints, structuredConstraints, secrets: data.secrets || [], networks: data.networks || [], skill_code: data.skill_code, codeHash: data.codeHash, analysisSummary: data.analysisSummary };
  } catch { return null; }
}

const pendingAnalyses = new Map<string, CodeAnalysis>(); // requestId -> analysis

const RISK_LEVELS = { low: 0, medium: 1, high: 2 } as const;

function structuralPolicyCheck(analysis: CodeAnalysis, policy: SessionPolicy): { pass: boolean; gaps: string[] } {
  const gaps: string[] = [];
  const newSecrets = analysis.secretsUsed.filter(s => !policy.allowedSecrets.includes(s));
  if (newSecrets.length) gaps.push(`new secrets: ${newSecrets.join(', ')}`);
  const newNetworks = analysis.networkTargets.filter(n => !policy.allowedNetworks.includes(n));
  if (newNetworks.length) gaps.push(`new networks: ${newNetworks.join(', ')}`);
  if (analysis.isMutating && !policy.allowMutating) gaps.push('mutating');
  if (RISK_LEVELS[analysis.riskLevel] > RISK_LEVELS[policy.maxRiskLevel]) gaps.push(`risk ${analysis.riskLevel} > ${policy.maxRiskLevel}`);
  return { pass: gaps.length === 0, gaps };
}

async function skillFitsPolicy(code: string, metadata: any, analysis: CodeAnalysis, policy: SessionPolicy, args?: Record<string, any>, codeHash?: string): Promise<{ fits: boolean; violations?: string[] }> {
  const structural = structuralPolicyCheck(analysis, policy);

  // Structured constraints path — deterministic enforcement first, then soft
  if (policy.structuredConstraints?.length && args && Object.keys(args).length) {
    if (!structural.pass) console.log(`  Structural gaps ignored (human-approved structured policy): ${structural.gaps.join(', ')}`);
    const { strict, soft } = splitConstraints(policy.structuredConstraints);

    // Step 1: Deterministic regex/predicate check — no LLM
    const strictResult = enforceStrict(strict, args);
    if (!strictResult.pass) {
      console.log(`  Strict constraint violations: ${strictResult.violations.join(', ')}`);
      return { fits: false, violations: strictResult.violations };
    }
    console.log(`  Strict constraints passed (${strict.length} checked)`);

    // Step 2: Soft constraints — trusted Haiku reviewer sees only approved rules + args
    if (soft.length) {
      const softResult = await enforceSoft(soft, args);
      if (!softResult.pass) {
        console.log(`  Soft constraint violations: ${softResult.violations.join(', ')}`);
        return { fits: false, violations: softResult.violations };
      }
      console.log(`  Soft constraints passed (${soft.length} checked)`);
    }

    return { fits: true };
  }

  // Pre-approved code path: code was submitted with scope and human approved the package
  if (policy.approvedCodeHash && codeHash === policy.approvedCodeHash && policy.constraints?.length) {
    if (!structural.pass) console.log(`  Pre-approved code, structural gaps ignored (human-approved): ${structural.gaps.join(', ')}`);
    const summary = policy.approvedAnalysisSummary || analysis.summary;
    if (args && Object.keys(args).length) {
      console.log(`  Pre-approved code (hash match), checking args against ${policy.constraints.length} constraints`);
      const compliance = await reviewArgs(summary, policy.constraints, args);
      console.log(`  Args review: compliant=${compliance.compliant}${compliance.violations?.length ? ` violations=${compliance.violations.join(', ')}` : ''}`);
      return { fits: compliance.compliant, violations: compliance.violations };
    }
    console.log(`  Pre-approved code (hash match), no args — auto-approving`);
    return { fits: true };
  }

  // Explicit scope sessions (with legacy string constraints): full review
  if (policy.constraints?.length) {
    if (!structural.pass) console.log(`  Structural gaps (deferred to review): ${structural.gaps.join(', ')}`);

    const reviewCache = {
      get: (h: string) => db.getCodeReview(h),
      set: (h: string, r: CodeReview) => db.setCodeReview(h, r)
    };
    const review = await reviewCode(code, metadata, codeHash || '', reviewCache);
    if (!review.faithful) {
      const realConcerns = review.concerns.filter(c => !/parameterized|hardcoded|env var|environment variable|not .* as described/i.test(c));
      if (realConcerns.length) {
        console.log(`  Code review: concerns — ${realConcerns.join(', ')}`);
        return { fits: false, violations: realConcerns };
      }
      console.log(`  Code review: not faithful but no real concerns, deferring to invocation review. params=[${review.parameterized.join(',')}]`);
    } else {
      console.log(`  Code review: faithful, params=[${review.parameterized.join(',')}] hardcoded=${JSON.stringify(review.hardcoded)}`);
    }

    if (args && Object.keys(args).length) {
      const compliance = await reviewInvocation(review, analysis, metadata, policy.constraints, args);
      return { fits: compliance.compliant, violations: compliance.violations };
    }

    const compliance = await checkPolicyCompliance(code, metadata, policy.constraints);
    return { fits: compliance.compliant, violations: compliance.violations };
  }

  // Structured constraints but no args — auto-approve if only strict constraints
  if (policy.structuredConstraints?.length) {
    const { soft } = splitConstraints(policy.structuredConstraints);
    if (!soft.length) {
      console.log(`  Structured policy, no args, no soft constraints — auto-approving`);
      return { fits: true };
    }
  }

  // Implicit sessions (no constraints): structural check is the only gatekeeper
  if (!structural.pass) {
    console.log(`  Structural policy check failed: ${structural.gaps.join(', ')}`);
    return { fits: false };
  }
  return { fits: true };
}

function policyFromAnalysis(analysis: CodeAnalysis): SessionPolicy {
  return {
    allowedSecrets: [...analysis.secretsUsed],
    allowedNetworks: [...analysis.networkTargets],
    allowMutating: analysis.isMutating,
    maxRiskLevel: analysis.riskLevel
  };
}

function mergePolicy(existing: SessionPolicy, analysis: CodeAnalysis): SessionPolicy {
  return {
    allowedSecrets: [...new Set([...existing.allowedSecrets, ...analysis.secretsUsed])],
    allowedNetworks: [...new Set([...existing.allowedNetworks, ...analysis.networkTargets])],
    allowMutating: existing.allowMutating || analysis.isMutating,
    maxRiskLevel: RISK_LEVELS[analysis.riskLevel] > RISK_LEVELS[existing.maxRiskLevel] ? analysis.riskLevel : existing.maxRiskLevel,
    constraints: existing.constraints,
    description: existing.description
  };
}

// Telegram bot
let telegramBot: TelegramApprovalBot | null = null;

if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
  telegramBot = new TelegramApprovalBot(
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    db,
    secrets,
    // On approval
    async (requestId, level) => {
      const request = db.getRequest(requestId);
      if (!request) return;

      if (level === '24h' || level === 'forever') {
        db.addApproval(request.skill_url, request.code_hash, level);
      }

      // Create or expand session from this approval
      const reqArgs = request.args ? JSON.parse(request.args) : {};
      const sessionId = reqArgs._sessionId;
      const analysis = pendingAnalyses.get(requestId);
      if (sessionId && analysis) {
        const existing = db.getSession(sessionId);
        if (existing) {
          db.updateSessionPolicy(sessionId, mergePolicy(existing.policy, analysis));
          console.log(`📋 Session ${sessionId} expanded`);
        } else {
          db.createSession(sessionId, policyFromAnalysis(analysis));
          console.log(`📋 Session ${sessionId} created`);
          if (telegramBot) {
            await telegramBot.sendSessionStartNotification(sessionId, policyFromAnalysis(analysis));
          }
        }
        pendingAnalyses.delete(requestId);
      }

      db.updateRequestStatus(requestId, 'approved');

      let code = db.getCode(requestId);
      if (!code) {
        const codeResponse = await fetch(request.skill_url);
        code = await codeResponse.text();
      }
      const metadata = parseMetadata(code);
      const requiredSecrets = JSON.parse(request.secrets);

      executeInBackground(requestId, code, metadata!, requiredSecrets);
    },
    // On denial
    (requestId) => {
      db.updateRequestStatus(requestId, 'denied');
      notifyStatusWaiters(requestId);
    },
    PUBLIC_URL
  );

  console.log('✅ Telegram bot initialized');
}

// Discovery — protocol documentation for agents
app.get('/', (req: Request, res: Response) => {
  res.type('text/markdown').send(`# OAuth3 Execution Proxy

Programmable API gateway running in a TEE (Trusted Execution Environment).
Submit code that runs in a Deno sandbox with access to secrets you don't hold directly.
Human approval gates execution — or session policies auto-approve within learned bounds.

## Quick Start

1. **Submit code** via \`POST /execute\`
2. If status is \`pending\`, share the \`approval_url\` with the user (use markdown link formatting)
3. **IMMEDIATELY long-poll** \`GET /execute/:id/status?wait=true\` (with your bearer token) — this blocks up to 120s and returns when the request is approved+executed or denied. You MUST call this right after submitting. Do NOT wait for the user to tell you it was approved.
4. If the long-poll times out (120s), re-poll. Loop until you get a terminal status.
5. Result arrives in \`result.stdout\`

## ⚠️ Critical: Always Long-Poll

Every response includes a \`status_url\`. You MUST fetch it immediately after receiving a \`pending\` or \`pending_scope\` status. Example flow:

\`\`\`
POST /execute -> { status: "pending", status_url: "...status?wait=true", approval_url: "..." }
# Show approval_url to user, AND SIMULTANEOUSLY:
GET /execute/:id/status?wait=true -> blocks until approved+executed -> { status: "completed", result: {...} }
\`\`\`

Do NOT treat pending as "done, wait for user to tell me." Treat it as "show the link, then immediately block on status_url."

## Endpoints

### POST /execute
Submit code for sandboxed execution.

\`\`\`json
{
  "skill_id": "my-task",
  "skill_code": "// @skill my-task\\n// @description Fetch something\\n// @secrets API_KEY\\n// @network api.example.com\\n// @timeout 30\\nconst r = await fetch('https://api.example.com', {headers: {Authorization: Deno.env.get('API_KEY')!}});\\nconsole.log(await r.text());",
  "secrets": ["API_KEY"],
  "args": {"key": "value"},
  "session_id": "optional-reuse-for-auto-approve"
}
\`\`\`

Response: \`{ request_id, status, session_id, approval_url }\`

- \`status: "approved"\` — already executing (trusted code or session auto-approve)
- \`status: "pending"\` — needs human approval at \`approval_url\`

### GET /execute/:id/status?wait=true
Long-polls up to 120s. Returns when status reaches a terminal state.

Response: \`{ request_id, status, result, error }\`
- \`result.stdout\` — your program's stdout (this is the output channel)
- \`result.stderr\` — stderr
- \`result.exitCode\` — 0 on success
- \`result.duration\` — ms

### POST /scope — request a scope (session with constraints)

Constraints can be **typed** (preferred) or plain strings (legacy). Typed constraints enable
deterministic enforcement — regex and predicate constraints are checked instantly with zero LLM cost.
Only \`natural_language\` constraints require a runtime Haiku call.

\`\`\`json
{
  "description": "GitHub access for amiller repos",
  "constraints": [
    { "type": "regex", "param": "repo", "pattern": "^amiller/.*$", "rationale": "Only amiller repos" },
    { "type": "predicate", "param": "action", "op": "in", "value": ["list", "create"], "rationale": "Read + create only" },
    { "type": "natural_language", "rule": "Skip issues labeled keep-open", "rationale": "Respect manual overrides" }
  ],
  "secrets": ["GH_TOKEN"],
  "networks": ["api.github.com"],
  "session_id": "optional-reuse-existing"
}
\`\`\`

**Constraint types:**
- \`regex\` — \`param\` value must match \`pattern\`. Deterministic, instant.
- \`predicate\` — operators: \`>=\`, \`<=\`, \`==\`, \`!=\`, \`in\`, \`prefix\`, \`suffix\`. Deterministic, instant.
- \`natural_language\` — free-text rule, checked by isolated Haiku reviewer at runtime. Costs ~$0.001/call.

Plain string constraints still work (treated as \`natural_language\`).

**Prefer \`regex\`/\`predicate\`** — they're faster, cheaper, and the human can verify the exact rule.

**Incremental scopes:** Call \`POST /scope\` again with the same \`session_id\` to add capabilities.
The human sees the delta. Session accumulates approved policies. Secrets/networks can only be added.

Returns \`{ request_id, status: "pending_scope", session_id, approval_url }\`.
Human approves the scope at the URL. Once approved, a session is created with
those constraints. Subsequent \`/execute\` calls with the same \`session_id\` are
auto-approved if they pass constraint checks.

### POST /execute with dry_run
Same body as above, add \`"dry_run": true\`. Returns what *would* happen without creating a request:
\`\`\`json
{ "dry_run": true, "would_auto_approve": true, "reason": "session_policy", "session_id": "...", "analysis": {...} }
{ "dry_run": true, "would_auto_approve": false, "reason": "needs_approval", "policy_gaps": { "new_secrets": [...], "new_networks": [...] } }
\`\`\`
Use this to check if you already have sufficient approval before submitting.

### GET /sessions — list active sessions with policies
### GET /sessions/:id — single session detail
### DELETE /sessions/:id — revoke a session
### POST /secrets — \`{ name, value }\`
### GET /secrets — list secret names (not values)
### GET /health — status check

## Code Format

Code must have metadata comments:
\`\`\`typescript
// @skill name-of-task
// @description What this does
// @secrets SECRET_NAME (one per line, each secret you need)
// @network hostname.com (one per line, each host you'll access)
// @timeout 30 (seconds, default 30)

// Your Deno/TypeScript code here
// Secrets available via Deno.env.get("SECRET_NAME")
// Args available via Deno.env.get("ARG_KEY")
// All output goes to stdout — use console.log() or Deno.stdout
\`\`\`

## Output Convention

stdout is the output channel. For structured data, print JSON:
\`\`\`typescript
console.log(JSON.stringify({ files: [...], data: {...} }));
\`\`\`
For binary data, base64-encode it:
\`\`\`typescript
import { encode } from "https://deno.land/std/encoding/base64.ts";
console.log(JSON.stringify({ filename: "out.zip", data: encode(bytes) }));
\`\`\`
Max output: ~1MB. stderr is captured separately for diagnostics.

## Sessions & Auto-Approval

Pass \`session_id\` to group related requests. Two ways to create a session:

1. **Implicit** — first manual approval creates a session policy from Haiku analysis
2. **Explicit** — \`POST /scope\` to request a session with specific constraints upfront

Subsequent requests that fit within the policy auto-approve. Sessions expire after 2h of inactivity.

### Three-layer review for constrained sessions:
1. **Structural analysis** (cached by code hash) — extracts secrets, networks, risk level
2. **Code review** (cached by code hash) — verifies code is faithful to its description,
   identifies what's parameterized (from args) vs hardcoded in source
3. **Invocation review** (per-call, NOT cached) — checks actual arg values against constraints.
   Does NOT re-read the code — just the review summary + args. Fast.

### Writing good skills for auto-approval:
- Write **generic, parameterized** skills — take repo/path/etc as args, not hardcoded
- The code review verifies the code only accesses what its args specify
- The invocation review checks each call's arg values against the scope constraints
- Example: a \`create-issue\` skill that takes \`repo\` as arg. Code review confirms it only
  hits \`/repos/{repo}/issues\`. Invocation review checks \`repo=owockibot/bounty\` is within bounds.
- Avoid embedding request bodies in skill code — pass them as args for stable code hashes

Trusted code (approved with "Trust Code") auto-executes forever by code hash.

## Presenting Links to Users

When sharing URLs with users (e.g. via Telegram), use markdown link formatting:
\`[Approve: task-name](https://long-url...)\` instead of raw URLs.
The approval_url and dashboard are long — always wrap them in descriptive link text.

## Available Secrets
${Object.keys(secrets).map(s => '- ' + s).join('\n') || '(none configured)'}

---
Public URL: ${PUBLIC_URL || '(not configured)'}
Executor: ${EXECUTOR_MODE} mode
`);
});

// Health check
app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok', executor: EXECUTOR_MODE }));

// Standalone signup (only available when no JWT_SECRET configured)
app.post('/signup', handleSignup);

// Dashboard data (JSON API — UI served by orchestrator)
app.get('/dashboard', requireTenant, syncTenant, (req: Request, res: Response) => {
  const sessions = db.listSessions();
  const requests = db.listRecentRequests(30);
  res.json({ sessions, requests });
});

// Add secret — persists to SQLite
app.post('/secrets', requireTenant, syncTenant, (req: Request, res: Response) => {
  const { name, value } = req.body;
  if (!name || !value) return res.status(400).json({ error: 'Missing name or value' });
  secrets[name] = value;
  db.setSecret(name, value);
  res.json({ success: true, name });
});

// List secrets (names only)
app.get('/secrets', requireTenant, syncTenant, (req: Request, res: Response) => {
  res.json({ secrets: Object.keys(secrets) });
});

app.delete('/secrets/:name', requireTenant, syncTenant, (req: Request, res: Response) => {
  const name = typeof req.params.name === 'string' ? req.params.name : req.params.name[0];
  if (!secrets[name]) return res.status(404).json({ error: 'Secret not found' });
  delete secrets[name];
  db.deleteSecret(name);
  res.json({ success: true, deleted: name });
});

// Auth: JWT (from orchestrator or standalone) with legacy bearer token fallback
// Imported from ./auth.ts as requireTenant middleware

// List active sessions
app.get('/stats', (_req: Request, res: Response) => {
  res.json({ haiku_tokens: tokenUsage });
});

app.get('/sessions', requireTenant, syncTenant, (req: Request, res: Response) => {
  const sessions = db.listSessions();
  res.json({
    sessions: sessions.map(s => ({
      session_id: s.session_id,
      created_at: s.created_at,
      last_activity: s.last_activity,
      age_minutes: Math.round((Date.now() - s.created_at) / 60000),
      idle_minutes: Math.round((Date.now() - s.last_activity) / 60000),
      policy: s.policy
    }))
  });
});

// Get single session
app.get('/sessions/:id', requireTenant, syncTenant, (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const session = db.getSession(id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({
    session_id: session.session_id,
    created_at: session.created_at,
    last_activity: session.last_activity,
    age_minutes: Math.round((Date.now() - session.created_at) / 60000),
    idle_minutes: Math.round((Date.now() - session.last_activity) / 60000),
    policy: session.policy
  });
});

// Revoke session
app.delete('/sessions/:id', requireTenant, syncTenant, (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const session = db.getSession(id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  db.deleteSession(id);
  res.json({ deleted: true, session_id: id });
});

// View code for an execution request
app.get('/view/:id', requireTenant, syncTenant, (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const code = db.getCode(id);
  if (!code) return res.status(404).json({ error: 'Not found' });
  const request = db.getRequest(id);
  const metadata = parseMetadata(code);
  res.json({ id, code, code_hash: request?.code_hash, metadata });
});

// Approval details (JSON API — UI served by orchestrator)
app.get('/approve/:id', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const token = req.query.token as string;
  const request = db.getRequest(id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (!token || token !== request.approval_token) return res.status(403).json({ error: 'Invalid token' });

  const scopeReq = getScopeRequest(id);
  const code = db.getCode(id) || undefined;
  const metadata = code ? parseMetadata(code) : undefined;
  const analysis = db.getAnalysis(request.code_hash);
  const storedSecretNames = Object.keys(db.getAllSecrets());

  res.json({
    id,
    status: request.status,
    skill_id: request.skill_id,
    code_hash: request.code_hash,
    created_at: request.created_at,
    code,
    metadata,
    analysis,
    scope_request: scopeReq ? {
      session_id: scopeReq.sessionId,
      description: scopeReq.description,
      constraints: scopeReq.constraints,
      structured_constraints: scopeReq.structuredConstraints,
      secrets: scopeReq.secrets,
      networks: scopeReq.networks,
      missing_secrets: scopeReq.secrets.filter(s => !storedSecretNames.includes(s)),
    } : undefined,
    result: request.result ? JSON.parse(request.result) : undefined,
    error: request.error,
  });
});

// Process web approval
// Process approval (JSON API)
app.post('/approve/:id', async (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const { token, action, level, secrets: providedSecrets } = req.body;
  const request = db.getRequest(id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (!token || token !== request.approval_token) return res.status(403).json({ error: 'Invalid token' });
  if (request.status !== 'pending') return res.json({ id, status: request.status, message: 'Already processed' });

  if (action === 'deny') {
    db.updateRequestStatus(id, 'denied');
    notifyStatusWaiters(id);
    if (telegramBot) {
      const reqMsg = request.telegram_message_id;
      if (reqMsg) await telegramBot.updateExecution(reqMsg, id, { success: false, error: 'Denied via web', duration: 0 });
    }
    return res.json({ id, status: 'denied' });
  }

  // Store any secrets provided with the approval
  if (providedSecrets && typeof providedSecrets === 'object') {
    for (const [n, v] of Object.entries(providedSecrets)) {
      if (v) { secrets[n] = v as string; db.setSecret(n, v as string); }
    }
  }

  // Scope request approval — create or extend session with constraints
  const scopeReq = getScopeRequest(id);
  if (scopeReq) {
    const allConstraints = [...scopeReq.structuredConstraints];
    for (const c of scopeReq.constraints) allConstraints.push({ type: 'natural_language', rule: c, rationale: '' });

    const existingSession = db.getSession(scopeReq.sessionId);
    if (existingSession) {
      const p = existingSession.policy;
      p.allowedSecrets = [...new Set([...p.allowedSecrets, ...scopeReq.secrets])];
      p.allowedNetworks = [...new Set([...p.allowedNetworks, ...scopeReq.networks])];
      p.structuredConstraints = [...(p.structuredConstraints || []), ...allConstraints];
      if (scopeReq.constraints.length) p.constraints = [...(p.constraints || []), ...scopeReq.constraints];
      if (scopeReq.codeHash) p.approvedCodeHash = scopeReq.codeHash;
      if (scopeReq.analysisSummary) p.approvedAnalysisSummary = scopeReq.analysisSummary;
      db.updateSessionPolicy(scopeReq.sessionId, p);
    } else {
      const policy: SessionPolicy = {
        allowedSecrets: scopeReq.secrets,
        allowedNetworks: scopeReq.networks,
        allowMutating: true,
        maxRiskLevel: 'medium',
        constraints: scopeReq.constraints.length ? scopeReq.constraints : undefined,
        description: scopeReq.description,
        approvedCodeHash: scopeReq.codeHash,
        approvedAnalysisSummary: scopeReq.analysisSummary,
        structuredConstraints: allConstraints.length ? allConstraints : undefined,
      };
      db.createSession(scopeReq.sessionId, policy);
    }

    db.addScopeGrant(scopeReq.sessionId, scopeReq.description, allConstraints, scopeReq.secrets, scopeReq.networks);
    db.updateRequestStatus(id, 'completed');
    notifyStatusWaiters(id);
    console.log(`📋 Scope approved, session ${scopeReq.sessionId} ${existingSession ? 'expanded' : 'created'} with ${allConstraints.length} constraints`);
    return res.json({ id, status: 'completed', session_id: scopeReq.sessionId, expanded: !!existingSession, constraints: allConstraints.length });
  }

  // Approve code execution
  const approvalLevel = (level as 'once' | 'trust_code') || 'once';
  if (approvalLevel === 'trust_code') {
    db.addApproval(request.skill_url, request.code_hash, 'forever');
  }

  const reqArgs = request.args ? JSON.parse(request.args) : {};
  const sessionId = reqArgs._sessionId;
  const analysisData = pendingAnalyses.get(id);
  if (sessionId && analysisData) {
    const existing = db.getSession(sessionId);
    if (existing) {
      db.updateSessionPolicy(sessionId, mergePolicy(existing.policy, analysisData));
    } else {
      db.createSession(sessionId, policyFromAnalysis(analysisData));
    }
    pendingAnalyses.delete(id);
  }

  db.updateRequestStatus(id, 'approved');

  let code = db.getCode(id);
  if (!code) {
    const codeResponse = await fetch(request.skill_url);
    code = await codeResponse.text();
  }
  const metadata = parseMetadata(code);
  const requiredSecrets = JSON.parse(request.secrets);
  executeInBackground(id, code, metadata!, requiredSecrets);

  res.json({ id, status: 'approved', executing: true });
});

// Request scope (creates session with constraints, pending human approval)
app.post('/scope', requireTenant, syncTenant, async (req: Request, res: Response) => {
  try {
    const { session_id: clientSessionId, description, constraints, secrets: requestedSecrets, networks, skill_code } = req.body;
    if (!description) return res.status(400).json({ error: 'Missing description' });
    const sessionId = clientSessionId || `session_${randomBytes(8).toString('hex')}`;
    const secretsList = Array.isArray(requestedSecrets) ? requestedSecrets : [];
    const networksList = Array.isArray(networks) ? networks : [];
    const constraintsList = Array.isArray(constraints) ? constraints : [];

    // If code provided, analyze it upfront so human can review code+scope together
    let codeHash: string | undefined;
    let analysisSummary: string | undefined;
    if (skill_code) {
      codeHash = hashCode(skill_code);
      const metadata = parseMetadata(skill_code);
      if (metadata && process.env.ANTHROPIC_API_KEY) {
        const cache = { get: (h: string) => db.getAnalysis(h), set: (h: string, a: CodeAnalysis) => db.setAnalysis(h, a) };
        const analysis = await analyzeCode(skill_code, metadata, codeHash, cache);
        analysisSummary = analysis.summary;
      }
    }

    const requestId = `scope_${randomBytes(8).toString('hex')}`;
    const approvalToken = randomBytes(32).toString('hex');
    const scopeData = JSON.stringify({ description, constraints: constraintsList, secrets: secretsList, networks: networksList, skill_code, codeHash, analysisSummary });

    db.createRequest(requestId, 'scope-request', 'scope', hashCode(scopeData), secretsList, { sessionId, description, constraints: constraintsList, networks: networksList }, approvalToken);
    db.storeCode(requestId, scopeData);

    const orchUrl = req.headers['x-orchestrator-url'] as string | undefined;
    const orchTenant = req.headers['x-tenant-id'] as string | undefined;
    const urlBase = orchUrl && orchTenant ? `${orchUrl}/t/${orchTenant}` : PUBLIC_URL;
    const approvalUrl = urlBase ? `${urlBase}/approve/${requestId}?token=${approvalToken}` : undefined;
    const statusUrl = urlBase ? `${urlBase}/execute/${requestId}/status?wait=true` : undefined;
    const dashboardUrl = urlBase ? `${urlBase}/dashboard?token=${API_BEARER_TOKEN}` : undefined;
    res.json({ request_id: requestId, status: 'pending_scope', session_id: sessionId, approval_url: approvalUrl, status_url: statusUrl, dashboard_url: dashboardUrl, message: 'Scope request awaiting approval — poll status_url to be notified when approved' });
  } catch (error: any) {
    console.error('Scope request error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Request execution (supports dry_run: true to check without executing)
app.post('/execute', requireTenant, syncTenant, async (req: Request, res: Response) => {
  try {
    const { skill_id, skill_url, skill_code, secrets: requiredSecrets, args, session_id: clientSessionId, dry_run } = req.body;
    if (!skill_id) return res.status(400).json({ error: 'Missing skill_id' });
    if (!skill_url && !skill_code) return res.status(400).json({ error: 'Missing skill_url or skill_code' });
    const sessionId = clientSessionId || `session_${randomBytes(8).toString('hex')}`;

    let code: string;
    if (skill_code) {
      code = skill_code;
    } else {
      const codeResponse = await fetch(skill_url);
      if (!codeResponse.ok) return res.status(400).json({ error: 'Failed to fetch skill code' });
      code = await codeResponse.text();
    }
    const codeHash = hashCode(code);
    const metadata = parseMetadata(code);
    if (!metadata) return res.status(400).json({ error: 'Invalid skill format - missing metadata' });

    const secretsList = Array.isArray(requiredSecrets) && requiredSecrets.length ? requiredSecrets
      : requiredSecrets && typeof requiredSecrets === 'object' ? Object.keys(requiredSecrets)
      : metadata?.secrets || [];

    // Check what approval path this would take
    const existingApproval = db.getApproval(skill_url || 'inline', codeHash);
    if (existingApproval) {
      if (dry_run) return res.json({ dry_run: true, would_auto_approve: true, reason: 'trusted_code', session_id: sessionId });
      const requestId = `exec_${randomBytes(8).toString('hex')}`;
      const approvalToken = randomBytes(32).toString('hex');
      db.createRequest(requestId, skill_id, skill_url || 'inline', codeHash, secretsList, args, approvalToken);
      db.storeCode(requestId, code);
      console.log(`⚡ Auto-executing trusted code: ${codeHash.substring(0, 16)}...`);
      db.updateRequestStatus(requestId, 'approved');
      executeInBackground(requestId, code, metadata, secretsList);
      return res.json({ request_id: requestId, status: 'approved', message: 'Auto-approved (trusted code)' });
    }

    // Run structured analysis (needed for session policy check)
    let analysis: CodeAnalysis | undefined;
    if (process.env.ANTHROPIC_API_KEY) {
      const cache = {
        get: (h: string) => db.getAnalysis(h),
        set: (h: string, a: CodeAnalysis) => db.setAnalysis(h, a)
      };
      analysis = await analyzeCode(code, metadata, codeHash, cache);
    }

    // Check session policy (structured constraints don't need analysis)
    let policyViolations: string[] | undefined;
    const session = db.getSession(sessionId);
    if (session) {
      const sc = session.policy.structuredConstraints?.length || 0;
      console.log(`📋 Checking session ${sessionId}: secrets=${JSON.stringify(session.policy.allowedSecrets)} networks=${JSON.stringify(session.policy.allowedNetworks)} constraints=${session.policy.constraints?.length || 0} structured=${sc}`);
      if (analysis) console.log(`   Analysis: secrets=${JSON.stringify(analysis.secretsUsed)} networks=${JSON.stringify(analysis.networkTargets)} risk=${analysis.riskLevel}`);
      const dummyAnalysis: CodeAnalysis = analysis || { summary: '', secretsUsed: [], networkTargets: [], isMutating: false, riskLevel: 'low', concerns: [], timestamp: Date.now() };
      const { fits, violations } = await skillFitsPolicy(code, metadata, dummyAnalysis, session.policy, args, codeHash);
      if (fits) {
        if (dry_run) return res.json({ dry_run: true, would_auto_approve: true, reason: 'session_policy', session_id: sessionId, analysis });
        console.log(`⚡ Auto-approved via session ${sessionId}: ${skill_id}`);
        const requestId = `exec_${randomBytes(8).toString('hex')}`;
        const approvalToken = randomBytes(32).toString('hex');
        db.createRequest(requestId, skill_id, skill_url || 'inline', codeHash, secretsList, args, approvalToken);
        db.storeCode(requestId, code);
        db.touchSession(sessionId);
        db.updateRequestStatus(requestId, 'approved');
        executeInBackground(requestId, code, metadata, secretsList);
        return res.json({ request_id: requestId, status: 'approved', session_id: sessionId, message: 'Auto-approved (session policy)' });
      }
      if (violations?.length) {
        console.log(`🚫 Policy violations for ${skill_id}:`, violations);
        policyViolations = violations;
      }
    }

    // Would need human approval
    if (dry_run) {
      const missingSecrets = secretsList.filter((s: string) => !secrets[s]);
      return res.json({
        dry_run: true,
        would_auto_approve: false,
        reason: policyViolations?.length ? 'policy_violation' : 'needs_approval',
        session_id: sessionId,
        session_exists: !!session,
        analysis,
        policy_violations: policyViolations,
        policy_gaps: session && analysis ? {
          new_secrets: analysis.secretsUsed.filter(s => !session.policy.allowedSecrets.includes(s)),
          new_networks: analysis.networkTargets.filter(n => !session.policy.allowedNetworks.includes(n)),
          risk_escalation: session ? RISK_LEVELS[analysis?.riskLevel || 'medium'] > RISK_LEVELS[session.policy.maxRiskLevel] : false,
          mutation_escalation: analysis?.isMutating && session ? !session.policy.allowMutating : false
        } : undefined,
        missing_secrets: missingSecrets.length > 0 ? missingSecrets : undefined
      });
    }

    const requestId = `exec_${randomBytes(8).toString('hex')}`;
    const approvalToken = randomBytes(32).toString('hex');
    db.createRequest(requestId, skill_id, skill_url || 'inline', codeHash, secretsList, { ...args, _sessionId: sessionId }, approvalToken);
    db.storeCode(requestId, code);
    if (analysis) pendingAnalyses.set(requestId, analysis);

    const orchUrl = req.headers['x-orchestrator-url'] as string | undefined;
    const orchTenant = req.headers['x-tenant-id'] as string | undefined;
    const urlBase = orchUrl && orchTenant ? `${orchUrl}/t/${orchTenant}` : PUBLIC_URL;
    const approvalUrl = urlBase ? `${urlBase}/approve/${requestId}?token=${approvalToken}` : undefined;

    if (telegramBot && approvalUrl) {
      const messageId = await telegramBot.sendApprovalLink(requestId, skill_id, metadata, approvalUrl, analysis?.summary);
      db.updateRequestStatus(requestId, 'pending', messageId);
    }

    const statusUrl = urlBase ? `${urlBase}/execute/${requestId}/status?wait=true` : undefined;
    const response: any = { request_id: requestId, status: 'pending', session_id: sessionId, approval_url: approvalUrl, status_url: statusUrl, message: 'Awaiting approval — poll status_url to be notified when approved' };
    if (policyViolations?.length) response.policy_violations = policyViolations;
    res.json(response);
  } catch (error: any) {
    console.error('Execute error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Waiters for long-poll: requestId -> resolver callbacks
const statusWaiters = new Map<string, Array<() => void>>();

function notifyStatusWaiters(requestId: string) {
  const waiters = statusWaiters.get(requestId);
  if (waiters) {
    statusWaiters.delete(requestId);
    for (const resolve of waiters) resolve();
  }
}

function buildStatusResponse(request: any): any {
  const r: any = { request_id: request.id, status: request.status, created_at: request.created_at };
  if (request.approved_at) r.approved_at = request.approved_at;
  if (request.executed_at) r.executed_at = request.executed_at;
  if (request.result) r.result = JSON.parse(request.result);
  if (request.error) r.error = request.error;
  // Include session_id for scope requests so agents can chain scope→execute
  if (request.skill_url === 'scope') {
    const args = request.args ? JSON.parse(request.args) : {};
    if (args.sessionId) r.session_id = args.sessionId;
  }
  return r;
}

// Get execution status — supports ?wait=true for long-poll (up to 120s)
app.get('/execute/:id/status', requireTenant, syncTenant, async (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const request = db.getRequest(id);
  if (!request) return res.status(404).json({ error: 'Request not found' });

  const wantWait = req.query.wait === 'true' || req.query.wait === '1';
  const terminal = ['completed', 'failed', 'denied'];

  // Long-poll: if status is not terminal, wait up to 120s for a change
  if (wantWait && !terminal.includes(request.status)) {
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 120_000);
      const entry = () => { clearTimeout(timeout); resolve(); };
      if (!statusWaiters.has(id)) statusWaiters.set(id, []);
      statusWaiters.get(id)!.push(entry);
    });
    // Re-read after waking
    const updated = db.getRequest(id);
    if (updated) return res.json(buildStatusResponse(updated));
  }

  res.json(buildStatusResponse(request));
});

// Helper: Execute skill in background
async function executeInBackground(requestId: string, code: string, metadata: any, requiredSecrets: string[]) {
  console.log(`\n🚀 Starting background execution for ${requestId}`);
  try {
    db.updateRequestStatus(requestId, 'executing');
    const dbRequest = db.getRequest(requestId);
    const args = dbRequest?.args ? JSON.parse(dbRequest.args) : {};

    const secretValues: Record<string, string> = {};
    const missingSecrets: string[] = [];
    for (const name of requiredSecrets) {
      if (!secrets[name]) missingSecrets.push(name);
      else secretValues[name] = secrets[name];
    }

    if (missingSecrets.length > 0) {
      console.log(`  Missing secrets: ${missingSecrets.join(', ')}`);
      db.updateRequestStatus(requestId, 'awaiting_secrets');
      if (telegramBot) await telegramBot.requestSecret(requestId, missingSecrets[0], missingSecrets);
      return;
    }

    const result = await executeSkill({
      code, secrets: secretValues, args,
      timeout: metadata.timeout || 30,
      allowedNetworks: metadata.network || []
    });
    console.log(`  Execution complete:`, result.success ? '✅' : '❌');

    db.updateRequestResult(requestId, {
      success: result.success, stdout: result.stdout,
      stderr: result.stderr, exitCode: result.exitCode, duration: result.duration
    }, result.success ? undefined : result.stderr);
    notifyStatusWaiters(requestId);

    const request = db.getRequest(requestId);
    if (request?.telegram_message_id && telegramBot) {
      await telegramBot.updateExecution(request.telegram_message_id, requestId, {
        success: result.success, stdout: result.stdout, error: result.stderr, duration: result.duration
      });
    }
  } catch (error: any) {
    console.error(`❌ Execution failed for ${requestId}:`, error.message);
    db.updateRequestResult(requestId, null, error.message);
    notifyStatusWaiters(requestId);
    try {
      const request = db.getRequest(requestId);
      if (request?.telegram_message_id && telegramBot) {
        await telegramBot.updateExecution(request.telegram_message_id, requestId, {
          success: false, stdout: '', error: error.message, duration: 0
        });
      }
    } catch {}
  }
}

setInterval(() => db.cleanupExpired(), 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Execution Proxy running on port ${PORT}`);
  console.log(`📊 Database: ${DB_PATH}`);
  console.log(`⚙️  Executor: ${EXECUTOR_MODE} mode`);
  console.log(`🔗 Public URL: ${PUBLIC_URL || '(not set)'}`);
  console.log(`🤖 Telegram: ${TELEGRAM_BOT_TOKEN ? 'Configured' : 'Not configured'}`);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
