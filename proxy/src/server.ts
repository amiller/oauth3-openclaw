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

// Dashboard — human-facing session/execution browser
app.get('/dashboard', (req: Request, res: Response) => {
  if (API_BEARER_TOKEN && req.query.token !== API_BEARER_TOKEN) return res.status(401).send('Unauthorized — append ?token=...');
  const sessions = db.listSessions();
  const requests = db.listRecentRequests(30);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const orchUrl = req.headers['x-orchestrator-url'] as string | undefined;
  const orchTenant = req.headers['x-tenant-id'] as string | undefined;
  const B = orchUrl && orchTenant ? `${orchUrl}/t/${orchTenant}` : '';
  const ago = (ts: number) => {
    const m = Math.round((Date.now() - ts) / 60000);
    return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
  };
  const statusIcon: Record<string, string> = { completed: '✅', failed: '❌', denied: '🚫', pending: '⏳', approved: '🔄', executing: '⚙️', awaiting_secrets: '🔑' };

  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>OAuth3 Dashboard</title>
<style>
body{font-family:monospace;background:#1e1e2e;color:#cdd6f4;margin:0;padding:1.5em;max-width:900px;margin:0 auto}
h1{color:#89b4fa;font-size:1.3em} h2{color:#a6adc8;font-size:1.1em;margin-top:2em}
table{width:100%;border-collapse:collapse;font-size:0.85em}
th{text-align:left;color:#6c7086;border-bottom:1px solid #313244;padding:0.4em 0.6em}
td{padding:0.4em 0.6em;border-bottom:1px solid #181825}
tr:hover{background:#181825}
.tag{display:inline-block;padding:0.15em 0.5em;border-radius:4px;font-size:0.8em}
.secret{background:#f38ba820;color:#f38ba8} .network{background:#89b4fa20;color:#89b4fa}
.risk-low{color:#a6e3a1} .risk-medium{color:#f9e2af} .risk-high{color:#f38ba8}
a{color:#89b4fa;text-decoration:none} a:hover{text-decoration:underline}
.btn{font-family:monospace;font-size:0.8em;padding:0.3em 0.6em;border:1px solid #f38ba8;color:#f38ba8;background:none;border-radius:4px;cursor:pointer}
.btn:hover{background:#f38ba820}
.empty{color:#6c7086;font-style:italic}
</style></head><body>
<h1>OAuth3 Dashboard</h1>

<h2>Active Sessions (${sessions.length})</h2>
${sessions.length === 0 ? '<p class="empty">No active sessions</p>' : `<table>
<tr><th>Session</th><th>Age</th><th>Idle</th><th>Secrets</th><th>Networks</th><th>Risk</th><th></th></tr>
${sessions.map(s => `<tr>
<td><a href="${B}/dashboard/session/${esc(s.session_id)}?token=${esc(API_BEARER_TOKEN)}"><code>${esc(s.session_id.substring(0, 20))}</code></a>${s.policy.description ? `<br><small>${esc(s.policy.description.substring(0, 60))}</small>` : ''}</td>
<td>${ago(s.created_at)}</td>
<td>${ago(s.last_activity)}</td>
<td>${s.policy.allowedSecrets.map((x: string) => `<span class="tag secret">${esc(x)}</span>`).join(' ') || '—'}</td>
<td>${s.policy.allowedNetworks.map((x: string) => `<span class="tag network">${esc(x)}</span>`).join(' ') || '—'}</td>
<td class="risk-${s.policy.maxRiskLevel}">${s.policy.maxRiskLevel}${s.policy.constraints?.length ? `<br><small>${s.policy.constraints.length} constraints</small>` : ''}</td>
<td><form method="POST" action="${B}/dashboard/revoke?token=${esc(API_BEARER_TOKEN)}" style="display:inline">
<input type="hidden" name="session_id" value="${esc(s.session_id)}">
<button class="btn" type="submit">revoke</button></form></td>
</tr>`).join('')}
</table>`}

<h2>Recent Executions</h2>
${requests.length === 0 ? '<p class="empty">No executions yet</p>' : `<table>
<tr><th>ID</th><th>Skill</th><th>Status</th><th>When</th><th></th></tr>
${requests.map(r => `<tr>
<td><code>${esc(r.id.substring(0, 16))}</code></td>
<td>${esc(r.skill_id)}</td>
<td>${statusIcon[r.status] || '?'} ${esc(r.status)}</td>
<td>${ago(r.created_at)}</td>
<td>${r.code_hash ? `<a href="${B}/view/${esc(r.id)}?token=${esc(API_BEARER_TOKEN)}">code</a>` : ''}</td>
</tr>`).join('')}
</table>`}

<p style="color:#6c7086;margin-top:2em;font-size:0.8em">Sessions expire after 2h of inactivity. <a href="${B}/dashboard?token=${esc(API_BEARER_TOKEN)}">Refresh</a></p>
</body></html>`);
});

// Dashboard revoke action
app.post('/dashboard/revoke', (req: Request, res: Response) => {
  if (API_BEARER_TOKEN && req.query.token !== API_BEARER_TOKEN) return res.status(401).send('Unauthorized');
  const { session_id } = req.body;
  if (session_id) db.deleteSession(session_id);
  const orchUrl = req.headers['x-orchestrator-url'] as string | undefined;
  const orchTenant = req.headers['x-tenant-id'] as string | undefined;
  const B = orchUrl && orchTenant ? `${orchUrl}/t/${orchTenant}` : '';
  res.redirect(`/dashboard?token=${API_BEARER_TOKEN}`);
});

// Session detail page
app.get('/dashboard/session/:id', (req: Request, res: Response) => {
  if (API_BEARER_TOKEN && req.query.token !== API_BEARER_TOKEN) return res.status(401).send('Unauthorized');
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const session = db.getSession(id);
  if (!session) return res.status(404).send('Session not found or expired');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const orchUrl = req.headers['x-orchestrator-url'] as string | undefined;
  const orchTenant = req.headers['x-tenant-id'] as string | undefined;
  const B = orchUrl && orchTenant ? `${orchUrl}/t/${orchTenant}` : '';
  const p = session.policy;

  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Session: ${esc(id.substring(0, 20))}</title>
<style>
body{font-family:monospace;background:#1e1e2e;color:#cdd6f4;margin:0;padding:1.5em;max-width:700px;margin:0 auto}
h1{color:#89b4fa;font-size:1.2em} h2{color:#a6adc8;font-size:1em;margin-top:1.5em}
.tag{display:inline-block;padding:0.15em 0.5em;border-radius:4px;font-size:0.85em;margin:0.1em}
.secret{background:#f38ba820;color:#f38ba8} .network{background:#89b4fa20;color:#89b4fa}
.constraint{background:#181825;padding:0.6em 1em;border-radius:6px;border-left:3px solid #f9e2af;margin:0.4em 0}
.meta{color:#6c7086} .section{margin:1em 0}
a{color:#89b4fa;text-decoration:none} a:hover{text-decoration:underline}
.risk-low{color:#a6e3a1} .risk-medium{color:#f9e2af} .risk-high{color:#f38ba8}
.btn{font-family:monospace;font-size:0.85em;padding:0.4em 0.8em;border:1px solid #f38ba8;color:#f38ba8;background:none;border-radius:4px;cursor:pointer}
</style></head><body>
<p><a href="${B}/dashboard?token=${esc(API_BEARER_TOKEN)}">&larr; Dashboard</a></p>
<h1>Session</h1>
<div class="meta"><code>${esc(id)}</code></div>
${p.description ? `<div class="section"><b>Description:</b> ${esc(p.description)}</div>` : ''}
<div class="section"><b>Created:</b> ${new Date(session.created_at).toISOString()}<br>
<b>Last activity:</b> ${new Date(session.last_activity).toISOString()}<br>
<b>Idle:</b> ${Math.round((Date.now() - session.last_activity) / 60000)} min</div>

<h2>Policy</h2>
<div class="section">
<b>Secrets:</b> ${p.allowedSecrets.map(s => `<span class="tag secret">${esc(s)}</span>`).join(' ') || '<span class="meta">none</span>'}<br>
<b>Networks:</b> ${p.allowedNetworks.map(n => `<span class="tag network">${esc(n)}</span>`).join(' ') || '<span class="meta">none</span>'}<br>
<b>Mutating:</b> ${p.allowMutating ? 'yes' : 'no'}<br>
<b>Max risk:</b> <span class="risk-${p.maxRiskLevel}">${p.maxRiskLevel}</span>
</div>

${p.constraints?.length ? `<h2>Constraints (${p.constraints.length})</h2>
${p.constraints.map(c => `<div class="constraint">${esc(c)}</div>`).join('')}` : ''}

${p.approvedCodeHash ? `<h2>Pre-approved Code</h2>
<div class="section">
<b>Code hash:</b> <code>${esc(p.approvedCodeHash.substring(0, 32))}...</code><br>
${p.approvedAnalysisSummary ? `<b>Analysis:</b> ${esc(p.approvedAnalysisSummary)}<br>` : ''}
<small class="meta">Executions matching this hash auto-approve — only args are checked against constraints.</small>
</div>` : ''}

<h2>Haiku Token Usage</h2>
<div class="section">
<b>Calls:</b> ${tokenUsage.calls} | <b>Input:</b> ${tokenUsage.inputTokens} tokens | <b>Output:</b> ${tokenUsage.outputTokens} tokens
<br><small class="meta">Cumulative since last proxy restart. Haiku 4.5: $0.80/1M input, $4/1M output.</small>
</div>

<div class="section" style="margin-top:2em">
<form method="POST" action="${B}/dashboard/revoke?token=${esc(API_BEARER_TOKEN)}">
<input type="hidden" name="session_id" value="${esc(id)}">
<button class="btn" type="submit">Revoke Session</button>
</form></div>
</body></html>`);
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

// View code for an execution request (accepts bearer header or ?token= query param)
app.get('/view/:id', (req: Request, res: Response, next: () => void) => {
  if (API_BEARER_TOKEN && req.query.token === API_BEARER_TOKEN) return next();
  requireTenant(req, res, next);
}, (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const code = db.getCode(id);
  if (!code) return res.status(404).send('Not found');

  const request = db.getRequest(id);
  const metadata = parseMetadata(code);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(metadata?.skill || id)}</title>
<style>
body{font-family:monospace;background:#1e1e2e;color:#cdd6f4;margin:0;padding:1em}
pre{background:#181825;padding:1em;border-radius:8px;overflow-x:auto;line-height:1.5}
h1{color:#89b4fa;font-size:1.2em} .meta{color:#6c7086;margin-bottom:1em}
</style></head><body>
<h1>${esc(metadata?.skill || 'Skill')}</h1>
<div class="meta">${esc(metadata?.description || '')}
<br>Hash: ${request?.code_hash?.substring(0, 16) || '?'}...
<br>Secrets: ${esc(metadata?.secrets?.join(', ') || 'none')}
<br>Network: ${esc(metadata?.network?.join(', ') || 'none')}</div>
<pre>${esc(code)}</pre>
</body></html>`);
});

// Web-based approval page (served from TEE)
app.get('/approve/:id', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const token = req.query.token as string;
  const request = db.getRequest(id);
  if (!request) return res.status(404).send('Not found');
  if (!token || token !== request.approval_token) return res.status(403).send('Invalid token');

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const orchUrl = req.headers['x-orchestrator-url'] as string | undefined;
  const orchTenant = req.headers['x-tenant-id'] as string | undefined;
  const B = orchUrl && orchTenant ? `${orchUrl}/t/${orchTenant}` : '';
  const dashLink = `<p style="margin-top:1.5em"><a href="${B}/dashboard?token=${esc(API_BEARER_TOKEN)}" style="color:#89b4fa">📊 Dashboard</a></p>`;

  // Scope request approval page
  const scopeReq = getScopeRequest(id);
  if (scopeReq && request.status === 'pending') {
    const hasStructured = scopeReq.structuredConstraints.length > 0;
    const renderConstraint = (c: PolicyConstraint) => {
      if (c.type === 'regex') return `<div class="constraint strict">✅ <code>${esc(c.param)}</code> matches <code>/${esc(c.pattern)}/</code><br><small class="rationale">${esc(c.rationale)}</small></div>`;
      if (c.type === 'predicate') return `<div class="constraint strict">✅ <code>${esc(c.param)}</code> ${esc(c.op)} <code>${esc(JSON.stringify(c.value))}</code><br><small class="rationale">${esc(c.rationale)}</small></div>`;
      return `<div class="constraint soft">⚠️ <span class="runtime-tag">[runtime-checked]</span> ${esc(c.rule)}<br><small class="rationale">${esc(c.rationale)}</small></div>`;
    };

    return res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Approve Policy</title>
<style>
body{font-family:monospace;background:#1e1e2e;color:#cdd6f4;margin:0;padding:1.5em;max-width:700px;margin:0 auto}
h1{color:#89b4fa;font-size:1.2em} .meta{color:#6c7086}
.policy-box{background:#181825;border-radius:8px;padding:1.2em;margin:1em 0;border:1px solid #313244}
.policy-box h2{margin:0 0 0.5em;font-size:1em;color:#cdd6f4}
.policy-desc{color:#a6adc8;margin-bottom:1em}
.resource-row{display:flex;gap:2em;margin:0.8em 0;flex-wrap:wrap}
.resource-col b{color:#6c7086;font-size:0.85em;text-transform:uppercase;letter-spacing:0.05em}
.tag{display:inline-block;padding:0.2em 0.6em;border-radius:4px;font-size:0.85em;margin:0.15em}
.secret{background:#f38ba820;color:#f38ba8} .network{background:#89b4fa20;color:#89b4fa}
.constraint{padding:0.5em 0.8em;border-radius:6px;margin:0.3em 0;font-size:0.9em}
.constraint.strict{background:#a6e3a110;border-left:3px solid #a6e3a1}
.constraint.soft{background:#f9e2af10;border-left:3px solid #f9e2af}
.constraint.legacy{background:#181825;border-left:3px solid #f9e2af}
.runtime-tag{color:#f9e2af;font-size:0.8em}
.rationale{color:#6c7086}
.section{margin:1em 0}
.actions{margin:1.5em 0;display:flex;gap:0.5em;flex-wrap:wrap}
button{font-family:monospace;font-size:1em;padding:0.6em 1.2em;border:none;border-radius:6px;cursor:pointer}
.approve{background:#a6e3a1;color:#1e1e2e} .deny{background:#f38ba8;color:#1e1e2e}
details{margin-top:1em} summary{cursor:pointer;color:#89b4fa;font-size:0.9em}
</style></head><body>
<h1>🔐 Policy Proposal</h1>
<form method="POST">
<input type="hidden" name="token" value="${esc(token)}">
<input type="hidden" name="action" value="approve">
<input type="hidden" name="level" value="scope">

<div class="policy-box">
<h2>${esc(scopeReq.description)}</h2>

<div class="resource-row">
<div class="resource-col"><b>Secrets</b><br>${scopeReq.secrets.map(s => {
    const stored = db.getAllSecrets()[s];
    return stored
      ? `<span class="tag secret">🔑 ${esc(s)}</span>`
      : `<div style="margin:0.3em 0"><span class="tag secret">🔑 ${esc(s)}</span><br><input type="password" name="secret_${esc(s)}" placeholder="Enter ${esc(s)}" style="width:100%;padding:0.4em;background:#1e1e2e;border:1px solid #313244;color:#cdd6f4;border-radius:4px;font-family:monospace;margin-top:0.2em"></div>`;
  }).join('') || '<span class="meta">none</span>'}</div>
<div class="resource-col"><b>Networks</b><br>${scopeReq.networks.map(n => `<span class="tag network">🌐 ${esc(n)}</span>`).join('') || '<span class="meta">none</span>'}</div>
</div>

${hasStructured ? `<div style="margin-top:1em"><b style="color:#6c7086;font-size:0.85em;text-transform:uppercase">Constraints</b>
${scopeReq.structuredConstraints.map(renderConstraint).join('')}
</div>` : ''}
${scopeReq.constraints.length ? `<div style="margin-top:${hasStructured ? '0.5' : '1'}em">${!hasStructured ? '<b style="color:#6c7086;font-size:0.85em;text-transform:uppercase">Constraints</b>' : ''}
${scopeReq.constraints.map(c => `<div class="constraint legacy">⚠️ ${esc(c)}</div>`).join('')}
</div>` : ''}
${!hasStructured && !scopeReq.constraints.length ? '<div class="meta" style="margin-top:0.5em">No constraints specified</div>' : ''}
</div>

${scopeReq.skill_code ? `<details><summary>▶ View Code</summary>
${scopeReq.analysisSummary ? `<div class="constraint" style="background:#181825;border-left:3px solid #89b4fa;margin:0.5em 0">${esc(scopeReq.analysisSummary)}</div>` : ''}
<pre style="background:#181825;padding:1em;border-radius:8px;overflow-x:auto;font-size:0.85em">${esc(scopeReq.skill_code)}</pre>
</details>` : ''}

<div class="actions"><button type="submit" class="approve">✅ Approve</button></div>
</form>
<form method="POST">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="action" value="deny">
  <div class="actions"><button type="submit" class="deny">❌ Deny</button></div>
</form>
</body></html>`);
  }

  const code = db.getCode(id) || '';
  const metadata = parseMetadata(code);
  const analysisData = db.getAnalysis(request.code_hash);
  const analysisSummary = analysisData?.summary || '';

  const terminal = ['completed', 'failed', 'denied', 'approved', 'executing'];
  if (terminal.includes(request.status)) {
    const resultData = request.result ? JSON.parse(request.result) : null;
    return res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(metadata?.skill || id)}</title>
<style>
body{font-family:monospace;background:#1e1e2e;color:#cdd6f4;margin:0;padding:1.5em;max-width:700px;margin:0 auto}
pre{background:#181825;padding:1em;border-radius:8px;overflow-x:auto;line-height:1.5;font-size:0.85em}
h1{color:#89b4fa;font-size:1.2em} .meta{color:#6c7086;margin-bottom:1em}
.status{font-size:1.1em;margin:1em 0;padding:0.8em;border-radius:8px;background:#181825}
</style></head><body>
<h1>${esc(metadata?.skill || 'Skill')}</h1>
<div class="status">${request.status === 'completed' ? '✅' : request.status === 'denied' ? '❌' : '⏳'} Status: ${esc(request.status)}${resultData?.stdout ? `\n<pre>${esc(resultData.stdout.substring(0, 500))}</pre>` : ''}${request.error ? `\n<pre>${esc(request.error.substring(0, 500))}</pre>` : ''}</div>
${dashLink}
</body></html>`);
  }

  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Approve: ${esc(metadata?.skill || id)}</title>
<style>
body{font-family:monospace;background:#1e1e2e;color:#cdd6f4;margin:0;padding:1.5em;max-width:700px;margin:0 auto}
pre{background:#181825;padding:1em;border-radius:8px;overflow-x:auto;line-height:1.5;font-size:0.85em}
h1{color:#89b4fa;font-size:1.2em} .meta{color:#6c7086;margin-bottom:1em}
.actions{margin:1.5em 0;display:flex;gap:0.5em;flex-wrap:wrap}
button{font-family:monospace;font-size:1em;padding:0.6em 1.2em;border:none;border-radius:6px;cursor:pointer}
.approve{background:#a6e3a1;color:#1e1e2e} .approve:hover{background:#94e296}
.trust{background:#89b4fa;color:#1e1e2e} .trust:hover{background:#74a8f7}
.deny{background:#f38ba8;color:#1e1e2e} .deny:hover{background:#f07a9a}
.analysis{background:#181825;padding:1em;border-radius:8px;border-left:3px solid #89b4fa;margin:1em 0}
</style></head><body>
<h1>${esc(metadata?.skill || 'Skill')}</h1>
<div class="meta">
${esc(metadata?.description || '')}
<br>Hash: ${esc(request.code_hash.substring(0, 16))}...
<br>Secrets: ${esc(metadata?.secrets?.join(', ') || 'none')}
<br>Network: ${esc(metadata?.network?.join(', ') || 'none')}
<br>Timeout: ${metadata?.timeout || 30}s
</div>
${analysisSummary ? `<div class="analysis"><b>Analysis:</b><br>${esc(analysisSummary)}</div>` : ''}
<pre>${esc(code)}</pre>
<form method="POST">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="action" value="approve">
${(metadata?.secrets?.length) ? `<div class="section"><b>Provide Secrets:</b>${metadata.secrets.map(s => {
    const stored = db.getAllSecrets()[s];
    return stored
      ? ` <span style="color:#a6e3a1"><code>${esc(s)}</code> ✅</span>`
      : `<div style="margin:0.4em 0"><label><code>${esc(s)}</code></label><br><input type="password" name="secret_${esc(s)}" placeholder="Enter ${esc(s)}" style="width:100%;padding:0.5em;background:#181825;border:1px solid #313244;color:#cdd6f4;border-radius:4px;font-family:monospace"></div>`;
  }).join('')}</div>` : ''}
  <div class="actions">
    <button type="submit" name="level" value="once" class="approve">✅ Run Once</button>
    <button type="submit" name="level" value="trust_code" class="trust">🔒 Trust Code</button>
  </div>
</form>
<form method="POST">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="action" value="deny">
  <div class="actions"><button type="submit" class="deny">❌ Deny</button></div>
</form>
${dashLink}
</body></html>`);
});

// Process web approval
app.post('/approve/:id', async (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const { token, action, level } = req.body;
  const request = db.getRequest(id);
  if (!request) return res.status(404).send('Not found');
  if (!token || token !== request.approval_token) return res.status(403).send('Invalid token');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const orchUrl = req.headers['x-orchestrator-url'] as string | undefined;
  const orchTenant = req.headers['x-tenant-id'] as string | undefined;
  const B = orchUrl && orchTenant ? `${orchUrl}/t/${orchTenant}` : '';
  const dashboardUrl = `${B}/dashboard?token=${esc(API_BEARER_TOKEN)}`;
  if (request.status !== 'pending') return res.redirect(`/approve/${id}?token=${token}`);

  if (action === 'deny') {
    db.updateRequestStatus(id, 'denied');
    notifyStatusWaiters(id);
    if (telegramBot) {
      const reqMsg = request.telegram_message_id;
      if (reqMsg) await telegramBot.updateExecution(reqMsg, id, { success: false, error: 'Denied via web', duration: 0 });
    }
    return res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>body{font-family:monospace;background:#1e1e2e;color:#cdd6f4;padding:2em;text-align:center}</style>
</head><body><h2>❌ Denied</h2><p>Request ${esc(id)} was denied.</p></body></html>`);
  }

  // Store any secrets provided with the approval form
  for (const key of Object.keys(req.body)) {
    if (key.startsWith('secret_') && req.body[key]) { const n = key.slice(7); secrets[n] = req.body[key]; db.setSecret(n, req.body[key]); }
  }

  // Scope request approval — create or extend session with constraints
  const scopeReq = getScopeRequest(id);
  if (scopeReq) {
    const allConstraints = [...scopeReq.structuredConstraints];
    // Convert legacy string constraints to natural_language
    for (const c of scopeReq.constraints) allConstraints.push({ type: 'natural_language', rule: c, rationale: '' });

    const existingSession = db.getSession(scopeReq.sessionId);
    if (existingSession) {
      // Incremental scope: merge into existing session
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

    // Record the scope grant
    db.addScopeGrant(scopeReq.sessionId, scopeReq.description, allConstraints, scopeReq.secrets, scopeReq.networks);

    db.updateRequestStatus(id, 'completed');
    notifyStatusWaiters(id);
    const totalConstraints = allConstraints.length;
    console.log(`📋 Scope approved, session ${scopeReq.sessionId} ${existingSession ? 'expanded' : 'created'} with ${totalConstraints} constraints${scopeReq.codeHash ? `, code hash ${scopeReq.codeHash.substring(0, 16)}` : ''}`);

    return res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>body{font-family:monospace;background:#1e1e2e;color:#cdd6f4;padding:2em;text-align:center}
a{color:#89b4fa}</style>
</head><body><h2>✅ ${existingSession ? 'Scope Expanded' : 'Scope Approved'}</h2>
<p>Session <code>${esc(scopeReq.sessionId)}</code> ${existingSession ? 'updated' : 'created'}.</p>
<p>${totalConstraints} constraints active.</p>
<p><a href="${dashboardUrl}">View Dashboard</a></p>
</body></html>`);
  }

  // Approve code execution
  const approvalLevel = (level as 'once' | 'trust_code') || 'once';
  if (approvalLevel === 'trust_code') {
    db.addApproval(request.skill_url, request.code_hash, 'forever');
  }

  // Session handling
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

  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>body{font-family:monospace;background:#1e1e2e;color:#cdd6f4;padding:2em;text-align:center}
a{color:#89b4fa}</style>
</head><body><h2>✅ Approved</h2><p>Executing ${esc(request.skill_id)}...</p>
<p><a href="/approve/${esc(id)}?token=${esc(token)}">View status</a></p>
<script>setTimeout(()=>location.reload(),3000)</script>
</body></html>`);
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
    if (session && (analysis || session.policy.structuredConstraints?.length)) {
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
