import './ses-init.js'
import { createHash } from 'crypto'
import { CapabilityFunction } from './capability.js'

export interface ExecutionRequest {
  code: string
  secrets: Record<string, string>
  args?: Record<string, any>
  timeout?: number
  capabilities?: CapabilityFunction[]
}

export interface ExecutionResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
  duration: number
  codeHash: string
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

export async function execute(request: ExecutionRequest): Promise<ExecutionResult> {
  const startTime = Date.now()
  const codeHash = hashCode(request.code)
  let stdout = ''
  let stderr = ''

  try {
    const endowments: Record<string, any> = {}

    for (const cap of request.capabilities || []) {
      if (!cap.endowment) continue
      const fnName = cap.name.split('.').pop()!
      endowments[fnName] = harden(cap.endowment.build(request.secrets))
    }

    endowments.args = harden(request.args || {})
    endowments.console = harden({
      log: (...a: any[]) => { stdout += a.map(String).join(' ') + '\n' },
      error: (...a: any[]) => { stderr += a.map(String).join(' ') + '\n' },
      warn: (...a: any[]) => { stderr += a.map(String).join(' ') + '\n' },
    })
    endowments.JSON = JSON
    endowments.Error = Error
    endowments.Promise = Promise
    endowments.atob = harden((s: string) => Buffer.from(s, 'base64').toString('binary'))
    endowments.btoa = harden((s: string) => Buffer.from(s, 'binary').toString('base64'))
    endowments.TextEncoder = TextEncoder
    endowments.TextDecoder = TextDecoder
    endowments.URL = URL
    endowments.URLSearchParams = URLSearchParams

    const compartment = new Compartment(endowments)
    const timeout = (request.timeout || 30) * 1000

    await Promise.race([
      compartment.evaluate(`(async () => { ${request.code} })()`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout)),
    ])

    return { success: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0, duration: Date.now() - startTime, codeHash }
  } catch (error: any) {
    stderr += error.message || String(error)
    return { success: false, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 1, duration: Date.now() - startTime, codeHash }
  }
}
