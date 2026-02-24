/**
 * HTTP API Server for Execution Proxy
 * Capabilities-only execution path: permit → action
 */

import './ses-init.js';
import 'dotenv/config';
import express, { Request, Response } from 'express';
import { ProxyDatabase, SessionPolicy } from './database.js';
import { execute, hashCode } from './executor.js';
import { CapabilitySpec, CapabilityFunction, hashSpec, tokenUsage, getPlugin, allPlugins } from './capability.js';
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
function getPermitRequest(requestId: string): { permitId: string; description: string; secrets: string[]; networks: string[]; capabilities?: CapabilitySpec[]; draftedCapabilities?: CapabilityFunction[]; agentId?: string; intent?: any[] } | null {
  const request = db.getRequest(requestId);
  if (!request || request.skill_url !== 'scope') return null;
  try {
    const code = db.getCode(requestId);
    if (!code) return null;
    const data = JSON.parse(code);
    const args = request.args ? JSON.parse(request.args) : {};
    return { permitId: args.sessionId || '', description: data.description || '', secrets: data.secrets || [], networks: data.networks || [], capabilities: data.capabilities, draftedCapabilities: data.draftedCapabilities, agentId: data.agentId, intent: data.intent };
  } catch { return null; }
}

// Discovery
app.get('/', (_req: Request, res: Response) => {
  const orchUrl = ORCHESTRATOR_URL || undefined;
  res.json({
    name: 'oauth3-tee',
    description: 'TEE-sandboxed code execution with human-approved capabilities',
    docs: orchUrl ? `${orchUrl}/tee-docs` : 'See orchestrator /tee-docs for full documentation',
    important: 'Read docs URL above before making API calls.',
    quick_start: {
      '1_signup': 'POST /signup {name: "my-agent"} → {token}',
      '2_permit': 'POST /permit {description: "...", intent: [{name: "github", goal: "Create issues on owner/repo", doc_urls: ["https://docs.github.com/en/rest/issues"], secret_hints: ["GITHUB_TOKEN"]}]} → {approval_url, status_url, permit_id}',
      '3_wait': 'Present approval_url to human, poll status_url until status=completed',
      '4_execute': 'POST /execute {permit_id, action_id: "do-thing", code: "const r = await github(\'GET\', \'/repos/o/r/issues\'); console.log(JSON.stringify(r));"}',
    },
    available_plugins: allPlugins().map(p => ({ type: p.type, description: p.describe().description })),
    endpoints: {
      signup: 'POST /signup',
      plugins: 'GET /plugins',
      permit: 'POST /permit — send intent[] for LLM-drafted policy (recommended) or capabilities[] for direct specs',
      draft: 'POST /draft — preview LLM-drafted policy without creating permit',
      execute: 'POST /execute',
      status: 'GET /execute/:id/status?wait=true',
      sessions: 'GET /sessions',
      secrets: 'POST /secrets',
      health: 'GET /health',
    },
    public_url: PUBLIC_URL || undefined,
  });
});

app.get('/plugins', (_req: Request, res: Response) => {
  res.json({ plugins: allPlugins().map(p => p.describe()) });
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

app.post('/cookies/upload', requireTenant, syncTenant, requireOwner, (req: Request, res: Response) => {
  const { domain, cookies, user_agent } = req.body;
  const tenant = (req as any).tenant as TenantContext;
  if (!domain || !Array.isArray(cookies)) return res.status(400).json({ error: 'Missing domain or cookies array' });
  const secretName = `COOKIES_${domain.replace(/^www\./, '').replace(/\./g, '_').toUpperCase()}`;
  db.setSecret(secretName, JSON.stringify({ cookies, user_agent: user_agent || '' }), tenant.tenant_id);
  res.json({ success: true, secret_name: secretName });
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
      intent: permitReq.intent,
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

// POST /draft — LLM policy drafting from intent + doc URLs
app.post('/draft', requireTenant, syncTenant, async (req: Request, res: Response) => {
  const { intent, doc_urls, secrets: secretHints } = req.body;
  if (!intent) return res.status(400).json({ error: 'Missing intent' });
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'LLM drafting not configured (no ANTHROPIC_API_KEY)' });

  // Fetch doc content (truncated)
  let docContent = '';
  for (const url of (doc_urls || []).slice(0, 3)) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'oauth3-tee/1.0' }, signal: AbortSignal.timeout(10000) });
      if (r.ok) docContent += `\n--- ${url} ---\n${(await r.text()).slice(0, 8000)}\n`;
    } catch {}
  }

  const plugin = getPlugin('scoped-fetch')!;
  const schema = JSON.stringify(plugin.describe().spec_schema, null, 2);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
      system: `You are a security policy drafter inside a TEE. Given the user's intent and optional API docs, draft a minimal scoped-fetch capability spec. Respond with ONLY a JSON object.\n\nSchema fields:\n${schema}\n\nRules:\n- Use the narrowest scope globs possible\n- Only include write methods if the goal requires mutation\n- Use body_schema.allow_keys to restrict request bodies to only needed fields\n- Add rate_limit if appropriate\n- Do NOT use response_filter — that is for owners to configure manually\n- Reference secrets as {SECRET_NAME} in auth.value`,
      messages: [{ role: 'user', content: `Intent: ${intent}\n${secretHints?.length ? `Available secrets: ${secretHints.join(', ')}` : ''}\n${docContent ? `API documentation:\n${docContent}` : ''}` }],
    }),
  });
  if (!r.ok) return res.status(502).json({ error: `LLM API error: ${r.status}` });
  const llmRes = await r.json() as any;
  const text = llmRes.content?.[0]?.text || '';

  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return res.status(502).json({ error: 'LLM did not return valid JSON', raw: text });

  try {
    const drafted = JSON.parse(jsonMatch[0]);
    drafted.type = 'scoped-fetch';
    const plugin = getPlugin('scoped-fetch')!;
    const v = plugin.validateSpec(drafted);
    if (!v.valid) return res.json({ drafted_capabilities: [drafted], validation_errors: v.errors, rationale: text });
    res.json({ drafted_capabilities: [drafted], rationale: text.replace(jsonMatch[0], '').trim() || undefined });
  } catch (e: any) {
    res.status(502).json({ error: 'Failed to parse LLM JSON', raw: text });
  }
});

// Draft a single intent item into a scoped-fetch spec via LLM
async function draftIntent(item: { name: string; goal: string; doc_urls?: string[]; secret_hints?: string[] }): Promise<any> {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) throw new Error('LLM drafting not configured (no ANTHROPIC_API_KEY)');

  let docContent = '';
  for (const url of (item.doc_urls || []).slice(0, 3)) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'oauth3-tee/1.0' }, signal: AbortSignal.timeout(10000) });
      if (r.ok) docContent += `\n--- ${url} ---\n${(await r.text()).slice(0, 8000)}\n`;
    } catch {}
  }

  const plugin = getPlugin('scoped-fetch')!;
  const schema = JSON.stringify(plugin.describe().spec_schema, null, 2);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
      system: `You are a security policy drafter inside a TEE. Given the user's goal and optional API docs, draft a minimal scoped-fetch capability spec. Respond with ONLY a JSON object.\n\nSchema fields:\n${schema}\n\nRules:\n- Use the narrowest scope globs possible\n- Only include write methods (POST/PUT/PATCH/DELETE) if the goal requires mutation\n- Use body_schema.allow_keys to restrict request bodies to only needed fields\n- Add rate_limit if the goal doesn't require high throughput\n- Do NOT use response_filter — that is for owners to configure manually\n- Reference secrets as {SECRET_NAME} in auth.value`,
      messages: [{ role: 'user', content: `Goal: ${item.goal}\nName: ${item.name}\n${item.secret_hints?.length ? `Available secrets: ${item.secret_hints.join(', ')}` : ''}\n${docContent ? `API documentation:\n${docContent}` : ''}` }],
    }),
  });
  if (!r.ok) throw new Error(`LLM API error: ${r.status}`);
  const llmRes = await r.json() as any;
  const text = llmRes.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('LLM did not return valid JSON');
  const drafted = JSON.parse(jsonMatch[0]);
  drafted.type = 'scoped-fetch';
  drafted.drafted_by = 'tee';
  return drafted;
}

// POST /permit (was /scope)
app.post('/permit', requireTenant, syncTenant, async (req: Request, res: Response) => {
  try {
    let { permit_id: clientPermitId, description, capabilities: rawCapabilities, networks: extraNetworks, intent } = req.body;
    if (!description) return res.status(400).json({ error: 'Missing description' });

    // Intent-based flow: draft capabilities from intent array
    if (Array.isArray(intent) && intent.length && !rawCapabilities) {
      try {
        rawCapabilities = await Promise.all(intent.map(draftIntent));
      } catch (e: any) {
        return res.status(502).json({ error: `Intent drafting failed: ${e.message}` });
      }
    }

    if (!Array.isArray(rawCapabilities) || !rawCapabilities.length) return res.status(400).json({ error: 'Missing capabilities array (or provide intent array for LLM drafting)' });

    const permitId = clientPermitId || `permit_${randomBytes(8).toString('hex')}`;
    let secretsList: string[] = [];
    let networksList: string[] = Array.isArray(extraNetworks) ? [...extraNetworks] : [];

    // Validate specs via plugins, auto-derive secrets/networks, generate code
    const capabilitySpecs: CapabilitySpec[] = [];
    const draftedCapabilities: CapabilityFunction[] = [];

    for (const raw of rawCapabilities) {
      const pluginType = raw.type || 'api-gateway';
      if (pluginType === 'api-gateway' || pluginType === 'cookie-session')
        console.warn(`⚠️  Plugin "${pluginType}" is deprecated — use scoped-fetch instead`);
      const plugin = getPlugin(pluginType);
      if (!plugin) {
        const available = allPlugins().map(p => p.type)
        return res.status(400).json({ error: `Unknown capability type: "${pluginType}". Available types: ${available.join(', ')}. Call GET /plugins for details.` })
      }

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
    const scopeData = JSON.stringify({ description, secrets: secretsList, networks: networksList, capabilities: capabilitySpecs, draftedCapabilities, agentId: tenant.tenant_id, intent: intent || undefined });

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
    // Single 50s wait — must respond before nginx 60s gateway timeout.
    // Client should retry fetch(status_url) in a loop until status is terminal.
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 50_000);
      const entry = () => { clearTimeout(timeout); resolve(); };
      if (!statusWaiters.has(id)) statusWaiters.set(id, []);
      statusWaiters.get(id)!.push(entry);
    });
  }

  const latest = db.getRequest(id);
  res.json(buildStatusResponse(latest || request));
}

// Raw stdout endpoint — no JSON wrapping, streamable, avoids client response size limits
app.get('/execute/:id/stdout', (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
  const token = req.query.token as string;
  const auth = req.headers.authorization;

  // Auth: token query param or Bearer JWT
  if (token) {
    const request = db.getRequest(id);
    if (!request || request.approval_token !== token) return res.status(403).json({ error: 'Invalid token' });
  } else if (auth) {
    const tenant = verifyTokenDirect(auth.replace(/^Bearer\s+/i, ''));
    if (!tenant) return res.status(401).json({ error: 'Invalid token' });
  } else {
    return res.status(401).json({ error: 'Auth required' });
  }

  const request = db.getRequest(id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (!request.result) return res.status(202).json({ status: request.status, message: 'Not yet complete' });

  const result = JSON.parse(request.result);
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('X-Exit-Code', String(result.exitCode ?? ''));
  res.setHeader('X-Duration-Ms', String(result.duration ?? ''));
  res.setHeader('X-Success', String(result.success ?? ''));
  res.send(result.stdout || '');
});

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
  const orchUrl = ORCHESTRATOR_URL || undefined;
  res.status(404).json({ error: 'Not found', docs: orchUrl ? `${orchUrl}/tee-docs` : 'GET / for endpoints' });
});

setInterval(() => db.cleanupExpired(), 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Execution Proxy running on port ${PORT}`);
  console.log(`📊 Database: ${DB_PATH}`);
  console.log(`⚙️  Executor: SES Compartment`);
  console.log(`🔗 Public URL: ${PUBLIC_URL || '(not set)'}`);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
