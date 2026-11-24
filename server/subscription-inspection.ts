import type { Router } from 'express'
import type { SubscriptionInspection } from '../shared/subscription-inspection.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { getActiveSubscriptions, TikTokSubscriptionError } from './tiktok-subscription-client.js'

type Observation = Omit<SubscriptionInspection, 'cached'>
type CacheEntry = {
  expiresAt: number
  revision: string
  promise?: Promise<Observation>
  result?: Observation
  error?: ApiError
}
const CACHE_MS = 30_000
export type CachedSubscriptionInspection =
  | { state: 'fresh'; checkedAt: number; observation: Observation }
  | { state: 'unavailable' | 'stale' | 'checking' | 'failed' | 'superseded'; checkedAt: number | null }
export type ReadSubscriptionInspection = (userId: string) => CachedSubscriptionInspection

function receiptRevision(ctx: AppContext): string {
  // Include attempts as well as new receipt IDs: a late binding can process an
  // existing receipt in the same millisecond. GET never changes either value.
  const row = ctx.db.prepare(`SELECT
    (SELECT COALESCE(MAX(id),0) FROM subscription_webhook_receipts WHERE client_key=? AND receiving_mode=?) AS receipt,
    (SELECT COALESCE(SUM(attempts),0) FROM subscription_receipt_processing WHERE client_key=? AND receiving_mode=?) AS attempts`)
    .get(ctx.config.tiktokClientKey ?? '', ctx.config.mode, ctx.config.tiktokClientKey ?? '', ctx.config.mode)!
  return JSON.stringify([row.receipt, row.attempts])
}

function target(ctx: AppContext, userId: string) {
  const key = ctx.config.tiktokClientKey
  if (!key) throw new ApiError(503, 'TIKTOK_UNCONFIGURED', '当前应用尚未配置 TikTok 服务端身份')
  const user = ctx.db.prepare('SELECT id,provider,provider_id,disabled FROM users WHERE id=?').get(userId)
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '目标用户不存在')
  if (user.provider !== 'tiktok' || typeof user.provider_id !== 'string' ||
    !user.provider_id.startsWith(`${key}:`) || user.provider_id.length <= key.length + 1 || user.disabled) {
    throw new ApiError(409, 'SUBSCRIBER_IDENTITY_UNAVAILABLE', '只能查询当前应用内有效的 TikTok 用户身份')
  }
  return { id: String(user.id), providerId: user.provider_id, app: key, mode: ctx.config.mode }
}
function safeFailure(error: unknown): ApiError {
  if (error instanceof TikTokSubscriptionError) {
    if (error.status === 401) {
      return new ApiError(409, 'SUBSCRIBER_LOGIN_REQUIRED', '目标用户的 TikTok 授权已失效，需要该用户重新登录；管理员会话未改变')
    }
    return new ApiError(error.status, error.code, error.message)
  }
  return new ApiError(502, 'SUBSCRIPTION_INSPECTION_FAILED', '暂时无法核对平台订阅，未改变订单、合同或观看权益')
}

export function registerSubscriptionInspection(router: Router, ctx: AppContext): ReadSubscriptionInspection {
  // Read cache only, not a ledger. A restart may repeat a read, never a purchase.
  const cache = new Map<string, CacheEntry>()
  router.post('/admin/users/:id/subscriptions/query', asyncRoute(async (req, res) => {
    const administrator = ctx.requireAdmin(req), sessionHash = ctx.sessionHash(req)
    if (!sessionHash) throw new ApiError(401, 'UNAUTHENTICATED', '管理员会话已失效')
    if (Object.keys(req.query).length || (req.body !== undefined &&
      (!req.body || Array.isArray(req.body) || typeof req.body !== 'object' || Object.keys(req.body).length))) {
      throw new ApiError(400, 'INVALID_INSPECTION_REQUEST', '订阅核对不接受另一个用户、令牌或商品参数')
    }
    const owner = target(ctx, String(req.params.id))
    const cacheKey = JSON.stringify([owner.app, owner.mode, owner.id, owner.providerId])
    const now = Date.now()
    let entry = cache.get(cacheKey)
    const revision = receiptRevision(ctx)
    const cached = Boolean(entry && (entry.promise || (entry.expiresAt > now && entry.revision === revision)))
    if (!cached) {
      for (const [key, value] of cache) if (!value.promise && value.expiresAt <= now) cache.delete(key)
      const next: CacheEntry = { expiresAt: now + CACHE_MS, revision }
      cache.set(cacheKey, next)
      next.promise = getActiveSubscriptions(ctx, owner.id).then(subscriptions => {
        const result: Observation = {
          userId: owner.id, checkedAt: Date.now(), receivingMode: owner.mode,
          isFulfillmentProof: false,
          subscriptions: subscriptions.map(item => ({
            subscriptionId: item.subscriptionId, tierId: item.tierId,
            latestTradeOrderId: item.latestTradeOrderId,
            isSubscriptionRightsValid: item.isSubscriptionRightsValid,
            isRenewalNormal: item.isRenewalNormal, environment: item.environment,
            rawTimes: Object.fromEntries(
              (['begin_time', 'begine_time', 'end_time', 'next_duduct_time'] as const)
                .filter(field => item.rawTimes[field] !== undefined)
                .map(field => [field, item.rawTimes[field]]),
            ),
            ...(item.payType === undefined ? {} : { payType: item.payType }),
          })),
        }
        next.result = result
        return result
      }).catch(error => {
        next.error = safeFailure(error)
        throw next.error
      }).finally(() => { next.promise = undefined })
      entry = next
    }
    const selected = entry!
    if (selected.error) throw selected.error
    const observation = selected.promise ? await selected.promise : selected.result!
    // Never return a target user's data to a session that changed during the read.
    const currentAdmin = ctx.requireAdmin(req)
    if (currentAdmin.id !== administrator.id || ctx.sessionHash(req) !== sessionHash) {
      throw new ApiError(401, 'ADMIN_SESSION_CHANGED', '管理员会话已变化，请重新核对')
    }
    const currentOwner = target(ctx, owner.id)
    if (currentOwner.providerId !== owner.providerId || currentOwner.app !== owner.app || currentOwner.mode !== owner.mode) {
      throw new ApiError(409, 'SUBSCRIBER_IDENTITY_CHANGED', '查询期间目标身份或应用环境发生变化，未采用旧结果')
    }
    ctx.audit(administrator.id, 'subscription.inspected', 'user', owner.id, {
      count: observation.subscriptions.length, cached, checkedAt: observation.checkedAt,
      fulfillment: false,
    })
    res.json({ ...observation, cached } satisfies SubscriptionInspection)
  }))
  // Peek only; this is the same short-lived observation cache, not another
  // entitlement ledger. A history GET must never start a platform request.
  return userId => {
    let owner: ReturnType<typeof target>
    try { owner = target(ctx, userId) } catch { return { state: 'unavailable', checkedAt: null } }
    const entry = cache.get(JSON.stringify([owner.app, owner.mode, owner.id, owner.providerId]))
    if (!entry) return { state: 'unavailable', checkedAt: null }
    const checkedAt = entry.result?.checkedAt ?? null
    if (entry.promise) return { state: 'checking', checkedAt }
    if (entry.expiresAt <= Date.now()) return { state: 'stale', checkedAt }
    if (entry.error) return { state: 'failed', checkedAt }
    if (entry.revision !== receiptRevision(ctx)) return { state: 'superseded', checkedAt }
    if (!entry.result) return { state: 'unavailable', checkedAt: null }
    return { state: 'fresh', checkedAt: entry.result.checkedAt, observation: entry.result }
  }
}
