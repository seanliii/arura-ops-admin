import type { AppMode } from './contracts.js'

/** Operator-facing observation only. This is not a paid-order or entitlement DTO. */
export interface InspectedSubscription {
  subscriptionId: string
  tierId: string
  latestTradeOrderId: string
  isSubscriptionRightsValid: boolean
  isRenewalNormal: boolean
  environment: 'sandbox' | 'production' | 'unknown'
  rawTimes: {
    begin_time?: string
    begine_time?: string
    end_time?: string
    next_duduct_time?: string
  }
  payType?: string
}
export interface SubscriptionInspection {
  userId: string
  checkedAt: number
  cached: boolean
  receivingMode: AppMode
  isFulfillmentProof: false
  subscriptions: InspectedSubscription[]
}
