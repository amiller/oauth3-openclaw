import { CapabilityPlugin, PluginCodegenResult, ApiGatewaySpec, EndowmentFactory } from './types.js'

function validate(spec: any): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!spec || typeof spec !== 'object') return { valid: false, errors: ['spec must be an object'] }
  if (typeof spec.name !== 'string' || !spec.name) errors.push('name required')
  if (typeof spec.doc_url !== 'string' || !spec.doc_url) errors.push('doc_url required')
  if (typeof spec.endpoint !== 'string' || !spec.endpoint) errors.push('endpoint required')
  if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(spec.method)) errors.push('method must be GET/POST/PUT/DELETE/PATCH')
  if (!spec.params || typeof spec.params !== 'object') errors.push('params required')
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

function secrets(spec: ApiGatewaySpec): string[] {
  if (!spec.auth?.value) return []
  const matches = spec.auth.value.matchAll(/\{([A-Z_][A-Z0-9_]*)\}/g)
  return [...new Set([...matches].map(m => m[1]))]
}

function networks(spec: ApiGatewaySpec): string[] {
  try { return [new URL(spec.endpoint.replace(/\{[^}]+\}/g, 'x')).hostname] } catch { return [] }
}

function summarize(spec: ApiGatewaySpec): string {
  const domain = (() => { try { return new URL(spec.doc_url).hostname } catch { return spec.doc_url } })()
  const s = secrets(spec)
  const constraints = Object.entries(spec.params)
    .filter(([, v]) => v.constraint)
    .map(([k, v]) => {
      const c = v.constraint!
      if (c.type === 'regex') return `${k} matches /${c.pattern}/`
      if (c.type === 'predicate') return `${k} ${c.op} ${JSON.stringify(c.value)}`
      return `${k}: ${(c as any).rule}`
    })
  return [
    `${spec.method} ${spec.endpoint}`,
    constraints.length ? `constrained: ${constraints.join(', ')}` : null,
    s.length ? `uses ${s.join(', ')}` : null,
    `docs: ${domain}`,
  ].filter(Boolean).join(' — ')
}

function codegen(spec: ApiGatewaySpec): Promise<PluginCodegenResult> {
  const params = Object.entries(spec.params)
  const pathP = params.filter(([, v]) => v.in === 'path')
  const bodyP = params.filter(([, v]) => v.in === 'body')
  const queryP = params.filter(([, v]) => v.in === 'query')
  const fnName = spec.name.split('.').pop()!

  const sigParams = params.map(([n]) => `${n}: string`).join(', ')
  const signature = `async function ${fnName}(${sigParams}): Promise<any>`
  const L: string[] = [`${signature} {`]

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
  const hdrs: string[] = []
  if (spec.auth) {
    const val = spec.auth.value.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (_m, k) => '${Deno.env.get("' + k + '")}')
    hdrs.push(`"${spec.auth.header}": \`${val}\``)
  }

  // Fetch
  const fetchOpts: string[] = [`method: "${spec.method}"`, `headers: {${hdrs.join(', ')}}`]
  if (bodyP.length) {
    hdrs.push(`"Content-Type": "application/json"`)
    fetchOpts[1] = `headers: {${hdrs.join(', ')}}`
    const bodyFields = bodyP.map(([n]) => n).join(', ')
    if (spec.rpc_wrap)
      L.push(`  const _body = JSON.stringify({jsonrpc:"2.0",method:${JSON.stringify(spec.rpc_method)},params:{${bodyFields}},id:1});`)
    else
      L.push(`  const _body = JSON.stringify({${bodyFields}});`)
    fetchOpts.push(`body: _body`)
  }

  L.push(`  const _r = await fetch(_url, {${fetchOpts.join(', ')}});`)
  L.push(`  if (!_r.ok) { const _e = await _r.text(); throw new Error(\`HTTP \${_r.status}: \${_e}\`); }`)
  const retLine = spec.response === 'binary'
    ? `  return Buffer.from(await _r.arrayBuffer()).toString('base64');`
    : spec.response === 'text' ? `  return _r.text();` : `  return _r.json();`
  L.push(retLine)
  L.push(`}`)

  const endowment: EndowmentFactory = {
    build(secrets: Record<string, string>) {
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

        let url = spec.endpoint.replace(/\{(\w+)\}/g, (_, k) => argMap[k])
        const queryP = paramEntries.filter(([, v]) => v.in === 'query')
        if (queryP.length) {
          const u = new URL(url)
          for (const [n] of queryP) if (argMap[n] !== undefined) u.searchParams.set(n, argMap[n])
          url = u.toString()
        }

        const headers: Record<string, string> = {}
        if (spec.auth) {
          headers[spec.auth.header] = spec.auth.value.replace(
            /\{([A-Z_][A-Z0-9_]*)\}/g, (_, k) => secrets[k] || ''
          )
        }

        const bodyP = paramEntries.filter(([, v]) => v.in === 'body')
        const opts: RequestInit = { method: spec.method, headers }
        if (bodyP.length) {
          headers['Content-Type'] = 'application/json'
          const bodyObj: Record<string, any> = {}
          for (const [n] of bodyP) bodyObj[n] = argMap[n]
          if (spec.rpc_wrap)
            opts.body = JSON.stringify({ jsonrpc: '2.0', method: spec.rpc_method, params: bodyObj, id: 1 })
          else
            opts.body = JSON.stringify(bodyObj)
        }

        const r = await fetch(url, opts)
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
        if (spec.response === 'binary') return Buffer.from(await r.arrayBuffer()).toString('base64')
        return spec.response === 'text' ? r.text() : r.json()
      }
    }
  }

  return Promise.resolve({ code: L.join('\n'), signature, endowment })
}

export const apiGatewayPlugin: CapabilityPlugin = {
  type: 'api-gateway',
  describe: () => ({
    type: 'api-gateway',
    description: 'DEPRECATED — use scoped-fetch instead. Single-endpoint HTTP proxy with param constraints.',
    spec_schema: {
      type: '"api-gateway"', name: 'string', doc_url: 'string', endpoint: 'string (URL template with {placeholders})',
      method: 'GET|POST|PUT|DELETE|PATCH',
      auth: '{ header: string, value: string (use {SECRET_NAME} for secret refs) } (optional)',
      params: 'Record<name, { in: "path"|"body"|"query", constraint?: { type, pattern?, op?, value?, rationale } }>',
    },
    example_spec: {
      type: 'api-gateway', name: 'github-list-issues', doc_url: 'https://docs.github.com/en/rest/issues',
      endpoint: 'https://api.github.com/repos/{owner}/{repo}/issues',
      method: 'GET', auth: { header: 'Authorization', value: 'Bearer {GITHUB_TOKEN}' },
      params: { owner: { in: 'path' }, repo: { in: 'path' }, state: { in: 'query' } },
    },
  }),
  validateSpec: validate,
  extractSecrets: secrets,
  extractNetworks: networks,
  summarize,
  codegen,
}
