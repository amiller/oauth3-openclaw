import { CapabilityPlugin } from './types.js'
import { apiGatewayPlugin } from './api-gateway.js'
import { cookieSessionPlugin } from './cookie-session.js'

const plugins = new Map<string, CapabilityPlugin>()
plugins.set('api-gateway', apiGatewayPlugin)
plugins.set('cookie-session', cookieSessionPlugin)

export function getPlugin(type: string): CapabilityPlugin | undefined { return plugins.get(type) }
export function registerPlugin(p: CapabilityPlugin) { plugins.set(p.type, p) }
