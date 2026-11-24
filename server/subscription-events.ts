import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import type { Router } from 'express'
import { ApiError, type AppContext } from './types.js'
import { transaction } from './db.js'
import { verifyTikTokSignature } from './platform.js'
import { invalidateSubscriptionAccess } from './subscription-access.js'
import type { SubscriptionProcessing } from '../shared/subscriptions.js'
import type { SubscriptionLedgerLocation } from '../shared/subscription-review.js'

/**
 * 原始收件与后续核销分开；本模块只验签、加密保存，不自行发权或计算退款。
 * 依据：artifacts/subscription-research-20261015/official-sources.md。
 */
const knownEvents = new Set([
  'minis.subscription.create', 'minis.subscription.renew', 'minis.subscription.onhold',
  'minis.subscription.expire', 'minis.subscription.reactivate',
  'minis.subscription.cancel', 'minis.subscription.refund', 'minis.subscription.revoke',
])
type Receipt = {
  id: number; client_key: string; receiving_mode: string; event_type: string
  payload_sha256: string; encrypted_payload: string
}
function storageKey(ctx: AppContext): Buffer {
  const key = ctx.config.tokenEncryptionKey
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) {
    throw new ApiError(503, 'SUBSCRIPTION_STORAGE_UNAVAILABLE', '订阅通知安全存储尚未配置，未确认接收')
  }
  return Buffer.from(key, 'hex')
}
function aad(app: string, mode: string, event: string, fingerprint: string): Buffer {
  return Buffer.from(JSON.stringify([app, mode, event, fingerprint]), 'utf8')
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function invalidEvent(): never {
  throw new ApiError(400, 'INVALID_SUBSCRIPTION_EVENT', '订阅通知外层格式不符合已确认的协议')
}
function pageInteger(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new ApiError(400, 'INVALID_PAGINATION', '分页参数必须是有效的正整数')
  }
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result > max) {
    throw new ApiError(400, 'INVALID_PAGINATION', '分页参数超出允许范围')
  }
  return result
}

/** Returns a receipt id only after a verified, encrypted, durable transaction commits. */
export function receiveSubscriptionWebhook(ctx: AppContext, rawBody: Buffer, signature: string): string | null {
  let event: unknown
  try { event = JSON.parse(rawBody.toString('utf8')) } catch { invalidEvent() }
  if (!isRecord(event)) invalidEvent()
  if (typeof event.event !== 'string' || !event.event.startsWith('minis.subscription.')) return null
  if (!/^minis\.subscription\.[a-z0-9_.-]{1,96}$/.test(event.event)) invalidEvent()
  if (!ctx.config.tiktokClientKey || !ctx.config.tiktokClientSecret) {
    throw new ApiError(503, 'TIKTOK_UNCONFIGURED', '订阅通知所属应用尚未配置')
  }
  // 独立验证，避免未来调用方误把未经验证的请求交给此收件函数。
  verifyTikTokSignature(rawBody, signature, ctx.config.tiktokClientSecret)
  if (event.client_key !== ctx.config.tiktokClientKey) {
    throw new ApiError(403, 'CLIENT_MISMATCH', '订阅通知不属于当前应用')
  }
  if (typeof event.create_time !== 'number' || !Number.isSafeInteger(event.create_time) ||
    event.create_time <= 0 || event.create_time > Math.floor(Date.now() / 1000) + 300) invalidEvent()
  if (event.user_openid != null &&
    (typeof event.user_openid !== 'string' || !event.user_openid.trim() || event.user_openid.length > 256)) invalidEvent()
  // 只核查通用 envelope 的格式，不据其未知字段解释财务结果。
  if (typeof event.content !== 'string') invalidEvent()
  try { if (!isRecord(JSON.parse(event.content))) invalidEvent() } catch { invalidEvent() }

  const app = ctx.config.tiktokClientKey, mode = ctx.config.mode
  const key = storageKey(ctx), fingerprint = createHash('sha256').update(rawBody).digest('hex')
  const eventType = event.event, createdAt = event.create_time * 1000, receivedAt = Date.now()
  const openId = typeof event.user_openid === 'string' ? event.user_openid : null
  const user = openId ? ctx.db.prepare("SELECT id FROM users WHERE provider='tiktok' AND provider_id=?")
    .get(`${app}:${openId}`) : undefined
  const userId = user ? String(user.id) : null
  const identityHash = openId
    ? createHmac('sha256', key).update(JSON.stringify([app, openId])).digest('hex') : null
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad(app, mode, eventType, fingerprint))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ raw: rawBody.toString('base64'), signature }), 'utf8'), cipher.final(),
  ])
  const encrypted = [nonce, cipher.getAuthTag(), ciphertext].map(value => value.toString('base64')).join('.')
  return transaction(ctx.db, () => {
    const result = ctx.db.prepare(`INSERT INTO subscription_webhook_receipts
      (client_key,receiving_mode,event_type,event_created_at,received_at,user_id,user_identity_hash,
       payload_sha256,encrypted_payload,status)
      VALUES (?,?,?,?,?,?,?,?,?,'pending_contract')`)
      .run(app, mode, eventType, createdAt, receivedAt, userId, identityHash, fingerprint, encrypted)
    const id = String(result.lastInsertRowid)
    // The event's content is not a payment proof yet. It only makes the current
    // observation stale; the user's own platform query decides access again.
    if (userId) invalidateSubscriptionAccess(ctx, userId)
    ctx.audit(userId, 'subscription.event.received', 'subscription_receipt', id, {
      event: eventType, payloadSha256: fingerprint, fulfillment: 'pending_contract',
    })
    return id
  })
}

/** Internal worker API only; no HTTP endpoint returns this plaintext packet. */
export function loadSubscriptionReceipt(ctx: AppContext, receiptId: string): { rawBody: Buffer; signature: string } {
  const id = pageInteger(receiptId, 0)
  const row = ctx.db.prepare('SELECT * FROM subscription_webhook_receipts WHERE id=?').get(id) as Receipt | undefined
  if (!row || row.client_key !== ctx.config.tiktokClientKey || row.receiving_mode !== ctx.config.mode) {
    throw new ApiError(404, 'SUBSCRIPTION_RECEIPT_UNAVAILABLE', '无法读取此订阅通知')
  }
  try {
    const [nonce, tag, encrypted, extra] = row.encrypted_payload.split('.')
    if (!nonce || !tag || !encrypted || extra !== undefined) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', storageKey(ctx), Buffer.from(nonce, 'base64'))
    decipher.setAAD(aad(row.client_key, row.receiving_mode, row.event_type, row.payload_sha256))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    const packet = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')), decipher.final(),
    ]).toString('utf8'))
    if (!isRecord(packet) || typeof packet.raw !== 'string' || typeof packet.signature !== 'string') throw new Error()
    const rawBody = Buffer.from(packet.raw, 'base64')
    if (createHash('sha256').update(rawBody).digest('hex') !== row.payload_sha256) throw new Error()
    return { rawBody, signature: packet.signature }
  } catch {
    throw new ApiError(503, 'SUBSCRIPTION_RECEIPT_UNREADABLE', '订阅通知无法安全解密，请检查对应存储密钥与备份')
  }
}

export function registerSubscriptionInbox(
  router: Router, ctx: AppContext,
  processingView?: (receiptId: string) => SubscriptionProcessing | undefined,
  ledgerLocation?: (receiptId: string) => SubscriptionLedgerLocation | null,
): void {
  // 幂等追加表，不重置或迁移现有购买记录；只在应用初始化时执行。
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_webhook_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_key TEXT NOT NULL,
      receiving_mode TEXT NOT NULL CHECK(receiving_mode IN ('local','staging','production')),
      event_type TEXT NOT NULL, event_created_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL, user_identity_hash TEXT,
      payload_sha256 TEXT NOT NULL, encrypted_payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_contract' CHECK(status='pending_contract')
    );
    CREATE INDEX IF NOT EXISTS subscription_receipts_fingerprint
      ON subscription_webhook_receipts(client_key,receiving_mode,payload_sha256);
  `)
  router.get('/admin/subscription-events', (req, res) => {
    ctx.requireAdmin(req)
    if (Object.keys(req.query).some(key => !['limit', 'before', 'receiptId'].includes(key))) {
      throw new ApiError(400, 'INVALID_PAGINATION', '订阅通知查询参数无效')
    }
    const limit = pageInteger(req.query.limit, 20, 100)
    const before = pageInteger(req.query.before, Number.MAX_SAFE_INTEGER)
    const receipt = req.query.receiptId === undefined ? null : pageInteger(req.query.receiptId, 0)
    const rows = ctx.db.prepare(`SELECT r.id,r.event_type,r.event_created_at,r.received_at,
      r.receiving_mode,r.user_id,r.payload_sha256,r.status,
      (SELECT COUNT(*) FROM subscription_webhook_receipts d
        WHERE d.client_key=r.client_key AND d.receiving_mode=r.receiving_mode
          AND d.payload_sha256=r.payload_sha256) AS delivery_count
      FROM subscription_webhook_receipts r
      WHERE r.client_key=? AND r.receiving_mode=? AND r.id<?
        ${receipt === null ? '' : 'AND r.id=?'} ORDER BY r.id DESC LIMIT ?`)
      .all(ctx.config.tiktokClientKey ?? '', ctx.config.mode, before, ...(receipt === null ? [] : [receipt]), limit + 1)
    const more = rows.length > limit
    const events = rows.slice(0, limit).map(row => ({
      id: String(row.id), event: row.event_type, eventCreatedAt: row.event_created_at,
      receivedAt: row.received_at, receivingMode: row.receiving_mode,
      sourceEnvironment: 'unverified' as const, userId: row.user_id,
      payloadSha256: row.payload_sha256, deliveryCount: row.delivery_count,
      status: row.status, knownEvent: knownEvents.has(String(row.event_type)),
      ...(processingView ? { processing: processingView(String(row.id)) } : {}),
      ...(ledgerLocation ? { ledgerLocation: ledgerLocation(String(row.id)) } : {}),
    }))
    res.json({ events, nextCursor: more ? events.at(-1)!.id : null })
  })
}
