/**
 * HTTP API Server for Execution Proxy
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import { ProxyDatabase, SessionPolicy } from './database.js';
import { executeSkill, hashCode, parseMetadata, EXECUTOR_MODE } from './executor.js';
import { analyzeCode, CodeAnalysis } from './analyzer.js';
import { randomBytes } from 'crypto';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
const pendingSessionIds = new Map<string, string>();   // requestId -> sessionId
const pendingAnalyses = new Map<string, CodeAnalysis>(); // requestId -> analysis

const RISK_LEVELS = { low: 0, medium: 1, high: 2 } as const;

function skillFitsPolicy(analysis: CodeAnalysis, policy: SessionPolicy): boolean {
  // All secrets used must be in the allowed set
  if (analysis.secretsUsed.some(s => !policy.allowedSecrets.includes(s))) return false;
  // All network targets must be in the allowed set
  if (analysis.networkTargets.some(n => !policy.allowedNetworks.includes(n))) return false;
  // Mutating only if policy allows
  if (analysis.isMutating && !policy.allowMutating) return false;
  // Risk level must not exceed policy
  if (RISK_LEVELS[analysis.riskLevel] > RISK_LEVELS[policy.maxRiskLevel]) return false;
  return true;
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
    maxRiskLevel: RISK_LEVELS[analysis.riskLevel] > RISK_LEVELS[existing.maxRiskLevel] ? analysis.riskLevel : existing.maxRiskLevel
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
      const sessionId = pendingSessionIds.get(requestId);
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
        pendingSessionIds.delete(requestId);
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
2. **Poll for result** via \`GET /execute/:id/status?wait=true\` (long-polls up to 120s)
3. If status is \`pending\`, the \`approval_url\` in the response needs human approval first
4. Result arrives in \`result.stdout\` — return all output as text/JSON on stdout

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

Pass \`session_id\` to group related requests. After the first manual approval,
the proxy learns a policy (allowed secrets, networks, mutation flag, risk level).
Subsequent requests that fit within the policy auto-approve for 2 hours.

Trusted code (approved with "Trust Code") auto-executes forever by code hash.

## Available Secrets
${Object.keys(secrets).map(s => '- ' + s).join('\n') || '(none configured)'}

---
Public URL: ${PUBLIC_URL || '(not configured)'}
Executor: ${EXECUTOR_MODE} mode
`);
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    telegram_configured: !!TELEGRAM_BOT_TOKEN,
    public_url: PUBLIC_URL || null,
    timestamp: Date.now()
  });
});

// Add secret — persists to SQLite
app.post('/secrets', requireAuth, (req: Request, res: Response) => {
  const { name, value } = req.body;
  if (!name || !value) return res.status(400).json({ error: 'Missing name or value' });
  secrets[name] = value;
  db.setSecret(name, value);
  res.json({ success: true, name });
});

// List secrets (names only)
app.get('/secrets', requireAuth, (req: Request, res: Response) => {
  res.json({ secrets: Object.keys(secrets) });
});

// Bearer token auth for internal endpoints
function requireAuth(req: Request, res: Response, next: Function) {
  if (!API_BEARER_TOKEN) return next(); // no token configured = open access (dev mode)
  const auth = req.headers.authorization;
  if (auth === `Bearer ${API_BEARER_TOKEN}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// List active sessions
app.get('/sessions', requireAuth, (req: Request, res: Response) => {
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
app.get('/sessions/:id', requireAuth, (req: Request, res: Response) => {
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
app.delete('/sessions/:id', requireAuth, (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const session = db.getSession(id);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  db.deleteSession(id);
  res.json({ deleted: true, session_id: id });
});

// View code for an execution request
app.get('/view/:id', requireAuth, (req: Request, res: Response) => {
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

  const code = db.getCode(id) || '';
  const metadata = parseMetadata(code);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
<div class="actions">
<form method="POST" style="display:inline">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="action" value="approve">
  <input type="hidden" name="level" value="once">
  <button type="submit" class="approve">✅ Run Once</button>
</form>
<form method="POST" style="display:inline">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="action" value="approve">
  <input type="hidden" name="level" value="trust_code">
  <button type="submit" class="trust">🔒 Trust Code</button>
</form>
<form method="POST" style="display:inline">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="action" value="deny">
  <button type="submit" class="deny">❌ Deny</button>
</form>
</div>
</body></html>`);
});

// Process web approval
app.post('/approve/:id', async (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const { token, action, level } = req.body;
  const request = db.getRequest(id);
  if (!request) return res.status(404).send('Not found');
  if (!token || token !== request.approval_token) return res.status(403).send('Invalid token');
  if (request.status !== 'pending') return res.redirect(`/approve/${id}?token=${token}`);

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

  // Approve
  const approvalLevel = (level as 'once' | 'trust_code') || 'once';
  if (approvalLevel === 'trust_code') {
    db.addApproval(request.skill_url, request.code_hash, 'forever');
  }

  // Session handling
  const sessionId = pendingSessionIds.get(id);
  const analysisData = pendingAnalyses.get(id);
  if (sessionId && analysisData) {
    const existing = db.getSession(sessionId);
    if (existing) {
      db.updateSessionPolicy(sessionId, mergePolicy(existing.policy, analysisData));
    } else {
      db.createSession(sessionId, policyFromAnalysis(analysisData));
    }
    pendingSessionIds.delete(id);
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

// Request execution (supports dry_run: true to check without executing)
app.post('/execute', requireAuth, async (req: Request, res: Response) => {
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

    const secretsList = Array.isArray(requiredSecrets) ? requiredSecrets
      : requiredSecrets && typeof requiredSecrets === 'object' ? Object.keys(requiredSecrets) : [];

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

    // Check session policy
    const session = db.getSession(sessionId);
    if (session && analysis) {
      const fits = skillFitsPolicy(analysis, session.policy);
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
    }

    // Would need human approval
    if (dry_run) {
      const missingSecrets = secretsList.filter((s: string) => !secrets[s]);
      return res.json({
        dry_run: true,
        would_auto_approve: false,
        reason: 'needs_approval',
        session_id: sessionId,
        session_exists: !!session,
        analysis,
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
    db.createRequest(requestId, skill_id, skill_url || 'inline', codeHash, secretsList, args, approvalToken);
    db.storeCode(requestId, code);

    pendingSessionIds.set(requestId, sessionId);
    if (analysis) pendingAnalyses.set(requestId, analysis);

    const approvalUrl = PUBLIC_URL ? `${PUBLIC_URL}/approve/${requestId}?token=${approvalToken}` : undefined;

    if (telegramBot && approvalUrl) {
      const messageId = await telegramBot.sendApprovalLink(requestId, skill_id, metadata, approvalUrl, analysis?.summary);
      db.updateRequestStatus(requestId, 'pending', messageId);
    }

    res.json({ request_id: requestId, status: 'pending', session_id: sessionId, approval_url: approvalUrl, message: 'Awaiting approval' });
  } catch (error: any) {
    console.error('Execute error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Waiters for long-poll: requestId -> resolver callbacks
const statusWaiters = new Map<string, Array<() => void>>();

function notifyStatusWaiters(requestId: string) {
  const waiters = statusWaiters.get(requestId);
  if (!waiters) return;
  statusWaiters.delete(requestId);
  for (const resolve of waiters) resolve();
}

// Get execution status — supports ?wait=true for long-poll (up to 120s)
app.get('/execute/:id/status', requireAuth, async (req: Request, res: Response) => {
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
    if (updated) {
      const response: any = { request_id: updated.id, status: updated.status, created_at: updated.created_at };
      if (updated.approved_at) response.approved_at = updated.approved_at;
      if (updated.executed_at) response.executed_at = updated.executed_at;
      if (updated.result) response.result = JSON.parse(updated.result);
      if (updated.error) response.error = updated.error;
      return res.json(response);
    }
  }

  const response: any = { request_id: request.id, status: request.status, created_at: request.created_at };
  if (request.approved_at) response.approved_at = request.approved_at;
  if (request.executed_at) response.executed_at = request.executed_at;
  if (request.result) response.result = JSON.parse(request.result);
  if (request.error) response.error = request.error;
  res.json(response);
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
