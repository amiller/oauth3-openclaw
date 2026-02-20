import Anthropic from '@anthropic-ai/sdk'
import { tokenUsage } from './analyzer.js'

export type PolicyConstraint =
  | { type: 'regex', param: string, pattern: string, rationale: string }
  | { type: 'predicate', param: string, op: '>=' | '<=' | '==' | '!=' | 'in' | 'prefix' | 'suffix', value: any, rationale: string }
  | { type: 'natural_language', rule: string, rationale: string }

export function enforceStrict(constraints: PolicyConstraint[], args: Record<string, any>): { pass: boolean, violations: string[] } {
  const violations: string[] = []
  for (const c of constraints) {
    if (c.type === 'regex') {
      const val = String(args[c.param] ?? '')
      if (!new RegExp(c.pattern).test(val))
        violations.push(`${c.param} "${val}" doesn't match /${c.pattern}/ — ${c.rationale}`)
    } else if (c.type === 'predicate') {
      const val = args[c.param]
      let ok = false
      switch (c.op) {
        case '>=': ok = val >= c.value; break
        case '<=': ok = val <= c.value; break
        case '==': ok = val == c.value; break
        case '!=': ok = val != c.value; break
        case 'in': ok = Array.isArray(c.value) && c.value.includes(val); break
        case 'prefix': ok = typeof val === 'string' && val.startsWith(c.value); break
        case 'suffix': ok = typeof val === 'string' && val.endsWith(c.value); break
      }
      if (!ok) violations.push(`${c.param} ${c.op} ${JSON.stringify(c.value)} failed (got ${JSON.stringify(val)}) — ${c.rationale}`)
    }
    // skip natural_language — handled by enforceSoft
  }
  return { pass: violations.length === 0, violations }
}

const client = new Anthropic()

export async function enforceSoft(constraints: PolicyConstraint[], args: Record<string, any>): Promise<{ pass: boolean, violations: string[] }> {
  const softRules = constraints.filter(c => c.type === 'natural_language') as Array<{ type: 'natural_language', rule: string, rationale: string }>
  if (!softRules.length) return { pass: true, violations: [] }
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system: `You enforce policy rules against argument values. You see ONLY the human-approved rules and the argument values. Return JSON: {"pass": true/false, "violations": ["rule that was violated and why"]}. Return ONLY JSON.`,
    messages: [{ role: 'user', content: `Rules:\n${softRules.map((r, i) => `${i + 1}. ${r.rule} (${r.rationale})`).join('\n')}\n\nArguments:\n${Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') || '(none)'}` }]
  })

  const u = msg.usage
  if (u) { tokenUsage.calls++; tokenUsage.inputTokens += u.input_tokens || 0; tokenUsage.outputTokens += u.output_tokens || 0 }

  const text = msg.content[0].type === 'text' ? msg.content[0].text : '{}'
  try {
    const parsed = JSON.parse(text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim())
    return { pass: !!parsed.pass, violations: parsed.violations || [] }
  } catch {
    return { pass: false, violations: ['Could not parse soft constraint review'] }
  }
}

export function isStructuredConstraint(c: any): c is PolicyConstraint {
  if (!c || typeof c !== 'object') return false
  if (c.type === 'regex') return typeof c.param === 'string' && typeof c.pattern === 'string'
  if (c.type === 'predicate') return typeof c.param === 'string' && typeof c.op === 'string'
  if (c.type === 'natural_language') return typeof c.rule === 'string'
  return false
}

export function splitConstraints(constraints: PolicyConstraint[]): { strict: PolicyConstraint[], soft: PolicyConstraint[] } {
  const strict = constraints.filter(c => c.type === 'regex' || c.type === 'predicate')
  const soft = constraints.filter(c => c.type === 'natural_language')
  return { strict, soft }
}
