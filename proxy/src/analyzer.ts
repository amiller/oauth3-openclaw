import Anthropic from '@anthropic-ai/sdk'
import { SkillMetadata } from './executor.js'

const client = new Anthropic()

const SYSTEM = `You are a security reviewer for Deno TypeScript skills that run in a sandboxed execution proxy. Analyze the submitted code and return a JSON object with these fields:

{
  "summary": "1-2 sentence human-readable description of what the code does",
  "secretsUsed": ["ENV_VAR_1", "ENV_VAR_2"],  // env vars actually read by the code (Deno.env.get, process.env, etc)
  "networkTargets": ["api.example.com"],       // domains the code actually contacts
  "isMutating": false,                          // true if code writes/deletes/modifies external state (POST/PUT/DELETE, file writes, DB mutations)
  "riskLevel": "low",                           // "low" = read-only + declared scope, "medium" = mutations or broad network, "high" = eval/exfiltration/undeclared access
  "concerns": []                                // short strings listing any security concerns, empty if none
}

Be precise about secretsUsed and networkTargets — only list what the code ACTUALLY uses, not what's declared in metadata.
Return ONLY the JSON object, no markdown fences or explanation.`

export interface CodeAnalysis {
  summary: string
  secretsUsed: string[]
  networkTargets: string[]
  isMutating: boolean
  riskLevel: 'low' | 'medium' | 'high'
  concerns: string[]
  timestamp: number
}

export interface AnalysisCache {
  get(hash: string): CodeAnalysis | undefined
  set(hash: string, a: CodeAnalysis): void
}

export async function analyzeCode(
  code: string, metadata: SkillMetadata, codeHash: string, cache: AnalysisCache
): Promise<CodeAnalysis> {
  const cached = cache.get(codeHash)
  if (cached) return cached

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: SYSTEM,
    messages: [{ role: 'user', content: `Skill: ${metadata.skill}
Description: ${metadata.description}
Declared secrets: ${metadata.secrets.join(', ') || 'none'}
Declared network: ${metadata.network.join(', ') || 'none'}
Timeout: ${metadata.timeout}s

\`\`\`typescript
${code}
\`\`\`` }]
  })

  let text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
  text = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    console.log(`  Analysis parse error. Raw: ${text.substring(0, 200)}`)
    parsed = { summary: text, secretsUsed: [], networkTargets: [], isMutating: true, riskLevel: 'medium', concerns: ['Could not parse structured analysis'] }
  }

  const analysis: CodeAnalysis = {
    summary: parsed.summary || '(no summary)',
    secretsUsed: parsed.secretsUsed || [],
    networkTargets: parsed.networkTargets || [],
    isMutating: parsed.isMutating ?? true,
    riskLevel: parsed.riskLevel || 'medium',
    concerns: parsed.concerns || [],
    timestamp: Date.now()
  }
  cache.set(codeHash, analysis)
  return analysis
}

export interface PolicyCompliance {
  compliant: boolean
  violations: string[]
}

const COMPLIANCE_SYSTEM = `You are a policy compliance checker for sandboxed code execution. You will be given code and a list of policy constraints. Determine if the code complies with ALL constraints.

Return ONLY a JSON object:
{
  "compliant": true/false,
  "violations": ["constraint text that was violated — and why"]
}

Be strict but fair. If the code COULD violate a constraint depending on runtime values, flag it. If the code clearly stays within bounds, mark compliant. Return ONLY JSON, no markdown fences.`

export async function checkPolicyCompliance(
  code: string, metadata: SkillMetadata, constraints: string[]
): Promise<PolicyCompliance> {
  if (!constraints.length) return { compliant: true, violations: [] }

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: COMPLIANCE_SYSTEM,
    messages: [{ role: 'user', content: `Skill: ${metadata.skill}
Description: ${metadata.description}

Policy constraints:
${constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}

\`\`\`typescript
${code}
\`\`\`` }]
  })

  let text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
  // Strip markdown fences if Haiku wraps the response
  text = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  try {
    const parsed = JSON.parse(text)
    return { compliant: !!parsed.compliant, violations: parsed.violations || [] }
  } catch {
    console.log(`  Compliance check parse error. Raw response: ${text.substring(0, 200)}`)
    return { compliant: false, violations: ['Could not parse compliance check — treating as non-compliant'] }
  }
}
