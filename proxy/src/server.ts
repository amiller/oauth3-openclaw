/**
 * HTTP API Server for Execution Proxy
 * Capabilities-only execution path: permit → action
 */

import './ses-init.js';
import 'dotenv/config';
import express, { Request, Response } from 'express';
import { ProxyDatabase, SessionPolicy } from './database.js';
import { execute, hashCode } from './executor.js';
import { CapabilitySpec, CapabilityFunction, hashSpec, tokenUsage, getPlugin } from './capability.js';
import { requireTenant, requireOwner, handleSignup, TenantContext, verifyTokenDirect } from './auth.js';
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

// Helper: reconstruct permit request data from DB
function getPermitRequest(requestId: string): { permitId: string; description: string; secrets: string[]; networks: string[]; capabilities?: CapabilitySpec[]; draftedCapabilities?: CapabilityFunction[]; agentId?: string } | null {
  const request = db.getRequest(requestId);
  if (!request || request.skill_url !== 'scope') return null;
  try {
    const code = db.getCode(requestId);
    if (!code) return null;
    const data = JSON.parse(code);
    const args = request.args ? JSON.parse(request.args) : {};
    return { permitId: args.sessionId || '', description: data.description || '', secrets: data.secrets || [], networks: data.networks || [], capabilities: data.capabilities, draftedCapabilities: data.draftedCapabilities, agentId: data.agentId };
  } catch { return null; }
}

// Discovery
app.get('/', (_req: Request, res: Response) => {
  res.type('text/markdown').send(`# OAuth3 Execution Proxy

TEE-sandboxed code execution with human-approved permits.
Your code runs in a SES Compartment with only the capability functions you were granted.

## How It Works

1. **Request a permit** — describe what capabilities you need (API endpoints, secrets, networks).
2. **Human approves the permit** — they see the capability specs, not your code.
3. **Submit actions** under the permit — code runs in a SES Compartment with only declared capabilities as endowments.

## Authentication

\`\`\`
POST /signup  {"name": "my-agent"}
→ { "tenant_id": "...", "token": "..." }
\`\`\`

Use on all requests: \`Authorization: Bearer <token>\`

## Quick Start

1. \`POST /signup\` to get a token
2. \`POST /permit\` with \`capabilities\` array → get \`approval_url\`, \`permit_id\`, \`status_url\`
3. **Poll \`status_url\`** (long-poll, blocks up to 120s) — wait until status is \`"completed"\` (approved)
4. \`POST /execute\` with \`{ action_id, code, args, permit_id }\` → get \`status_url\`
5. **Poll \`status_url\`** again — wait until execution finishes

\`\`\`
POST /permit  → { status: "pending_permit", approval_url, permit_id, status_url }
GET  status_url?wait=true  → blocks until → { status: "completed", permit_id }
POST /execute → { status: "approved", request_id, status_url }
GET  status_url?wait=true  → blocks until → { status: "completed", result: {...} }
\`\`\`

**IMPORTANT**:
- Always use the \`status_url\` from the response to poll — it already includes \`?wait=true\`. Do NOT append query params.
- Do NOT poll \`/sessions/:id\` — that returns permit policy, not approval status.
- \`status_url\` long-polls (blocks up to 120s). Just \`fetch(status_url)\` in a loop.

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

The permit response includes a \`capabilities[].signature\` field showing the exact function available in the sandbox.
For example, a capability named \`github.createIssue\` generates: \`async function createIssue(owner, repo, title, body)\`

\`\`\`json
{
  "action_id": "create-issue",
  "code": "const r = await createIssue(args.owner, args.repo, args.title, args.body);\\nconsole.log(JSON.stringify(r));",
  "args": { "owner": "amiller", "repo": "test", "title": "Test issue", "body": "Created by agent" },
  "permit_id": "permit_abc123"
}
\`\`\`

The SES Compartment endows: capability functions (from \`signature\`), \`args\` object, and \`console\`. No \`fetch()\`, no \`Deno.env\` — use the generated functions.

### GET /execute/:id/status?wait=true — Poll for Result

Long-polls up to 120s. Returns immediately if already in a terminal state (\`completed\`, \`failed\`, \`denied\`).
Use this for BOTH permit approval polling and execution result polling — the \`status_url\` from \`/permit\` and \`/execute\` responses points here.

Response: \`{ request_id, status, permit_id?, result?, error? }\`

### Other Endpoints
- \`GET /sessions\` — list active permits (policy details, not approval status)
- \`GET /sessions/:id\` — permit policy detail
- \`GET /session/:id/actions\` — list actions under a permit (Bearer auth)
- \`DELETE /sessions/:id\` — revoke a permit
- \`POST /secrets\` — \`{ name, value }\` (owner only)
- \`GET /secrets\` — list secret names (not values)
- \`GET /health\` — status check

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

app.post('/secrets', requireTenant, syncTenant, requireOwner, (req: Request, res: Response) => {
  const { name, value } = req.body;
  const tenant = (req as any).tenant as TenantContext;
  if (!name || !value) return res.status(400).json({ error: 'Missing name or value' });
  db.setSecret(name, value, tenant.tenant_id);
  res.json({ success: true, name });
});

app.get('/secrets', requireTenant, syncTenant, requireOwner, (req: Request, res: Response) => {
  const tenant = (req as any).tenant as TenantContext;
  res.json({ secrets: db.getSecretNamesByOwner(tenant.tenant_id) });
});

app.delete('/secrets/:name', requireTenant, syncTenant, requireOwner, (req: Request, res: Response) => {
  const tenant = (req as any).tenant as TenantContext;
  const name = typeof req.params.name === 'string' ? req.params.name : req.params.name[0];
  const existing = db.getSecretNamesByOwner(tenant.tenant_id);
  if (!existing.includes(name)) return res.status(404).json({ error: 'Secret not found' });
  db.deleteSecret(name, tenant.tenant_id);
  res.json({ success: true, deleted: name });
});

app.get('/stats', (_req: Request, res: Response) => {
  res.json({ haiku_tokens: tokenUsage });
});

app.get('/sessions', requireTenant, syncTenant, (req: Request, res: Response) => {
  const tenant = (req as any).tenant as TenantContext;
  const sessions = db.listSessions();
  const filtered = sessions.filter(s => {
    if (tenant.role === 'owner') return s.owner_id === tenant.tenant_id;
    return s.agent_id === tenant.tenant_id;
  });
  res.json({
    sessions: filtered.map(s => ({
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

  // If owner token provided, check which secrets they already have
  let ownerSecretNames: string[] = [];
  const ownerAuth = req.query.owner_token as string || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (ownerAuth) {
    const owner = verifyTokenDirect(ownerAuth);
    if (owner?.role === 'owner') ownerSecretNames = db.getSecretNamesByOwner(owner.tenant_id);
  }

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
      missing_secrets: permitReq.secrets.filter(s => !ownerSecretNames.includes(s)),
      capabilities: permitReq.capabilities,
      drafted_capabilities: permitReq.draftedCapabilities,
    } : undefined,
    result: request.result ? JSON.parse(request.result) : undefined,
    error: request.error,
  });
});

// Process approval (JSON API) — requires owner JWT
app.post('/approve/:id', async (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const { token, action, secrets: providedSecrets, owner_token } = req.body;
  const request = db.getRequest(id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (!token || token !== request.approval_token) return res.status(403).json({ error: 'Invalid token' });
  if (request.status !== 'pending') return res.json({ id, status: request.status, message: 'Already processed' });

  // Authenticate the owner
  let ownerTenant: TenantContext | null = null;
  const authHeader = req.headers.authorization;
  if (authHeader) ownerTenant = verifyTokenDirect(authHeader.replace(/^Bearer\s+/i, ''));
  if (!ownerTenant && owner_token) ownerTenant = verifyTokenDirect(owner_token);
  if (!ownerTenant) return res.status(401).json({ error: 'Owner authentication required — provide owner_token in body or Authorization header' });
  if (ownerTenant.role !== 'owner') return res.status(403).json({ error: 'Only owner role can approve permits' });

  if (action === 'deny') {
    db.updateRequestStatus(id, 'denied');
    notifyStatusWaiters(id);
    return res.json({ id, status: 'denied' });
  }

  const ownerId = ownerTenant.tenant_id;

  // Store any secrets provided with the approval (scoped to this owner)
  if (providedSecrets && typeof providedSecrets === 'object') {
    for (const [n, v] of Object.entries(providedSecrets)) {
      if (v) db.setSecret(n, v as string, ownerId);
    }
  }

  // Permit approval — create session with capabilities
  const permitReq = getPermitRequest(id);
  if (permitReq) {
    const agentId = permitReq.agentId;
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
      db.createSession(permitReq.permitId, policy, agentId, ownerId);
    }

    db.addScopeGrant(permitReq.permitId, permitReq.description, [], permitReq.secrets, permitReq.networks);
    db.updateRequestStatus(id, 'completed');
    notifyStatusWaiters(id);
    console.log(`📋 Permit approved by owner ${ownerId}, session ${permitReq.permitId} ${existingSession ? 'expanded' : 'created'}`);
    return res.json({ id, status: 'completed', permit_id: permitReq.permitId, expanded: !!existingSession });
  }

  db.updateRequestStatus(id, 'denied');
  notifyStatusWaiters(id);
  res.json({ id, status: 'denied', error: 'Direct execution approval no longer supported' });
});

// Session activity feed
app.get('/session/:id/actions', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const token = req.query.token as string;
  const auth = req.headers.authorization;

  // Auth: approval_token query param OR Bearer JWT (agent/owner of session)
  if (token) {
    const scopeReq = (() => {
      const requests = db.listRecentRequests(100);
      return requests.find((r: any) => r.skill_url === 'scope' && r.approval_token === token && r.args && JSON.parse(r.args).sessionId === id);
    })();
    if (!scopeReq) return res.status(403).json({ error: 'Invalid token for this session' });
  } else if (auth) {
    const jwt = auth.replace(/^Bearer\s+/i, '');
    const tenant = verifyTokenDirect(jwt);
    if (!tenant) return res.status(401).json({ error: 'Invalid token' });
    const session = db.getSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.agent_id !== tenant.tenant_id && session.owner_id !== tenant.tenant_id)
      return res.status(403).json({ error: 'Not authorized for this session' });
  } else {
    return res.status(401).json({ error: 'Token required (query param or Authorization header)' });
  }
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
    const { permit_id: clientPermitId, description, capabilities: rawCapabilities, networks: extraNetworks } = req.body;
    if (!description) return res.status(400).json({ error: 'Missing description' });
    if (!Array.isArray(rawCapabilities) || !rawCapabilities.length) return res.status(400).json({ error: 'Missing capabilities array' });

    const permitId = clientPermitId || `permit_${randomBytes(8).toString('hex')}`;
    let secretsList: string[] = [];
    let networksList: string[] = Array.isArray(extraNetworks) ? [...extraNetworks] : [];

    // Validate specs via plugins, auto-derive secrets/networks, generate code
    const capabilitySpecs: CapabilitySpec[] = [];
    const draftedCapabilities: CapabilityFunction[] = [];

    for (const raw of rawCapabilities) {
      const pluginType = raw.type || 'api-gateway';
      const plugin = getPlugin(pluginType);
      if (!plugin) return res.status(400).json({ error: `Unknown capability type: ${pluginType}` });

      const v = plugin.validateSpec(raw);
      if (!v.valid) return res.status(400).json({ error: `Invalid capability spec "${raw.name}": ${v.errors.join(', ')}` });
      capabilitySpecs.push(raw as CapabilitySpec);
      for (const s of plugin.extractSecrets(raw)) { if (!secretsList.includes(s)) secretsList.push(s) }
      for (const n of plugin.extractNetworks(raw)) { if (!networksList.includes(n)) networksList.push(n) }

      const specH = hashSpec(raw);
      const cached = db.getCachedCapability(specH);
      let docDomain: string;
      try { docDomain = new URL(raw.doc_url).hostname } catch { docDomain = raw.doc_url }

      if (cached) {
        console.log(`  Capability ${raw.name}: using cached`);
        draftedCapabilities.push({ name: raw.name, spec: raw, code: cached.code, hash: hashCode(cached.code), doc_domain: docDomain, signature: cached.signature || undefined });
        continue;
      }

      try {
        const result = await plugin.codegen(raw);
        db.cacheCapability(specH, raw.name, raw, result.code, docDomain, result.signature);
        draftedCapabilities.push({ name: raw.name, spec: raw, code: result.code, hash: hashCode(result.code), doc_domain: docDomain, signature: result.signature });
        console.log(`  Capability ${raw.name}: generated (${result.code.split('\n').length} lines)`);
      } catch (err: any) {
        console.error(`  Capability ${raw.name}: codegen failed — ${err.message}`);
        return res.status(502).json({ error: `Failed to generate capability "${raw.name}": ${err.message}` });
      }
    }

    const requestId = `permit_${randomBytes(8).toString('hex')}`;
    const approvalToken = randomBytes(32).toString('hex');
    const tenant = (req as any).tenant as TenantContext;
    const scopeData = JSON.stringify({ description, secrets: secretsList, networks: networksList, capabilities: capabilitySpecs, draftedCapabilities, agentId: tenant.tenant_id });

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
      capabilities: draftedCapabilities.map(c => ({ name: c.name, signature: c.signature })),
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

    const tenant = (req as any).tenant as TenantContext;
    const session = db.getSession(effectivePermitId);
    if (!session) return res.status(404).json({ error: 'Permit not found or expired' });
    if (!session.policy.capabilities?.length) return res.status(400).json({ error: 'Permit has no capabilities — resubmit permit with capabilities array' });

    // Verify agent owns this session
    if (session.agent_id && session.agent_id !== tenant.tenant_id) return res.status(403).json({ error: 'This permit belongs to a different agent' });

    const codeHash = hashCode(actionCode);

    if (dry_run) return res.json({ dry_run: true, would_auto_approve: true, reason: 'capability_mode', permit_id: effectivePermitId });

    const requestId = `exec_${randomBytes(8).toString('hex')}`;
    const approvalToken = randomBytes(32).toString('hex');
    const secretsList = session.policy.allowedSecrets;
    db.createRequest(requestId, actionId, 'inline', codeHash, secretsList, { ...args, _permitId: effectivePermitId }, approvalToken);
    db.storeCode(requestId, actionCode);
    db.touchSession(effectivePermitId);

    const enforcement: any = {
      mode: 'capability',
      capabilities: session.policy.capabilities.map(c => ({
        name: c.name, doc_domain: c.doc_domain, signature: c.signature,
      })),
    };

    // Rebuild endowments from specs (endowments are functions, not serializable)
    const caps = await Promise.all(session.policy.capabilities.map(async (c) => {
      const plugin = getPlugin(c.spec?.type || 'api-gateway');
      if (!plugin || !c.spec) return c;
      const result = await plugin.codegen(c.spec);
      return { ...c, endowment: result.endowment };
    }));

    db.updateRequestStatus(requestId, 'approved');
    executeInBackground(requestId, actionCode, caps, secretsList, session.owner_id, args, enforcement);
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

  const wantWait = String(req.query.wait || '').startsWith('true') || req.query.wait === '1';
  const maxWait = Math.min(parseInt(req.query.timeout as string) || 600_000, 600_000); // default 10min, max 10min
  const terminal = ['completed', 'failed', 'denied'];

  if (wantWait && !terminal.includes(request.status)) {
    const deadline = Date.now() + maxWait;
    while (Date.now() < deadline) {
      const wait = Math.min(120_000, deadline - Date.now());
      if (wait <= 0) break;
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, wait);
        const entry = () => { clearTimeout(timeout); resolve(); };
        if (!statusWaiters.has(id)) statusWaiters.set(id, []);
        statusWaiters.get(id)!.push(entry);
      });
      const updated = db.getRequest(id);
      if (updated && terminal.includes(updated.status)) return res.json(buildStatusResponse(updated));
    }
  }

  const latest = db.getRequest(id);
  res.json(buildStatusResponse(latest || request));
}

// Background execution
async function executeInBackground(requestId: string, code: string, capabilities: CapabilityFunction[], requiredSecrets: string[], ownerId: string | null, args?: Record<string, any>, enforcement?: any) {
  console.log(`\n🚀 Starting background execution for ${requestId}`);
  try {
    db.updateRequestStatus(requestId, 'executing');
    const dbRequest = db.getRequest(requestId);
    const execArgs = args || (dbRequest?.args ? JSON.parse(dbRequest.args) : {});

    const ownerSecrets = ownerId ? db.getSecretsByOwner(ownerId) : {};
    const secretValues: Record<string, string> = {};
    const missingSecrets: string[] = [];
    for (const name of requiredSecrets) {
      if (ownerSecrets[name]) secretValues[name] = ownerSecrets[name];
      else missingSecrets.push(name);
    }

    if (missingSecrets.length > 0) {
      console.log(`  Missing secrets: ${missingSecrets.join(', ')}`);
      db.updateRequestResult(requestId, null, `Missing secrets: ${missingSecrets.join(', ')}`);
      notifyStatusWaiters(requestId);
      return;
    }

    const result = await execute({ code, secrets: secretValues, args: execArgs, timeout: 30, capabilities });
    console.log(`  Execution complete:`, result.success ? '✅' : '❌');

    const resultData: any = {
      success: result.success, stdout: result.stdout, stderr: result.stderr,
      exitCode: result.exitCode, duration: result.duration,
    };
    if (enforcement) {
      resultData.enforcement = {
        ...enforcement,
        sandbox: { type: 'ses-compartment', endowments: capabilities.map(c => c.name) },
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
  console.log(`⚙️  Executor: SES Compartment`);
  console.log(`🔗 Public URL: ${PUBLIC_URL || '(not set)'}`);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
