import type { SubscriptionReview } from '../shared/subscription-review.js'
import type { CachedSubscriptionInspection } from './subscription-inspection.js'
import type { AppContext } from './types.js'
import {
  readSubscriptionReviewReceipts, type SubscriptionLifecycleObservation, type SubscriptionTransactionHistoryItem,
} from './subscription-ledger.js'

function decimal(value: string | null): [string, string] | null {
  if (value === null || value.trim() !== value || !/^\d+(?:\.\d+)?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return [whole!.replace(/^0+(?=\d)/, ''), fraction]
}
/** Exact decimal comparison without float conversion, currency conversion or summing notices. */
function refundEvidence(item: SubscriptionTransactionHistoryItem): SubscriptionReview['refund'] {
  const result: SubscriptionReview['refund'] = {
    state: 'none', amount: item.refundPrice, currency: item.refundCurrency,
  }
  if (!item.refunded) return result
  const paid = decimal(item.actualPrice), refunded = decimal(item.refundPrice)
  if (!paid || !refunded || !item.currency?.trim() || !item.refundCurrency?.trim()) {
    return { ...result, state: 'unknown' }
  }
  if (item.currency !== item.refundCurrency) return { ...result, state: 'conflict' }
  const width = Math.max(paid[1].length, refunded[1].length)
  const a = `${paid[0]}.${paid[1].padEnd(width, '0')}`, b = `${refunded[0]}.${refunded[1].padEnd(width, '0')}`
  const greater = refunded[0].length > paid[0].length || (refunded[0].length === paid[0].length && b > a)
  return { ...result, state: greater ? 'conflict' : a === b ? 'full' : 'partial' }
}

export function reviewSubscriptionTransaction(
  ctx: AppContext, userId: string, item: SubscriptionTransactionHistoryItem,
  cached: CachedSubscriptionInspection, lifecycle: SubscriptionLifecycleObservation[],
): SubscriptionReview {
  const refund = refundEvidence(item)
  const rights: SubscriptionReview['rights'] = {
    state: cached.state === 'fresh' ? 'unmatched' : cached.state, checkedAt: cached.checkedAt,
  }
  const payments = lifecycle.filter(event => event.action === 'create' || event.action === 'renew')
  const newestPaymentAt = Math.max(0, ...payments.map(event => event.eventCreatedAt))
  const newestPayments = payments.filter(event => event.eventCreatedAt === newestPaymentAt)
  let currentSubscriptionValid = false
  if (cached.state === 'fresh') {
    const sameSubscription = cached.observation.subscriptions.filter(observation => observation.subscriptionId === item.subscriptionId)
    if (sameSubscription.length > 1) rights.state = 'ambiguous'
    else {
      const observation = sameSubscription[0]
      const latest = newestPayments.length === 1 && newestPayments[0]!.count === 1 ? newestPayments[0] : undefined
      const linkedToLatest = observation && latest && observation.environment === item.environment
        && observation.latestTradeOrderId === latest.tradeOrderId && observation.tierId === latest.tierId
      currentSubscriptionValid = !!linkedToLatest && observation!.isSubscriptionRightsValid
      if (linkedToLatest && observation!.latestTradeOrderId === item.tradeOrderId && observation!.tierId === item.tierId) {
        rights.state = observation.isSubscriptionRightsValid ? 'valid' : 'inactive'
      }
    }
  }
  const relevant = lifecycle.filter(event => event.action !== 'cancel')
  const latestTime = Math.max(0, ...relevant.map(event => event.eventCreatedAt))
  const latest = relevant.filter(event => event.eventCreatedAt === latestTime)
  const expires = latest.some(event => event.action === 'expire')
  const holds = latest.some(event => event.action === 'onhold')
  const active = latest.some(event => ['create', 'renew', 'reactivate'].includes(event.action))
  const reasons: string[] = []
  let category: SubscriptionReview['category'] = 'recorded'
  if (item.receiptConflict || !item.paymentRecorded) {
    category = 'needs_review'
    reasons.push(item.receiptConflict ? '同笔通知存在冲突，不能采用单一结果。' : '尚无该笔付款确认；退款通知不能代替付款确认。')
  } else if (refund.state === 'conflict') {
    category = 'needs_review'; reasons.push('退款币种与实付不同，或通知金额大于实付；不做汇率换算或自动修账。')
  } else if (item.revoked) {
    category = 'revoked'; reasons.push('已记录该笔撤销通知；附带退款标记不是第二笔退款。')
  } else if (item.refunded) {
    category = 'refunded'; reasons.push('已记录该笔退款通知；重复通知只关联原交易，不累计退款次数。')
  } else if ((expires && (active || holds || currentSubscriptionValid)) || (holds && active)) {
    category = 'needs_review'; reasons.push('同订阅生命周期通知或最新权益观察有冲突，需要核对原通知。')
  } else if (expires) {
    category = 'expired'; reasons.push('该订阅最新生命周期通知为到期；按平台事件时间判断，不是这笔付款失败。')
  } else if (holds) {
    category = 'needs_review'; reasons.push('该订阅最新通知为暂停状态，不等同到期或付款失败。')
  } else if (rights.state === 'inactive') {
    category = 'rights_check'; reasons.push('已确认付款，但新鲜且唯一匹配该笔最近交易的平台观察为权益无效；需核对原因，不自动补权。')
  } else {
    reasons.push(rights.state === 'valid' ? '该笔已确认，匹配的当前平台权益观察有效。'
      : '付款记录已确认，但当前权益缺少可采用的同笔观察；这不是缺权益的证据。')
  }
  if (lifecycle.some(event => event.action === 'cancel')) reasons.push('取消自动续费不等于当前权益已失效。')
  reasons.push('没有续播不表示付款失败；原始权益时间字段单位未核实，不据此推算到期。')
  return {
    category, environment: item.environment, reasons, rights, refund,
    receipts: readSubscriptionReviewReceipts(ctx, userId, item, lifecycle.map(event => event.receiptId)),
  }
}
