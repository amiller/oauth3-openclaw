import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'crypto'

export type PolicyConstraint =
  | { type: 'regex', param: string, pattern: string, rationale: string }
  | { type: 'predicate', param: string, op: '>=' | '<=' | '==' | '!=' | 'in' | 'prefix' | 'suffix', value: any, rationale: string }
  | { type: 'natural_language', rule: string, rationale: string }

// Token usage tracking (moved from analyzer.ts)
export const tokenUsage = { calls: 0, inputTokens: 0, outputTokens: 0 }

export interface CapabilitySpec {
  name: string
  doc_url: string
  endpoint: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  auth?: { header: string; value: string }
  params: Record<string, {
    in: 'path' | 'body' | 'query'
    constraint?: PolicyConstraint
  }>
  rpc_method?: string
  rpc_wrap?: boolean
  response?: 'json' | 'text'
}

export interface CapabilityFunction {
  name: string
  spec: CapabilitySpec
  code: string
  hash: string
  doc_domain: string
}

export function validateSpec(spec: any): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!spec || typeof spec !== 'object') return { valid: false, errors: ['spec must be an object'] }
  if (typeof spec.name !== 'string' || !spec.name) errors.push('name required')
  if (typeof spec.doc_url !== 'string' || !spec.doc_url) errors.push('doc_url required')
  if (typeof spec.endpoint !== 'string' || !spec.endpoint) errors.push('endpoint required')
  if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(spec.method)) errors.push('method must be GET/POST/PUT/DELETE/PATCH')
  if (!spec.params || typeof spec.params !== 'object') errors.push('params required')

  // No freeform text fields that could inject
  if (spec.name && /[^a-zA-Z0-9._-]/.test(spec.name)) errors.push('name must be alphanumeric/dots/dashes')
  try { new URL(spec.doc_url) } catch { errors.push('doc_url must be a valid URL') }
  try { new URL(spec.endpoint.replace(/\{[^}]+\}/g, 'x')) } catch { errors.push('endpoint must be a valid URL template') }

  if (spec.auth) {
    if (typeof spec.auth.header !== 'string') errors.push('auth.header must be string')
    if (typeof spec.auth.value !== 'string') errors.push('auth.value must be string')
  }

  if (spec.params && typeof spec.params === 'object') {
    for (const [k, v] of Object.entries(spec.params) as [string, any][]) {
      if (!['path', 'body', 'query'].includes(v?.in)) errors.push(`params.${k}.in must be path/body/query`)
    }
  }

  return { valid: errors.length === 0, errors }
}

export function extractSecrets(spec: CapabilitySpec): string[] {
  if (!spec.auth?.value) return []
  const matches = spec.auth.value.matchAll(/\{([A-Z_][A-Z0-9_]*)\}/g)
  return [...new Set([...matches].map(m => m[1]))]
}

export function extractNetworks(spec: CapabilitySpec): string[] {
  try {
    const url = new URL(spec.endpoint.replace(/\{[^}]+\}/g, 'x'))
    return [url.hostname]
  } catch { return [] }
}

export function summarizeSpec(spec: CapabilitySpec): string {
  const domain = (() => { try { return new URL(spec.doc_url).hostname } catch { return spec.doc_url } })()
  const secrets = extractSecrets(spec)
  const constraints = Object.entries(spec.params)
    .filter(([, v]) => v.constraint)
    .map(([k, v]) => {
      const c = v.constraint!
      if (c.type === 'regex') return `${k} matches /${c.pattern}/`
      if (c.type === 'predicate') return `${k} ${c.op} ${JSON.stringify(c.value)}`
      return `${k}: ${(c as any).rule}`
    })
  const parts = [
    `${spec.method} ${spec.endpoint}`,
    constraints.length ? `constrained: ${constraints.join(', ')}` : null,
    secrets.length ? `uses ${secrets.join(', ')}` : null,
    `docs: ${domain}`,
  ].filter(Boolean)
  return parts.join(' — ')
}

export function hashSpec(spec: CapabilitySpec): string {
  return createHash('sha256').update(JSON.stringify(spec), 'utf8').digest('hex')
}

const DRAFT_SYSTEM = `You generate a single TypeScript async function from a capability spec and API documentation.

The function MUST:
1. Use positional parameters (NOT a single object param). Each spec param becomes a separate function argument.
2. Validate each param that has a constraint (regex test or predicate check), throw on failure
3. Construct exactly one HTTP request to the spec endpoint, substituting path params directly with template literals — do NOT use encodeURIComponent on path segments that contain slashes (e.g. "owner/repo")
4. Apply the auth header with the secret from Deno.env.get()
5. If rpc_wrap is true, wrap params in a JSON-RPC envelope with the rpc_method
6. Return the parsed response (json or text per spec)

Output ONLY the function body as a single async function. No imports, no explanation, no markdown fences.
Function name: use the last segment of the spec name (e.g. "github.createIssue" → "createIssue").`

const client = new Anthropic()

export async function draftCapability(spec: CapabilitySpec, docContent: string): Promise<{ code: string; hash: string }> {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: DRAFT_SYSTEM,
    messages: [{
      role: 'user',
      content: `Capability spec:\n${JSON.stringify(spec, null, 2)}\n\nAPI documentation:\n${docContent.slice(0, 4000)}`
    }]
  })

  const u = msg.usage
  if (u) { tokenUsage.calls++; tokenUsage.inputTokens += u.input_tokens || 0; tokenUsage.outputTokens += u.output_tokens || 0 }

  let code = msg.content[0].type === 'text' ? msg.content[0].text : ''
  code = code.replace(/^```(?:typescript)?\n?/m, '').replace(/\n?```$/m, '').trim()
  const hash = createHash('sha256').update(code, 'utf8').digest('hex')
  return { code, hash }
}

export async function fetchDocContent(url: string): Promise<string> {
  const r = await fetch(url, { headers: { Accept: 'text/plain, text/html' }, signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`Failed to fetch docs from ${url}: ${r.status}`)
  return await r.text()
}
