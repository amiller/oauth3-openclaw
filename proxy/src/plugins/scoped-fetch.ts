import { CapabilityPlugin, PluginCodegenResult, PluginSpec, EndowmentFactory } from './types.js'

export interface ScopedFetchSpec extends PluginSpec {
  type: 'scoped-fetch'
  base_url: string
  auth?: { header: string; value: string }
  scope: string[]
  methods?: string[]
  cookie_secret?: string
  body_schema?: { allow_keys?: string[]; deny_keys?: string[] }
  rate_limit?: { max_calls: number; window_seconds: number }
}

// Glob matcher: * = one segment, ** = any segments
function matchScope(path: string, patterns: string[]): boolean {
  const clean = path.replace(/^\//, '')
  return patterns.some(pat => {
    const re = pat.replace(/^\//, '')
      .split('/')
      .map(s => s === '**' ? '.*' : s === '*' ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]+'))
      .join('/')
    return new RegExp(`^${re}$`).test(clean)
  })
}

function validate(spec: any): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!spec || typeof spec !== 'object') return { valid: false, errors: ['spec must be an object'] }
  if (typeof spec.name !== 'string' || !spec.name) errors.push('name required')
  if (typeof spec.doc_url !== 'string' || !spec.doc_url) errors.push('doc_url required')
  if (typeof spec.base_url !== 'string' || !spec.base_url) errors.push('base_url required')
  if (!Array.isArray(spec.scope) || !spec.scope.length) errors.push('scope must be non-empty array of glob patterns')
  if (spec.name && /[^a-zA-Z0-9._-]/.test(spec.name)) errors.push('name must be alphanumeric/dots/dashes')
  try { new URL(spec.base_url) } catch { errors.push('base_url must be a valid URL') }
  if (spec.methods && (!Array.isArray(spec.methods) || spec.methods.some((m: any) => typeof m !== 'string')))
    errors.push('methods must be array of strings')
  if (spec.auth) {
    if (typeof spec.auth.header !== 'string') errors.push('auth.header must be string')
    if (typeof spec.auth.value !== 'string') errors.push('auth.value must be string')
  }
  if (spec.body_schema) {
    if (spec.body_schema.allow_keys && !Array.isArray(spec.body_schema.allow_keys)) errors.push('body_schema.allow_keys must be array')
    if (spec.body_schema.deny_keys && !Array.isArray(spec.body_schema.deny_keys)) errors.push('body_schema.deny_keys must be array')
  }
  if (spec.rate_limit) {
    if (typeof spec.rate_limit.max_calls !== 'number' || spec.rate_limit.max_calls < 1) errors.push('rate_limit.max_calls must be positive number')
    if (typeof spec.rate_limit.window_seconds !== 'number' || spec.rate_limit.window_seconds < 1) errors.push('rate_limit.window_seconds must be positive number')
  }
  return { valid: errors.length === 0, errors }
}

function secrets(spec: ScopedFetchSpec): string[] {
  const out: string[] = []
  if (spec.auth?.value) {
    for (const m of spec.auth.value.matchAll(/\{([A-Z_][A-Z0-9_]*)\}/g)) out.push(m[1])
  }
  if (spec.cookie_secret) out.push(spec.cookie_secret)
  return [...new Set(out)]
}

function networks(spec: ScopedFetchSpec): string[] {
  try { return [new URL(spec.base_url).hostname] } catch { return [] }
}

function summarize(spec: ScopedFetchSpec): string {
  return [
    `scoped-fetch ${spec.base_url}`,
    `scope: [${spec.scope.join(', ')}]`,
    spec.methods ? `methods: ${spec.methods.join(',')}` : null,
    secrets(spec).length ? `uses ${secrets(spec).join(', ')}` : null,
    spec.body_schema ? `body constraints` : null,
    spec.rate_limit ? `rate limit: ${spec.rate_limit.max_calls}/${spec.rate_limit.window_seconds}s` : null,
  ].filter(Boolean).join(' — ')
}

function codegen(spec: ScopedFetchSpec): Promise<PluginCodegenResult> {
  const fnName = spec.name.split('.').pop()!
  const signature = `async function ${fnName}(method: string, path: string, options?: {body?: object, headers?: Record<string,string>, query?: Record<string,string>}): Promise<any>`
  const code = [
    `// Scoped fetch: ${spec.base_url} — scope: [${spec.scope.join(', ')}]`,
    `// ${fnName}('GET', '/path')`,
    `// ${fnName}('POST', '/path', {body: {title: 'hello'}})  ← body MUST be inside {body: ...}`,
    `// ${fnName}('GET', '/path', {query: {page: '1'}, headers: {'Accept': 'application/json'}})`,
  ].join('\n')

  // Rate limit state (per-endowment instance, reset on window expiry)
  let rlCount = 0, rlWindowStart = 0

  const endowment: EndowmentFactory = {
    build(secretValues: Record<string, string>) {
      return async (method: string, path: string, options?: { body?: any; headers?: Record<string, string>; query?: Record<string, string> }) => {
        const cleanPath = path.replace(/^\//, '')
        if (!matchScope(cleanPath, spec.scope))
          throw new Error(`Path "${cleanPath}" not in scope: [${spec.scope.join(', ')}]`)
        if (spec.methods && !spec.methods.includes(method.toUpperCase()))
          throw new Error(`Method ${method} not allowed. Allowed: ${spec.methods.join(', ')}`)

        // Body schema enforcement
        if (spec.body_schema && options?.body && typeof options.body === 'object') {
          const keys = Object.keys(options.body)
          if (spec.body_schema.allow_keys) {
            const bad = keys.filter(k => !spec.body_schema!.allow_keys!.includes(k))
            if (bad.length) throw new Error(`Body key(s) not allowed: ${bad.join(', ')}. Allowed: ${spec.body_schema.allow_keys.join(', ')}`)
          }
          if (spec.body_schema.deny_keys) {
            const bad = keys.filter(k => spec.body_schema!.deny_keys!.includes(k))
            if (bad.length) throw new Error(`Body key(s) denied: ${bad.join(', ')}`)
          }
        }

        // Rate limit enforcement
        if (spec.rate_limit) {
          const now = Date.now()
          if (now - rlWindowStart > spec.rate_limit.window_seconds * 1000) { rlCount = 0; rlWindowStart = now }
          if (++rlCount > spec.rate_limit.max_calls)
            throw new Error(`Rate limit exceeded: ${spec.rate_limit.max_calls} calls per ${spec.rate_limit.window_seconds}s`)
        }

        const url = new URL(cleanPath, spec.base_url.endsWith('/') ? spec.base_url : spec.base_url + '/')
        if (options?.query) for (const [k, v] of Object.entries(options.query)) url.searchParams.set(k, v)

        const headers: Record<string, string> = { ...options?.headers }
        if (spec.auth) {
          headers[spec.auth.header] = spec.auth.value.replace(
            /\{([A-Z_][A-Z0-9_]*)\}/g, (_, k) => secretValues[k] || ''
          )
        }
        if (spec.cookie_secret && secretValues[spec.cookie_secret]) {
          headers['Cookie'] = secretValues[spec.cookie_secret]
        }

        let body: string | undefined
        if (options?.body !== undefined) {
          body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
          if (typeof options.body !== 'string') headers['Content-Type'] ??= 'application/json'
        }

        const r = await fetch(url.toString(), { method: method.toUpperCase(), headers, body })
        if (r.status === 204) return null
        const ct = r.headers.get('content-type') || ''
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)

        const isBinary = ct.includes('octet-stream') || ct.includes('binary') || ct.includes('zip') || ct.includes('pdf') || ct.includes('image/')
        if (isBinary) {
          const b64 = Buffer.from(await r.arrayBuffer()).toString('base64')
          return { _type: 'base64', data: b64, content_type: ct, size: b64.length }
        }

        if (ct.includes('json')) return r.json()
        return r.text()
      }
    }
  }

  return Promise.resolve({ code, signature, endowment })
}

export const scopedFetchPlugin: CapabilityPlugin = {
  type: 'scoped-fetch',
  describe: () => ({
    type: 'scoped-fetch',
    description: 'Scoped HTTP client — one endowment covers an entire API domain with glob-based path restrictions. JSON/text returned directly; binary returns {_type:"base64", data, content_type, size}.',
    spec_schema: {
      type: '"scoped-fetch"', name: 'string', doc_url: 'string',
      base_url: 'string (e.g. "https://api.github.com")',
      auth: '{ header: string, value: string } (optional, {SECRET_NAME} substitution)',
      scope: 'string[] (glob patterns: * = one segment, ** = any segments)',
      methods: 'string[] (optional, default all)',
      cookie_secret: 'string (optional, secret name containing cookies)',
      body_schema: '{ allow_keys?: string[], deny_keys?: string[] } (optional, restrict request body keys)',
      rate_limit: '{ max_calls: number, window_seconds: number } (optional)',
    },
    example_spec: {
      type: 'scoped-fetch', name: 'github', doc_url: 'https://docs.github.com/en/rest',
      base_url: 'https://api.github.com',
      auth: { header: 'Authorization', value: 'Bearer {GITHUB_TOKEN}' },
      scope: ['repos/*/actions/**', 'user'],
    },
  }),
  validateSpec: validate,
  extractSecrets: secrets,
  extractNetworks: networks,
  summarize,
  codegen,
}
