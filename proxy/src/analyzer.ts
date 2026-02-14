import Anthropic from '@anthropic-ai/sdk'
import { SkillMetadata } from './executor.js'

const client = new Anthropic()

const SYSTEM = `You are a security reviewer for Deno TypeScript skills that run in a sandboxed execution proxy. Analyze the submitted code and provide a brief assessment (3-5 lines max). Cover:
1. What the code actually does (one sentence)
2. Whether actual behavior matches the declared @description
3. Whether actual network calls and secret usage match declared @secrets and @network
4. Any security concerns (exfiltration, eval, unexpected side effects)`

export interface CodeAnalysis {
  summary: string
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

  const summary = msg.content[0].type === 'text' ? msg.content[0].text : '(no analysis)'
  const analysis: CodeAnalysis = { summary, timestamp: Date.now() }
  cache.set(codeHash, analysis)
  return analysis
}
