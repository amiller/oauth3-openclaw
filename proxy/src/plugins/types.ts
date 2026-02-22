import { PolicyConstraint } from '../capability.js'

export interface PluginCodegenResult {
  code: string
  signature: string
}

export interface CapabilityPlugin {
  type: string
  validateSpec(spec: any): { valid: boolean; errors: string[] }
  extractSecrets(spec: any): string[]
  extractNetworks(spec: any): string[]
  summarize(spec: any): string
  codegen(spec: any): Promise<PluginCodegenResult>
}

// Base spec — every plugin extends this
export interface PluginSpec {
  type?: string   // defaults to "api-gateway"
  name: string
  doc_url: string
  doc_nav?: string // instructions for finding the relevant doc section
}

// api-gateway specific
export interface ApiGatewaySpec extends PluginSpec {
  endpoint: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  auth?: { header: string; value: string }
  params: Record<string, { in: 'path' | 'body' | 'query'; constraint?: PolicyConstraint }>
  rpc_method?: string
  rpc_wrap?: boolean
  response?: 'json' | 'text'
}
