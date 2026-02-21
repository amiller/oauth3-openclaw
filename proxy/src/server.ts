/**
 * HTTP API Server for Execution Proxy
 * Capabilities-only execution path: permit → action
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import { ProxyDatabase, SessionPolicy } from './database.js';
import { execute, hashCode, EXECUTOR_MODE } from './executor.js';
import { verifyCapabilityMode } from './ast-analyzer.js';
import { CapabilitySpec, CapabilityFunction, validateSpec, extractSecrets, extractNetworks, summarizeSpec, hashSpec, draftCapability, fetchDocContent, tokenUsage, PolicyConstraint } from './capability.js';
import { requireTenant, handleSignup, TenantContext } from './auth.js';
import * as pgLog from './postgres.js';
import { randomBytes } from 'crypto';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((_req, res, next) => { res.setHeader('Referrer-Policy', 'no-referrer'); next(); });

// CORS
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://oauth3.app';
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (req.url.includes('/approve/')) console.log('[CORS debug]', { origin, referer: req.headers.referer, ua: req.headers['user-agent']?.slice(0, 80), method: req.method });
  if (origin && (CORS_ORIGIN === '*' || CORS_ORIGIN.split(',').includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function syncTenant(req: Request, _res: Response, next: () => void) {
  const tenant = (req as any).tenant as TenantContext | undefined;
  if (tenant) { db.tenantId = tenant.tenant_id; pgLog.ensureTenant(tenant.tenant_id, tenant.plan); }
  next();
}

const PORT = parseInt(process.env.PORT || '3737');
const DB_PATH = process.env.DB_PATH || './proxy.db';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const ORCHESTRATOR_URL = (process.env.ORCHESTRATOR_URL || '').replace(/\/+$/, '');

function buildApprovalUrl(requestId: string, approvalToken: string, req: any): string | undefined {
  const orchHeader = req.headers['x-orchestrator-url'] as string | undefined;
  const orchTenant = req.headers['x-tenant-id'] as string | undefined;
  if (orchHeader && orchTenant) return `${orchHeader}/t/${orchTenant}/approve/${requestId}?token=${approvalToken}`;
  if (ORCHESTRATOR_URL) return `${ORCHESTRATOR_URL}/approve/${requestId}?token=${approvalToken}`;
  if (PUBLIC_URL) return `${PUBLIC_URL}/approve/${requestId}?token=${approvalToken}`;
  return undefined;
}

const db = new ProxyDatabase(DB_PATH);

const secrets: Record<string, string> = db.getAllSecrets();
console.log(`🔑 Loaded ${Object.keys(secrets).length} secrets from database`);

// Helper: reconstruct permit request data from DB
function getPermitRequest(requestId: string): { permitId: string; description: string; secrets: string[]; networks: string[]; capabilities?: CapabilitySpec[]; draftedCapabilities?: CapabilityFunction[] } | null {
  const request = db.getRequest(requestId);
  if (!request || request.skill_url !== 'scope') return null;
  try {
    const code = db.getCode(requestId);
    if (!code) return null;
    const data = JSON.parse(code);
    const args = request.args ? JSON.parse(request.args) : {};
    return { permitId: args.sessionId || '', description: data.description || '', secrets: data.secrets || [], networks: data.networks || [], capabilities: data.capabilities, draftedCapabilities: data.draftedCapabilities };
  } catch { return null; }
}

// Discovery
app.get('/', (_req: Request, res: Response) => {
  res.type('text/markdown').send(`# OAuth3 Execution Proxy

TEE-sandboxed code execution with human-approved permits.
Your code runs in a Deno sandbox with access to secrets you don't hold directly.

## How It Works

1. **Request a permit** — describe what capabilities you need (API endpoints, secrets, networks).
2. **Human approves the permit** — they see the capability specs, not your code.
3. **Submit actions** under the permit — code + args, verified programmatically.
4. **System enforces** — AST static analysis checks your code only calls declared capabilities.

## Authentication

\`\`\`
POST /signup  {"name": "my-agent"}
→ { "tenant_id": "...", "token": "..." }
\`\`\`

Use on all requests: \`Authorization: Bearer <token>\`

## Quick Start

1. \`POST /signup\` to get a token
2. \`POST /permit\` with \`capabilities\` array → get \`approval_url\` + \`permit_id\`
3. Human approves at \`approval_url\`
4. \`POST /execute\` with \`{ action_id, code, args, permit_id }\` → auto-verified and executed
5. \`GET /execute/:id/status?wait=true\` → long-poll for result

\`\`\`
POST /permit  → { status: "pending_permit", approval_url, permit_id }
# Human approves
POST /execute → { status: "approved", request_id }
GET  /execute/:id/status?wait=true → { status: "completed", result: {...} }
\`\`\`

## Endpoints

### POST /permit — Request a Permit

\`\`\`json
{
  "description": "File issues on GitHub",
  "capabilities": [
    {
      "name": "github.createIssue",
      "doc_url": "https://docs.github.com/en/rest/issues/issues#create-an-issue",
      "endpoint": "https://api.github.com/repos/{owner}/{repo}/issues",
      "method": "POST",
      "auth": { "header": "Authorization", "value": "token {GH_TOKEN}" },
      "params": {
        "owner": { "in": "path", "constraint": { "type": "regex", "param": "owner", "pattern": "^amiller$", "rationale": "Only amiller repos" } },
        "repo": { "in": "path" },
        "title": { "in": "body" },
        "body": { "in": "body" }
      }
    }
  ]
}
\`\`\`

### POST /execute — Submit an Action

\`\`\`json
{
  "action_id": "create-issue",
  "code": "const r = await github.createIssue({owner:'amiller', repo:'test', title:args.title, body:args.body});\\nconsole.log(JSON.stringify(r));",
  "args": { "title": "Test issue", "body": "Created by agent" },
  "permit_id": "permit_abc123"
}
\`\`\`

Agent code calls capability functions (e.g. \`github.createIssue\`) — no direct \`fetch()\` or \`Deno.env.get()\` allowed.

### GET /execute/:id/status?wait=true — Poll for Result

Long-polls up to 120s. Returns on terminal status.

### Other Endpoints
- \`GET /sessions\` — list active permits
- \`GET /sessions/:id\` — permit detail
- \`DELETE /sessions/:id\` — revoke a permit
- \`POST /secrets\` — \`{ name, value }\`
- \`GET /secrets\` — list secret names (not values)
- \`GET /health\` — status check

## Available Secrets
${Object.keys(secrets).map(s => '- ' + s).join('\n') || '(none configured)'}

---
Public URL: ${PUBLIC_URL || '(not configured)'}
`);
});

app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));
app.post('/signup', handleSignup);

app.get('/dashboard', requireTenant, syncTenant, (req: Request, res: Response) => {
  const sessions = db.listSessions();
  const requests = db.listRecentRequests(30);
  res.json({ sessions, requests });
});

app.post('/secrets', requireTenant, syncTenant, (req: Request, res: Response) => {
  const { name, value } = req.body;
  if (!name || !value) return res.status(400).json({ error: 'Missing name or value' });
  secrets[name] = value;
  db.setSecret(name, value);
  res.json({ success: true, name });
});

app.get('/secrets', requireTenant, syncTenant, (_req: Request, res: Response) => {
  res.json({ secrets: Object.keys(secrets) });
});

app.delete('/secrets/:name', requireTenant, syncTenant, (req: Request, res: Response) => {
  const name = typeof req.params.name === 'string' ? req.params.name : req.params.name[0];
  if (!secrets[name]) return res.status(404).json({ error: 'Secret not found' });
  delete secrets[name];
  db.deleteSecret(name);
  res.json({ success: true, deleted: name });
});

app.get('/stats', (_req: Request, res: Response) => {
  res.json({ haiku_tokens: tokenUsage });
});

app.get('/sessions', requireTenant, syncTenant, (_req: Request, res: Response) => {
  const sessions = db.listSessions();
  res.json({
    sessions: sessions.map(s => ({
      permit_id: s.session_id,
      created_at: s.created_at,
      last_activity: s.last_activity,
      age_minutes: Math.round((Date.now() - s.created_at) / 60000),
      idle_minutes: Math.round((Date.now() - s.last_activity) / 60000),
      policy: s.policy
    }))
  });
});

app.get('/sessions/:id', requireTenant, syncTenant, (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const session = db.getSession(id);
  if (!session) return res.status(404).json({ error: 'Permit not found or expired' });
  res.json({
    permit_id: session.session_id,
    created_at: session.created_at,
    last_activity: session.last_activity,
    age_minutes: Math.round((Date.now() - session.created_at) / 60000),
    idle_minutes: Math.round((Date.now() - session.last_activity) / 60000),
    policy: session.policy
  });
});

app.delete('/sessions/:id', requireTenant, syncTenant, (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const session = db.getSession(id);
  if (!session) return res.status(404).json({ error: 'Permit not found or expired' });
  db.deleteSession(id);
  res.json({ deleted: true, permit_id: id });
});

// Approval details (JSON API)
app.get('/approve/:id', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const token = req.query.token as string;
  const request = db.getRequest(id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (!token || token !== request.approval_token) return res.status(403).json({ error: 'Invalid token' });

  const permitReq = getPermitRequest(id);
  const storedSecretNames = Object.keys(db.getAllSecrets());

  res.json({
    id,
    status: request.status,
    action_id: request.action_id,
    code_hash: request.code_hash,
    created_at: request.created_at,
    scope_request: permitReq ? {
      permit_id: permitReq.permitId,
      description: permitReq.description,
      secrets: permitReq.secrets,
      networks: permitReq.networks,
      missing_secrets: permitReq.secrets.filter(s => !storedSecretNames.includes(s)),
      capabilities: permitReq.capabilities,
      drafted_capabilities: permitReq.draftedCapabilities,
    } : undefined,
    result: request.result ? JSON.parse(request.result) : undefined,
    error: request.error,
  });
});

// Process approval (JSON API)
app.post('/approve/:id', async (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const { token, action, secrets: providedSecrets } = req.body;
  const request = db.getRequest(id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (!token || token !== request.approval_token) return res.status(403).json({ error: 'Invalid token' });
  if (request.status !== 'pending') return res.json({ id, status: request.status, message: 'Already processed' });

  if (action === 'deny') {
    db.updateRequestStatus(id, 'denied');
    notifyStatusWaiters(id);
    return res.json({ id, status: 'denied' });
  }

  // Store any secrets provided with the approval
  if (providedSecrets && typeof providedSecrets === 'object') {
    for (const [n, v] of Object.entries(providedSecrets)) {
      if (v) { secrets[n] = v as string; db.setSecret(n, v as string); }
    }
  }

  // Permit approval — create session with capabilities
  const permitReq = getPermitRequest(id);
  if (permitReq) {
    const existingSession = db.getSession(permitReq.permitId);
    if (existingSession) {
      const p = existingSession.policy;
      p.allowedSecrets = [...new Set([...p.allowedSecrets, ...permitReq.secrets])];
      p.allowedNetworks = [...new Set([...p.allowedNetworks, ...permitReq.networks])];
      if (permitReq.draftedCapabilities?.length) p.capabilities = [...(p.capabilities || []), ...permitReq.draftedCapabilities];
      db.updateSessionPolicy(permitReq.permitId, p);
    } else {
      const policy: SessionPolicy = {
        allowedSecrets: permitReq.secrets,
        allowedNetworks: permitReq.networks,
        description: permitReq.description,
        capabilities: permitReq.draftedCapabilities?.length ? permitReq.draftedCapabilities : undefined,
      };
      db.createSession(permitReq.permitId, policy);
    }

    db.addScopeGrant(permitReq.permitId, permitReq.description, [], permitReq.secrets, permitReq.networks);
    db.updateRequestStatus(id, 'completed');
    notifyStatusWaiters(id);
    console.log(`📋 Permit approved, session ${permitReq.permitId} ${existingSession ? 'expanded' : 'created'}`);
    return res.json({ id, status: 'completed', permit_id: permitReq.permitId, expanded: !!existingSession });
  }

  // Should not reach here in capabilities-only mode
  db.updateRequestStatus(id, 'denied');
  notifyStatusWaiters(id);
  res.json({ id, status: 'denied', error: 'Direct execution approval no longer supported' });
});

// Session activity feed
app.get('/session/:id/actions', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const token = req.query.token as string;
  if (!token) return res.status(401).json({ error: 'Token required' });
  const scopeReq = (() => {
    const requests = db.listRecentRequests(100);
    return requests.find((r: any) => r.skill_url === 'scope' && r.approval_token === token && r.args && JSON.parse(r.args).sessionId === id);
  })();
  if (!scopeReq) return res.status(403).json({ error: 'Invalid token for this session' });
  const requests = db.listRecentRequests(50);
  const actions = requests.filter((r: any) => {
    if (r.skill_url === 'scope') return false;
    try { const a = r.args ? JSON.parse(r.args) : {}; return a._permitId === id; } catch { return false; }
  }).map((r: any) => ({
    id: r.id, action_id: r.skill_id, status: r.status, created_at: r.created_at,
    result: r.result ? JSON.parse(r.result) : null, error: r.error,
  }));
  res.json({ permit_id: id, actions });
});

// POST /permit (was /scope)
app.post('/permit', requireTenant, syncTenant, async (req: Request, res: Response) => {
  try {
    const { permit_id: clientPermitId, description, capabilities: rawCapabilities } = req.body;
    if (!description) return res.status(400).json({ error: 'Missing description' });
    if (!Array.isArray(rawCapabilities) || !rawCapabilities.length) return res.status(400).json({ error: 'Missing capabilities array' });

    const permitId = clientPermitId || `permit_${randomBytes(8).toString('hex')}`;
    let secretsList: string[] = [];
    let networksList: string[] = [];

    // Validate specs, auto-derive secrets/networks, draft functions
    const capabilitySpecs: CapabilitySpec[] = [];
    const draftedCapabilities: CapabilityFunction[] = [];

    for (const raw of rawCapabilities) {
      const v = validateSpec(raw);
      if (!v.valid) return res.status(400).json({ error: `Invalid capability spec "${raw.name}": ${v.errors.join(', ')}` });
      capabilitySpecs.push(raw as CapabilitySpec);
      for (const s of extractSecrets(raw)) { if (!secretsList.includes(s)) secretsList.push(s) }
      for (const n of extractNetworks(raw)) { if (!networksList.includes(n)) networksList.push(n) }
    }

    // Draft capability functions (requires ANTHROPIC_API_KEY)
    for (const spec of capabilitySpecs) {
      const specH = hashSpec(spec);
      const cached = db.getCachedCapability(specH);
      let docDomain: string;
      try { docDomain = new URL(spec.doc_url).hostname } catch { docDomain = spec.doc_url }

      if (cached) {
        console.log(`  Capability ${spec.name}: using cached draft`);
        draftedCapabilities.push({ name: spec.name, spec, code: cached.code, hash: hashCode(cached.code), doc_domain: docDomain });
        continue;
      }

      try {
        console.log(`  Capability ${spec.name}: fetching docs from ${spec.doc_url}`);
        const docContent = await fetchDocContent(spec.doc_url);
        const draft = await draftCapability(spec, docContent);
        db.cacheCapability(specH, spec.name, spec, draft.code, docDomain);
        draftedCapabilities.push({ name: spec.name, spec, code: draft.code, hash: draft.hash, doc_domain: docDomain });
        console.log(`  Capability ${spec.name}: drafted (${draft.code.split('\n').length} lines)`);
      } catch (err: any) {
        console.error(`  Capability ${spec.name}: draft failed — ${err.message}`);
        return res.status(502).json({ error: `Failed to draft capability "${spec.name}": ${err.message}` });
      }
    }

    const requestId = `permit_${randomBytes(8).toString('hex')}`;
    const approvalToken = randomBytes(32).toString('hex');
    const scopeData = JSON.stringify({ description, secrets: secretsList, networks: networksList, capabilities: capabilitySpecs, draftedCapabilities });

    db.createRequest(requestId, 'permit-request', 'scope', hashCode(scopeData), secretsList, { sessionId: permitId, description }, approvalToken);
    db.storeCode(requestId, scopeData);

    const approvalUrl = buildApprovalUrl(requestId, approvalToken, req);
    const statusUrl = PUBLIC_URL ? `${PUBLIC_URL}/execute/${requestId}/status?wait=true` : undefined;

    res.json({
      request_id: requestId,
      status: 'pending_permit',
      permit_id: permitId,
      approval_url: approvalUrl,
      status_url: statusUrl,
      capabilities_drafted: capabilitySpecs.map(s => s.name),
      message: 'Permit request awaiting approval — poll status_url'
    });
  } catch (error: any) {
    console.error('Permit request error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Keep /scope as alias for backward compat
app.post('/scope', requireTenant, syncTenant, async (req: Request, res: Response) => {
  // Rewrite to /permit format
  const body = { ...req.body };
  if (body.session_id && !body.permit_id) body.permit_id = body.session_id;
  (req as any).body = body;
  // Forward to permit handler by re-dispatching (simple approach: inline the same logic)
  res.redirect(307, '/permit');
});

// POST /execute — capabilities-only
app.post('/execute', requireTenant, syncTenant, async (req: Request, res: Response) => {
  try {
    const { action_id, code, args, permit_id: permitId, dry_run } = req.body;
    // Backward compat: accept old field names
    const actionId = action_id || req.body.skill_id;
    const actionCode = code || req.body.skill_code;
    const effectivePermitId = permitId || req.body.session_id;

    if (!actionId) return res.status(400).json({ error: 'Missing action_id' });
    if (!actionCode) return res.status(400).json({ error: 'Missing code' });
    if (!effectivePermitId) return res.status(400).json({ error: 'Missing permit_id — request a permit first via POST /permit' });

    const session = db.getSession(effectivePermitId);
    if (!session) return res.status(404).json({ error: 'Permit not found or expired' });
    if (!session.policy.capabilities?.length) return res.status(400).json({ error: 'Permit has no capabilities — resubmit permit with capabilities array' });

    const codeHash = hashCode(actionCode);

    if (dry_run) return res.json({ dry_run: true, would_auto_approve: true, reason: 'capability_mode', permit_id: effectivePermitId });

    const requestId = `exec_${randomBytes(8).toString('hex')}`;
    const approvalToken = randomBytes(32).toString('hex');
    const secretsList = session.policy.allowedSecrets;
    db.createRequest(requestId, actionId, 'inline', codeHash, secretsList, { ...args, _permitId: effectivePermitId }, approvalToken);
    db.storeCode(requestId, actionCode);
    db.touchSession(effectivePermitId);

    // Verify agent code only calls declared capabilities
    const capNames = session.policy.capabilities.map(c => c.name);
    const verification = verifyCapabilityMode(actionCode, capNames);
    const enforcement: any = {
      mode: 'capability',
      verification,
      capabilities: session.policy.capabilities.map(c => ({
        name: c.name, doc_domain: c.doc_domain, summary: summarizeSpec(c.spec),
      })),
    };

    if (!verification.allPassed) {
      const failures = verification.checks.filter(c => !c.passed).map(c => `${c.name}: ${c.details || c.actual}`);
      console.log(`🚫 Capability verification failed for ${actionId}:`, failures);
      db.updateRequestResult(requestId, { success: false, enforcement }, `Capability verification failed: ${failures.join('; ')}`);
      return res.status(403).json({ request_id: requestId, status: 'denied', reason: 'capability_verification_failed', failures, enforcement });
    }

    db.updateRequestStatus(requestId, 'approved');
    const capDefs = session.policy.capabilities.map(c => c.code).join('\n\n');
    const execCode = capDefs + '\n\n// --- Agent code ---\n' + actionCode;
    executeInBackground(requestId, execCode, session.policy.allowedNetworks, secretsList, args, enforcement);
    const statusUrl = PUBLIC_URL ? `${PUBLIC_URL}/execute/${requestId}/status?wait=true` : undefined;
    return res.json({ request_id: requestId, status: 'approved', permit_id: effectivePermitId, status_url: statusUrl, message: 'Auto-approved (capability mode)' });
  } catch (error: any) {
    console.error('Execute error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Long-poll status
const statusWaiters = new Map<string, Array<() => void>>();

function notifyStatusWaiters(requestId: string) {
  const waiters = statusWaiters.get(requestId);
  if (waiters) { statusWaiters.delete(requestId); for (const resolve of waiters) resolve(); }
}

function buildStatusResponse(request: any): any {
  const r: any = { request_id: request.id, status: request.status, created_at: request.created_at };
  if (request.approved_at) r.approved_at = request.approved_at;
  if (request.executed_at) r.executed_at = request.executed_at;
  if (request.result) r.result = JSON.parse(request.result);
  if (request.error) r.error = request.error;
  if (request.skill_url === 'scope') {
    const args = request.args ? JSON.parse(request.args) : {};
    if (args.sessionId) r.permit_id = args.sessionId;
  }
  return r;
}

app.get('/execute/:id/status', async (req: Request, res: Response) => {
  const token = req.query.token as string;
  if (token) {
    const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
    const request = db.getRequest(id);
    if (request && request.approval_token === token) {
      (req as any)._tokenAuthed = true;
      return handleStatus(req, res);
    }
  }
  requireTenant(req, res, () => syncTenant(req, res, () => handleStatus(req, res)));
});

async function handleStatus(req: Request, res: Response) {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const request = db.getRequest(id);
  if (!request) return res.status(404).json({ error: 'Request not found' });

  const wantWait = req.query.wait === 'true' || req.query.wait === '1';
  const terminal = ['completed', 'failed', 'denied'];

  if (wantWait && !terminal.includes(request.status)) {
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 120_000);
      const entry = () => { clearTimeout(timeout); resolve(); };
      if (!statusWaiters.has(id)) statusWaiters.set(id, []);
      statusWaiters.get(id)!.push(entry);
    });
    const updated = db.getRequest(id);
    if (updated) return res.json(buildStatusResponse(updated));
  }

  res.json(buildStatusResponse(request));
}

// Background execution
async function executeInBackground(requestId: string, code: string, allowedNetworks: string[], requiredSecrets: string[], args?: Record<string, any>, enforcement?: any) {
  console.log(`\n🚀 Starting background execution for ${requestId}`);
  try {
    db.updateRequestStatus(requestId, 'executing');
    const dbRequest = db.getRequest(requestId);
    const execArgs = args || (dbRequest?.args ? JSON.parse(dbRequest.args) : {});

    const secretValues: Record<string, string> = {};
    const missingSecrets: string[] = [];
    for (const name of requiredSecrets) {
      if (!secrets[name]) missingSecrets.push(name);
      else secretValues[name] = secrets[name];
    }

    if (missingSecrets.length > 0) {
      console.log(`  Missing secrets: ${missingSecrets.join(', ')}`);
      db.updateRequestResult(requestId, null, `Missing secrets: ${missingSecrets.join(', ')}`);
      notifyStatusWaiters(requestId);
      return;
    }

    const result = await execute({ code, secrets: secretValues, args: execArgs, timeout: 30, allowedNetworks });
    console.log(`  Execution complete:`, result.success ? '✅' : '❌');

    const resultData: any = {
      success: result.success, stdout: result.stdout, stderr: result.stderr,
      exitCode: result.exitCode, duration: result.duration,
    };
    if (enforcement) {
      resultData.enforcement = {
        ...enforcement,
        sandbox: { allowNet: allowedNetworks, allowEnv: [...requiredSecrets, ...Object.keys(execArgs).filter(k => !k.startsWith('_'))] },
        runtime: { exitCode: result.exitCode, duration: result.duration },
      };
    }
    db.updateRequestResult(requestId, resultData, result.success ? undefined : result.stderr);
    notifyStatusWaiters(requestId);
  } catch (error: any) {
    console.error(`❌ Execution failed for ${requestId}:`, error.message);
    db.updateRequestResult(requestId, null, error.message);
    notifyStatusWaiters(requestId);
  }
}

// JSON 404
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found', hint: 'GET / for API documentation' });
});

setInterval(() => db.cleanupExpired(), 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Execution Proxy running on port ${PORT}`);
  console.log(`📊 Database: ${DB_PATH}`);
  console.log(`⚙️  Executor: ${EXECUTOR_MODE} mode`);
  console.log(`🔗 Public URL: ${PUBLIC_URL || '(not set)'}`);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
