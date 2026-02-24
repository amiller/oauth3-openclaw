import { createHash, randomBytes } from 'crypto'
import { CapabilityPlugin, PluginCodegenResult, EndowmentFactory } from './types.js'

export interface TiktokHistorySpec {
  type: 'tiktok-history'
  name: string
  doc_url: string
  cookie_secret: string
  proxy_url_secret?: string  // SOCKS5 proxy URL for geo-restricted access
}

const XBOGUS_ALPHABET = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe'
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

function generateXBogus(queryString: string, userAgent: string): string {
  const ts = Math.floor(Date.now() / 1000)
  const hash = createHash('md5').update(queryString + userAgent + ts).digest('hex')
  let encoded = ''
  for (let i = 0; i < hash.length; i += 2)
    encoded += XBOGUS_ALPHABET[parseInt(hash.substring(i, i + 2), 16) % XBOGUS_ALPHABET.length]
  return encoded.slice(0, 24)
}

function generateVerifyFp(): string {
  return 'verify_' + randomBytes(4).toString('hex')
}

function buildQueryParams(count: string, maxCursor?: string): Record<string, string> {
  const p: Record<string, string> = {
    scene: '1',
    count,
    timezone_offset: '0',
    aid: '1180',
    device_id: (Date.now().toString() + Math.floor(Math.random() * 999999).toString().padStart(6, '0')).slice(0, 19),
    device_type: 'web_h264',
    screen_width: '1920', window_width: '1920',
    screen_height: '1080', window_height: '1080',
    browser_language: 'en-US', browser_name: 'Mozilla',
    browser_online: 'true', browser_platform: 'Win32',
    browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    app_language: 'en-US', app_name: 'tiktok_web',
    channel: 'tiktok_web', cookie_enabled: 'true',
    data_collection_enabled: 'true', device_platform: 'web_pc',
    focus_state: 'true', from_page: 'watch_history',
    history_len: '4', is_fullscreen: 'false', is_page_visible: 'true',
    os: 'windows', priority_region: 'US',
    referer: 'https://www.tiktok.com/tpp/watch-history',
    region: 'US', root_referer: 'https://www.tiktok.com/',
    tz_name: 'America/New_York', user_is_login: 'true',
    verifyFp: generateVerifyFp(),
    webcast_language: 'en',
    WebIdLastTime: Math.floor(Date.now() / 1000).toString(),
  }
  if (maxCursor && maxCursor !== '0') p.max_cursor = maxCursor
  return p
}

function validate(spec: any): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!spec || typeof spec !== 'object') return { valid: false, errors: ['spec must be an object'] }
  if (typeof spec.name !== 'string' || !spec.name) errors.push('name required')
  if (typeof spec.doc_url !== 'string' || !spec.doc_url) errors.push('doc_url required')
  if (typeof spec.cookie_secret !== 'string' || !spec.cookie_secret) errors.push('cookie_secret required')
  return { valid: errors.length === 0, errors }
}

function secrets(spec: TiktokHistorySpec): string[] {
  return [spec.cookie_secret, spec.proxy_url_secret].filter(Boolean) as string[]
}

function networks(): string[] { return ['www.tiktok.com'] }

function summarize(spec: TiktokHistorySpec): string {
  return `TikTok watch history — cookies: ${spec.cookie_secret}`
}

function codegen(spec: TiktokHistorySpec): Promise<PluginCodegenResult> {
  const fnName = spec.name.split('.').pop()!
  const signature = `async function ${fnName}(count: string, max_cursor?: string): Promise<{videos: any[], has_more: boolean, next_cursor: string}>`

  const code = [
    `${signature} {`,
    `  // count: 1-20 videos per page`,
    `  // max_cursor: pass next_cursor from previous response to get next page (omit for first page)`,
    `  // Returns: { videos: [...], has_more: boolean, next_cursor: string }`,
    `}`,
  ].join('\n')

  const endowment: EndowmentFactory = {
    build(secretsMap: Record<string, string>) {
      return async (...callArgs: any[]) => {
        const count = String(callArgs[0] || '20')
        const maxCursor = callArgs[1] ? String(callArgs[1]) : undefined
        const n = parseInt(count, 10)
        if (isNaN(n) || n < 1 || n > 20) throw new Error('count must be 1-20')

        const raw = secretsMap[spec.cookie_secret]
        if (!raw) throw new Error(`missing secret ${spec.cookie_secret}`)
        const sec = JSON.parse(raw)
        const cookies: any[] = Array.isArray(sec.cookies) ? sec.cookies : (Array.isArray(sec) ? sec : [])
        const tiktokCookies = cookies.filter((c: any) => c.domain && (c.domain.endsWith('.tiktok.com') || c.domain === 'tiktok.com'))
        if (!tiktokCookies.some((c: any) => c.name === 'sessionid'))
          throw new Error('sessionid cookie missing — TikTok session expired?')

        const cookieStr = tiktokCookies.map((c: any) => `${c.name}=${c.value}`).join('; ')
        const userAgent = sec.user_agent || DEFAULT_UA

        const params = buildQueryParams(count, maxCursor)
        const qs = new URLSearchParams(params).toString()
        params['X_Bogus'] = generateXBogus(qs, userAgent)
        const finalQs = new URLSearchParams(params).toString()
        const url = `https://www.tiktok.com/tiktok/watch/history/list/v1/?${finalQs}`

        // TODO: SOCKS5 proxy support via proxy_url_secret
        const r = await fetch(url, {
          method: 'GET',
          headers: {
            'Cookie': cookieStr,
            'User-Agent': userAgent,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.tiktok.com/tpp/watch-history',
            'Origin': 'https://www.tiktok.com',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
        const data = await r.json() as any
        if (data.status_code !== 0) throw new Error(`TikTok API error ${data.status_code}: ${data.status_msg || 'unknown'}`)

        const watchTimestamps: string[] = data.aweme_watch_history || []
        const nextCursor = watchTimestamps.length > 0
          ? watchTimestamps[watchTimestamps.length - 1]
          : (data.max_cursor || '0')

        return {
          videos: data.aweme_list || [],
          has_more: data.has_more === 1,
          next_cursor: String(nextCursor),
        }
      }
    }
  }

  return Promise.resolve({ code, signature, endowment })
}

export const tiktokHistoryPlugin: CapabilityPlugin = {
  type: 'tiktok-history',
  describe: () => ({
    type: 'tiktok-history',
    description: 'Fetch TikTok watch history. Returns paginated list of watched videos.',
    spec_schema: {
      type: '"tiktok-history"', name: 'string', doc_url: 'string',
      cookie_secret: 'string (name of stored cookie secret, e.g. COOKIES_TIKTOK_COM)',
      proxy_url_secret: 'string (optional, SOCKS5 proxy secret name)',
    },
    example_spec: {
      type: 'tiktok-history', name: 'tiktok.watchHistory',
      doc_url: 'https://www.tiktok.com/tpp/watch-history',
      cookie_secret: 'COOKIES_TIKTOK_COM',
    },
  }),
  validateSpec: validate,
  extractSecrets: secrets,
  extractNetworks: networks,
  summarize,
  codegen,
}
