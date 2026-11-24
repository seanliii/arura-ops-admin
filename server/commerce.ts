import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Router } from 'express'
import { recordAnalyticsOrder } from './analytics-ledger.js'
import type { Entitlement, Order, OrderKind, PaymentAttemptClaim } from '../shared/contracts.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { createPlatformOrder, PlatformOrderUnknownError, queryPlatformOrder, verifyTikTokSignature } from './platform.js'
import { canPurchaseContent } from './catalog-policy.js'
import { receiveSubscriptionWebhook, registerSubscriptionInbox } from './subscription-events.js'
import { registerSubscriptionInspection } from './subscription-inspection.js'
import { registerSubscriptionWorkflow, subscriptionProcessingDTO } from './subscription-workflow.js'
import { readSubscriptionAccess, refreshSubscriptionAccess } from './subscription-access.js'
import {
  initializeSubscriptionLedger, processSubscriptionReceipt, readSubscriptionProcessing,
  readSubscriptionReceiptLocation, reprocessSubscriptionReceipts,
} from './subscription-ledger.js'
import { isSandboxWebhook, relaySandboxWebhook } from './sandbox-webhook-relay.js'

type Row = Record<string, any>
const one = (ctx: AppContext, sql: string, ...args: any[]) => ctx.db.prepare(sql).get(...args) as Row | undefined
const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message) }
const orderRow = (ctx: AppContext, id: string) => one(ctx, 'SELECT * FROM orders WHERE id=?', id)

export function activeEntitlements(ctx: AppContext, userId: string): Entitlement[] {
  const now = Date.now()
  return (ctx.db.prepare(`SELECT e.* FROM entitlements e JOIN orders o ON o.id=e.order_id
    LEFT JOIN platform_order_attempts a ON a.order_id=o.id
    WHERE e.user_id=? AND e.revoked_at IS NULL
    AND e.starts_at<=? AND (e.expires_at IS NULL OR e.expires_at>?)
    AND (? <> 'production' OR (o.provider='tiktok' AND (a.is_sandbox IS NULL OR a.is_sandbox=0)))
    AND (? <> 'staging' OR (o.provider='tiktok' AND a.is_sandbox=1))`)
    .all(userId, now, now, ctx.config.mode, ctx.config.mode) as Row[])
    .map(row => ({ id: row.id, kind: row.kind, targetId: row.target_id, orderId: row.order_id, expiresAt: row.expires_at }))
}

export function hasEpisodeAccess(ctx: AppContext, userId: string | null, episodeId: number, includeSubscription = true): boolean {
  const episode = one(ctx, `SELECT e.*,d.status,d.free_episodes,d.regions FROM episodes e
    JOIN dramas d ON d.id=e.drama_id WHERE e.id=?`, episodeId)
  if (!episode || episode.status !== 'published' || !JSON.parse(episode.regions).includes(ctx.config.catalogRegion ?? 'JP')) return false
  if (episode.seq <= episode.free_episodes) return true
  if (!userId) return false
  return activeEntitlements(ctx, userId).some(e => e.kind === 'vip' ||
    (e.kind === 'drama' && e.targetId === episode.drama_id) || (e.kind === 'episode' && e.targetId === episodeId)) ||
    (includeSubscription && readSubscriptionAccess(ctx, userId).status === 'valid')
}

function requestOrder(ctx: AppContext, userId: string, key: string) {
  return one(ctx, `SELECT o.* FROM order_request_keys k JOIN orders o ON o.id=k.order_id
    WHERE k.user_id=? AND k.request_key=?`, userId, key) ||
    one(ctx, 'SELECT * FROM orders WHERE user_id=? AND request_key=?', userId, key)
}
function pendingProductOrder(ctx: AppContext, userId: string, kind: OrderKind, targetId: number | null, now: number) {
  return one(ctx, `SELECT o.* FROM orders o LEFT JOIN platform_order_attempts a ON a.order_id=o.id
    LEFT JOIN beans_payment_attempts b ON b.order_id=o.id
    WHERE o.user_id=? AND o.kind=? AND o.target_id IS ? AND (
      (o.provider='tiktok' AND o.status IN ('pending','processing','cancelled','failed')
        AND (a.state IS NULL OR a.state<>'not_created')
        AND (b.released_at IS NULL OR b.outcome='succeeded' OR EXISTS
          (SELECT 1 FROM platform_order_checks c WHERE c.order_id=o.id AND c.status='SUCCESS')))
      OR (o.provider='sandbox' AND ?='sandbox' AND o.status IN ('pending','processing') AND o.expires_at>?)
    ) ORDER BY o.created_at DESC LIMIT 1`, userId, kind, targetId, ctx.config.paymentMode, now)
}
function dto(ctx: AppContext, row: Row): Order {
  const attempt = one(ctx, 'SELECT outcome,released_at FROM beans_payment_attempts WHERE order_id=?', row.id)
  const episode = row.kind === 'episode'
    ? one(ctx, 'SELECT drama_id,seq FROM episodes WHERE id=?', row.target_id) : undefined
  return {
    id: row.id, kind: row.kind, targetId: row.target_id, title: row.title, amount: row.amount,
    dramaId: row.kind === 'drama' ? row.target_id : episode?.drama_id ?? null,
    episodeSeq: episode?.seq ?? null,
    currency: row.currency, provider: row.provider, status: row.status, tradeOrderId: row.trade_order_id,
    createdAt: row.created_at, paidAt: row.paid_at, expiresAt: row.expires_at,
    ...(attempt ? { paymentAttempt: { outcome: attempt.outcome, released: attempt.released_at !== null } } : {}),
    ...(row.user_email !== undefined ? { userId: row.user_id, userEmail: row.user_email } : {}),
  }
}
function owned(ctx: AppContext, id: string, userId: string): Row {
  const order = orderRow(ctx, id)
  if (!order || order.user_id !== userId) return fail(404, 'ORDER_NOT_FOUND', '注文が見つかりません')
  return order
}
const processingNotice = {
  code: 'PAYMENT_RESULT_UNKNOWN',
  message: 'TikTokの支払い結果を確認中です。キャンセルや新しい注文は行わず、結果をお待ちください。',
}
type ProviderCheck = {
  status: 'PENDING' | 'SUCCESS' | 'UNCONFIRMED'
  checkedAt: number
  receiptConfirmed: boolean
}
const checkNotices = {
  PENDING: { code: 'PAYMENT_PROVIDER_PENDING', message: 'TikTokの注文は確認待ちです。新しい注文を作成せず、結果をお待ちください。' },
  SUCCESS: { code: 'PAYMENT_RECEIPT_PENDING', message: 'TikTokは支払い成功を返しましたが、有効な通知を待っています。権利の反映まで再購入せずお待ちください。' },
  UNCONFIRMED: { code: 'PAYMENT_CHECK_UNCONFIRMED', message: 'TikTokの注文状態を確認できませんでした。再購入せず、時間をおいてもう一度確認してください。' },
}
function orderResponse(ctx: AppContext, row: Row, providerCheck?: ProviderCheck) {
  const notice = providerCheck
    ? (providerCheck.receiptConfirmed ? undefined : checkNotices[providerCheck.status])
    : (row.provider === 'tiktok' && row.status === 'processing' ? processingNotice : undefined)
  return { order: dto(ctx, row), ...(notice ? { notice } : {}), ...(providerCheck ? { providerCheck } : {}) }
}
function latestProviderCheck(ctx: AppContext, row: Row): ProviderCheck | undefined {
  if (row.provider !== 'tiktok') return undefined
  const check = one(ctx, 'SELECT status,checked_at FROM platform_order_checks WHERE order_id=? AND trade_order_id=?', row.id, row.trade_order_id)
  if (!check) return undefined
  // Read receipt evidence now, not the snapshot from before an awaited query.
  // Late payments/refunds therefore win without any changes to webhook handling.
  const receiptConfirmed = Boolean(one(ctx, `SELECT 1 FROM payment_events
    WHERE order_id=? AND provider='tiktok' AND event_type IN ('paid','refunded') LIMIT 1`, row.id))
  return { status: check.status, checkedAt: check.checked_at, receiptConfirmed }
}
const checkCooldownMs = 30000
const inFlightOrderChecks = new WeakMap<AppContext['db'], Map<string, Promise<void>>>()
async function reconcilePlatformOrder(ctx: AppContext, row: Row, force = false): Promise<void> {
  let inFlight = inFlightOrderChecks.get(ctx.db)
  if (!inFlight) { inFlight = new Map(); inFlightOrderChecks.set(ctx.db, inFlight) }
  const running = inFlight.get(row.id)
  if (running) { await running; return }
  const now = Date.now(), checkId = randomUUID()
  const claimed = transaction(ctx, () => {
    const previous = one(ctx, 'SELECT trade_order_id,next_check_at FROM platform_order_checks WHERE order_id=?', row.id)
    if (!force && previous && previous.trade_order_id === row.trade_order_id && previous.next_check_at > now) return false
    // SUCCESS is durable evidence for this trade, not a cache entry that a
    // retry may erase. Keep it visible even while another query is in flight.
    ctx.db.prepare(`INSERT INTO platform_order_checks(order_id,trade_order_id,status,checked_at,next_check_at,check_id)
      VALUES (?,?,'UNCONFIRMED',?,?,?) ON CONFLICT(order_id) DO UPDATE SET
      trade_order_id=excluded.trade_order_id,
      status=CASE WHEN platform_order_checks.trade_order_id=excluded.trade_order_id
        AND platform_order_checks.status='SUCCESS' THEN 'SUCCESS' ELSE excluded.status END,
      checked_at=CASE WHEN platform_order_checks.trade_order_id=excluded.trade_order_id
        AND platform_order_checks.status='SUCCESS' THEN platform_order_checks.checked_at ELSE excluded.checked_at END,
      next_check_at=excluded.next_check_at,check_id=excluded.check_id`)
      .run(row.id, row.trade_order_id, now, now + checkCooldownMs, checkId)
    return true
  })
  if (!claimed) return
  const task = (async () => {
    let status: ProviderCheck['status'] = 'UNCONFIRMED'
    try { status = (await queryPlatformOrder(ctx, row.user_id, row.trade_order_id)).status }
    catch {
      // Persist only the safe local result. Provider diagnostics, tokens and
      // foreign trade IDs never enter the database or the API response.
    }
    const checkedAt = Date.now()
    // PENDING or an unavailable query cannot retract a prior success or make
    // its confirmation time look newer. Even a late SUCCESS from an older
    // worker must be retained for the same trade; other stale results cannot
    // overwrite a newer check. Only signed receipts grant rights.
    ctx.db.prepare(`UPDATE platform_order_checks SET
      status=CASE WHEN status='SUCCESS' THEN 'SUCCESS' ELSE ? END,
      checked_at=CASE WHEN status='SUCCESS' AND ?<>'SUCCESS' THEN checked_at ELSE ? END,
      next_check_at=?
      WHERE order_id=? AND trade_order_id=? AND (check_id=? OR ?='SUCCESS')`)
      .run(status, status, checkedAt, checkedAt + checkCooldownMs, row.id, row.trade_order_id, checkId, status)
  })()
  inFlight.set(row.id, task)
  try { await task } finally { if (inFlight.get(row.id) === task) inFlight.delete(row.id) }
}
function unresolvedRealOrder(ctx: AppContext, row: Row): boolean {
  if (row.provider !== 'tiktok' || !['pending', 'processing', 'cancelled', 'failed'].includes(row.status)) return false
  if (one(ctx, 'SELECT released_at FROM beans_payment_attempts WHERE order_id=?', row.id)?.released_at) return false
  return one(ctx, 'SELECT state FROM platform_order_attempts WHERE order_id=?', row.id)?.state !== 'not_created'
}
function retainUnresolvedOrder(ctx: AppContext, row: Row): Row {
  if (unresolvedRealOrder(ctx, row) &&
    (row.status !== 'pending' || !row.trade_order_id || row.expires_at <= Date.now())) {
    ctx.db.prepare("UPDATE orders SET status='processing' WHERE id=?").run(row.id)
    return orderRow(ctx, row.id)!
  }
  return row
}
function product(ctx: AppContext, kind: OrderKind, targetId: number | null, userId: string) {
  const entitlements = activeEntitlements(ctx, userId)
  if (kind === 'vip') {
    if (targetId !== null) fail(400, 'INVALID_PRODUCT', '商品が無効です')
    if (entitlements.some(e => e.kind === 'vip')) fail(409, 'ALREADY_UNLOCKED', 'VIPは利用中です')
    return { amount: ctx.config.vipPrice, title: `VIP ${ctx.config.vipDays}日間` }
  }
  const drama = kind === 'drama'
    ? one(ctx, 'SELECT * FROM dramas WHERE id=?', targetId)
    : one(ctx, `SELECT d.*,e.title AS episode_title,e.seq FROM episodes e JOIN dramas d ON d.id=e.drama_id
        WHERE e.id=?`, targetId)
  if (!drama || !canPurchaseContent(ctx, kind, targetId)) return fail(404, 'PRODUCT_NOT_FOUND', '販売中の作品が見つかりません')
  if (kind === 'episode') {
    if (drama.seq <= drama.free_episodes) fail(400, 'FREE_EPISODE', '無料のエピソードは購入不要です')
    if (hasEpisodeAccess(ctx, userId, targetId!)) fail(409, 'ALREADY_UNLOCKED', '購入済みです')
  } else if (entitlements.some(e => e.kind === 'vip' || (e.kind === 'drama' && e.targetId === targetId)) ||
    readSubscriptionAccess(ctx, userId).status === 'valid') {
    fail(409, 'ALREADY_UNLOCKED', 'この作品は視聴できます')
  }
  const amount = kind === 'drama' ? drama.bundle_price : drama.episode_price
  if (!Number.isSafeInteger(amount) || amount <= 0) fail(409, 'PRICE_NOT_SET', '価格が設定されていません')
  return { amount, title: kind === 'drama' ? `${drama.title}・全話` : `${drama.title}・${drama.episode_title}` }
}

function transaction<T>(ctx: AppContext, action: () => T): T {
  ctx.db.exec('BEGIN IMMEDIATE')
  try { const result = action(); ctx.db.exec('COMMIT'); return result }
  catch (error) { ctx.db.exec('ROLLBACK'); throw error }
}

/** Only verified provider events or the explicitly local test checkout may call this. */
export function settleOrder(
  ctx: AppContext, id: string, outcome: 'paid' | 'failed' | 'refunded',
  eventId: string, authoritative = false,
): Order {
  return transaction(ctx, () => {
    const row = orderRow(ctx, id)
    if (!row) return fail(404, 'ORDER_NOT_FOUND', '注文が見つかりません')
    if (!authoritative && row.status === 'refunded' && outcome !== 'refunded') {
      return fail(409, 'ORDER_FINAL', '返金済みの注文です')
    }
    const seen = one(ctx, 'SELECT id FROM payment_events WHERE id=?', eventId)
    if (seen) return dto(ctx, row)
    if (row.status === outcome) return dto(ctx, row)
    if (row.status === 'refunded') return fail(409, 'ORDER_FINAL', '返金済みの注文です')
    if (!authoritative && outcome !== 'refunded' && (row.status !== 'pending' || row.expires_at <= Date.now())) {
      return fail(409, 'ORDER_EXPIRED_OR_FINAL', 'この注文は期限切れ、または処理済みです')
    }
    if (outcome === 'refunded' && !['paid', 'pending', 'processing', 'cancelled'].includes(row.status)) {
      return fail(409, 'ORDER_FINAL', '返金できない注文です')
    }
    if (outcome === 'paid' && !authoritative && row.kind !== 'vip') {
      // Recheck delivery for an old local checkout, but never discard money that
      // a verified provider receipt says was already paid before withdrawal.
      if (!canPurchaseContent(ctx, row.kind, row.target_id)) return fail(409, 'PRODUCT_UNAVAILABLE', '作品は現在公開されていません')
    }
    const now = Date.now()
    ctx.db.prepare('INSERT INTO payment_events(id,order_id,provider,event_type,received_at) VALUES (?,?,?,?,?)')
      .run(eventId, row.id, row.provider, outcome, now)
    if (outcome === 'paid') {
      if (row.provider === 'tiktok' && row.kind !== 'vip' && one(ctx, `SELECT 1 FROM orders
        WHERE user_id=? AND kind=? AND target_id IS ? AND status='paid' AND id<>? LIMIT 1`,
      row.user_id, row.kind, row.target_id, row.id)) {
        // Both signed payments remain in the ledger. Never silently discard
        // money, synthesize a refund, or grant twice for a replay of one event.
        ctx.audit(row.user_id, 'payment.duplicate_product', 'order', row.id, { kind: row.kind, targetId: row.target_id })
      }
      ctx.db.prepare("UPDATE orders SET status='paid',paid_at=? WHERE id=?").run(now, row.id)
      ctx.db.prepare(`INSERT OR IGNORE INTO entitlements(id,user_id,kind,target_id,order_id,starts_at,expires_at)
        VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), row.user_id, row.kind, row.target_id, row.id, now,
          row.kind === 'vip' ? now + ctx.config.vipDays * 86400000 : null)
    } else if (outcome === 'refunded') {
      ctx.db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(row.id)
      ctx.db.prepare('UPDATE entitlements SET revoked_at=? WHERE order_id=?').run(now, row.id)
      ctx.db.prepare('DELETE FROM playback_grants WHERE user_id=?').run(row.user_id)
    } else {
      if (row.status === 'paid') return fail(409, 'ORDER_FINAL', '支払い済みの注文です')
      ctx.db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(row.id)
    }
    const current = orderRow(ctx, row.id)!
    recordAnalyticsOrder(ctx, current, outcome === 'paid' ? 'payment_confirmed' : outcome === 'refunded' ? 'refund_confirmed' : 'order_failed', undefined, now)
    if (outcome === 'paid') recordAnalyticsOrder(ctx, current, 'entitlement_granted', undefined, now)
    if (outcome === 'refunded') recordAnalyticsOrder(ctx, current, 'entitlement_revoked', undefined, now)
    ctx.audit(row.user_id, `payment.${outcome}`, 'order', row.id, { provider: row.provider })
    return dto(ctx, orderRow(ctx, row.id)!)
  })
}

export function registerCommerce(router: Router, ctx: AppContext) {
  registerSubscriptionInbox(router, ctx, receiptId => ctx.config.mode === 'local'
    ? undefined : subscriptionProcessingDTO(readSubscriptionProcessing(ctx, receiptId)),
  receiptId => readSubscriptionReceiptLocation(ctx, receiptId))
  initializeSubscriptionLedger(ctx)
  const readInspection = registerSubscriptionInspection(router, ctx)
  registerSubscriptionWorkflow(router, ctx, readInspection)
  const reconcile = (admin: boolean) => asyncRoute(async (req, res) => {
    const user = admin ? ctx.requireAdmin(req) : ctx.requireUser(req)
    const row = admin ? orderRow(ctx, String(req.params.id)) : owned(ctx, String(req.params.id), user.id)
    if (!row) return fail(404, 'ORDER_NOT_FOUND', '注文が見つかりません')
    if ((req.body !== undefined && (!req.body || typeof req.body !== 'object' ||
      Array.isArray(req.body) || Object.keys(req.body).length > 0)) || Object.keys(req.query).length > 0) {
      return fail(400, 'INVALID_RECONCILIATION_REQUEST', '注文の確認には追加の入力は不要です')
    }
    if (row.provider !== 'tiktok' || ctx.config.paymentMode === 'sandbox') {
      return fail(403, 'PLATFORM_RECONCILE_DISABLED', 'テスト決済にはプラットフォーム照会を使用できません')
    }
    if (typeof row.trade_order_id !== 'string' || !row.trade_order_id.trim()) {
      return fail(409, 'PLATFORM_TRADE_ID_MISSING', 'TikTokの注文番号は未確認です。通知をお待ちください')
    }
    await reconcilePlatformOrder(ctx, row)
    const current = orderRow(ctx, row.id)!
    res.json(orderResponse(ctx, current, latestProviderCheck(ctx, current)))
  })
  router.post('/orders/:id/reconcile', reconcile(false))
  router.post('/admin/orders/:id/reconcile', reconcile(true))
  // Unlike platform_order_attempts (platform order creation), this records the
  // one-use client SDK invocation. No client outcome is settlement authority.
  const beansContext = (req: Parameters<AppContext['user']>[0], reportToken?: string) => {
    const user = ctx.requireUser(req)
    const stored = one(ctx, 'SELECT provider,provider_id,disabled FROM users WHERE id=?', user.id)
    if (ctx.config.paymentMode !== 'tiktok' || !['production', 'staging'].includes(ctx.config.mode) ||
      user.provider !== 'tiktok' || user.role !== 'user' || stored?.provider !== 'tiktok' ||
      stored.disabled || !ctx.sessionHash(req)) fail(403, 'PAYMENT_UNAVAILABLE', '決済を利用できません')
    // Results follow the original invocation's secret across natural Bearer
    // renewal, not merely the user id. Release still binds its awaited work to
    // the exact active session. Neither binding is payment/settlement evidence.
    const binding = reportToken === undefined ? ['session', ctx.sessionHash(req)] : ['sdk-result', reportToken]
    return createHash('sha256').update(JSON.stringify([user.id, user.provider, user.role, stored,
      binding, ctx.config.mode, ctx.config.paymentMode, ctx.config.tiktokClientKey,
      ctx.config.tiktokClientSecret, ctx.config.tokenEncryptionKey])).digest('hex')
  }
  const beansOrder = (req: Parameters<AppContext['user']>[0]) => {
    const row = owned(ctx, String(req.params.id), ctx.requireUser(req).id)
    if (row.provider !== 'tiktok' || row.kind === 'vip' || row.currency !== 'BEANS') {
      fail(403, 'PAYMENT_UNAVAILABLE', 'Beansの単品購入ではありません')
    }
    if (!row.trade_order_id) fail(409, 'PLATFORM_TRADE_ID_MISSING', '取引番号を確認できません')
    return row
  }
  const validBody = (req: Parameters<AppContext['user']>[0], keys: string[]) => {
    const body = req.body ?? {}
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !keys.includes(key)) || Object.keys(req.query).length) {
      fail(400, 'INVALID_ORDER', '注文の入力が無効です')
    }
    return body
  }
  const reportedSuccess = (row: Row) => one(ctx, `SELECT 1 FROM orders o
    LEFT JOIN beans_payment_attempts b ON b.order_id=o.id
    LEFT JOIN platform_order_checks c ON c.order_id=o.id
    WHERE o.user_id=? AND o.kind=? AND o.target_id IS ? AND o.provider='tiktok'
    AND o.status NOT IN ('paid','refunded') AND (b.outcome='succeeded' OR c.status='SUCCESS') LIMIT 1`,
  row.user_id, row.kind, row.target_id)
  router.post('/orders/:id/payment-attempt', (req, res) => {
    validBody(req, [])
    const reportToken = randomBytes(32).toString('hex')
    const contextHash = beansContext(req, reportToken)
    const result: PaymentAttemptClaim = transaction(ctx, () => {
      const row = beansOrder(req)
      if (row.status !== 'pending' || row.expires_at <= Date.now() ||
        one(ctx, 'SELECT 1 FROM beans_payment_attempts WHERE order_id=?', row.id) || reportedSuccess(row)) {
        fail(409, 'ORDER_NOT_PAYABLE', '元の取引を再利用できません')
      }
      const details = product(ctx, row.kind, row.target_id, row.user_id)
      if (details.amount !== row.amount || details.title !== row.title) fail(409, 'ORDER_NOT_PAYABLE', '商品情報が変更されました')
      const now = Date.now(), id = randomUUID()
      ctx.db.prepare(`INSERT INTO beans_payment_attempts(order_id,id,context_hash,outcome,started_at,updated_at)
        VALUES (?,?,?,'started',?,?)`).run(row.id, id, contextHash, now, now)
      ctx.db.prepare("UPDATE orders SET status='processing' WHERE id=?").run(row.id)
      ctx.audit(row.user_id, 'payment.sdk_started', 'order', row.id)
      return { attemptId: id, tradeOrderId: row.trade_order_id, reportToken }
    })
    res.status(201).json(result)
  })
  router.post('/orders/:id/payment-attempt/result', (req, res) => {
    const body = validBody(req, ['attemptId', 'outcome', 'reportToken'])
    if (typeof body.attemptId !== 'string' || typeof body.reportToken !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.reportToken) ||
      !['succeeded', 'cancelled', 'failed', 'unknown', 'not_started'].includes(body.outcome)) {
      fail(400, 'INVALID_ORDER', '決済の入力が無効です')
    }
    const contextHash = beansContext(req, body.reportToken)
    const row = transaction(ctx, () => {
      const current = beansOrder(req)
      const attempt = one(ctx, 'SELECT * FROM beans_payment_attempts WHERE order_id=?', current.id)
      if (!attempt || attempt.id !== body.attemptId || !/^[a-f0-9]{64}$/.test(attempt.context_hash) ||
        !timingSafeEqual(Buffer.from(attempt.context_hash, 'hex'), Buffer.from(contextHash, 'hex'))) {
        return fail(409, 'SESSION_CHANGED', '決済の操作元が変更されました')
      }
      if (attempt.outcome !== 'started') {
        if (attempt.outcome !== body.outcome) fail(409, 'ORDER_FINAL', '操作結果は記録済みです')
        return current // A same-result retry neither changes evidence nor repeats audit events.
      }
      ctx.db.prepare('UPDATE beans_payment_attempts SET outcome=?,updated_at=? WHERE order_id=?')
        .run(body.outcome, Date.now(), current.id)
      ctx.audit(current.user_id, 'payment.sdk_result', 'order', current.id, { outcome: body.outcome })
      // In particular, do not downgrade a paid/refunded receipt racing this callback.
      return current
    })
    res.json(orderResponse(ctx, row))
  })
  router.post('/orders/:id/payment-attempt/release', asyncRoute(async (req, res) => {
    const body = validBody(req, ['acknowledgePossibleCharge'])
    if (body.acknowledgePossibleCharge !== true) fail(400, 'INVALID_ORDER', '遅延請求の可能性への確認が必要です')
    const contextHash = beansContext(req), row = beansOrder(req)
    const eligible = (current: Row) => {
      const attempt = one(ctx, 'SELECT outcome FROM beans_payment_attempts WHERE order_id=?', current.id)
      // A checkbox is not payment evidence. Started, lost callbacks, generic
      // failures and legacy records stay read-only; never synthesize an outcome.
      return attempt && ['cancelled', 'not_started'].includes(attempt.outcome)
    }
    if (!eligible(row)) fail(409, 'ORDER_NOT_PAYABLE', '元の決済結果を確認してください')
    if (['paid', 'refunded'].includes(row.status) || reportedSuccess(row)) fail(409, 'ORDER_NOT_PAYABLE', '支払いの通知を確認してください')
    // Not a provider close API. A local cancellation/no-dispatch report plus
    // PENDING permits an explicit fresh purchase under the one-use contract.
    // Query failure is NOT permission; late signed money remains authoritative.
    await reconcilePlatformOrder(ctx, row, true)
    if (beansContext(req) !== contextHash) fail(409, 'SESSION_CHANGED', '決済の操作元が変更されました')
    const current = transaction(ctx, () => {
      const latest = beansOrder(req)
      if (latest.trade_order_id !== row.trade_order_id || !eligible(latest) ||
        latestProviderCheck(ctx, latest)?.status !== 'PENDING' ||
        ['paid', 'refunded'].includes(latest.status) || reportedSuccess(latest)) {
        fail(409, 'ORDER_NOT_PAYABLE', '支払いの通知を確認してください')
      }
      const now = Date.now()
      ctx.db.prepare('UPDATE beans_payment_attempts SET released_at=COALESCE(released_at,?) WHERE order_id=?')
        .run(now, latest.id)
      ctx.db.prepare("UPDATE orders SET status='processing' WHERE id=?").run(latest.id)
      ctx.audit(latest.user_id, 'payment.retry_acknowledged', 'order', latest.id, { providerCheck: latestProviderCheck(ctx, latest)?.status })
      return orderRow(ctx, latest.id)!
    })
    res.json(orderResponse(ctx, current))
  }))
  router.post('/orders', asyncRoute(async (req, res) => {
    const user = ctx.requireUser(req)
    if (ctx.config.paymentMode === 'disabled') fail(503, 'PAYMENT_UNAVAILABLE', '決済は現在利用できません')
    const creatorIdentity = () => {
      const current = ctx.user(req)
      const stored = current && one(ctx, 'SELECT provider,provider_id,disabled FROM users WHERE id=?', current.id)
      return JSON.stringify([ctx.config.mode, ctx.config.paymentMode, ctx.config.tiktokClientKey,
        ctx.config.tiktokClientSecret, ctx.config.tokenEncryptionKey, ctx.sessionHash(req),
        current?.id, current?.provider, current?.role, stored?.provider, stored?.provider_id, stored?.disabled])
    }
    const initialIdentity = creatorIdentity()
    const body = req.body || {}
    if (Object.keys(body).some(k => !['kind', 'targetId', 'idempotencyKey', 'analytics'].includes(k))) fail(400, 'INVALID_ORDER', '注文の入力が無効です')
    const { kind, idempotencyKey } = body as { kind: OrderKind; idempotencyKey: string }
    const targetId = body.targetId == null ? null : body.targetId
    if (!['episode', 'drama', 'vip'].includes(kind) || typeof idempotencyKey !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(idempotencyKey) ||
      (kind !== 'vip' && (!Number.isSafeInteger(targetId) || targetId <= 0))) fail(400, 'INVALID_ORDER', '注文の入力が無効です')
    if (kind === 'vip' && ctx.config.paymentMode === 'tiktok') {
      fail(503, 'SUBSCRIPTION_SKU_REQUIRED', '実際の定期購読は専用のプラン画面をご利用ください。Beansのテスト価格では購入できません。')
    }
    if (ctx.config.paymentMode === 'sandbox' && ctx.config.mode !== 'local') fail(403, 'SANDBOX_DISABLED', 'テスト決済は無効です')
    if (kind !== 'vip' && ctx.config.subscription &&
      !requestOrder(ctx, user.id, idempotencyKey) && !pendingProductOrder(ctx, user.id, kind, targetId, Date.now())) {
      const direct = kind === 'episode' ? hasEpisodeAccess(ctx, user.id, targetId!, false)
        : activeEntitlements(ctx, user.id).some(e => e.kind === 'vip' || (e.kind === 'drama' && e.targetId === targetId))
      if (!direct) {
        const before = [ctx.config.mode, ctx.config.tiktokClientKey, ctx.sessionHash(req), user.id, user.provider, user.role]
        const access = await refreshSubscriptionAccess(ctx, user.id, true)
        const current = ctx.requireUser(req)
        const after = [ctx.config.mode, ctx.config.tiktokClientKey, ctx.sessionHash(req), current.id, current.provider, current.role]
        if (JSON.stringify(before) !== JSON.stringify(after)) fail(401, 'UNAUTHENTICATED', 'アカウントが変更されました。購入は実行していません。')
        if (access.status === 'valid') fail(409, 'ALREADY_UNLOCKED', '有効なVIP視聴権があります。重複購入は不要です。')
        if (access.status === 'unverified') fail(access.reason === 'login_required' ? 401 : 503,
          'SUBSCRIPTION_ACCESS_UNVERIFIED', '会員の視聴権を確認できませんでした。再購入せず、状態を再確認してください。')
      }
    }
    // Reserve the product and every request key before awaiting the provider. The
    // transaction also protects two workers sharing this SQLite database.
    const reservation = transaction(ctx, () => {
      const old = requestOrder(ctx, user.id, idempotencyKey)
      if (old && (old.kind !== kind || old.target_id !== targetId)) {
        fail(409, 'IDEMPOTENCY_CONFLICT', 'このリクエスト番号は別の注文で使用済みです')
      }
      const now = Date.now()
      const pending = old || pendingProductOrder(ctx, user.id, kind, targetId, now)
      if (pending) {
        ctx.db.prepare('INSERT OR IGNORE INTO order_request_keys(user_id,request_key,order_id) VALUES (?,?,?)')
          .run(user.id, idempotencyKey, pending.id)
        return { row: retainUnresolvedOrder(ctx, pending), created: false }
      }
      const details = product(ctx, kind, targetId, user.id), id = randomUUID()
      ctx.db.prepare(`INSERT INTO orders(id,user_id,kind,target_id,title,amount,currency,provider,request_key,created_at,expires_at,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, user.id, kind, targetId, details.title, details.amount,
          ctx.config.paymentMode === 'sandbox' ? 'TEST_CREDITS' : 'BEANS', ctx.config.paymentMode,
          idempotencyKey, now, now + 15 * 60000, ctx.config.paymentMode === 'tiktok' ? 'processing' : 'pending')
      ctx.db.prepare('INSERT INTO order_request_keys(user_id,request_key,order_id) VALUES (?,?,?)').run(user.id, idempotencyKey, id)
      recordAnalyticsOrder(ctx, orderRow(ctx, id)!, 'order_created', body.analytics, now)
      if (ctx.config.paymentMode === 'tiktok') {
        ctx.db.prepare("INSERT INTO platform_order_attempts(order_id,state,updated_at) VALUES (?,'submitting',?)").run(id, now)
      }
      return { row: orderRow(ctx, id)!, created: true }
    })
    if (!reservation.created) {
      res.status(reservation.row.status === 'processing' ? 202 : 200).json(orderResponse(ctx, reservation.row)); return
    }
    const id = reservation.row.id
    if (ctx.config.paymentMode === 'tiktok') {
      let result: { tradeOrderId: string }
      try {
        result = await createPlatformOrder(ctx, user.id, dto(ctx, reservation.row), () => {
          if (creatorIdentity() !== initialIdentity) throw new Error('identity changed')
          const row = orderRow(ctx, id), attempt = one(ctx, 'SELECT * FROM platform_order_attempts WHERE order_id=?', id)
          if (!row || row.user_id !== user.id || row.provider !== 'tiktok' || row.status !== 'processing' ||
            row.trade_order_id || row.expires_at <= Date.now() || attempt?.state !== 'submitting' || attempt.cancel_requested) {
            throw new Error('order interrupted')
          }
          const currentProduct = product(ctx, kind, targetId, user.id)
          if (currentProduct.amount !== reservation.row.amount || currentProduct.title !== reservation.row.title ||
            row.amount !== reservation.row.amount || row.kind !== kind || row.target_id !== targetId ||
            row.title !== reservation.row.title || row.currency !== reservation.row.currency) {
            throw new Error('product changed')
          }
        })
      } catch (error) {
        const uncertain = error instanceof PlatformOrderUnknownError || !(error instanceof ApiError)
        const row = transaction(ctx, () => {
          const current = orderRow(ctx, id)!
          // A verified receipt may already have recovered the trade while this
          // HTTP request was outstanding. Never downgrade that confirmed result.
          if (current.trade_order_id) return current
          ctx.db.prepare('UPDATE platform_order_attempts SET state=?,error_code=?,updated_at=? WHERE order_id=?')
            .run(uncertain ? 'unknown' : 'not_created', error instanceof ApiError ? error.code : 'PLATFORM_ORDER_UNKNOWN', Date.now(), id)
          ctx.db.prepare('UPDATE orders SET status=? WHERE id=?').run(uncertain ? 'processing' : 'failed', id)
          if (!uncertain) recordAnalyticsOrder(ctx, orderRow(ctx, id)!, 'order_failed')
          return orderRow(ctx, id)!
        })
        if (!uncertain && !row.trade_order_id) throw error
        res.status(row.status === 'processing' ? 202 : 200).json(orderResponse(ctx, row)); return
      }
      // A persistence failure here must leave the reservation unresolved rather
      // than labelling an already-created platform order as failed.
      transaction(ctx, () => {
        const row = orderRow(ctx, id)!, attempt = one(ctx, 'SELECT * FROM platform_order_attempts WHERE order_id=?', id)!
        if (row.trade_order_id && row.trade_order_id !== result.tradeOrderId) throw new PlatformOrderUnknownError()
        ctx.db.prepare('UPDATE orders SET trade_order_id=? WHERE id=?').run(result.tradeOrderId, id)
        ctx.db.prepare("UPDATE platform_order_attempts SET state='created',error_code=NULL,updated_at=? WHERE order_id=?").run(Date.now(), id)
        if (row.status === 'processing' && attempt.state === 'submitting' && !attempt.cancel_requested && row.expires_at > Date.now()) {
          ctx.db.prepare("UPDATE orders SET status='pending' WHERE id=?").run(id)
        }
      })
    }
    ctx.audit(user.id, 'order.created', 'order', id, { kind, targetId, amount: reservation.row.amount })
    const row = orderRow(ctx, id)!
    res.status(row.status === 'processing' ? 202 : 201).json(orderResponse(ctx, row))
  }))
  router.get('/orders', (req, res) => {
    const user = ctx.requireUser(req)
    const rows = ctx.db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(user.id) as Row[]
    res.json({ orders: rows.map(row => dto(ctx, row)) })
  })
  router.get('/orders/:id', (req, res) => {
    const row = owned(ctx, String(req.params.id), ctx.requireUser(req).id)
    res.json(orderResponse(ctx, row, latestProviderCheck(ctx, row)))
  })
  router.post('/orders/:id/cancel', (req, res) => {
    const row = owned(ctx, String(req.params.id), ctx.requireUser(req).id)
    if (unresolvedRealOrder(ctx, row)) {
      transaction(ctx, () => {
        ctx.db.prepare("UPDATE orders SET status='processing' WHERE id=?").run(row.id)
        ctx.db.prepare(`INSERT INTO platform_order_attempts(order_id,state,cancel_requested,updated_at) VALUES (?,'unknown',1,?)
          ON CONFLICT(order_id) DO UPDATE SET cancel_requested=1,updated_at=excluded.updated_at`).run(row.id, Date.now())
        ctx.audit(row.user_id, 'order.cancellation_pending', 'order', row.id)
      })
      res.status(202).json(orderResponse(ctx, orderRow(ctx, row.id)!)); return
    }
    if (row.status === 'pending') {
      transaction(ctx, () => {
        ctx.db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(row.id)
        recordAnalyticsOrder(ctx, orderRow(ctx, row.id)!, 'order_cancelled')
        ctx.audit(row.user_id, 'order.cancelled', 'order', row.id)
      })
    } else if (row.status !== 'cancelled') fail(409, 'ORDER_FINAL', '処理済みの注文はキャンセルできません')
    res.json({ order: dto(ctx, orderRow(ctx, row.id)!) })
  })
  router.post('/orders/:id/sandbox-confirm', (req, res) => {
    if (ctx.config.mode !== 'local' || ctx.config.paymentMode !== 'sandbox') fail(403, 'SANDBOX_DISABLED', 'テスト決済は無効です')
    const row = owned(ctx, String(req.params.id), ctx.requireUser(req).id)
    if (row.provider !== 'sandbox') fail(403, 'SANDBOX_DISABLED', '実決済の注文には使用できません')
    if (!['paid', 'failed'].includes(req.body?.outcome)) fail(400, 'INVALID_OUTCOME', '決済結果が無効です')
    const order = settleOrder(ctx, row.id, req.body.outcome, `sandbox:${row.id}:${req.body.outcome}`)
    res.json({ order })
  })
  router.get('/admin/orders', (req, res) => {
    ctx.requireAdmin(req)
    const rows = ctx.db.prepare('SELECT o.*,u.email AS user_email FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 500').all() as Row[]
    res.json({ orders: rows.map(row => dto(ctx, row)) })
  })
  router.get('/admin/entitlements', (req, res) => {
    ctx.requireAdmin(req)
    res.json({ entitlements: ctx.db.prepare('SELECT id,user_id,kind,target_id,order_id,starts_at,expires_at,revoked_at FROM entitlements ORDER BY starts_at DESC LIMIT 500').all() })
  })
  router.get('/admin/payment-reviews', (req, res) => {
    ctx.requireAdmin(req)
    const integer = (value: unknown, fallback: number, max: number) => {
      if (value === undefined) return fallback
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
        return fail(400, 'INVALID_PAGINATION', 'ページ指定が無効です')
      }
      return Number(value)
    }
    const limit = integer(req.query.limit, 50, 100)
    const before = integer(req.query.before, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    const deliveries = ctx.db.prepare(`SELECT id,order_id,trade_order_id,event_type,status,amount_raw,payload_sha256,is_sandbox,received_at
      FROM payment_review_deliveries WHERE id<? ORDER BY id DESC LIMIT ?`).all(before, limit + 1) as Row[]
    const rows = deliveries.slice(0, limit)
    res.json({
      reviews: rows.map(row => ({
        id: String(row.id), orderId: row.order_id, tradeOrderId: row.trade_order_id,
        event: row.event_type, status: row.status, amountRaw: row.amount_raw,
        payloadSha256: row.payload_sha256, receivedAt: row.received_at,
        isSandbox: row.is_sandbox === null ? null : Boolean(row.is_sandbox),
      })),
      nextCursor: deliveries.length > limit ? String(rows[rows.length - 1].id) : null,
    })
  })
  router.post('/admin/orders/:id/refund', (req, res) => {
    const admin = ctx.requireAdmin(req)
    const row = orderRow(ctx, String(req.params.id))
    if (!row) fail(404, 'ORDER_NOT_FOUND', '注文が見つかりません')
    if (ctx.config.mode !== 'local' || row!.provider !== 'sandbox') fail(403, 'PROVIDER_REFUND_REQUIRED', '実決済の返金はプラットフォームで処理してください')
    const reason = req.body?.reason
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) fail(400, 'REASON_REQUIRED', '返金理由を入力してください')
    if (row!.status !== 'paid' && row!.status !== 'refunded') fail(409, 'NOT_PAID', '支払い済みの注文だけ返金できます')
    const order = settleOrder(ctx, row!.id, 'refunded', `sandbox-refund:${row!.id}`)
    ctx.audit(admin.id, 'refund.requested', 'order', row!.id, { reason: reason.trim() })
    res.json({ order })
  })
  router.post('/webhooks/tiktok', asyncRoute(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) fail(400, 'RAW_BODY_REQUIRED', 'Invalid webhook body')
    const secret = ctx.config.tiktokClientSecret
    if (!secret || !ctx.config.tiktokClientKey) fail(503, 'TIKTOK_UNCONFIGURED', 'TikTok is not configured')
    verifyTikTokSignature(req.body, req.get('TikTok-Signature') || '', secret!)
    // Node 22 supplies the original primitive JSON lexeme to the reviver. Capture
    // the amount without a Number conversion (or a guess about monetary units).
    const amounts = new WeakMap<object, string>()
    function captureAmount(this: object, key: string, value: unknown, context?: { source?: string }) {
      if (key === 'refund_amount') amounts.set(this, context?.source ?? JSON.stringify(value))
      return value
    }
    let event: any
    try { event = JSON.parse(req.body.toString('utf8'), captureAmount) } catch { fail(400, 'INVALID_EVENT', 'Invalid event') }
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail(400, 'INVALID_EVENT', 'Invalid event')
    if (event.client_key !== ctx.config.tiktokClientKey) fail(403, 'CLIENT_MISMATCH', 'Invalid event client')
    if (ctx.config.sandboxWebhookTarget && isSandboxWebhook(event)) {
      await relaySandboxWebhook(ctx.config, req.body, req.get('TikTok-Signature') || '', req.get('Content-Type') || 'application/json')
      res.json({ ok: true, forwarded: 'sandbox' })
      return
    }
    const subscriptionReceipt = receiveSubscriptionWebhook(ctx, req.body, req.get('TikTok-Signature') || '')
    if (subscriptionReceipt !== null) {
      if (ctx.config.mode === 'local') {
        res.json({ ok: true, received: true, receiptId: subscriptionReceipt, fulfillment: 'pending_contract' })
        return
      }
      const processed = processSubscriptionReceipt(ctx, subscriptionReceipt)
      if (processed.status === 'recorded' && ['create', 'reactivate'].includes(processed.action ?? '')) {
        // Newly established bindings may make previously received renewals usable.
        reprocessSubscriptionReceipts(ctx, 25, true)
      }
      res.status(processed.status === 'retryable_error' ? 503 : 200).json({
        ok: processed.status !== 'retryable_error', received: true, receiptId: subscriptionReceipt,
        fulfillment: ['recorded', 'duplicate'].includes(processed.status) ? 'recorded' : 'pending_contract',
        processing: subscriptionProcessingDTO(processed),
      })
      return
    }
    const accepted: Record<string, 'paid' | 'refunded'> = {
      'minis.trade_order.redeem.success': 'paid',
      'minis.trade_order.redeem.refund_success': 'refunded',
    }
    const partialRecovery = event.event === 'minis.trade_order.redeem.refund_traceback'
    if (!Object.hasOwn(accepted, event.event) && !partialRecovery) { res.json({ ok: true, ignored: true }); return }
    let content: any
    try { content = typeof event.content === 'string' ? JSON.parse(event.content, captureAmount) : event.content } catch { fail(400, 'INVALID_EVENT', 'Invalid content') }
    if (!content || typeof content.order_id !== 'string' || !content.order_id ||
      typeof content.trade_order_id !== 'string' || !content.trade_order_id) fail(400, 'INVALID_EVENT', 'Missing order identity')
    const row = orderRow(ctx, content.order_id)
    if (!row || row.provider !== 'tiktok' || (row.trade_order_id && row.trade_order_id !== content.trade_order_id)) {
      fail(404, 'ORDER_MISMATCH', 'Order does not match')
    }
    if (ctx.config.mode === 'production' && content.is_sandbox !== false) fail(403, 'SANDBOX_EVENT_REJECTED', 'Sandbox events cannot grant production entitlements')
    if (ctx.config.mode === 'staging' && content.is_sandbox !== true) fail(403, 'STAGING_EVENT_REJECTED', 'Only sandbox events are accepted in staging')
    const user = one(ctx, 'SELECT provider_id FROM users WHERE id=?', row!.user_id)
    if (event.user_openid != null && typeof event.user_openid !== 'string') fail(400, 'INVALID_EVENT', 'Invalid user identity')
    if (event.user_openid && user?.provider_id !== `${ctx.config.tiktokClientKey}:${event.user_openid}`) fail(403, 'USER_MISMATCH', 'Order owner does not match')
    transaction(ctx, () => {
      const attempt = one(ctx, 'SELECT * FROM platform_order_attempts WHERE order_id=?', row!.id)
      const sandbox = typeof content.is_sandbox === 'boolean' ? Number(content.is_sandbox) : null
      if (attempt?.is_sandbox != null && sandbox !== null && attempt.is_sandbox !== sandbox) {
        fail(403, 'ORDER_ENVIRONMENT_MISMATCH', 'Order environment does not match')
      }
      if (!row!.trade_order_id) {
        // A verified receipt can also recover a legacy reservation without attempt
        // metadata. Missing metadata is uncertainty, not evidence of non-creation.
        // Never attach a trade to a known non-created or different local order.
        if (!unresolvedRealOrder(ctx, row!) ||
          one(ctx, 'SELECT id FROM orders WHERE trade_order_id=?', content.trade_order_id)) {
          fail(404, 'ORDER_MISMATCH', 'Order does not match')
        }
        ctx.db.prepare('UPDATE orders SET trade_order_id=? WHERE id=?').run(content.trade_order_id, row!.id)
      }
      ctx.db.prepare(`INSERT INTO platform_order_attempts(order_id,state,is_sandbox,updated_at) VALUES (?,'created',?,?)
        ON CONFLICT(order_id) DO UPDATE SET state='created',
        is_sandbox=COALESCE(excluded.is_sandbox,platform_order_attempts.is_sandbox),updated_at=excluded.updated_at`)
        .run(row!.id, sandbox, Date.now())
      if (partialRecovery) {
        ctx.db.prepare(`INSERT INTO payment_review_deliveries
          (order_id,trade_order_id,event_type,amount_raw,payload_sha256,is_sandbox,received_at) VALUES (?,?,?,?,?,?,?)`)
          .run(row!.id, content.trade_order_id, event.event, amounts.get(content) ?? null,
            createHash('sha256').update(req.body).digest('hex'), sandbox, Date.now())
      }
    })
    if (partialRecovery) { res.json({ ok: true, reviewStatus: 'pending_review' }); return }
    const eventId = createHash('sha256').update(`${event.event}:${content.trade_order_id}`).digest('hex')
    settleOrder(ctx, row!.id, accepted[event.event], eventId, true)
    res.json({ ok: true })
  }))
}
