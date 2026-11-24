<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SubscriptionInspection } from '../../shared/subscription-inspection'
import type { SubscriptionHistoryScope } from '../../shared/subscription-review'
import { api, ApiError, formatDate, message, SESSION_EXPIRED } from '../api'
import Feedback from './Feedback.vue'
import SubscriptionHistory from './SubscriptionHistory.vue'

const props = defineProps<{ userId: string; nickname: string; historyOnly?: boolean; initialScope?: SubscriptionHistoryScope }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const observation = ref<SubscriptionInspection | null>(null)
const loading = ref(false)
const error = ref('')
const closed = ref(false)
const historyPanel = ref<InstanceType<typeof SubscriptionHistory>>()
let controller = new AbortController()
let generation = 0
const environments = { sandbox: '平台测试订阅', production: '平台正式订阅', unknown: '来源环境未知' }

async function load() {
  if (closed.value || loading.value) return
  const target = props.userId, epoch = generation, signal = controller.signal
  const current = () => !closed.value && epoch === generation && target === props.userId && !signal.aborted
  loading.value = true; error.value = ''
  try {
    const result = await api<SubscriptionInspection>(
      `/admin/users/${encodeURIComponent(target)}/subscriptions/query`,
      { method: 'POST', body: {}, signal, notify401: false },
    )
    if (!current()) return
    if (result.userId !== target || result.isFulfillmentProof !== false ||
      !Number.isSafeInteger(result.checkedAt) || typeof result.cached !== 'boolean' ||
      !Array.isArray(result.subscriptions) || result.subscriptions.some(item =>
        !item || typeof item.subscriptionId !== 'string' || typeof item.tierId !== 'string'
        || typeof item.latestTradeOrderId !== 'string' || typeof item.isSubscriptionRightsValid !== 'boolean'
        || typeof item.isRenewalNormal !== 'boolean' || !Object.hasOwn(environments, item.environment)
        || !item.rawTimes || typeof item.rawTimes !== 'object'
        || Object.values(item.rawTimes).some(value => typeof value !== 'string'))) {
      throw new Error('平台核对结果格式不完整，未更新已有观察记录。')
    }
    observation.value = result
  } catch (cause) {
    if (!current()) return
    if (cause instanceof ApiError && (cause.status === 401 || (cause.status === 403 && cause.code === 'FORBIDDEN'))) {
      window.dispatchEvent(new Event(SESSION_EXPIRED))
    } else error.value = message(cause)
  } finally {
    if (current()) {
      // 失败也是新的核对观察；不能让历史沿用上一次成功查询的权益结论。
      await historyPanel.value?.refreshIfLoaded()
      if (current()) loading.value = false
    }
  }
}
function reset() {
  generation++
  controller.abort(); controller = new AbortController()
  observation.value = null; loading.value = false; error.value = ''
}
function close() {
  if (closed.value) return
  closed.value = true; reset()
  dialog.value?.close()
  emit('close')
}
watch(() => props.userId, () => { reset(); if (!closed.value && !props.historyOnly) void load() }, { flush: 'sync' })
onMounted(() => {
  window.addEventListener(SESSION_EXPIRED, close)
  dialog.value?.showModal()
  if (!props.historyOnly) void load()
})
onBeforeUnmount(() => {
  window.removeEventListener(SESSION_EXPIRED, close)
  closed.value = true; generation++; controller.abort()
})
</script>

<template>
  <dialog ref="dialog" class="confirm-dialog subscription-inspector" aria-labelledby="subscription-inspector-title" @cancel.prevent="close">
    <div class="inspector-body">
    <h2 id="subscription-inspector-title">{{ historyOnly ? '订阅记录与异常核对' : '平台订阅只读核对' }}</h2>
    <p>目标用户：{{ nickname }} <small class="mono">{{ userId }}</small></p>
    <SubscriptionHistory v-if="historyOnly && !closed" ref="historyPanel" :key="userId" :user-id="userId" :initial-scope="initialScope" auto-load />
    <component :is="historyOnly ? 'details' : 'section'" class="current-inspection">
    <summary v-if="historyOnly">平台当前权益</summary>
    <p :class="historyOnly ? 'muted' : 'notice warning'">这里只查询平台当前订阅，不开通、续期、取消或退款，也不直接给本系统发放会员。查询成功不是付款回执。</p>
    <button v-if="historyOnly" class="button" type="button" :disabled="loading" @click="load">查询平台当前权益</button>
    <Feedback :loading="loading" :error="error" />
    <template v-if="observation">
      <p class="muted">查询时间：{{ formatDate(observation.checkedAt) }}<span v-if="observation.cached"> · 使用 30 秒内的查询缓存</span></p>
      <p v-if="error" class="notice warning">下方为上次成功取得的信息，不代表本次查询已成功。</p>
      <p v-if="!observation.subscriptions.length" class="notice">平台未返回当前订阅；这不表示用户没有历史消费。</p>
      <article v-for="(subscription, index) in observation.subscriptions" :key="`${subscription.subscriptionId}-${index}`" class="inspection-item">
        <p class="badge">{{ environments[subscription.environment] }}</p>
        <dl class="inspection-grid">
          <div><dt>平台订阅编号</dt><dd class="mono">{{ subscription.subscriptionId }}</dd></div>
          <div><dt>平台档位</dt><dd class="mono">{{ subscription.tierId }}</dd></div>
          <div><dt>最近关联交易</dt><dd class="mono">{{ subscription.latestTradeOrderId }}</dd></div>
          <div><dt>支付方式</dt><dd>{{ subscription.payType || '未提供' }}</dd></div>
        </dl>
        <p>{{ subscription.isSubscriptionRightsValid ? '平台当前权益：有效' : '平台当前权益：无效' }}</p>
        <p>{{ subscription.isRenewalNormal ? '平台返回续费状态正常' : '续费状态异常或已关闭，具体原因仍需核对' }}</p>
        <details v-if="Object.keys(subscription.rawTimes).length">
          <summary>平台原始时间字段（单位待核实）</summary>
          <p class="muted">保留原始整数，不推算日期、已付周期或剩余会员天数。</p>
          <dl><template v-for="(value, field) in subscription.rawTimes" :key="field"><dt class="mono">{{ field }}</dt><dd class="mono">{{ value }}</dd></template></dl>
        </details>
      </article>
    </template>
    </component>
    <SubscriptionHistory v-if="!historyOnly && !closed" ref="historyPanel" :key="userId" :user-id="userId" />
    </div>
    <div class="form-actions inspector-actions">
      <button v-if="!historyOnly" class="button primary" type="button" :disabled="loading" @click="load">重新查询</button>
      <button class="button" type="button" @click="close">关闭</button>
    </div>
  </dialog>
</template>

<style scoped>
.subscription-inspector { width: min(760px, calc(100vw - 32px)); overflow-wrap: anywhere; }
.subscription-inspector[open] { display: flex; flex-direction: column; overflow: visible; }
.inspector-body { min-height: 0; min-width: 0; overflow: auto; }
.inspector-actions { flex: none; padding: .75rem 0 0; background: inherit; flex-wrap: wrap; }
.inspection-item { padding: 1rem 0; border-top: 1px solid var(--border, #e4e7eb); }
.inspection-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.inspection-grid dt { color: var(--muted, #626b78); font-size: .875rem; }
.inspection-grid dd { margin: .3rem 0 0; }
details dd { margin: .25rem 0 .6rem; }
summary { cursor: pointer; min-height: 44px; padding: .6rem 0; }
.current-inspection { margin-top: 1rem; min-width: 0; }
@media (max-width: 560px) {
  .inspection-grid { grid-template-columns: 1fr; }
  .subscription-inspector { padding: 16px; }
}
</style>
