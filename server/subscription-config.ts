import type { AppMode } from '../shared/contracts.js'
import type { SubscriptionConfig } from '../shared/subscriptions.js'

/** Exact official no-charge tiers from the subscription guide; not production SKUs. */
export const OFFICIAL_SANDBOX_TIERS = new Set([
  'sandbox_499_1M', 'sandbox_1347_3M', 'sandbox_699_1M', 'sandbox_1887_3M',
])

export function loadSubscriptionConfig(mode: AppMode, supplied?: SubscriptionConfig): SubscriptionConfig | undefined {
  const rawIds = process.env.TIKTOK_SUBSCRIPTION_TIER_IDS?.trim() || ''
  const rawEnabled = process.env.TIKTOK_SUBSCRIPTION_SANDBOX?.trim() || ''
  const rawProduction = process.env.TIKTOK_SUBSCRIPTION_PRODUCTION?.trim() || ''
  if (!supplied && !rawIds && (!rawEnabled || rawEnabled === 'false') &&
    (!rawProduction || rawProduction === 'false')) return undefined
  if (!supplied && ((rawEnabled && !['true', 'false'].includes(rawEnabled)) ||
    (rawProduction && !['true', 'false'].includes(rawProduction)))) {
    throw new Error('订阅测试和生产开关必须为true或false')
  }
  const ids = supplied?.tierIds ?? rawIds.split(',').map(value => value.trim()).filter(Boolean)
  const enabled = supplied?.sandboxCheckout ?? rawEnabled === 'true'
  const production = supplied?.productionCheckout ?? rawProduction === 'true'
  if (!Array.isArray(ids) || !ids.length || ids.length > 12 ||
    ids.some(id => typeof id !== 'string' || !id || id !== id.trim() || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) ||
    new Set(ids).size !== ids.length || typeof enabled !== 'boolean' || typeof production !== 'boolean') {
    throw new Error('订阅档位必须为1至12个不重复的真实平台ID')
  }
  if (mode === 'production' && ids.some(id => /^sandbox/i.test(id))) {
    throw new Error('生产环境不能配置官方sandbox订阅档位')
  }
  if (enabled && (mode !== 'staging' || !ids.every(id => OFFICIAL_SANDBOX_TIERS.has(id)))) {
    throw new Error('官方无真钱订阅测试仅允许预发布环境及明确列出的官方sandbox档位')
  }
  if (production && (mode !== 'production' || enabled)) {
    throw new Error('真实订阅只能在生产环境显式开启，不能与官方测试同时开启')
  }
  return { tierIds: [...ids], sandboxCheckout: enabled, productionCheckout: production }
}
