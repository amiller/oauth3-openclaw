/**
 * Regex-based static analysis for short Deno skills (~20-50 lines).
 * No LLM — purely deterministic extraction of fetch URLs, env vars, imports.
 */

export interface StaticAnalysis {
  fetchUrls: { url: string; literal: boolean }[]
  envVars: string[]
  imports: string[]
  hasDynamicFetch: boolean
  hasEval: boolean
  lineCount: number
}

export interface VerificationCheck {
  name: string
  passed: boolean
  expected: string
  actual: string
  details?: string
}

export interface VerificationResult {
  checks: VerificationCheck[]
  allPassed: boolean
  warnings: string[]
}

export function analyzeStatic(source: string): StaticAnalysis {
  const fetchUrls: StaticAnalysis['fetchUrls'] = []
  const envVars: string[] = []
  const imports: string[] = []
  let hasDynamicFetch = false
  let hasEval = false

  // Literal fetch URLs: fetch('https://...' or fetch("https://..."
  for (const m of source.matchAll(/fetch\(\s*['"]([^'"]+)['"]/g)) {
    fetchUrls.push({ url: m[1], literal: true })
  }

  // Template literal fetch URLs: fetch(`...${...}...`)
  for (const m of source.matchAll(/fetch\(\s*`([^`]+)`/g)) {
    const tpl = m[1]
    if (/\$\{/.test(tpl)) {
      hasDynamicFetch = true
      // Extract the static host part if possible (e.g. `https://api.github.com/repos/${repo}`)
      const hostMatch = tpl.match(/^https?:\/\/([^/$]+)/)
      if (hostMatch) fetchUrls.push({ url: `https://${hostMatch[1]}`, literal: false })
    } else {
      fetchUrls.push({ url: tpl, literal: true })
    }
  }

  // Deno.env.get('VAR') or Deno.env.get("VAR")
  for (const m of source.matchAll(/Deno\.env\.get\(\s*['"](\w+)['"]\s*\)/g)) {
    if (!envVars.includes(m[1])) envVars.push(m[1])
  }

  // import ... from '...' or import('...')
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+.+from\s+['"]([^'"]+)['"]/g)) {
    imports.push(m[1])
  }
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.push(m[1])
  }

  // Dangerous patterns
  if (/\beval\s*\(/.test(source) || /\bnew\s+Function\s*\(/.test(source)) hasEval = true

  return { fetchUrls, envVars, imports, hasDynamicFetch, hasEval, lineCount: source.split('\n').length }
}

export function verifyCapabilityMode(
  source: string,
  capabilityNames: string[]
): VerificationResult {
  const checks: VerificationCheck[] = []
  const warnings: string[] = []

  // No fetch() calls in agent code
  const fetchMatches = [...source.matchAll(/\bfetch\s*\(/g)]
  checks.push({
    name: 'no_direct_fetch',
    passed: fetchMatches.length === 0,
    expected: 'no fetch() calls',
    actual: fetchMatches.length ? `${fetchMatches.length} fetch() call(s) found` : 'clean',
  })

  // No Deno.env.get() in agent code
  const envMatches = [...source.matchAll(/Deno\.env\.get\s*\(/g)]
  checks.push({
    name: 'no_direct_env',
    passed: envMatches.length === 0,
    expected: 'no Deno.env.get() calls',
    actual: envMatches.length ? `${envMatches.length} Deno.env.get() call(s) found` : 'clean',
  })

  // No eval / new Function
  const hasEval = /\beval\s*\(/.test(source) || /\bnew\s+Function\s*\(/.test(source)
  checks.push({
    name: 'no_eval',
    passed: !hasEval,
    expected: 'no eval/Function',
    actual: hasEval ? 'eval detected' : 'clean',
  })

  // No dynamic imports
  const dynamicImports = [...source.matchAll(/\bimport\s*\(/g)]
  checks.push({
    name: 'no_dynamic_import',
    passed: dynamicImports.length === 0,
    expected: 'no dynamic imports',
    actual: dynamicImports.length ? `${dynamicImports.length} dynamic import(s)` : 'clean',
  })

  // Check that code references at least one capability function
  const referencedCaps = capabilityNames.filter(n => {
    const funcName = n.includes('.') ? n.split('.').pop()! : n
    return new RegExp(`\\b${funcName}\\s*\\(`).test(source)
  })
  if (referencedCaps.length === 0) {
    warnings.push('Agent code does not call any declared capabilities')
  }

  return {
    checks,
    allPassed: checks.every(c => c.passed),
    warnings,
  }
}

