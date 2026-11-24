import { createHash, randomUUID } from 'node:crypto'
import type { Request, Router } from 'express'
import type {
  SubscriberSummary, SubscriptionOffer, SubscriptionOperation, SubscriptionQuote,
  SubscriptionState, SubscriptionDevice, SubscriptionAction,
  SubscriptionProcessing,
  SubscriptionHistoryResponse,
} from '../shared/subscriptions.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { transaction } from './db.js'
import {
  createSubscription, reactivateSubscription, getActiveSubscriptions, getSubscriptionTiers,
  getSubscriptionTrade, TikTokSubscriptionError, type SubscriptionInfo,
} from './tiktok-subscription-client.js'
import { OFFICIAL_SANDBOX_TIERS } from './subscription-config.js'
import { readSubscriptionAccess, refreshSubscriptionAccess } from './subscription-access.js'
import type { ReadSubscriptionInspection } from './subscription-inspection.js'
import type { AdminSubscriptionHistoryResponse } from '../shared/subscription-review.js'
import { reviewSubscriptionTransaction } from './subscription-review.js'
import {
  readOperationConfirmation, readSubscriptionProcessing, processSubscriptionReceipt,
  reprocessSubscriptionReceipts, bindObservedSubscriptionContracts,
  readSubscriptionTransactionHistory,
  readSubscriptionLifecycle, type SubscriptionLifecycleObservation, type SubscriptionHistoryOptions,
  type SubscriptionReceiptProcessing,
} from './subscription-ledger.js'

type Row = Record<string, any>
type Owner = { id: string; providerId: string; app: string; mode: string; session: string }
const QUOTE_MS = 5 * 60_000
const LEASE_MS = 90_000
const CHECK_MS = 30_000
const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message) }
const one = (ctx: AppContext, sql: string, ...args: any[]) => ctx.db.prepare(sql).get(...args) as Row | undefined
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function owner(ctx: AppContext, req: Request): Owner {
  const user = ctx.requireUser(req), session = ctx.sessionHash(req), app = ctx.config.tiktokClientKey
  if (user.role !== 'user' || user.provider !== 'tiktok') {
    return fail(403, 'TIKTOK_VIEWER_REQUIRED', '視聴用のTikTokアカウントでログインしてください。')
  }
  if (!session) return fail(401, 'UNAUTHENTICATED', 'ログインし直してください。')
  if (!app) return fail(503, 'TIKTOK_UNCONFIGURED', 'TikTokとの接続設定を準備中です。')
  const row = one(ctx, 'SELECT provider_id FROM users WHERE id=? AND disabled=0', user.id)
  if (typeof row?.provider_id !== 'string' || !row.provider_id.startsWith(`${app}:`) || row.provider_id.length <= app.length + 1) {
    return fail(403, 'SUBSCRIPTION_IDENTITY_MISMATCH', 'このアプリのTikTokアカウントを確認できません。')
  }
  return { id: user.id, providerId: row.provider_id, app, mode: ctx.config.mode, session }
}
function sameOwner(ctx: AppContext, req: Request, before: Owner) {
  const now = owner(ctx, req)
  if (hash(now) !== hash(before)) fail(409, 'SESSION_CHANGED', 'アカウントまたは接続環境が変更されました。元の操作を確認してください。')
}
function input(req: Request, allowed: string[]): Record<string, any> {
  if (Object.keys(req.query).length || (req.body !== undefined &&
    (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some(key => !allowed.includes(key))))) {
    return fail(400, 'INVALID_SUBSCRIPTION_REQUEST', 'サブスクリプションの入力を確認してください。')
  }
  return req.body ?? {}
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) {
    return fail(400, 'INVALID_SUBSCRIPTION_REQUEST', '操作番号を確認してください。')
  }
  return value
}
function configured(ctx: AppContext) {
  return Boolean(ctx.config.subscription?.tierIds.length && ctx.config.tiktokClientKey &&
    ctx.config.tiktokClientSecret && ctx.config.tokenEncryptionKey)
}
function sandboxCheckout(ctx: AppContext) {
  return configured(ctx) && ctx.config.mode === 'staging' && ctx.config.paymentMode === 'tiktok' &&
    ctx.config.subscription?.sandboxCheckout === true &&
    ctx.config.subscription.tierIds.every(id => OFFICIAL_SANDBOX_TIERS.has(id))
}
function canCheckout(ctx: AppContext) {
  return sandboxCheckout(ctx) || (configured(ctx) && ctx.config.mode === 'production' &&
    ctx.config.paymentMode === 'tiktok' && ctx.config.subscription?.productionCheckout === true &&
    ctx.config.subscription.sandboxCheckout !== true &&
    ctx.config.subscription.tierIds.every(id => !/^sandbox/i.test(id)))
}
function requireCheckout(ctx: AppContext) {
  if (!canCheckout(ctx)) fail(503, 'SUBSCRIPTION_FULFILLMENT_NOT_READY',
    '新しいサブスクリプションは現在受け付けていません。契約や視聴権は引き続き確認できます。')
}
function quoteConfig(ctx: AppContext) {
  return hash([ctx.config.mode, ctx.config.tiktokClientKey, ctx.config.paymentMode,
    ctx.config.subscription?.tierIds, ctx.config.subscription?.sandboxCheckout,
    ctx.config.subscription?.productionCheckout === true])
}
function offer(value: unknown): SubscriptionOffer {
  const o = value as SubscriptionOffer
  if (!o || typeof o.tierId !== 'string' || typeof o.price !== 'string' ||
    !/^\d{1,16}(?:\.\d{1,8})?$/.test(o.price) || BigInt(o.price.replace('.', '')) <= 0n ||
    typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency) ||
    typeof o.symbol !== 'string' || o.symbol.length > 16 ||
    !['WEEKLY', 'MONTHLY', 'BIMONTHLY', 'QUARTERLY', 'SEMIANNYALLY', 'ANNUALLY'].includes(o.deductCycle) ||
    !['one_time', 'auto_renew'].includes(o.deductType)) {
    return fail(502, 'SUBSCRIPTION_PRICE_INVALID', 'TikTokの料金を確認できませんでした。購入せず、後で再確認してください。')
  }
  return { tierId: o.tierId, price: o.price, currency: o.currency, symbol: o.symbol,
    deductCycle: o.deductCycle, deductType: o.deductType }
}
function summary(s: SubscriptionInfo): SubscriberSummary {
  return { subscriptionId: s.subscriptionId, tierId: s.tierId,
    rightsValid: s.isSubscriptionRightsValid, renewalNormal: s.isRenewalNormal, sourceEnvironment: s.environment }
}
export function subscriptionProcessingDTO(value: SubscriptionReceiptProcessing): SubscriptionProcessing {
  return { status: value.status, reason: value.reason, environment: value.environment,
    updatedAt: value.lastAttemptAt, retryAt: value.nextAttemptAt }
}
function operationDTO(ctx: AppContext, row: Row): SubscriptionOperation {
  const confirmation = readOperationConfirmation(ctx, String(row.id))
  const receipt = confirmation?.confirmed ? confirmation.receipt : null
  return {
    id: row.id, action: row.action,
    status: confirmation?.receiptConflict ? 'conflict' : receipt ? 'confirmed' : row.status,
    offer: offer(JSON.parse(row.offer_json)),
    devicePlatform: row.device_platform, tradeOrderId: row.trade_order_id, subscriptionId: row.subscription_id,
    createdAt: row.created_at, updatedAt: row.updated_at, errorCode: row.error_code,
    providerStatus: row.provider_status, sourceEnvironment: row.source_environment,
    checkedAt: row.checked_at, isFulfillmentProof: Boolean(receipt), receipt,
    refundStatus: confirmation?.revoked ? 'revoked' : confirmation?.refunded ? 'reported' : 'none',
  }
}
function expire(ctx: AppContext) {
  // Before the write, an expired attempt is known not to have submitted. After
  // dispatch it is unknown; keep the original lease ID so a late receipt can land.
  ctx.db.prepare(`UPDATE subscription_operations SET
    status=CASE WHEN status='checking' THEN 'not_created' ELSE 'outcome_unknown' END,
    error_code='SUBSCRIPTION_INTERRUPTED',updated_at=?
    WHERE confirmation_receipt_id IS NULL AND status IN ('checking','submitting') AND lease_until<=?`).run(Date.now(), Date.now())
}
function pending(ctx: AppContext, who: Owner): Row | undefined {
  return one(ctx, `SELECT * FROM subscription_operations WHERE user_id=? AND client_key=? AND receiving_mode=?
    AND owner_identity=? AND (receipt_conflict=1 OR (confirmation_receipt_id IS NULL
      AND status IN ('checking','submitting','ready_for_sdk','awaiting_confirmation','outcome_unknown')))
    ORDER BY receipt_conflict DESC,created_at DESC LIMIT 1`, who.id, who.app, who.mode, who.providerId)
}
function requireNoUnresolvedConflict(ctx: AppContext, who: Owner): void {
  if (one(ctx, `SELECT id FROM subscription_operations WHERE user_id=? AND client_key=?
    AND receiving_mode=? AND owner_identity=? AND receipt_conflict=1 LIMIT 1`,
  who.id, who.app, who.mode, who.providerId)) {
    fail(409, 'SUBSCRIPTION_CONFLICT_PENDING', '以前の手続きに確認が必要です。新しく購入せず、元の操作を確認してください。')
  }
}
function owned(ctx: AppContext, who: Owner, id: string): Row {
  const row = one(ctx, `SELECT * FROM subscription_operations WHERE id=? AND user_id=? AND client_key=?
    AND receiving_mode=? AND owner_identity=?`, id, who.id, who.app, who.mode, who.providerId)
  if (!row) return fail(404, 'SUBSCRIPTION_OPERATION_NOT_FOUND', '操作が見つかりません。')
  return row
}
function safeError(error: unknown): ApiError {
  if (error instanceof TikTokSubscriptionError) {
    return new ApiError(error.status, error.code, 'TikTokとの確認を完了できませんでした。元の操作を再確認してください。')
  }
  if (error instanceof ApiError) return error
  return new ApiError(502, 'SUBSCRIPTION_REQUEST_FAILED', 'TikTokとの通信を完了できませんでした。')
}
function quoteDTO(row: Row): SubscriptionQuote {
  return { id: row.id, devicePlatform: row.device_platform, expiresAt: row.expires_at,
    tiers: JSON.parse(row.offers_json).map(offer) }
}
function historyOptions(req: Request, admin = false): SubscriptionHistoryOptions {
  if (Object.keys(req.query).some(key => !['limit', 'before', ...(admin ? ['tradeOrderId', 'subscriptionId'] : [])].includes(key))) {
    return fail(400, 'INVALID_PAGINATION', '履歴の入力を確認してください。')
  }
  const limit = req.query.limit === undefined ? 20
    : typeof req.query.limit === 'string' && /^[1-9]\d{0,2}$/.test(req.query.limit) ? Number(req.query.limit) : 0
  const before = req.query.before
  if (limit < 1 || limit > 100 || (before !== undefined &&
    (typeof before !== 'string' || !/^[1-9]\d{0,15}$/.test(before) || !Number.isSafeInteger(Number(before))))) {
    return fail(400, 'INVALID_PAGINATION', '履歴のページ番号を確認してください。')
  }
  const filters: Pick<SubscriptionHistoryOptions, 'tradeOrderId' | 'subscriptionId'> = {}
  if (admin) for (const key of ['tradeOrderId', 'subscriptionId'] as const) {
    const value = req.query[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
      return fail(400, 'INVALID_SUBSCRIPTION_FILTER', '请填写完整的交易或订阅编号')
    }
    filters[key] = value
  }
  return { limit, ...(typeof before === 'string' ? { before } : {}), ...filters }
}
function historyDTO(
  ctx: AppContext, userId: string, req: Request, readInspection?: ReadSubscriptionInspection,
): SubscriptionHistoryResponse | AdminSubscriptionHistoryResponse {
  const options = historyOptions(req, !!readInspection)
  const result = readSubscriptionTransactionHistory(ctx, userId, options)
  const observation = readInspection?.(userId)
  const lifecycle = new Map<string, SubscriptionLifecycleObservation[]>()
  if (observation) for (const item of result.items) {
    if (!lifecycle.has(item.subscriptionId)) lifecycle.set(item.subscriptionId, readSubscriptionLifecycle(ctx, userId, item.subscriptionId))
  }
  return {
    items: result.items.map(item => ({
      tradeOrderId: item.tradeOrderId, subscriptionId: item.subscriptionId, kind: item.kind ?? 'unknown',
      confirmation: item.hasConflict ? 'conflict' : item.paymentRecorded ? 'confirmed' : 'unconfirmed',
      confirmedAt: item.confirmedAt, originalPrice: item.originalPrice,
      actualPrice: item.actualPrice, currency: item.currency,
      refundReported: item.refunded, revoked: item.revoked, createdAt: item.createdAt,
      ...(observation ? { review: reviewSubscriptionTransaction(ctx, userId, item, observation, lifecycle.get(item.subscriptionId)!) } : {}),
    })),
    nextCursor: result.nextCursor,
    ...(observation ? { scope: { tradeOrderId: options.tradeOrderId ?? null, subscriptionId: options.subscriptionId ?? null } } : {}),
  }
}

export function registerSubscriptionWorkflow(
  router: Router, ctx: AppContext,
  readInspection: ReadSubscriptionInspection = () => ({ state: 'unavailable', checkedAt: null }),
): void {
  const dto = (row: Row) => operationDTO(ctx, row)
  router.get('/subscriptions/history', (req, res) => {
    const who = owner(ctx, req)
    res.json(historyDTO(ctx, who.id, req))
  })
  router.get('/admin/users/:id/subscription-history', (req, res) => {
    ctx.requireAdmin(req)
    const target = one(ctx, 'SELECT id,provider,provider_id FROM users WHERE id=?', String(req.params.id))
    if (!ctx.config.tiktokClientKey || target?.provider !== 'tiktok' || typeof target.provider_id !== 'string' ||
      !target.provider_id.startsWith(`${ctx.config.tiktokClientKey}:`)) {
      return fail(404, 'SUBSCRIPTION_USER_NOT_FOUND', '当前应用的订阅用户不存在')
    }
    res.json(historyDTO(ctx, String(target.id), req, readInspection))
  })
  router.post('/admin/subscription-events/:id/reprocess', (req, res) => {
    const administrator = ctx.requireAdmin(req); input(req, [])
    const id = String(req.params.id)
    if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) {
      return fail(400, 'INVALID_SUBSCRIPTION_RECEIPT_ID', '订阅收件编号无效')
    }
    // Validates the application and receiving environment before any retry.
    readSubscriptionProcessing(ctx, id)
    const result = processSubscriptionReceipt(ctx, id)
    if (result.status === 'recorded') reprocessSubscriptionReceipts(ctx, 25, true)
    ctx.audit(administrator.id, 'subscription.receipt.reprocess', 'subscription_receipt', id, { status: result.status })
    res.status(result.status === 'retryable_error' ? 503 : 200).json({ processing: subscriptionProcessingDTO(result) })
  })
  router.get('/subscriptions', (req, res) => {
    const who = owner(ctx, req)
    if (Object.keys(req.query).length) fail(400, 'INVALID_SUBSCRIPTION_REQUEST', '追加の入力は不要です。')
    expire(ctx)
    const row = pending(ctx, who)
    const state: SubscriptionState = {
      userId: who.id, configured: configured(ctx), sandboxCheckout: sandboxCheckout(ctx), canCheckout: canCheckout(ctx),
      fulfillmentReady: configured(ctx), mode: ctx.config.mode, operation: row ? dto(row) : null,
      access: readSubscriptionAccess(ctx, who.id),
      reason: canCheckout(ctx) ? null : configured(ctx)
        ? '新しいサブスクリプションの受付は停止中です。現在の契約と料金は確認できます。'
        : 'サブスクリプションの接続設定を準備中です。',
    }
    res.json(state)
  })
  router.post('/subscriptions/restore', asyncRoute(async (req, res) => {
    const who = owner(ctx, req); input(req, [])
    const access = await refreshSubscriptionAccess(ctx, who.id, true)
    sameOwner(ctx, req, who)
    res.json({ access })
  }))
  router.post('/subscriptions/quotes', asyncRoute(async (req, res) => {
    const who = owner(ctx, req), { devicePlatform } = input(req, ['devicePlatform'])
    if (!['android', 'iphone'].includes(devicePlatform)) fail(400, 'SUBSCRIPTION_DEVICE_REQUIRED', '決済に使用する端末を選択してください。')
    if (!configured(ctx)) fail(503, 'SUBSCRIPTION_UNCONFIGURED', 'サブスクリプションの料金を準備中です。')
    const stamp = quoteConfig(ctx), ids = [...ctx.config.subscription!.tierIds]
    const subscriptions = await getActiveSubscriptions(ctx, who.id)
    sameOwner(ctx, req, who)
    const remote = await getSubscriptionTiers(ctx, who.id, ids, devicePlatform)
    sameOwner(ctx, req, who)
    if (stamp !== quoteConfig(ctx)) fail(409, 'SUBSCRIPTION_CONFIG_CHANGED', '料金設定が変更されました。再確認してください。')
    bindObservedSubscriptionContracts(ctx, who.id, subscriptions)
    reprocessSubscriptionReceipts(ctx, 25, true)
    const tiers = ids.filter(id => remote[id]).map(id => offer(remote[id]))
    if (!tiers.length) fail(502, 'SUBSCRIPTION_PRICE_INVALID', '有効な料金を確認できませんでした。')
    const id = randomUUID(), now = Date.now()
    ctx.db.prepare(`INSERT INTO subscription_quotes(id,user_id,client_key,receiving_mode,owner_identity,
      config_hash,device_platform,offers_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, who.id, who.app, who.mode, who.providerId, stamp, devicePlatform, JSON.stringify(tiers), now, now + QUOTE_MS)
    res.json({ quote: quoteDTO(one(ctx, 'SELECT * FROM subscription_quotes WHERE id=?', id)!),
      subscriptions: subscriptions.map(summary), checkedAt: now, sandboxCheckout: sandboxCheckout(ctx),
      canCheckout: canCheckout(ctx), fulfillmentReady: configured(ctx) })
  }))
  router.post('/subscriptions/operations', asyncRoute(async (req, res) => {
    const who = owner(ctx, req), value = input(req, ['action', 'quoteId', 'tierId', 'requestId'])
    requireCheckout(ctx)
    if (!['create', 'reactivate'].includes(value.action) || typeof value.tierId !== 'string' ||
      !ctx.config.subscription!.tierIds.includes(value.tierId)) {
      fail(400, 'INVALID_SUBSCRIPTION_REQUEST', '操作または現在受付中のプランを確認してください。')
    }
    const action = value.action as SubscriptionAction, requestId = identifier(value.requestId), quoteId = identifier(value.quoteId)
    const requestHash = hash([action, quoteId, value.tierId])
    expire(ctx)
    const reservation = transaction(ctx.db, () => {
      const priorKey = one(ctx, `SELECT * FROM subscription_operation_requests
        WHERE user_id=? AND client_key=? AND receiving_mode=? AND request_key=?`, who.id, who.app, who.mode, requestId)
      if (priorKey) {
        if (priorKey.request_hash !== requestHash) fail(409, 'IDEMPOTENCY_CONFLICT', '同じ操作番号を別の入力に使用できません。')
        return { row: owned(ctx, who, priorKey.operation_id), created: false }
      }
      const quote = one(ctx, `SELECT * FROM subscription_quotes WHERE id=? AND user_id=? AND client_key=?
        AND receiving_mode=? AND owner_identity=?`, quoteId, who.id, who.app, who.mode, who.providerId)
      if (!quote) return fail(404, 'SUBSCRIPTION_QUOTE_NOT_FOUND', '料金確認が見つかりません。')
      const bind = (id: string) => ctx.db.prepare(`INSERT INTO subscription_operation_requests
        (user_id,client_key,receiving_mode,request_key,request_hash,operation_id) VALUES(?,?,?,?,?,?)`)
        .run(who.id, who.app, who.mode, requestId, requestHash, id)
      const existing = pending(ctx, who)
      if (existing) {
        if (existing.action !== action || existing.tier_id !== value.tierId) {
          return fail(409, 'SUBSCRIPTION_PENDING', '確認中の操作があります。新しい購入は行わず元の操作を確認してください。')
        }
        bind(existing.id)
        return { row: existing, created: false }
      }
      if (quote.expires_at <= Date.now() || quote.config_hash !== quoteConfig(ctx)) {
        return fail(409, 'SUBSCRIPTION_QUOTE_EXPIRED', '料金確認の有効期限が切れました。もう一度確認してください。')
      }
      const selected = quoteDTO(quote).tiers.find(item => item.tierId === value.tierId)
      if (!selected || selected.deductType !== 'auto_renew') {
        return fail(409, 'SUBSCRIPTION_TIER_UNAVAILABLE', '選択した自動更新プランを確認できません。')
      }
      const id = randomUUID(), now = Date.now(), lease = randomUUID()
      ctx.db.prepare(`INSERT INTO subscription_operations
        (id,user_id,client_key,receiving_mode,owner_identity,quote_id,action,tier_id,offer_json,device_platform,
         status,lease_id,lease_until,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'checking',?,?,?,?)`)
        .run(id, who.id, who.app, who.mode, who.providerId, quote.id, action, selected.tierId,
          JSON.stringify(selected), quote.device_platform, lease, now + LEASE_MS, now, now)
      bind(id)
      return { row: owned(ctx, who, id), created: true }
    })
    if (!reservation.created) { res.json({ operation: dto(reservation.row), created: false }); return }
    const row = reservation.row, stamp = quoteConfig(ctx)
    let writeStarted = false
    try {
      const live = await getActiveSubscriptions(ctx, who.id)
      sameOwner(ctx, req, who)
      bindObservedSubscriptionContracts(ctx, who.id, live)
      let subscriptionId: string | null = null
      if (action === 'create' && live.length) fail(409, 'SUBSCRIPTION_ALREADY_EXISTS', '現在の契約を確認してください。重複して購入する必要はありません。')
      if (action === 'reactivate') {
        const environment = ctx.config.mode === 'staging' ? 'sandbox' : 'production'
        if (live.length !== 1 || live[0].tierId !== row.tier_id || live[0].environment !== environment || live[0].isRenewalNormal) {
          fail(409, 'SUBSCRIPTION_REACTIVATION_UNAVAILABLE', '再開できる契約を確認できません。現在のお支払い方法をご確認ください。')
        }
        subscriptionId = live[0].subscriptionId
      }
      const latest = await getSubscriptionTiers(ctx, who.id, [row.tier_id], row.device_platform as SubscriptionDevice)
      sameOwner(ctx, req, who)
      requireCheckout(ctx)
      requireNoUnresolvedConflict(ctx, who)
      if (stamp !== quoteConfig(ctx)) fail(409, 'SUBSCRIPTION_CONFIG_CHANGED', '設定が変更されました。購入せず再確認してください。')
      if (!latest[row.tier_id] || hash(offer(latest[row.tier_id])) !== hash(offer(JSON.parse(row.offer_json)))) {
        fail(409, 'SUBSCRIPTION_PRICE_CHANGED', '料金が変更されました。新しい料金を確認してから続けてください。')
      }
      const started = ctx.db.prepare(`UPDATE subscription_operations SET status='submitting',subscription_id=?,updated_at=?
        WHERE id=? AND lease_id=? AND status='checking' AND confirmation_receipt_id IS NULL
          AND receipt_conflict=0 AND lease_until>?`)
        .run(subscriptionId, Date.now(), row.id, row.lease_id, Date.now())
      if (!started.changes) fail(409, 'SUBSCRIPTION_INTERRUPTED', '操作が中断されました。元の記録を確認してください。')
      writeStarted = true
      const orderInfo = { orderId: row.id, productName: 'aurora VIP' }
      const beforeDispatch = () => {
        // The adapter may still have to refresh its user token. This check runs
        // after that await, at the actual outgoing business-request boundary.
        sameOwner(ctx, req, who)
        requireCheckout(ctx)
        requireNoUnresolvedConflict(ctx, who)
        const current = owned(ctx, who, row.id)
        if (stamp !== quoteConfig(ctx) || current.lease_id !== row.lease_id ||
          current.status !== 'submitting' || current.lease_until <= Date.now() ||
          current.confirmation_receipt_id !== null || current.receipt_conflict) {
          fail(409, 'SUBSCRIPTION_INTERRUPTED', '送信前に操作条件が変わりました。元の記録を確認してください。')
        }
      }
      const result = action === 'create'
        ? await createSubscription(ctx, who.id, { ...orderInfo, tierId: row.tier_id }, beforeDispatch)
        : await reactivateSubscription(ctx, who.id, { subscriptionId: subscriptionId!, orderInfo }, beforeDispatch)
      // Creation receipt is saved even after a client disconnect/logout. It is
      // not a payment receipt, and must never be delivered to another identity.
      transaction(ctx.db, () => {
        const current = owned(ctx, who, row.id)
        const conflicting = Boolean(current.trade_order_id && current.trade_order_id !== result.tradeOrderId)
        ctx.db.prepare(`INSERT OR IGNORE INTO subscription_operation_responses
          (operation_id,lease_id,returned_trade_id,conflicting,received_at) VALUES(?,?,?,?,?)`)
          .run(row.id, row.lease_id, result.tradeOrderId, Number(conflicting), Date.now())
        if (conflicting) {
          ctx.db.prepare(`UPDATE subscription_operations SET receipt_conflict=1,
            error_code='SUBSCRIPTION_TRADE_CONFLICT',updated_at=? WHERE id=?`).run(Date.now(), row.id)
        } else {
          ctx.db.prepare(`UPDATE subscription_operations SET trade_order_id=?,status='ready_for_sdk',
            error_code=NULL,updated_at=? WHERE id=? AND lease_id=? AND confirmation_receipt_id IS NULL
              AND receipt_conflict=0 AND status IN ('submitting','outcome_unknown')`)
            .run(result.tradeOrderId, Date.now(), row.id, row.lease_id)
        }
        ctx.audit(who.id, 'subscription.operation.created', 'subscription_operation', row.id,
          { action, environment: who.mode === 'staging' ? 'sandbox' : 'production' })
      })
      reprocessSubscriptionReceipts(ctx, 25, true)
    } catch (cause) {
      const error = safeError(cause)
      const unknown = writeStarted && !(cause instanceof TikTokSubscriptionError && cause.outcome !== 'unknown')
      ctx.db.prepare(`UPDATE subscription_operations SET status=?,error_code=?,updated_at=?
        WHERE id=? AND lease_id=? AND confirmation_receipt_id IS NULL
          AND status IN ('checking','submitting','outcome_unknown')`)
        .run(unknown ? 'outcome_unknown' : 'not_created', error.code, Date.now(), row.id, row.lease_id)
      sameOwner(ctx, req, who)
      const current = dto(owned(ctx, who, row.id))
      if (current.status === 'confirmed' || current.status === 'conflict') {
        res.status(current.status === 'confirmed' ? 200 : 202).json({ operation: current, created: true }); return
      }
      if (unknown) { res.status(202).json({ operation: dto(owned(ctx, who, row.id)), created: true }); return }
      throw error
    }
    sameOwner(ctx, req, who)
    res.status(201).json({ operation: dto(owned(ctx, who, row.id)), created: true })
  }))
  router.get('/subscriptions/operations/:id', (req, res) => {
    const who = owner(ctx, req)
    if (Object.keys(req.query).length) fail(400, 'INVALID_SUBSCRIPTION_REQUEST', '追加の入力は不要です。')
    expire(ctx)
    res.json({ operation: dto(owned(ctx, who, identifier(req.params.id))) })
  })
  router.post('/subscriptions/operations/:id/start', (req, res) => {
    const who = owner(ctx, req); input(req, []); requireCheckout(ctx)
    expire(ctx)
    requireNoUnresolvedConflict(ctx, who)
    const row = owned(ctx, who, identifier(req.params.id))
    if (!ctx.config.subscription!.tierIds.includes(row.tier_id)) {
      return fail(409, 'SUBSCRIPTION_TIER_UNAVAILABLE', 'このプランの受付は停止されています。元の取引状況をご確認ください。')
    }
    if (row.status !== 'ready_for_sdk' || !row.trade_order_id ||
      row.confirmation_receipt_id !== null || row.receipt_conflict) {
      return fail(409, 'SUBSCRIPTION_SDK_ALREADY_REQUESTED', '元の手続きが進行中、または未確認です。繰り返し開かず状況を確認してください。')
    }
    const result = ctx.db.prepare(`UPDATE subscription_operations SET status='awaiting_confirmation',sdk_started_at=?,updated_at=?
      WHERE id=? AND status='ready_for_sdk' AND sdk_started_at IS NULL
        AND confirmation_receipt_id IS NULL AND receipt_conflict=0
        AND NOT EXISTS (SELECT 1 FROM subscription_operations blocked
          WHERE blocked.user_id=? AND blocked.client_key=? AND blocked.receiving_mode=?
            AND blocked.owner_identity=? AND blocked.receipt_conflict=1)`)
      .run(Date.now(), Date.now(), row.id, who.id, who.app, who.mode, who.providerId)
    if (!result.changes) fail(409, 'SUBSCRIPTION_SDK_ALREADY_REQUESTED', '手続きは既に開始されています。')
    res.json({ operation: dto(owned(ctx, who, row.id)), sdk: { action: row.action, tradeOrderId: row.trade_order_id } })
  })
  router.post('/subscriptions/operations/:id/check', asyncRoute(async (req, res) => {
    const who = owner(ctx, req); input(req, [])
    expire(ctx)
    const row = owned(ctx, who, identifier(req.params.id))
    if (!row.trade_order_id) fail(409, 'SUBSCRIPTION_TRADE_UNKNOWN', '取引番号が未確認です。新しく作成せず、元の操作をお問い合わせください。')
    const checkId = randomUUID(), now = Date.now()
    const claim = ctx.db.prepare(`UPDATE subscription_operations SET check_id=?,next_check_at=?
      WHERE id=? AND next_check_at<=?`).run(checkId, now + CHECK_MS, row.id, now)
    if (!claim.changes) { res.json({ operation: dto(row) }); return }
    try {
      const observed = await getSubscriptionTrade(ctx, who.id, row.trade_order_id)
      sameOwner(ctx, req, who)
      if (observed.environment !== (ctx.config.mode === 'staging' ? 'sandbox' : 'production')) {
        fail(409, 'SUBSCRIPTION_ENVIRONMENT_UNCONFIRMED', '取引の環境を確認できませんでした。会員権は変更していません。')
      }
      if (row.subscription_id && observed.subscriptionId !== row.subscription_id) {
        fail(409, 'SUBSCRIPTION_CONTRACT_MISMATCH', '元の契約と取引を照合できませんでした。')
      }
      ctx.db.prepare(`UPDATE subscription_operations SET provider_status=?,source_environment=?,checked_at=?,
        error_code=CASE WHEN receipt_conflict=0 THEN NULL ELSE error_code END
        WHERE id=? AND check_id=?`).run(observed.status, observed.environment, Date.now(), row.id, checkId)
    } catch (cause) {
      const error = safeError(cause)
      ctx.db.prepare('UPDATE subscription_operations SET error_code=? WHERE id=? AND check_id=?').run(error.code, row.id, checkId)
      throw error
    }
    // No paid flag, period, grant, refund or user role can be produced by this read.
    res.json({ operation: dto(owned(ctx, who, row.id)) })
  }))
}
