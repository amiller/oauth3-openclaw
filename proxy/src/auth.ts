import { createHmac, randomBytes } from 'crypto'
import { Request, Response, NextFunction } from 'express'

const JWT_SECRET = process.env.JWT_SECRET || ''
const API_BEARER_TOKEN = process.env.API_BEARER_TOKEN || ''

// Standalone mode: enclave issues its own JWTs when no JWT_SECRET is configured
// Hosted mode: orchestrator issues JWTs with shared secret
const STANDALONE = !JWT_SECRET

export interface TenantContext {
  tenant_id: string
  plan?: string
  iat: number
  exp: number
}

// --- JWT helpers (HS256, no deps) ---

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url')
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString()
}

function signJWT(payload: object, secret: string, expiresIn = 86400): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + expiresIn }))
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

function verifyJWT(token: string, secret: string): TenantContext | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const sig = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url')
  if (sig !== parts[2]) return null
  try {
    const payload = JSON.parse(b64urlDecode(parts[1]))
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload as TenantContext
  } catch { return null }
}

// --- Standalone: issue tokens directly from enclave ---

let standaloneSecret = ''

function getSecret(): string {
  if (JWT_SECRET) return JWT_SECRET
  // Standalone mode: use a per-process secret (or derive from dstack later)
  if (!standaloneSecret) {
    standaloneSecret = randomBytes(32).toString('hex')
    console.log('🔑 Standalone mode: generated local JWT secret')
  }
  return standaloneSecret
}

export function issueToken(tenantId: string, plan = 'free'): string {
  return signJWT({ tenant_id: tenantId, plan }, getSecret())
}

// --- Express middleware ---

export function requireTenant(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization
  if (!auth) {
    // Dev fallback: no auth configured = open access
    if (!JWT_SECRET && !API_BEARER_TOKEN) {
      ;(req as any).tenant = { tenant_id: 'dev', plan: 'free', iat: 0, exp: Infinity }
      return next()
    }
    return res.status(401).json({ error: 'Missing Authorization header' })
  }

  const token = auth.replace(/^Bearer\s+/i, '')

  // Try JWT first
  const tenant = verifyJWT(token, getSecret())
  if (tenant) {
    ;(req as any).tenant = tenant
    return next()
  }

  // Fallback: legacy bearer token (backwards compat during migration)
  if (API_BEARER_TOKEN && token === API_BEARER_TOKEN) {
    ;(req as any).tenant = { tenant_id: req.headers['x-tenant-id'] as string || 'legacy', plan: 'free', iat: 0, exp: Infinity }
    return next()
  }

  res.status(401).json({ error: 'Invalid token' })
}

// Standalone signup endpoint — enclave issues JWT directly
export function handleSignup(req: Request, res: Response) {
  if (!STANDALONE) return res.status(404).json({ error: 'Signup not available — use orchestrator' })
  const { name } = req.body || {}
  const tenantId = `tenant_${randomBytes(8).toString('hex')}`
  const token = issueToken(tenantId)
  res.json({ tenant_id: tenantId, token, message: 'Store this token — it cannot be recovered' })
}
