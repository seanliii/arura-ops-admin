/**
 * 仅选择播放协议，不证明宿主身份，也不授予观看权限；HTTP UA 可被伪造。
 * 依据本地 sdk.raw.js 的 c()/l()/En()：AppVersion 的两种格式、平台标记、
 * 数字分段比较；getDramaInfo/getPlayer 在 iOS/Android 的门槛均为 44.5.0。
 * 与 SDK 的宽松缺省不同，缺失、重复、歧义或非数字版本一律保留旧 token。
 */
export function supportsModernMinisPlayback(rawHeaders: readonly string[]): boolean {
  const agents: string[] = []
  for (let i = 0; i < rawHeaders.length; i += 2) {
    // req.get() 会隐藏 Node 丢弃的重复 User-Agent，必须检查原始 HTTP 头。
    if (rawHeaders[i]?.toLowerCase() === 'user-agent') agents.push(rawHeaders[i + 1] ?? '')
  }
  if (agents.length !== 1) return false
  const ua = agents[0]!
  const android = /android/i.test(ua), ios = /iPad|iPhone|iPod/.test(ua)
  if (android === ios) return false // 未知平台或同时出现两种平台。
  if ((ua.match(/\bAppVersion(?=[^a-z0-9]|$)/gi) ?? []).length !== 1) return false

  let appVersion: string | undefined
  // 保留 SDK 的顺序及分隔符语义，不把任意 UA 子串猜成 AppVersion。
  const remaining = `${ua} `.replace(/(\b[A-Za-z_]+)_([\d.]+\b) /g, (_match, key: string, value: string) => {
    if (key === 'AppVersion') appVersion = value
    return ''
  })
  for (const field of remaining.match(/([^/]+)\/([^/]*) /g) ?? []) {
    const [key, value] = field.slice(0, -1).split('/')
    if (key === 'AppVersion') appVersion = value
  }
  if (!appVersion || !/^\d+(?:\.\d+)*$/.test(appVersion)) return false
  const parts = appVersion.split('.').map(Number)
  if (!parts.every(Number.isSafeInteger)) return false
  const minimum = [44, 5, 0]
  for (let i = 0; i < minimum.length; i++) {
    const part = parts[i] ?? 0 // 与 SDK 一样，44.5 等价于 44.5.0。
    if (part !== minimum[i]) return part > minimum[i]!
  }
  return true
}
