export interface ContinuationResult {
  completeOrigins: number
  eligibleOrigins: number
  nextRequests: number
  nextFirstFrames: number
  nextQualified: number
  rate: { numerator: number; denominator: number; value: number | null }
  exclusions: { versionEnd: number; missingSupply: number; unavailableSupply: number; unknownSupply: number }
  outcomes: { continued: number; playbackFailed: number; laterReturn: number; paidWithoutFrame: number;
    requestedWithoutFrame: number; unobserved: number; observing: number }
  associationUnknown: number
  observation: { status: string; matureOrigins: number; provisionalOrigins: number; allowedLatenessDays: number }
  autoPlayDisabled: number | null
  autoPlayPreferenceObserved?: number
  definition: string
  supplyDefinition: string
}
export const resultPercent = (value: number | null | undefined) =>
  value == null ? '暂无数据' : `${(value * 100).toFixed(1)}%`

export function maturityLabel(state?: string) {
  return ({
    mature: '已成熟', observing: '观察窗口未结束', late_window: '迟到窗口内，尚未成熟',
    processing_unknown: '处理进度未知', partial_history: '历史明细不完整',
  } as Record<string, string>)[state ?? ''] ?? '成熟状态未知'
}
export function continuationValue(result?: ContinuationResult) {
  if (!result) return '待补关联'
  if (result.rate.value != null) {
    return `${resultPercent(result.rate.value)}${result.observation?.status === 'mature' ? '' : '（暂计）'}`
  }
  if (result.observation?.status !== 'mature') return maturityLabel(result.observation?.status)
  return '暂无可计算起点'
}
export const fulfillmentState: Record<string, string> = {
  valid: '当前权益有效', missing: '缺少有效权益', entitlement_mismatch: '权益归属不符',
  refunded: '已退款', revoked: '权益已撤销', expired: '权益已到期', not_started: '权益尚未开始',
  environment_unknown: '环境依据不明确', payment_unconfirmed: '付款尚未确认',
  association_unknown: '同单关联待核对', order_unavailable: '原订单不可用',
}
