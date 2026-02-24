import { CapabilityPlugin, PluginCodegenResult, EndowmentFactory } from './types.js'
import { PolicyConstraint } from '../capability.js'

export interface CookieSessionSpec {
  type: 'cookie-session'
  name: string
  doc_url: string
  doc_nav?: string
  cookie_secret: string
  endpoint: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  params: Record<string, { in: 'path' | 'body' | 'query'; constraint?: PolicyConstraint }>
  extra_headers?: Record<string, string>
  response?: 'json' | 'text'
}

function validate(spec: any): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!spec || typeof spec !== 'object') return { valid: false, errors: ['spec must be an object'] }
  if (typeof spec.name !== 'string' || !spec.name) errors.push('name required')
  if (typeof spec.doc_url !== 'string' || !spec.doc_url) errors.push('doc_url required')
  if (typeof spec.cookie_secret !== 'string' || !spec.cookie_secret) errors.push('cookie_secret required')
  if (typeof spec.endpoint !== 'string' || !spec.endpoint) errors.push('endpoint required')
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(spec.method)) errors.push('method must be GET/POST/PUT/DELETE')
  if (!spec.params || typeof spec.params !== 'object') errors.push('params required')
  if (spec.name && /[^a-zA-Z0-9._-]/.test(spec.name)) errors.push('name must be alphanumeric/dots/dashes')
  try { new URL(spec.doc_url) } catch { errors.push('doc_url must be a valid URL') }
  try { new URL(spec.endpoint.replace(/\{[^}]+\}/g, 'x')) } catch { errors.push('endpoint must be a valid URL template') }
  if (spec.params && typeof spec.params === 'object') {
    for (const [k, v] of Object.entries(spec.params) as [string, any][]) {
      if (!['path', 'body', 'query'].includes(v?.in)) errors.push(`params.${k}.in must be path/body/query`)
    }
  }
  return { valid: errors.length === 0, errors }
}

function secrets(spec: CookieSessionSpec): string[] { return [spec.cookie_secret] }

function networks(spec: CookieSessionSpec): string[] {
  try { return [new URL(spec.endpoint.replace(/\{[^}]+\}/g, 'x')).hostname] } catch { return [] }
}

function summarize(spec: CookieSessionSpec): string {
  const domain = (() => { try { return new URL(spec.endpoint.replace(/\{[^}]+\}/g, 'x')).hostname } catch { return spec.endpoint } })()
  const constraints = Object.entries(spec.params)
    .filter(([, v]) => v.constraint)
    .map(([k, v]) => {
      const c = v.constraint!
      if (c.type === 'regex') return `${k} matches /${c.pattern}/`
      if (c.type === 'predicate') return `${k} ${c.op} ${JSON.stringify(c.value)}`
      return `${k}: ${(c as any).rule}`
    })
  return [
    `Cookie-auth ${spec.method} ${spec.endpoint}`,
    constraints.length ? `constrained: ${constraints.join(', ')}` : null,
    `using ${spec.cookie_secret}`,
    `docs: ${domain}`,
  ].filter(Boolean).join(' — ')
}

function codegen(spec: CookieSessionSpec): Promise<PluginCodegenResult> {
  const params = Object.entries(spec.params)
  const pathP = params.filter(([, v]) => v.in === 'path')
  const bodyP = params.filter(([, v]) => v.in === 'body')
  const queryP = params.filter(([, v]) => v.in === 'query')
  const fnName = spec.name.split('.').pop()!

  const sigParams = params.map(([n]) => `${n}: string`).join(', ')
  const signature = `async function ${fnName}(${sigParams}): Promise<any>`
  const L: string[] = [`${signature} {`]

  // Parse cookie secret
  L.push(`  const _raw = Deno.env.get(${JSON.stringify(spec.cookie_secret)});`)
  L.push(`  if (!_raw) throw new Error("missing secret ${spec.cookie_secret}");`)
  L.push(`  const _sec = JSON.parse(_raw);`)
  L.push(`  const _domain = new URL(\`${spec.endpoint.replace(/\{(\w+)\}/g, (_m, k) => '${' + k + '}')}\`).hostname;`)
  L.push(`  const _cookies = _sec.cookies.filter((c: any) => _domain.endsWith(c.domain.replace(/^\\./, "")));`)
  L.push(`  const _cookieStr = _cookies.map((c: any) => c.name + "=" + c.value).join("; ");`)

  // Constraint validation
  for (const [name, p] of params) {
    if (!p.constraint) continue
    const c = p.constraint
    if (c.type === 'regex')
      L.push(`  if (!/${c.pattern}/.test(${name})) throw new Error(${JSON.stringify(`${name}: ${c.rationale}`)});`)
    else if (c.type === 'predicate')
      L.push(`  if (!(${name} ${c.op} ${JSON.stringify(c.value)})) throw new Error(${JSON.stringify(`${name}: ${c.rationale}`)});`)
  }

  // URL
  const urlTemplate = spec.endpoint.replace(/\{(\w+)\}/g, (_m, k) => '${' + k + '}')
  if (queryP.length) {
    L.push(`  const _u = new URL(\`${urlTemplate}\`);`)
    for (const [n] of queryP) L.push(`  if (${n} !== undefined) _u.searchParams.set("${n}", ${n});`)
    L.push(`  const _url = _u.toString();`)
  } else {
    L.push(`  const _url = \`${urlTemplate}\`;`)
  }

  // Headers
  const extraHdrs = spec.extra_headers
    ? Object.entries(spec.extra_headers).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')
    : ''
  const hdrParts = [`"Cookie": _cookieStr`, `"User-Agent": _sec.user_agent`]
  if (extraHdrs) hdrParts.push(extraHdrs)

  // Fetch
  const fetchOpts: string[] = [`method: "${spec.method}"`, `headers: {${hdrParts.join(', ')}}`]
  if (bodyP.length) {
    hdrParts.push(`"Content-Type": "application/json"`)
    fetchOpts[1] = `headers: {${hdrParts.join(', ')}}`
    const bodyFields = bodyP.map(([n]) => n).join(', ')
    L.push(`  const _body = JSON.stringify({${bodyFields}});`)
    fetchOpts.push(`body: _body`)
  }

  L.push(`  const _r = await fetch(_url, {${fetchOpts.join(', ')}});`)
  L.push(`  if (!_r.ok) { const _e = await _r.text(); throw new Error(\`HTTP \${_r.status}: \${_e}\`); }`)
  L.push(spec.response === 'text' ? `  return _r.text();` : `  return _r.json();`)
  L.push(`}`)

  const endowment: EndowmentFactory = {
    build(secretsMap: Record<string, string>) {
      return async (...callArgs: any[]) => {
        const paramEntries = Object.entries(spec.params)
        const argMap: Record<string, string> = {}
        paramEntries.forEach(([name, _], i) => { argMap[name] = callArgs[i] })

        for (const [name, p] of paramEntries) {
          if (!p.constraint) continue
          const val = argMap[name]
          const c = p.constraint
          if (c.type === 'regex' && !new RegExp(c.pattern).test(val))
            throw new Error(`${name}: ${c.rationale}`)
          if (c.type === 'predicate' && !(eval(`"${val}" ${c.op} ${JSON.stringify(c.value)}`)))
            throw new Error(`${name}: ${c.rationale}`)
        }

        const raw = secretsMap[spec.cookie_secret]
        if (!raw) throw new Error(`missing secret ${spec.cookie_secret}`)
        const sec = JSON.parse(raw)

        let url = spec.endpoint.replace(/\{(\w+)\}/g, (_, k) => argMap[k])
        const reqDomain = new URL(url).hostname
        const cookies = sec.cookies.filter((c: any) => reqDomain.endsWith(c.domain.replace(/^\./, '')))
        const cookieStr = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ')

        if (queryP.length) {
          const u = new URL(url)
          for (const [n] of queryP) if (argMap[n] !== undefined) u.searchParams.set(n, argMap[n])
          url = u.toString()
        }

        const headers: Record<string, string> = {
          'Cookie': cookieStr,
          'User-Agent': sec.user_agent,
          ...spec.extra_headers,
        }

        const opts: RequestInit = { method: spec.method, headers }
        const bodyParams = paramEntries.filter(([, v]) => v.in === 'body')
        if (bodyParams.length) {
          headers['Content-Type'] = 'application/json'
          const bodyObj: Record<string, any> = {}
          for (const [n] of bodyParams) bodyObj[n] = argMap[n]
          opts.body = JSON.stringify(bodyObj)
        }

        const r = await fetch(url, opts)
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
        return spec.response === 'text' ? r.text() : r.json()
      }
    }
  }

  return Promise.resolve({ code: L.join('\n'), signature, endowment })
}

export const cookieSessionPlugin: CapabilityPlugin = {
  type: 'cookie-session',
  describe: () => ({
    type: 'cookie-session',
    description: 'DEPRECATED — use scoped-fetch with cookie_secret instead. Single-endpoint cookie-auth proxy.',
    spec_schema: {
      type: '"cookie-session"', name: 'string', doc_url: 'string',
      cookie_secret: 'string (name of stored cookie secret)',
      endpoint: 'string (URL template)', method: 'GET|POST|PUT|DELETE',
      params: 'Record<name, { in: "path"|"body"|"query" }>',
      extra_headers: 'Record<string,string> (optional)',
    },
    example_spec: {
      type: 'cookie-session', name: 'reddit-saved',
      doc_url: 'https://www.reddit.com/dev/api/',
      cookie_secret: 'COOKIES_REDDIT_COM',
      endpoint: 'https://www.reddit.com/user/{username}/saved.json',
      method: 'GET', params: { username: { in: 'path' }, limit: { in: 'query' } },
    },
  }),
  validateSpec: validate,
  extractSecrets: secrets,
  extractNetworks: networks,
  summarize,
  codegen,
}
