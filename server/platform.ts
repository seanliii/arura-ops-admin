import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { ApiError, type AppContext, type ServerConfig } from './types.js'
import type { Order } from '../shared/contracts.js'

export interface TikTokToken {
  openId: string
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}
const TOKEN_ENDPOINT = 'https://open.tiktokapis.com/v2/oauth/token/'
const TRADE_ENDPOINT = 'https://open.tiktokapis.com/v2/minis/trade_order/create/'
const AMOUNT_CHECK_ENDPOINT = 'https://open.tiktokapis.com/v2/minis/utility/check_redeem_amounts/'
const TRADE_QUERY_ENDPOINT = 'https://open.tiktokapis.com/v2/minis/trade_order/query/'

/** The create request may have reached TikTok. Retrying it could create another trade. */
export class PlatformOrderUnknownError extends ApiError {
  constructor() { super(502, 'PLATFORM_ORDER_UNKNOWN', 'TikTokの注文結果を確認中です。新しい注文を作成せず、結果をお待ちください') }
}

async function checkedFetch(url: string, init: RequestInit, creatingOrder = false): Promise<any> {
  let response: globalThis.Response
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(12000) }) }
  catch {
    if (creatingOrder) throw new PlatformOrderUnknownError()
    throw new ApiError(502, 'PLATFORM_UNREACHABLE', 'TikTokに接続できません。後でもう一度お試しください')
  }
  let data: any
  try { data = await response.json() } catch {
    if (creatingOrder) throw new PlatformOrderUnknownError()
    throw new ApiError(502, 'PLATFORM_RESPONSE', 'TikTokから不正な応答がありました')
  }
  const code = data?.error?.code ?? data?.data?.error_code
  if (creatingOrder) {
    const providerCode = String(data?.error?.code ?? '')
    // Official Minis codes: 50001000 is an internal error; 20021002 says the
    // external order already exists. Neither proves that no trade was created.
    if (response.status >= 500 || [408, 409, 429].includes(response.status) ||
      ['50001000', '20021002'].includes(providerCode) ||
      (providerCode !== 'ok' && data?.data?.trade_order_id != null)) throw new PlatformOrderUnknownError()
    // Only an explicit client rejection establishes non-creation. A gateway error,
    // timeout, conflict, or unfamiliar response does not establish an order outcome.
    // 40001000: invalid parameters; 20021001: invalid submerchant configuration.
    if (['40001000', '20021001'].includes(providerCode) ||
      (response.status >= 400 && response.status < 500 &&
        typeof data?.error?.code === 'string' && code && code !== 'ok')) {
      throw new ApiError(502, 'PLATFORM_REJECTED', 'TikTokの注文が拒否されました。設定をご確認ください')
    }
    if (!response.ok || data?.error?.code !== 'ok' || typeof data?.data?.trade_order_id !== 'string' ||
      !data.data.trade_order_id.trim()) throw new PlatformOrderUnknownError()
    return data
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError(502, 'PLATFORM_RESPONSE', 'TikTokから不正な応答がありました')
  }
  if (!response.ok || (code != null && code !== 'ok' && code !== 0)) {
    // Provider errors can include tokens and request details; never expose raw payload.
    throw new ApiError(502, 'PLATFORM_REJECTED', 'TikTokの要求が拒否されました。設定または有効期限をご確認ください')
  }
  return data
}
export async function exchangeTikTokCode(code: string, config: ServerConfig): Promise<TikTokToken> {
  if (!config.tiktokClientKey || !config.tiktokClientSecret || !config.tokenEncryptionKey) {
    throw new ApiError(503, 'TIKTOK_UNCONFIGURED', 'TikTokアカウント連携の設定が必要です')
  }
  if (typeof code !== 'string' || !code.trim() || code.length > 4096) throw new ApiError(400, 'INVALID_CODE', 'ログインコードが無効です')
  const response = await checkedFetch(TOKEN_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: config.tiktokClientKey, client_secret: config.tiktokClientSecret, code, grant_type: 'authorization_code' }),
  })
  const data = response.data || response
  if (typeof data.open_id !== 'string' || !data.open_id || typeof data.access_token !== 'string' || !data.access_token) {
    throw new ApiError(502, 'IDENTITY_MISSING', 'TikTokのユーザー情報を確認できません')
  }
  return { openId: data.open_id, accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in }
}
function encryptionKey(config: ServerConfig): Buffer {
  if (!config.tokenEncryptionKey || !/^[0-9a-f]{64}$/i.test(config.tokenEncryptionKey)) throw new ApiError(503, 'TOKEN_KEY_MISSING', 'サーバーの認証保管設定が必要です')
  return Buffer.from(config.tokenEncryptionKey, 'hex')
}
export function storePlatformTokens(ctx: AppContext, userId: string, token: TikTokToken): void {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(ctx.config), nonce)
  cipher.setAAD(Buffer.from(userId))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(token), 'utf8'), cipher.final()])
  const payload = `${nonce.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`
  ctx.db.prepare(`INSERT INTO platform_tokens(user_id,encrypted_tokens,expires_at,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
    .run(userId, payload, Date.now() + Math.max(0, Number(token.expiresIn) || 0) * 1000, Date.now())
}
export async function accessToken(ctx: AppContext, userId: string): Promise<string> {
  const row = ctx.db.prepare('SELECT * FROM platform_tokens WHERE user_id=?').get(userId) as Record<string, any> | undefined
  if (!row) throw new ApiError(401, 'TIKTOK_LOGIN_REQUIRED', 'TikTokで再ログインしてください')
  let token: TikTokToken
  try {
    const [nonce, tag, ciphertext] = row.encrypted_tokens.split('.')
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(ctx.config), Buffer.from(nonce, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    decipher.setAAD(Buffer.from(userId))
    token = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString())
  } catch { throw new ApiError(401, 'TIKTOK_LOGIN_REQUIRED', 'TikTokで再ログインしてください') }
  if (row.expires_at > Date.now() + 60000) return token.accessToken
  if (!token.refreshToken || !ctx.config.tiktokClientKey || !ctx.config.tiktokClientSecret) {
    throw new ApiError(401, 'TIKTOK_LOGIN_REQUIRED', 'TikTokで再ログインしてください')
  }
  const response = await checkedFetch(TOKEN_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: ctx.config.tiktokClientKey, client_secret: ctx.config.tiktokClientSecret, grant_type: 'refresh_token', refresh_token: token.refreshToken }),
  })
  const data = response.data || response
  if (typeof data.access_token !== 'string' || data.open_id !== token.openId) throw new ApiError(401, 'TIKTOK_LOGIN_REQUIRED', 'TikTokで再ログインしてください')
  storePlatformTokens(ctx, userId, { openId: token.openId, accessToken: data.access_token, refreshToken: data.refresh_token || token.refreshToken, expiresIn: data.expires_in })
  return data.access_token
}
export async function createPlatformOrder(
  ctx: AppContext, userId: string, order: Order, beforeDispatch?: () => void,
): Promise<{ tradeOrderId: string }> {
  if (order.kind === 'vip') throw new ApiError(503, 'SUBSCRIPTION_SKU_REQUIRED', '実際の定期購読には承認済みSKUと契約設定が必要です')
  if (!ctx.config.tiktokClientKey || !ctx.config.tiktokClientSecret || !ctx.config.tokenEncryptionKey) {
    throw new ApiError(503, 'TIKTOK_UNCONFIGURED', 'TikTok決済の設定が必要です')
  }
  // Token acquisition occurs before the non-idempotent create request. A refresh
  // failure is not an uncertain trade creation, and must not be classified as one.
  const token = await accessToken(ctx, userId)
  // This is a read-only price check. Rejection, timeout or an incomplete response
  // proves that this attempt has not submitted a create request yet.
  const amountCheck = await checkedFetch(AMOUNT_CHECK_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ token_type: 'BEANS', token_amounts: [order.amount] }),
  })
  // 2026-10-21真实只读回包使用 vaild；文档仍写 valid。仅兼容这两个已知字段，
  // 都要求严格boolean true；同时出现且矛盾时拒绝，不能把任一truthy值当作批准。
  const amountData = amountCheck.data
  const validityFields = amountData && typeof amountData === 'object' && !Array.isArray(amountData)
    ? ['valid', 'vaild'].filter(field => Object.hasOwn(amountData, field)) : []
  if (amountCheck.error?.code !== 'ok' || !validityFields.length ||
      !validityFields.every(field => amountData[field] === true)) {
    throw new ApiError(502, 'PLATFORM_AMOUNT_REJECTED', 'TikTokが商品の金額を確認できませんでした。時間をおいて再度お試しください')
  }
  // 复用订阅链路的发送前复核：令牌刷新、金额查询都可能等待，不能仅检查最初的会话。
  // 此处必须同步完成，与实际create之间不再await；已发送后的迟到回执仍正常保存。
  if (beforeDispatch) {
    try {
      const result: unknown = beforeDispatch()
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {})
        throw new Error()
      }
    } catch {
      throw new ApiError(409, 'PLATFORM_PRECONDITION_CHANGED', 'アカウント・注文・販売条件が変更されました。購入は送信していません。元の状態を確認してください。')
    }
  }
  const response = await checkedFetch(TRADE_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      token_type: 'BEANS', token_amount: order.amount,
      order_info: { order_id: order.id, product_name: order.title, quantity: 1, quantity_unit: order.kind === 'episode' ? 'episode' : 'drama' },
    }),
  }, true)
  const tradeOrderId = response.data?.trade_order_id
  return { tradeOrderId }
}
export async function queryPlatformOrder(
  ctx: AppContext, userId: string, tradeOrderId: string,
): Promise<{ tradeOrderId: string; status: 'PENDING' | 'SUCCESS' }> {
  if (typeof tradeOrderId !== 'string' || !tradeOrderId.trim()) {
    throw new ApiError(400, 'PLATFORM_TRADE_ID_MISSING', 'TikTokの注文番号を確認できません')
  }
  if (!ctx.config.tiktokClientKey || !ctx.config.tiktokClientSecret || !ctx.config.tokenEncryptionKey) {
    throw new ApiError(503, 'TIKTOK_UNCONFIGURED', 'TikTok決済の設定が必要です')
  }
  const token = await accessToken(ctx, userId)
  const response = await checkedFetch(TRADE_QUERY_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ trade_order_id: tradeOrderId }),
  })
  const status = response.data?.trade_order_status
  if (response.error?.code !== 'ok' || response.data?.trade_order_id !== tradeOrderId ||
    (status !== 'PENDING' && status !== 'SUCCESS')) {
    throw new ApiError(502, 'PLATFORM_QUERY_UNCONFIRMED', 'TikTokの注文状態を確認できませんでした')
  }
  // No amount or environment is guaranteed by this API. A successful query is
  // not a verified payment receipt and cannot authorize fulfillment.
  return { tradeOrderId, status }
}
export function verifyTikTokSignature(body: Buffer, header: string, secret: string, now = Date.now()): void {
  const parts = header.split(',').map(part => part.trim().split('='))
  const times = parts.filter(([key]) => key === 't')
  const signatures = parts.filter(([key]) => key === 's')
  if (times.length !== 1 || signatures.length !== 1 || !/^\d{10}$/.test(times[0][1]) || !/^[a-f0-9]{64}$/i.test(signatures[0][1])) {
    throw new ApiError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature')
  }
  const timestamp = times[0][1]
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) throw new ApiError(401, 'EXPIRED_SIGNATURE', 'Expired webhook signature')
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest()
  if (!timingSafeEqual(expected, Buffer.from(signatures[0][1], 'hex'))) throw new ApiError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature')
}
