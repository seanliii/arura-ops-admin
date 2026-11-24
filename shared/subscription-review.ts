import type { SubscriptionHistoryItem, SubscriptionHistoryResponse } from './subscriptions.js'

export type SubscriptionReviewCategory = 'recorded' | 'rights_check' | 'refunded' | 'revoked' | 'expired' | 'needs_review'
export type SubscriptionRightsObservationState =
  | 'valid' | 'inactive' | 'unavailable' | 'stale' | 'checking' | 'failed' | 'superseded' | 'unmatched' | 'ambiguous'
export interface SubscriptionLedgerLocation {
  userId: string
  subscriptionId: string
  tradeOrderId: string | null
}
export interface SubscriptionReview {
  category: SubscriptionReviewCategory
  environment: 'sandbox' | 'production'
  reasons: string[]
  rights: { state: SubscriptionRightsObservationState; checkedAt: number | null }
  refund: { state: 'none' | 'full' | 'partial' | 'unknown' | 'conflict'; amount: string | null; currency: string | null }
  receipts: { id: string; event: string; eventCreatedAt: number; recordedAt: number }[]
}
export interface SubscriptionHistoryScope { tradeOrderId: string | null; subscriptionId: string | null }
export interface AdminSubscriptionHistoryItem extends SubscriptionHistoryItem { review?: SubscriptionReview }
export interface AdminSubscriptionHistoryResponse extends SubscriptionHistoryResponse {
  items: AdminSubscriptionHistoryItem[]
  scope: SubscriptionHistoryScope
}

export const subscriptionReviewLabels: Record<SubscriptionReviewCategory, string> = {
  recorded: '已入账', rights_check: '权益无效，待核对', refunded: '已收到退款通知',
  revoked: '已撤销', expired: '订阅已到期', needs_review: '记录待核对',
}
export const subscriptionRightsLabels: Record<SubscriptionRightsObservationState, string> = {
  valid: '同笔关联权益有效', inactive: '同笔关联权益无效',
  unavailable: '没有可用的平台权益观察', stale: '平台权益观察已过时',
  checking: '平台核对进行中', failed: '最近一次平台核对失败',
  superseded: '有更新的通知或处理结果，需重新核对',
  unmatched: '没有唯一匹配这笔最近交易的观察', ambiguous: '观察有重复或冲突，未采用',
}
export const subscriptionRefundLabels: Record<SubscriptionReview['refund']['state'], string> = {
  none: '未记录退款通知', full: '通知金额与实付一致', partial: '通知金额少于实付',
  unknown: '退款金额或比较依据未知', conflict: '金额或币种不一致，待核对',
}
