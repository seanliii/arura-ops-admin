import { Buffer } from 'node:buffer'
import { TextDecoder } from 'node:util'

export type SubscriptionAction =
  | 'create' | 'renew' | 'reactivate' | 'cancel' | 'onhold' | 'expire' | 'refund' | 'revoke'
export type SubscriptionEnvironment = 'sandbox' | 'production' | 'unknown'

export interface SubscriptionDiscount {
  party?: string
  source?: string
  discountAmount?: string
  discountRate?: string
  currency?: string
}

export interface SubscriptionContent {
  action: SubscriptionAction
  eventName: string
  clientKey: string
  userOpenId: string | null
  eventCreatedAt: number
  subscriptionId: string | null
  tradeOrderId: string | null
  orderId: string | null
  environment: SubscriptionEnvironment
  originalPrice: string | null
  actualPrice: string | null
  currency: string | null
  refundPrice: string | null
  refundCurrency: string | null
  benefitBeginRaw: string | null
  benefitEndRaw: string | null
  discounts: ReadonlyArray<SubscriptionDiscount> | null
  issues: string[]
}

export type SubscriptionDecodeResult =
  | { kind: 'unsupported'; eventName: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'event'; value: SubscriptionContent }

const actions: ReadonlyMap<string, SubscriptionAction> = new Map([
  ['minis.subscription.create', 'create'],
  ['minis.subscription.renew', 'renew'],
  ['minis.subscription.reactivate', 'reactivate'],
  ['minis.subscription.cancel', 'cancel'],
  ['minis.subscription.onhold', 'onhold'],
  ['minis.subscription.expire', 'expire'],
  ['minis.subscription.refund', 'refund'],
  ['minis.subscription.revoke', 'revoke'],
])

type JsonObject = Record<string, unknown>
type IdentityField = 'user_openid' | 'subscription_id' | 'trade_order_id' | 'order_id'
type PriceField = 'original_price' | 'actual_price' | 'currency' | 'refund_price' | 'refund_currency'
type BenefitField = 'benefit_begin_time' | 'benefit_end_time'

// 与普通字符串 ID 区分；数值只能来自原生 JSON.parse 的原始 token，不能用已舍入的 Number 补回。
class JsonNumber { constructor(readonly source: string) {} }

function parseJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value
    if (typeof context?.source !== 'string') throw new Error('json_number_source_unavailable')
    return new JsonNumber(context.source)
  }) as unknown
}

function isObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object') return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function int64(value: unknown): bigint | null {
  if (!(value instanceof JsonNumber) || !/^-?(?:0|[1-9]\d*)$/.test(value.source)) return null
  const integer = BigInt(value.source)
  return integer >= -9223372036854775808n && integer <= 9223372036854775807n ? integer : null
}

function invalid(reason: string): SubscriptionDecodeResult {
  return { kind: 'invalid', reason }
}

function identity(source: JsonObject, key: IdentityField, issues: Set<string>): string | null {
  const value = source[key]
  if (Object.hasOwn(source, key) && nonemptyString(value)) return value
  issues.add(`${key}.missing`)
  return null
}

function price(source: JsonObject, key: PriceField, issues: Set<string>): string | null {
  const value = source[key]
  if (!Object.hasOwn(source, key) || value === null) return null
  if (typeof value === 'string') return value
  issues.add(`${key}.invalid_type`)
  return null
}

function benefit(source: JsonObject, key: BenefitField, issues: Set<string>): string | null {
  if (!Object.hasOwn(source, key) || source[key] === null) return null
  const value = source[key]
  if (value instanceof JsonNumber && int64(value) !== null) return value.source
  issues.add(`${key}.invalid_int64`)
  return null
}

const discountFields = [
  ['party', 'party'],
  ['source', 'source'],
  ['discount_amount', 'discountAmount'],
  ['discount_rate', 'discountRate'],
  ['currency', 'currency'],
] as const

function discounts(source: JsonObject, issues: Set<string>): ReadonlyArray<SubscriptionDiscount> | null {
  if (!Object.hasOwn(source, 'discounts') || source.discounts === null) return null
  if (!Array.isArray(source.discounts)) {
    issues.add('discounts.invalid_type')
    return null
  }
  const result: SubscriptionDiscount[] = []
  for (const entry of source.discounts) {
    if (!isObject(entry)) {
      issues.add('discounts.invalid_item')
      return null
    }
    const item: SubscriptionDiscount = {}
    for (const [key, output] of discountFields) {
      if (!Object.hasOwn(entry, key)) continue
      const fieldValue = entry[key]
      if (typeof fieldValue !== 'string') {
        issues.add(`discounts.${key}.invalid_type`)
        return null
      }
      item[output] = fieldValue
    }
    result.push(item)
  }
  return result
}

/**
 * 只解析已由上层验签、保存原文的通知；不验签、不读取外部状态、不发货或授予权益。
 * 依据研究中的事件 Content 表按 action 选字段；原始周期数值没有单位转换或到期判断。
 */
export function decodeSubscriptionContent(rawBody: Buffer): SubscriptionDecodeResult {
  if (!Buffer.isBuffer(rawBody)) return invalid('body.invalid_type')
  let body: unknown
  try {
    body = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(rawBody))
  } catch {
    return invalid('body.invalid_json')
  }
  if (!isObject(body)) return invalid('body.invalid_object')
  const eventName = Object.hasOwn(body, 'event') ? body.event : undefined
  if (!nonemptyString(eventName)) return invalid('event.invalid')
  const action = actions.get(eventName)
  if (!action) return { kind: 'unsupported', eventName }
  if (!Object.hasOwn(body, 'client_key') || !nonemptyString(body.client_key)) return invalid('client_key.invalid')

  const seconds = Object.hasOwn(body, 'create_time') ? int64(body.create_time) : null
  if (seconds === null) return invalid('create_time.invalid')
  const milliseconds = seconds * 1000n
  if (milliseconds < BigInt(Number.MIN_SAFE_INTEGER) || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    return invalid('create_time.invalid')
  }
  if (!Object.hasOwn(body, 'content') || typeof body.content !== 'string') return invalid('content.invalid_type')
  let content: unknown
  try {
    content = parseJson(body.content)
  } catch {
    return invalid('content.invalid_json')
  }
  if (!isObject(content)) return invalid('content.invalid_object')
  if (Object.hasOwn(content, 'client_key') && Object.hasOwn(content, 'event') && Object.hasOwn(content, 'content')) {
    return invalid('content.nested_envelope')
  }

  // 显式错型必须与缺失分开；即使某事件不使用该 ID，也不能让错误身份降级成可继承的缺省。
  if (Object.hasOwn(body, 'user_openid') && typeof body.user_openid !== 'string') return invalid('user_openid.invalid')
  for (const key of ['subscription_id', 'trade_order_id', 'order_id'] as const) {
    if (Object.hasOwn(content, key) && !nonemptyString(content[key])) return invalid(`${key}.invalid`)
  }
  if (Object.hasOwn(content, 'is_sandbox') && typeof content.is_sandbox !== 'boolean') {
    return invalid('is_sandbox.invalid_type')
  }

  const issues = new Set<string>()
  const environment: SubscriptionEnvironment = Object.hasOwn(content, 'is_sandbox')
    ? content.is_sandbox === true ? 'sandbox' : 'production'
    : 'unknown'
  if (environment === 'unknown') issues.add('is_sandbox.missing')
  const hasTrade = action !== 'onhold' && action !== 'expire'
  const hasOrder = action === 'create' || action === 'reactivate'
  const hasBenefit = action === 'create' || action === 'renew'
  const hasRefund = action === 'refund' || action === 'revoke'
  const hasPrice = hasBenefit || hasRefund

  const value: SubscriptionContent = {
    action,
    eventName,
    clientKey: body.client_key,
    userOpenId: identity(body, 'user_openid', issues),
    eventCreatedAt: Number(milliseconds),
    subscriptionId: identity(content, 'subscription_id', issues),
    tradeOrderId: hasTrade ? identity(content, 'trade_order_id', issues) : null,
    orderId: hasOrder ? identity(content, 'order_id', issues) : null,
    environment,
    originalPrice: hasPrice ? price(content, 'original_price', issues) : null,
    actualPrice: hasPrice ? price(content, 'actual_price', issues) : null,
    currency: hasPrice ? price(content, 'currency', issues) : null,
    refundPrice: hasRefund ? price(content, 'refund_price', issues) : null,
    refundCurrency: hasRefund ? price(content, 'refund_currency', issues) : null,
    benefitBeginRaw: hasBenefit ? benefit(content, 'benefit_begin_time', issues) : null,
    benefitEndRaw: hasBenefit ? benefit(content, 'benefit_end_time', issues) : null,
    discounts: hasPrice ? discounts(content, issues) : null,
    issues: [],
  }
  value.issues = [...issues]
  return { kind: 'event', value }
}
