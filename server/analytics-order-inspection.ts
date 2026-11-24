import { createHmac } from 'node:crypto'
import type { Router } from 'express'
import { analyticsEnvironment } from '../shared/analytics.js'
import { ApiError, type AppContext } from './types.js'

type Row = Record<string, any>
interface OrderObservation {
  orderId: string; accountKey: string | null; dramaId: number | null; episodeId: number | null
  environment: string; paidAt: number; resumeTimes: number[]; conflicting: boolean
}
const orderSelect = `SELECT o.*,a.is_sandbox,
  CASE WHEN o.kind='drama' THEN o.target_id ELSE ep.drama_id END AS drama_id,ep.seq AS episode_seq,
  e.id AS entitlement_id,e.user_id AS entitlement_user,e.kind AS entitlement_kind,e.target_id AS entitlement_target,
  e.starts_at,e.expires_at AS entitlement_expires_at,e.revoked_at,
  (SELECT min(p.received_at) FROM payment_events p WHERE p.order_id=o.id AND p.provider=o.provider AND p.event_type='paid') AS receipt_at,
  (SELECT min(p.received_at) FROM payment_events p WHERE p.order_id=o.id AND p.provider=o.provider AND p.event_type='refunded') AS refund_at,
  (SELECT count(*) FROM payment_review_deliveries r WHERE r.order_id=o.id) AS refund_reviews
  FROM orders o LEFT JOIN platform_order_attempts a ON a.order_id=o.id
  LEFT JOIN episodes ep ON o.kind='episode' AND ep.id=o.target_id
  LEFT JOIN entitlements e ON e.order_id=o.id`

function orderEnvironment(row: Row) {
  if (row.provider === 'sandbox') return 'internal'
  if (row.provider === 'tiktok' && row.is_sandbox === 1) return 'official_test'
  if (row.provider === 'tiktok' && row.is_sandbox === 0) return 'production'
  return null
}
function outcome(row: Row, ctx: AppContext, now: number) {
  let state = 'valid'
  if (orderEnvironment(row) !== analyticsEnvironment(ctx.config.mode)) state = 'environment_unknown'
  else if (row.status === 'refunded' || (row.refund_at != null && row.refund_at <= now)) state = 'refunded'
  else if (row.status !== 'paid' || row.paid_at == null || row.paid_at > now ||
    row.receipt_at == null || row.receipt_at > now) state = 'payment_unconfirmed'
  else if (!row.entitlement_id) state = 'missing'
  else if (row.entitlement_user !== row.user_id || row.entitlement_kind !== row.kind ||
    row.entitlement_target !== row.target_id) state = 'entitlement_mismatch'
  else if (row.revoked_at != null) state = 'revoked'
  else if (row.entitlement_expires_at != null && row.entitlement_expires_at <= now) state = 'expired'
  else if (row.starts_at > now) state = 'not_started'
  return { state, needsReview: ['missing', 'entitlement_mismatch'].includes(state),
    refundReviewPending: Number(row.refund_reviews) > 0 && state !== 'refunded' }
}
function orderDTO(row: Row) {
  return { id: row.id, kind: row.kind, targetId: row.target_id, dramaId: row.drama_id,
    episodeSeq: row.episode_seq, title: row.title, amount: row.amount, currency: row.currency,
    provider: row.provider, status: row.status, createdAt: row.created_at, paidAt: row.paid_at,
    expiresAt: row.expires_at }
}
/** 主线程只读业务账本。worker不持有业务库；查询不会创建身份盐或发起结算。 */
export function inspectAnalyticsOrders(ctx: AppContext, observations: OrderObservation[], now = Date.now()) {
  const ids = [...new Set(observations.map(o => o.orderId))], rows = new Map<string, Row>()
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400)
    for (const row of ctx.db.prepare(`${orderSelect} WHERE o.id IN (${batch.map(() => '?').join(',')})`).all(...batch)) {
      rows.set(String(row.id), row)
    }
  }
  const salt = ctx.db.prepare("SELECT value FROM settings WHERE key='analytics_actor_salt'").get()?.value
  const orders = observations.map(observation => {
    const row = rows.get(observation.orderId)
    let state = row ? outcome(row, ctx, now).state : 'order_unavailable'
    const account = row && typeof salt === 'string'
      ? createHmac('sha256', salt).update('account:' + row.user_id).digest('hex') : null
    const associated = !!row && !observation.conflicting && account != null && account === observation.accountKey &&
      observation.environment === analyticsEnvironment(ctx.config.mode) &&
      row.drama_id != null && row.drama_id === observation.dramaId &&
      (row.kind !== 'episode' || row.target_id === observation.episodeId) &&
      row.paid_at === observation.paidAt
    if (row && !associated && state !== 'environment_unknown') state = 'association_unknown'
    const matched = associated && !['environment_unknown', 'payment_unconfirmed'].includes(state)
    const resumeAt = matched && row?.entitlement_user === row?.user_id &&
      row?.entitlement_kind === row?.kind && row?.entitlement_target === row?.target_id
      ? observation.resumeTimes.find(at => at <= now && at >= Math.max(row!.paid_at, row!.starts_at ?? Infinity) &&
        (row!.entitlement_expires_at == null || at < row!.entitlement_expires_at) &&
        (row!.revoked_at == null || at < row!.revoked_at) && (row!.refund_at == null || at < row!.refund_at)) ?? null
      : null
    const resumeObserved = resumeAt != null
    return { orderId: observation.orderId, dramaId: row?.drama_id ?? observation.dramaId,
      title: row?.title ?? '原订单不可用', currency: row?.currency ?? null,
      state, matched, needsReview: matched && ['missing', 'entitlement_mismatch'].includes(state),
      paidAt: row?.paid_at ?? observation.paidAt, receiptAt: row?.receipt_at ?? null,
      entitlementStartsAt: row?.starts_at ?? null, entitlementExpiresAt: row?.entitlement_expires_at ?? null,
      revokedAt: row?.revoked_at ?? null, refundAt: row?.refund_at ?? null,
      refundReviewPending: Number(row?.refund_reviews ?? 0) > 0 && state !== 'refunded',
      resumeObserved, resumeAt }
  })
  const valid = orders.filter(o => o.state === 'valid' && o.matched)
  return { checkedAt: now, source: 'current_read_only_ledger', observedPaidOrders: orders.length,
    matchedPaidOrders: orders.filter(o => o.matched).length, currentValidEntitlements: valid.length,
    observedResumedOrders: valid.filter(o => o.resumeObserved).length,
    validWithoutObservedResume: valid.filter(o => !o.resumeObserved).length,
    missingEntitlements: orders.filter(o => o.state === 'missing' && o.matched).length,
    unknownOrders: orders.filter(o => !o.matched).length, orders,
    definition: '所选范围内确认付款的内容订单，与查询时原账本和当前权益核对；续播只计同单同账户同内容、付款及发权之后的真实帧观测。有权益未观察到续播不等于支付故障。退款、撤权和到期另列；缺少关联、环境依据或历史明细保持未知。' }
}
export function registerAnalyticsOrderInspection(router: Router, ctx: AppContext) {
  router.get('/api/admin/orders/:id/inspection', (req, res) => {
    ctx.requireAdmin(req)
    const id = String(req.params.id)
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(400, 'INVALID_ORDER_ID', '订单编号格式不正确')
    if (Object.keys(req.query).length) throw new ApiError(400, 'INVALID_ORDER_QUERY', '只读订单查询不接受操作参数')
    const row = ctx.db.prepare(`${orderSelect} WHERE o.id=?`).get(id)
    if (!row) throw new ApiError(404, 'ORDER_NOT_FOUND', '没有找到这笔原订单')
    const now = Date.now()
    res.json({ readOnly: true, checkedAt: now, environment: orderEnvironment(row), order: orderDTO(row),
      outcome: { ...outcome(row, ctx, now), receiptAt: row.receipt_at, refundAt: row.refund_at,
        entitlementStartsAt: row.starts_at, entitlementExpiresAt: row.entitlement_expires_at, revokedAt: row.revoked_at },
      note: '仅读取当前账本；未查询TikTok、补权、退款或再次扣款。续播观察仍以进入本页时的数据范围为准。' })
  })
}
