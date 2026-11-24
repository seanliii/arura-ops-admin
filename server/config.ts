import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import type { ServerConfig } from './types.js'
import { loadCloudUploadConfig, DEFAULT_CLOUD_UPLOAD_BYTES, MAX_CLOUD_UPLOAD_BYTES } from './cloud-upload-config.js'
import { loadMediaRegistrationConfig } from './media-registration-config.js'
import { loadSubscriptionConfig } from './subscription-config.js'
import { loadSandboxWebhookTarget } from './sandbox-webhook-relay.js'
import { loadWebPlaybackConfig } from './byteplus-playback-client.js'

// Both `tsx server/index.ts` and `node dist-server/server/index.js` use the same
// data/static roots; compiling must not silently create a second empty database.
let root = dirname(fileURLToPath(import.meta.url))
while (!existsSync(resolve(root, 'package.json')) && dirname(root) !== root) root = dirname(root)
export const projectDir = root
function positive(value: unknown, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error('服务器配置数值必须为正数')
  return n
}
function parseTrustedProxies(value: unknown): string[] {
  const invalid = () => new Error('DRAMA_TRUSTED_PROXIES必须为空或显式IP/CIDR列表，不接受布尔值、跳数、别名或全网范围')
  if (value === undefined) return []
  const entries = typeof value === 'string' ? (value.trim() ? value.split(',') : []) : value
  if (!Array.isArray(entries)) throw invalid()
  return entries.map(entry => {
    if (typeof entry !== 'string') throw invalid()
    const address = entry.trim(), parts = address.split('/'), family = isIP(parts[0])
    if (!family || address.includes('%') || parts.length > 2) throw invalid()
    if (parts.length === 2 && (!/^[1-9]\d*$/.test(parts[1]) || Number(parts[1]) > (family === 4 ? 32 : 128))) throw invalid()
    return address
  })
}
export function loadConfig(options: Partial<ServerConfig> = {}): ServerConfig {
  const mode = options.mode ?? process.env.DRAMA_MODE ?? 'local'
  const paymentMode = options.paymentMode ?? (process.env.DRAMA_PAYMENT_MODE?.trim() || (mode === 'local' ? 'sandbox' : 'disabled'))
  if (!['local', 'staging', 'production'].includes(mode)) throw new Error('无效的 DRAMA_MODE')
  if (!['sandbox', 'disabled', 'tiktok'].includes(paymentMode)) throw new Error('无效的 DRAMA_PAYMENT_MODE')
  if (mode !== 'local' && paymentMode === 'sandbox') throw new Error('预发布和生产环境禁止本地 sandbox 支付')
  const cookieSameSite = options.cookieSameSite ?? (process.env.DRAMA_COOKIE_SAMESITE?.trim() || 'strict')
  if (cookieSameSite !== 'strict' && cookieSameSite !== 'none') throw new Error('DRAMA_COOKIE_SAMESITE必须为strict或none')
  const secureEnv = process.env.DRAMA_COOKIE_SECURE?.trim()
  if (options.cookieSecure === undefined && secureEnv && !['true', 'false'].includes(secureEnv)) throw new Error('DRAMA_COOKIE_SECURE必须为true或false')
  const cookieSecure = options.cookieSecure ?? (secureEnv ? secureEnv === 'true' : mode !== 'local')
  const sessionCookieName = options.sessionCookieName ?? process.env.DRAMA_SESSION_COOKIE_NAME ?? 'drama_session'
  const sessionCookiePath = options.sessionCookiePath ?? process.env.DRAMA_SESSION_COOKIE_PATH ?? '/'
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(sessionCookieName) ||
      !/^(?:\/|\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/)$/.test(sessionCookiePath)) {
    throw new Error('会话Cookie名称或路径格式无效')
  }
  if (cookieSameSite === 'none' && cookieSecure !== true) throw new Error('SameSite=None必须启用Secure Cookie（cookieSecure=true）')
  const port = process.env.DRAMA_PORT || process.env.PORT || '5310'
  const defaultOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
  if (mode === 'local') {
    for (const devPort of [5173, 5174]) {
      defaultOrigins.push(`http://127.0.0.1:${devPort}`, `http://localhost:${devPort}`)
    }
  }
  const configuredOrigins = process.env.DRAMA_ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean)
  if (process.env.DRAMA_ANALYTICS_ENABLED && !['true','false'].includes(process.env.DRAMA_ANALYTICS_ENABLED)) throw new Error('DRAMA_ANALYTICS_ENABLED必须为true或false')
  const config: ServerConfig = {
    analyticsEnabled: options.analyticsEnabled ?? process.env.DRAMA_ANALYTICS_ENABLED !== 'false',
    catalogRegion: options.catalogRegion ?? process.env.DRAMA_CATALOG_REGION?.trim() ?? 'JP',
    dataDir: resolve(options.dataDir ?? (process.env.DRAMA_DATA_DIR?.trim() || resolve(projectDir, `.${mode}`))),
    mode: mode as ServerConfig['mode'], paymentMode: paymentMode as ServerConfig['paymentMode'],
    allowedOrigins: options.allowedOrigins ?? (configuredOrigins?.length ? configuredOrigins : defaultOrigins),
    trustedProxies: parseTrustedProxies(options.trustedProxies === undefined ? process.env.DRAMA_TRUSTED_PROXIES : options.trustedProxies),
    cookieSecure, cookieSameSite, sessionCookieName, sessionCookiePath,
    sessionHours: positive(options.sessionHours ?? process.env.DRAMA_SESSION_HOURS, 24 * 7),
    uploadMaxBytes: positive(options.uploadMaxBytes, 200 * 1024 * 1024),
    vipPrice: positive(options.vipPrice ?? process.env.DRAMA_VIP_PRICE, 1000),
    vipDays: positive(options.vipDays ?? process.env.DRAMA_VIP_DAYS, 30),
    tiktokClientKey: options.tiktokClientKey ?? process.env.TIKTOK_CLIENT_KEY,
    tiktokClientSecret: options.tiktokClientSecret ?? process.env.TIKTOK_CLIENT_SECRET,
    tiktokWebhookSecret: options.tiktokWebhookSecret ?? process.env.TIKTOK_WEBHOOK_SECRET,
    sandboxWebhookTarget: loadSandboxWebhookTarget(mode as ServerConfig['mode'],
      options.sandboxWebhookTarget === undefined ? process.env.TIKTOK_SANDBOX_WEBHOOK_TARGET : options.sandboxWebhookTarget),
    tokenEncryptionKey: options.tokenEncryptionKey ?? process.env.TOKEN_ENCRYPTION_KEY,
    byteplusUpload: loadCloudUploadConfig(options.byteplusUpload),
    webPlayback: loadWebPlaybackConfig(options.webPlayback),
    mediaRegistration: loadMediaRegistrationConfig(options.mediaRegistration),
    subscription: loadSubscriptionConfig(mode as ServerConfig['mode'], options.subscription),
    cloudUploadMaxBytes: positive(options.cloudUploadMaxBytes ?? process.env.BYTEPLUS_UPLOAD_MAX_BYTES, DEFAULT_CLOUD_UPLOAD_BYTES),
  }
  if (!/^[A-Z]{2}$/.test(config.catalogRegion!)) throw new Error('DRAMA_CATALOG_REGION必须是显式大写双字母地区代码')
  if (config.sandboxWebhookTarget && Number(port) === 5315) throw new Error('TIKTOK_SANDBOX_WEBHOOK_TARGET不能指向自身监听的5315端口')
  if (config.tokenEncryptionKey && !/^[a-fA-F0-9]{64}$/.test(config.tokenEncryptionKey)) throw new Error('TOKEN_ENCRYPTION_KEY必须是64位十六进制字符串')
  if (!Number.isSafeInteger(config.vipPrice) || !Number.isSafeInteger(config.uploadMaxBytes) || config.uploadMaxBytes > 200 * 1024 * 1024) throw new Error('价格必须为整数，上传限额不能超过200MB')
  if (!Number.isSafeInteger(config.cloudUploadMaxBytes) || config.cloudUploadMaxBytes! > MAX_CLOUD_UPLOAD_BYTES) throw new Error('云上传文件限额必须为正整数字节数且不超过20000000000；与本地上传限额分开')
  for (const origin of config.allowedOrigins) {
    const u = new URL(origin)
    if (!['http:', 'https:'].includes(u.protocol) || origin !== u.origin || origin.includes('*')) throw new Error('Origin必须是精确的完整协议与主机，不可包含路径或通配符')
  }
  return config
}
