import { CapabilityPlugin } from './types.js'
import { apiGatewayPlugin } from './api-gateway.js'

const plugins = new Map<string, CapabilityPlugin>()
plugins.set('api-gateway', apiGatewayPlugin)

export function getPlugin(type: string): CapabilityPlugin | undefined { return plugins.get(type) }
export function registerPlugin(p: CapabilityPlugin) { plugins.set(p.type, p) }
