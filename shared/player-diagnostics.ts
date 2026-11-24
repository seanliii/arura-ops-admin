/** Troubleshooting hints, not raw SDK logs. Only fixed vocabulary crosses the
 * wire; unknown words become "other". Never use this to decide playback access. */
const sources = ['bridge', 'server', 'ttnet', 'foundation', 'http', 'response_parse', 'native', 'unknown'] as const
const vocabulary = new Set(`other get drama info episode album video play playback player media cloud account
method not found no missing invalid empty unsupported support available unavailable success successful failed failure
error unknown unclassified request response result callback invoke invocation exception data code parse parsing
timeout timed out network disconnected connection connect read write dns resolution tls transport incomplete
traffic control drop aborted native server business bridge http response_parse ttnet foundation jsb jssdk
parameter parameters param params argument arguments type shape format version review submitted progress rejected
withdrawn passed pass online shelf list items urls unusable normalized transform access denied permission permissions
authorized unauthorized authorization authentication auth login required expired token signature mismatch region country
restricted forbidden blocked enforced database internal status inconsistent unexpected null undefined is for user
service api rate limit exceeded disabled enabled cannot cannot_find not_found method_not_found`.replace(/_/g, ' ').split(/\s+/))
const textFields = ['stage', 'reason', 'bridgeMessage', 'serverMessage', 'nativeMessage'] as const
export interface PlayerDiagnostic {
  version: 1
  source?: typeof sources[number]
  stage?: string
  reason?: string
  bridgeMessage?: string
  serverMessage?: string
  nativeMessage?: string
  rawCode?: number
  /** A platform request trace identifier, not a device, account or session ID. */
  requestId?: string
}

function hint(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return
  const scrubbed = value.slice(0, 4096)
    .replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.\w+/gi, '')
    .replace(/(?:authorization|token|play_?auth|drm_?kek|union_info|signature|credential|cookie|secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '')
    .toLowerCase().replace(/_/g, ' ')
  const words = scrubbed.split(/[\s.,;:()[\]{}"'!?/\\]+/).filter(Boolean)
    .map(word => vocabulary.has(word) ? word : 'other')
    .filter((word, index, all) => word !== 'other' || index === 0 || all[index - 1] !== 'other')
  let result = ''
  for (const word of words.slice(0, 20)) {
    const next = result ? `${result} ${word}` : word
    if (next.length > 160) break
    result = next
  }
  return result || undefined
}

export function sanitizePlayerDiagnostic(value: unknown): PlayerDiagnostic {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  const result: PlayerDiagnostic = { version: 1 }
  if (sources.includes(input.source as never)) result.source = input.source as PlayerDiagnostic['source']
  for (const key of textFields) {
    const text = hint(input[key])
    if (text) result[key] = text
  }
  if (typeof input.rawCode === 'number' && Number.isInteger(input.rawCode) &&
      input.rawCode >= -2147483648 && input.rawCode <= 2147483647) result.rawCode = input.rawCode
  // TikTok trace IDs carry a YYYYMMDDhhmmss prefix and an uppercase hex suffix.
  // Reject arbitrary strings even when the SDK labels them "logid".
  if (typeof input.requestId === 'string' &&
      /^20\d{2}[01]\d[0-3]\d[0-2]\d[0-5]\d[0-5]\d[A-F0-9]{8,50}$/.test(input.requestId)) {
    result.requestId = input.requestId
  }
  return result
}

export function isPlayerDiagnostic(value: unknown): value is PlayerDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const sanitized = sanitizePlayerDiagnostic(value)
  const entries = Object.entries(value)
  return entries.length > 1 && entries.length === Object.keys(sanitized).length &&
    entries.every(([key, item]) => sanitized[key as keyof PlayerDiagnostic] === item)
}
