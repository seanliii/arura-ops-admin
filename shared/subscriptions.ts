/** User-facing subscription preparation. Observations are not payment receipts. */
export type SubscriptionDevice = 'android' | 'iphone'
export type SubscriptionAction = 'create' | 'reactivate'
export type SubscriptionOperationStatus =
  | 'checking' | 'submitting' | 'ready_for_sdk' | 'awaiting_confirmation' | 'outcome_unknown' | 'not_created'
  | 'confirmed' | 'conflict'
export interface SubscriptionConfig {
  tierIds: string[]
  /** Official no-charge sandbox only; production fulfillment is not enabled by this switch. */
  sandboxCheckout: boolean
  /** Defaults off. Real checkout also requires production mode and approved real tiers. */
  productionCheckout?: boolean
}
export interface SubscriptionOffer {
  tierId: string
  price: string
  currency: string
  symbol: string
  deductCycle: 'WEEKLY' | 'MONTHLY' | 'BIMONTHLY' | 'QUARTERLY' | 'SEMIANNYALLY' | 'ANNUALLY'
  deductType: 'one_time' | 'auto_renew'
}
export interface SubscriberSummary {
  subscriptionId: string
  tierId: string
  rightsValid: boolean
  renewalNormal: boolean
  sourceEnvironment: 'sandbox' | 'production' | 'unknown'
}
export interface SubscriptionOperation {
  id: string
  action: SubscriptionAction
  status: SubscriptionOperationStatus
  offer: SubscriptionOffer
  devicePlatform: SubscriptionDevice
  tradeOrderId: string | null
  subscriptionId: string | null
  createdAt: number
  updatedAt: number
  errorCode: string | null
  providerStatus: 'PENDING' | 'SUCCESS' | 'REFUNDED' | null
  sourceEnvironment: 'sandbox' | 'production' | 'unknown'
  checkedAt: number | null
  /** True only after this operation is linked to a processed matching receipt. */
  isFulfillmentProof: boolean
  receipt?: SubscriptionReceiptConfirmation | null
  refundStatus?: 'none' | 'reported' | 'revoked'
}
export interface SubscriptionState {
  userId: string
  configured: boolean
  sandboxCheckout: boolean
  canCheckout: boolean
  fulfillmentReady: boolean
  mode: 'local' | 'staging' | 'production'
  reason: string | null
  operation: SubscriptionOperation | null
  access?: PlatformSubscriptionAccess
}
export interface SubscriptionQuote {
  id: string
  devicePlatform: SubscriptionDevice
  expiresAt: number
  tiers: SubscriptionOffer[]
}
export interface SubscriptionQuoteResponse {
  quote: SubscriptionQuote
  subscriptions: SubscriberSummary[]
  checkedAt: number
  sandboxCheckout: boolean
  canCheckout: boolean
  fulfillmentReady: boolean
}
export interface SubscriptionOperationResponse {
  operation: SubscriptionOperation
  created?: boolean
}
export interface SubscriptionSDKStart extends SubscriptionOperationResponse {
  sdk: { action: SubscriptionAction; tradeOrderId: string }
}

/** Current access observation; refreshAt is cache freshness, NOT subscription expiry. */
export interface PlatformSubscriptionAccess {
  source: 'tiktok_current_subscription'
  status: 'valid' | 'inactive' | 'unverified' | 'unconfigured'
  checkedAt: number | null
  refreshAt: number | null
  reason: 'not_configured' | 'not_tiktok_user' | 'provider_unavailable' | 'environment_unverified'
    | 'identity_changed' | 'refresh_required' | 'login_required' | null
}
export interface SubscriptionRestoreResponse {
  access: PlatformSubscriptionAccess
}

export interface SubscriptionReceiptConfirmation {
  receiptId: string
  event: 'minis.subscription.create' | 'minis.subscription.reactivate'
  eventCreatedAt: number
  recordedAt: number
}
export interface SubscriptionHistoryItem {
  tradeOrderId: string
  subscriptionId: string
  kind: 'create' | 'renew' | 'unknown'
  confirmation: 'confirmed' | 'unconfirmed' | 'conflict'
  confirmedAt: number | null
  originalPrice: string | null
  actualPrice: string | null
  currency: string | null
  refundReported: boolean
  revoked: boolean
  createdAt: number
}
export interface SubscriptionHistoryResponse {
  items: SubscriptionHistoryItem[]
  nextCursor: string | null
}
export type SubscriptionProcessingStatus =
  | 'unprocessed' | 'recorded' | 'duplicate' | 'pending_binding' | 'pending_environment'
  | 'invalid' | 'unsupported' | 'conflict' | 'retryable_error'
export interface SubscriptionProcessing {
  status: SubscriptionProcessingStatus
  reason: string | null
  environment: 'sandbox' | 'production' | 'unknown'
  updatedAt: number | null
  retryAt: number | null
}
