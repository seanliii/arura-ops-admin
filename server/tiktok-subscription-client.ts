import { accessToken } from './platform.js'
import { ApiError, type AppContext } from './types.js'

/**
 * Server-only adapter; does not grant rights, persist orders or enable VIP routes.
 * Official text rechecked 2026-10-15:
 * https://developers.tiktok.com/docs/en/minis-subscription-apis (research E02)
 * https://developers.tiktok.com/docs/en/minis-error-codes (research E08)
 * No response, request, credential or upstream error is logged or attached to errors.
 */
const ORIGIN = 'https://open.tiktokapis.com'
const PATHS = {
  create: '/v2/minis/subscription/create/',
  reactivate: '/v2/minis/subscription/reactivate/',
  active: '/v2/minis/subscription/get_active_list/',
  info: '/v2/minis/subscription/get_subscription_info/',
  trade: '/v2/minis/subscription/get_trade_order_info/',
  tiers: '/v2/minis/subscription/get_subscription_tier_info/',
} as const
const TIMEOUT_MS = 12_000
const DEDUCT_CYCLES = ['WEEKLY', 'MONTHLY', 'BIMONTHLY', 'QUARTERLY', 'SEMIANNYALLY', 'ANNUALLY'] as const
const DEDUCT_TYPES = ['one_time', 'auto_renew'] as const
const TRADE_STATUSES = ['PENDING', 'SUCCESS', 'REFUNDED'] as const
const TRADE_FIELDS = [
  'trade_order_id', 'subscription_id', 'trade_order_status', 'is_sandbox', 'pay_type',
  'begin_time', 'begine_time', 'end_time', 'next_duduct_time', 'actually_end_time',
] as const

export interface SubscriptionOrderInfo { orderId: string; productName: string }
export interface CreateSubscriptionInput extends SubscriptionOrderInfo { tierId: string }
export interface ReactivateSubscriptionInput { subscriptionId: string; orderInfo: SubscriptionOrderInfo }
/** Server-local synchronous authorization, executed after token refresh and before dispatch. */
export type SubscriptionDispatchGuard = () => void
/** A created operation, not payment confirmation or proof of subscription rights. */
export interface SubscriptionOrderResult { tradeOrderId: string }
export type SubscriptionEnvironment = 'sandbox' | 'production' | 'unknown'
export type SubscriptionDevicePlatform = 'android' | 'iphone'
export type SubscriptionDeductCycle = typeof DEDUCT_CYCLES[number]
export type SubscriptionDeductType = typeof DEDUCT_TYPES[number]
export type SubscriptionTradeStatus = typeof TRADE_STATUSES[number]

/** Decimal integer lexemes, NOT timestamps converted to any assumed time unit. */
export interface SubscriptionRawTimes {
  begin_time?: string
  begine_time?: string
  end_time?: string
  next_duduct_time?: string
}
export interface SubscriptionInfo {
  subscriptionId: string
  tierId: string
  /** E02 defines this as the latest trade, not necessarily the queried trade. */
  latestTradeOrderId: string
  isSubscriptionRightsValid: boolean
  isRenewalNormal: boolean
  environment: SubscriptionEnvironment
  rawTimes: SubscriptionRawTimes
  /** Preserve new channels too; this client does not choose a management UI. */
  payType?: string
}
export type SubscriptionTradeDocumentShape =
  | 'response_table:data.subscription_tiers_info'
  | 'response_example:data'
export interface SubscriptionTradeRawTimes extends SubscriptionRawTimes {
  /** E02 example only: retain integer text, without interpreting its meaning. */
  actually_end_time?: string
}
/**
 * A user-authorized platform observation, NOT a payment receipt or rights grant.
 * E02 specifies IDs/status, but its layouts disagree and time units are unspecified.
 * E01's fulfillment flow still requires verified webhook evidence and idempotence.
 */
export interface SubscriptionTradeObservation {
  readonly kind: 'subscription_trade_observation'
  readonly isFulfillmentProof: false
  readonly documentShape: SubscriptionTradeDocumentShape
  readonly tradeOrderId: string
  readonly subscriptionId: string
  readonly status: SubscriptionTradeStatus
  readonly environment: SubscriptionEnvironment
  readonly rawTimes: Readonly<SubscriptionTradeRawTimes>
  readonly payType?: string
}
export interface SubscriptionTier {
  tierId: string
  deductCycle: SubscriptionDeductCycle
  deductType: SubscriptionDeductType
  /** Platform price string, never Number, local market pricing or Beans. */
  price: string
  currency: string
  symbol: string
}
export type SubscriptionTiers = Readonly<Record<string, SubscriptionTier>>

const ERRORS = {
  SUBSCRIPTION_INVALID_ARGUMENT: [400, '订阅请求参数无效'],
  TIKTOK_UNCONFIGURED: [503, 'TikTok 订阅所需的服务端凭据尚未配置'],
  TIKTOK_LOGIN_REQUIRED: [401, '请重新登录 TikTok 后再操作'],
  SUBSCRIPTION_TOKEN_UNAVAILABLE: [502, '暂时无法取得用户授权，订阅请求尚未提交'],
  SUBSCRIPTION_REJECTED: [502, 'TikTok 已明确拒绝本次订阅请求'],
  SUBSCRIPTION_REQUEST_FAILED: [502, '暂时无法查询 TikTok 订阅，请稍后核对'],
  SUBSCRIPTION_RESPONSE_INVALID: [502, 'TikTok 订阅响应未通过字段校验'],
  SUBSCRIPTION_OUTCOME_UNKNOWN: [502, '订阅操作结果未知，请核对原订单，不要重新创建或自动重试'],
  SUBSCRIPTION_PROTOCOL_UNCONFIRMED: [502, 'TikTok 订阅协议尚未确认，不能将此响应作为付款或权益凭据'],
  SUBSCRIPTION_PRECONDITION_CHANGED: [409, '发送前的订阅条件已变化，本次业务请求尚未提交'],
} as const
export type SubscriptionErrorCode = keyof typeof ERRORS
/** For writes, only not_submitted / rejected establish no creation by this attempt. */
export type SubscriptionRequestOutcome = 'not_submitted' | 'rejected' | 'unknown'
export type SubscriptionProtocolIssue =
  | 'trade_response_layout' | 'trade_status' | 'trade_identity' | 'trade_fields' | 'begin_time_conflict'

export class TikTokSubscriptionError extends ApiError {
  declare code: SubscriptionErrorCode
  constructor(
    code: SubscriptionErrorCode,
    public readonly outcome: SubscriptionRequestOutcome = 'unknown',
    public readonly protocolIssue?: SubscriptionProtocolIssue,
  ) {
    super(ERRORS[code][0], code, ERRORS[code][1])
    this.name = 'TikTokSubscriptionError'
  }
}

const invalidArgument = () => new TikTokSubscriptionError('SUBSCRIPTION_INVALID_ARGUMENT', 'not_submitted')
const invalidResponse = () => new TikTokSubscriptionError('SUBSCRIPTION_RESPONSE_INVALID')
const protocolUnconfirmed = (issue: SubscriptionProtocolIssue) =>
  new TikTokSubscriptionError('SUBSCRIPTION_PROTOCOL_UNCONFIRMED', 'unknown', issue)

// Wrapping numeric tokens avoids confusing a JSON number with a genuine string ID.
// Only native JSON.parse parses JSON; there is no fallback parser or rounded Number.
class JsonNumber { constructor(readonly source: string) {} }
function parseResponse(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value
    if (typeof context?.source !== 'string') throw invalidResponse()
    return new JsonNumber(context.source)
  }) as unknown
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof JsonNumber)
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse()
  return value
}
function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function inputString(value: unknown): string {
  if (!nonemptyString(value)) throw invalidArgument()
  return value
}
function responseString(value: unknown): string {
  if (!nonemptyString(value)) throw invalidResponse()
  return value
}
function responseBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidResponse()
  return value
}
function environment(source: Record<string, unknown>): SubscriptionEnvironment {
  if (!Object.hasOwn(source, 'is_sandbox')) return 'unknown'
  return responseBoolean(source.is_sandbox) ? 'sandbox' : 'production'
}
function rawInt64(value: unknown): string {
  // Never coerce quoted numbers, round a fraction or expand an exponent.
  if (!(value instanceof JsonNumber) || !/^-?(?:0|[1-9]\d*)$/.test(value.source)) throw invalidResponse()
  const integer = BigInt(value.source)
  if (integer < -9223372036854775808n || integer > 9223372036854775807n) throw invalidResponse()
  return value.source
}
function rawTimes(source: Record<string, unknown>): SubscriptionRawTimes {
  const result: SubscriptionRawTimes = {}
  for (const key of ['begin_time', 'begine_time', 'end_time', 'next_duduct_time'] as const) {
    if (!Object.hasOwn(source, key)) continue
    result[key] = rawInt64(source[key])
  }
  if (result.begin_time !== undefined && result.begine_time !== undefined && result.begin_time !== result.begine_time) {
    throw protocolUnconfirmed('begin_time_conflict')
  }
  return result
}
function decodeSubscription(value: unknown): SubscriptionInfo {
  const source = record(value)
  return {
    subscriptionId: responseString(source.subscription_id),
    tierId: responseString(source.tier_id),
    latestTradeOrderId: responseString(source.trade_order_id),
    isSubscriptionRightsValid: responseBoolean(source.is_subscription_rights_valid),
    isRenewalNormal: responseBoolean(source.is_renewal_normal),
    environment: environment(source),
    rawTimes: rawTimes(source),
    ...(Object.hasOwn(source, 'pay_type') ? { payType: responseString(source.pay_type) } : {}),
  }
}
function orderInfo(input: SubscriptionOrderInfo): { order_id: string; product_name: string } {
  if (!isRecord(input)) throw invalidArgument()
  // Never spread caller-supplied identity, authorization, price or other extras.
  return { order_id: inputString(input.orderId), product_name: inputString(input.productName) }
}

async function userToken(ctx: AppContext, userId: string): Promise<string> {
  inputString(userId)
  if (!nonemptyString(ctx.config.tiktokClientKey) || !nonemptyString(ctx.config.tiktokClientSecret) ||
      !ctx.config.tokenEncryptionKey || !/^[0-9a-f]{64}$/i.test(ctx.config.tokenEncryptionKey)) {
    throw new TikTokSubscriptionError('TIKTOK_UNCONFIGURED', 'not_submitted')
  }
  let token: unknown
  try {
    // Reuse the existing user-bound decryption, refresh and rotated-token storage.
    // This is before submission; a refresh error is NOT an unknown created order.
    token = await accessToken(ctx, userId)
  } catch (error) {
    const code = error instanceof ApiError && error.status === 401
      ? 'TIKTOK_LOGIN_REQUIRED' : 'SUBSCRIPTION_TOKEN_UNAVAILABLE'
    throw new TikTokSubscriptionError(code, 'not_submitted')
  }
  if (!nonemptyString(token) || /[\r\n]/.test(token)) {
    throw new TikTokSubscriptionError('TIKTOK_LOGIN_REQUIRED', 'not_submitted')
  }
  return token
}

// E08 explicitly documents these request/business rejections. Unknown codes,
// internal error 50001000 and duplicate external order 20021002 prove no such thing.
const WRITE_REJECTIONS = new Set([
  '40001000', '20021001', '20001003', '20021101', '20021102', '20021103', '20021108', '20021111',
])
function errorCode(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (value instanceof JsonNumber && /^\d+$/.test(value.source)) return value.source
  return undefined
}

async function post(
  ctx: AppContext, userId: string, operation: keyof typeof PATHS, body: Record<string, unknown>,
  beforeDispatch?: SubscriptionDispatchGuard,
): Promise<Record<string, unknown>> {
  const token = await userToken(ctx, userId)
  const writing = operation === 'create' || operation === 'reactivate'
  if (writing && beforeDispatch) {
    try {
      const result: unknown = beforeDispatch()
      if (result !== undefined) {
        // An accidental async guard cannot authorize a request before it settles.
        void Promise.resolve(result).catch(() => {})
        throw new Error()
      }
    } catch {
      throw new TikTokSubscriptionError('SUBSCRIPTION_PRECONDITION_CHANGED', 'not_submitted')
    }
  }
  const unknownWrite = () => new TikTokSubscriptionError('SUBSCRIPTION_OUTCOME_UNKNOWN')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let response: Response
  let text: string
  try {
    // The deadline includes reading the body. Abort alone does not bound a body
    // supplied by a custom fetch implementation which fails to honor its signal.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')) }, TIMEOUT_MS)
    })
    const received = await Promise.race([
      (async () => {
        const response = await fetch(ORIGIN + PATHS[operation], {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        })
        return { response, text: await response.text() }
      })(),
      deadline,
    ])
    response = received.response
    text = received.text
  } catch {
    throw writing ? unknownWrite() : new TikTokSubscriptionError('SUBSCRIPTION_REQUEST_FAILED')
  } finally {
    clearTimeout(timer)
  }

  let envelope: Record<string, unknown>
  let code: string | undefined
  try {
    envelope = record(parseResponse(text))
    code = errorCode(record(envelope.error).code)
  } catch {
    throw writing ? unknownWrite() : invalidResponse()
  }
  if (writing) {
    if ((!response.ok && (response.status < 400 || response.status >= 500)) ||
        [408, 409, 425, 429].includes(response.status)) throw unknownWrite()
    if (code !== 'ok') {
      const hasTrade = Object.hasOwn(envelope, 'trade_order_id') ||
        (isRecord(envelope.data) && Object.hasOwn(envelope.data, 'trade_order_id'))
      if (!hasTrade && code && WRITE_REJECTIONS.has(code)) {
        throw new TikTokSubscriptionError('SUBSCRIPTION_REJECTED', 'rejected')
      }
      throw unknownWrite()
    }
    if (!response.ok || !isRecord(envelope.data)) throw unknownWrite()
  } else {
    if (!code) throw invalidResponse()
    if (response.status === 401 && code !== 'ok') {
      throw new TikTokSubscriptionError('TIKTOK_LOGIN_REQUIRED', 'not_submitted')
    }
    if (!response.ok) throw new TikTokSubscriptionError('SUBSCRIPTION_REQUEST_FAILED')
    if (code !== 'ok') throw new TikTokSubscriptionError('SUBSCRIPTION_REJECTED', 'rejected')
  }
  return record(envelope.data)
}

function decodeCreatedOrder(source: Record<string, unknown>): SubscriptionOrderResult {
  if (!nonemptyString(source.trade_order_id)) throw new TikTokSubscriptionError('SUBSCRIPTION_OUTCOME_UNKNOWN')
  return { tradeOrderId: source.trade_order_id }
}

/** Persist an intent before calling. This method submits once and NEVER retries. */
export async function createSubscription(
  ctx: AppContext, userId: string, input: CreateSubscriptionInput,
  beforeDispatch?: SubscriptionDispatchGuard,
): Promise<SubscriptionOrderResult> {
  if (!isRecord(input)) throw invalidArgument()
  const body = { tier_id: inputString(input.tierId), order_info: orderInfo(input) }
  return decodeCreatedOrder(await post(ctx, userId, 'create', body, beforeDispatch))
}

/** Reactivation is not restore-purchases or evidence of payment for a new period. */
export async function reactivateSubscription(
  ctx: AppContext, userId: string, input: ReactivateSubscriptionInput,
  beforeDispatch?: SubscriptionDispatchGuard,
): Promise<SubscriptionOrderResult> {
  if (!isRecord(input)) throw invalidArgument()
  const body = { subscription_id: inputString(input.subscriptionId), order_info: orderInfo(input.orderInfo) }
  return decodeCreatedOrder(await post(ctx, userId, 'reactivate', body, beforeDispatch))
}

export async function getActiveSubscriptions(ctx: AppContext, userId: string): Promise<SubscriptionInfo[]> {
  // E02 declares POST with no body parameters. {} needs confirmation in authorized
  // platform testing; do not copy the example curl's implicit GET.
  const data = await post(ctx, userId, 'active', {})
  if (!Array.isArray(data.subscriptions)) throw invalidResponse()
  return data.subscriptions.map(decodeSubscription)
}

export async function getSubscriptionInfo(
  ctx: AppContext, userId: string, tradeOrderId: string,
): Promise<SubscriptionInfo> {
  const data = await post(ctx, userId, 'info', { trade_order_id: inputString(tradeOrderId) })
  return decodeSubscription(data.subscription)
}

/**
 * E02's response table names data.subscription_tiers_info as a single trade
 * object; its same-section example puts that object directly in data. Recognize
 * only those two documented layouts and tag the one actually received, rather
 * than asserting that either is a confirmed receipt contract.
 * Required IDs and the three statuses come from SubscriptionTradeOrderInfoObject,
 * NOT the example's random status. Optional environment/times stay absent/unknown.
 * Never merge layouts, search unknown wrappers or infer amounts/paid periods.
 */
export async function getSubscriptionTrade(
  ctx: AppContext, userId: string, tradeOrderId: string,
): Promise<SubscriptionTradeObservation> {
  const data = await post(ctx, userId, 'trade', { trade_order_id: inputString(tradeOrderId) })
  // Even an environment/time field outside a nested trade makes its layout
  // ambiguous. Do not silently prefer the nested object or combine the two.
  const flat = TRADE_FIELDS.some(key => Object.hasOwn(data, key))
  const nested = Object.hasOwn(data, 'subscription_tiers_info')
  if (flat === nested) throw protocolUnconfirmed('trade_response_layout')
  const source = nested ? data.subscription_tiers_info : data
  if (!isRecord(source)) throw protocolUnconfirmed('trade_response_layout')
  if (!nonemptyString(source.trade_order_id) || source.trade_order_id !== tradeOrderId ||
      !nonemptyString(source.subscription_id)) throw protocolUnconfirmed('trade_identity')
  const status = source.trade_order_status
  if (typeof status !== 'string' || !TRADE_STATUSES.includes(status as SubscriptionTradeStatus)) {
    throw protocolUnconfirmed('trade_status')
  }
  try {
    const times: SubscriptionTradeRawTimes = rawTimes(source)
    if (Object.hasOwn(source, 'actually_end_time')) times.actually_end_time = rawInt64(source.actually_end_time)
    return {
      kind: 'subscription_trade_observation',
      isFulfillmentProof: false,
      documentShape: nested ? 'response_table:data.subscription_tiers_info' : 'response_example:data',
      tradeOrderId: source.trade_order_id,
      subscriptionId: source.subscription_id,
      status: status as SubscriptionTradeStatus,
      environment: environment(source),
      rawTimes: times,
      ...(Object.hasOwn(source, 'pay_type') ? { payType: responseString(source.pay_type) } : {}),
    }
  } catch (error) {
    if (error instanceof TikTokSubscriptionError && error.protocolIssue === 'begin_time_conflict') throw error
    throw protocolUnconfirmed('trade_fields')
  }
}

/** No cache: user authorization and device_platform scope every price lookup. */
export async function getSubscriptionTiers(
  ctx: AppContext, userId: string, tierIds: readonly string[], devicePlatform: SubscriptionDevicePlatform,
): Promise<SubscriptionTiers> {
  if (!Array.isArray(tierIds) || tierIds.length === 0 || !['android', 'iphone'].includes(devicePlatform)) throw invalidArgument()
  const requested = Array.from(tierIds, inputString)
  const data = await post(ctx, userId, 'tiers', { tier_ids: requested, device_platform: devicePlatform })
  const tiers = record(data.subscription_tiers_info)
  return Object.fromEntries(Object.entries(tiers).map(([key, value]): [string, SubscriptionTier] => {
    const source = record(value)
    const tierId = responseString(source.tier_id)
    if (key !== tierId || !requested.includes(tierId) ||
        !DEDUCT_CYCLES.includes(source.deduct_cycle as SubscriptionDeductCycle) ||
        !DEDUCT_TYPES.includes(source.deduct_type as SubscriptionDeductType) ||
        typeof source.symbol !== 'string') throw invalidResponse()
    return [key, {
      tierId,
      deductCycle: source.deduct_cycle as SubscriptionDeductCycle,
      deductType: source.deduct_type as SubscriptionDeductType,
      price: responseString(source.price),
      currency: responseString(source.currency),
      symbol: source.symbol,
    }]
  }))
}
