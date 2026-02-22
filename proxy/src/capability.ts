import { createHash } from 'crypto'

export type PolicyConstraint =
  | { type: 'regex', param: string, pattern: string, rationale: string }
  | { type: 'predicate', param: string, op: '>=' | '<=' | '==' | '!=' | 'in' | 'prefix' | 'suffix', value: any, rationale: string }
  | { type: 'natural_language', rule: string, rationale: string }

export const tokenUsage = { calls: 0, inputTokens: 0, outputTokens: 0 }

export interface CapabilitySpec {
  type?: string
  name: string
  doc_url: string
  doc_nav?: string
  endpoint: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  auth?: { header: string; value: string }
  params: Record<string, { in: 'path' | 'body' | 'query'; constraint?: PolicyConstraint }>
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
  signature?: string
  endowment?: import('./plugins/types.js').EndowmentFactory
}

export function hashSpec(spec: CapabilitySpec): string {
  return createHash('sha256').update(JSON.stringify(spec), 'utf8').digest('hex')
}

// Re-export plugin system for convenience
export { getPlugin } from './plugins/registry.js'
export type { CapabilityPlugin, PluginCodegenResult } from './plugins/types.js'
