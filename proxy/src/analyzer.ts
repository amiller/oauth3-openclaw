import Anthropic from '@anthropic-ai/sdk'
import { SkillMetadata } from './executor.js'

const client = new Anthropic()

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
}

function parseHaikuJson(text: string, fallback: any): any {
  const clean = stripFences(text)
  try { return JSON.parse(clean) }
  catch { console.log(`  Haiku parse error. Raw: ${clean.substring(0, 200)}`); return fallback }
}

// --- Call 1: Structural analysis (cached by code hash) ---
// Extracts secrets, networks, risk level, mutation flag

const ANALYSIS_SYSTEM = `You are a security reviewer for Deno TypeScript skills that run in a sandboxed execution proxy. Analyze the submitted code and return a JSON object with these fields:

{
  "summary": "1-2 sentence human-readable description of what the code does",
  "secretsUsed": ["ENV_VAR_1", "ENV_VAR_2"],
  "networkTargets": ["api.example.com"],
  "isMutating": false,
  "riskLevel": "low",
  "concerns": []
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
    system: ANALYSIS_SYSTEM,
    messages: [{ role: 'user', content: `Skill: ${metadata.skill}
Description: ${metadata.description}
Declared secrets: ${metadata.secrets.join(', ') || 'none'}
Declared network: ${metadata.network.join(', ') || 'none'}
Timeout: ${metadata.timeout}s

\`\`\`typescript
${code}
\`\`\`` }]
  })

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
  const parsed = parseHaikuJson(text, { summary: text, secretsUsed: [], networkTargets: [], isMutating: true, riskLevel: 'medium', concerns: ['Could not parse structured analysis'] })

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

// --- Call 2: Code review (cached by code hash) ---
// Behavioral review: is the code faithful to its description? What's parameterized vs hardcoded?

const CODE_REVIEW_SYSTEM = `You are reviewing Deno TypeScript code for a sandboxed execution proxy. The code will be invoked with arguments passed as environment variables.

Determine:
1. Does the code faithfully implement what its description claims?
2. Which values come from arguments (env vars read at runtime) vs hardcoded in the source?
3. Any concerns about the code itself — exfiltration, undeclared network access, eval, etc.

Return ONLY a JSON object:
{
  "faithful": true,
  "parameterized": ["repo", "title"],
  "hardcoded": {"state": "closed", "api_base": "https://api.github.com"},
  "concerns": []
}

"parameterized" = env var names the code reads that control its behavior (Deno.env.get calls).
"hardcoded" = significant values baked into the source (URLs, repo names, methods, states).
"faithful" = false only if the code does something its description doesn't mention, or omits something it claims to do.
Return ONLY JSON, no markdown fences.`

export interface CodeReview {
  faithful: boolean
  parameterized: string[]
  hardcoded: Record<string, string>
  concerns: string[]
  timestamp: number
}

export interface CodeReviewCache {
  get(hash: string): CodeReview | undefined
  set(hash: string, r: CodeReview): void
}

export async function reviewCode(
  code: string, metadata: SkillMetadata, codeHash: string, cache: CodeReviewCache
): Promise<CodeReview> {
  const cached = cache.get(codeHash)
  if (cached) return cached

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: CODE_REVIEW_SYSTEM,
    messages: [{ role: 'user', content: `Skill: ${metadata.skill}
Description: ${metadata.description}

\`\`\`typescript
${code}
\`\`\`` }]
  })

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
  const parsed = parseHaikuJson(text, { faithful: false, parameterized: [], hardcoded: {}, concerns: ['Could not parse code review'] })

  const review: CodeReview = {
    faithful: parsed.faithful ?? false,
    parameterized: parsed.parameterized || [],
    hardcoded: parsed.hardcoded || {},
    concerns: parsed.concerns || [],
    timestamp: Date.now()
  }
  cache.set(codeHash, review)
  return review
}

// --- Call 3: Invocation review (per-call, NOT cached) ---
// Given the code review + constraints + actual args, is this specific call within bounds?

const INVOCATION_SYSTEM = `You are checking whether a specific invocation of pre-reviewed code complies with policy constraints.

The code has already been reviewed. You receive:
- A summary of what the code does and what values are parameterized vs hardcoded
- The policy constraints for this session
- The actual argument values for THIS specific invocation

Judge compliance based on what the code WILL do with THESE specific argument values.
Do NOT re-review the code itself — it's already been approved structurally.
Focus on whether the argument values are within the policy bounds.

Return ONLY a JSON object:
{
  "compliant": true/false,
  "violations": ["constraint text that was violated — and why"]
}

Return ONLY JSON, no markdown fences.`

export async function reviewInvocation(
  codeReview: CodeReview, analysis: CodeAnalysis, metadata: SkillMetadata,
  constraints: string[], args: Record<string, any>
): Promise<PolicyCompliance> {
  if (!constraints.length) return { compliant: true, violations: [] }

  const userContent = `Skill: ${metadata.skill}
Description: ${metadata.description}

Code review summary: ${analysis.summary}
Parameterized (from args): ${codeReview.parameterized.join(', ') || 'none'}
Hardcoded values: ${Object.entries(codeReview.hardcoded).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}
Secrets used: ${analysis.secretsUsed.join(', ') || 'none'}
Networks contacted: ${analysis.networkTargets.join(', ') || 'none'}
Mutating: ${analysis.isMutating}
${codeReview.concerns.length ? `Code concerns: ${codeReview.concerns.join('; ')}` : ''}

Policy constraints:
${constraints.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Invocation arguments:
${Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') || '(no args)'}`

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: INVOCATION_SYSTEM,
    messages: [{ role: 'user', content: userContent }]
  })

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
  const parsed = parseHaikuJson(text, null)
  if (!parsed) return { compliant: false, violations: ['Could not parse invocation review — treating as non-compliant'] }
  return { compliant: !!parsed.compliant, violations: parsed.violations || [] }
}

// --- Legacy combined check (fallback when no args) ---

export interface PolicyCompliance {
  compliant: boolean
  violations: string[]
}

const COMPLIANCE_SYSTEM = `You are a policy compliance checker for sandboxed code execution. You will be given code and a list of policy constraints.

Return ONLY a JSON object:
{
  "compliant": true/false,
  "violations": ["constraint text that was violated — and why"]
}

Be strict but fair. If the code COULD violate a constraint depending on runtime values, flag it. Return ONLY JSON, no markdown fences.`

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

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
  const parsed = parseHaikuJson(text, null)
  if (!parsed) return { compliant: false, violations: ['Could not parse compliance check — treating as non-compliant'] }
  return { compliant: !!parsed.compliant, violations: parsed.violations || [] }
}
