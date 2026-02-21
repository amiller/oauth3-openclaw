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

function extractHost(url: string): string | null {
  try { return new URL(url).hostname } catch { return null }
}

export function verifyAgainstScope(
  analysis: StaticAnalysis,
  scope: { secrets: string[]; networks: string[]; argKeys?: string[] }
): VerificationResult {
  const checks: VerificationCheck[] = []
  const warnings: string[] = []
  const allowedHosts = scope.networks
  const allowedVars = [...scope.secrets, ...(scope.argKeys || [])]

  // Check fetch URL hosts
  const fetchHosts = [...new Set(analysis.fetchUrls.map(f => extractHost(f.url)).filter(Boolean))] as string[]
  const unauthorizedHosts = fetchHosts.filter(h => !allowedHosts.includes(h))
  checks.push({
    name: 'fetch_urls',
    passed: unauthorizedHosts.length === 0,
    expected: allowedHosts.join(', ') || '(none)',
    actual: fetchHosts.join(', ') || '(none)',
    details: unauthorizedHosts.length ? `Unauthorized: ${unauthorizedHosts.join(', ')}` : undefined,
  })

  // Check env vars
  const unauthorizedVars = analysis.envVars.filter(v => !allowedVars.includes(v))
  checks.push({
    name: 'env_vars',
    passed: unauthorizedVars.length === 0,
    expected: allowedVars.join(', ') || '(none)',
    actual: analysis.envVars.join(', ') || '(none)',
    details: unauthorizedVars.length ? `Unauthorized: ${unauthorizedVars.join(', ')}` : undefined,
  })

  // No eval
  checks.push({
    name: 'no_eval',
    passed: !analysis.hasEval,
    expected: 'no eval/Function',
    actual: analysis.hasEval ? 'eval detected' : 'clean',
  })

  // Dynamic fetch warning
  if (analysis.hasDynamicFetch) {
    warnings.push('Dynamic fetch URLs detected — runtime sandbox will enforce network restrictions')
  }

  // Dynamic imports warning
  const dynamicImports = analysis.imports.filter(i => !i.startsWith('https://') && !i.startsWith('npm:') && !i.startsWith('node:'))
  if (dynamicImports.length) {
    warnings.push(`Relative/unknown imports: ${dynamicImports.join(', ')}`)
  }

  return {
    checks,
    allPassed: checks.every(c => c.passed),
    warnings,
  }
}
