<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  subscriptionRefundLabels, subscriptionReviewLabels, subscriptionRightsLabels,
  type AdminSubscriptionHistoryItem, type AdminSubscriptionHistoryResponse,
  type SubscriptionHistoryScope, type SubscriptionReview,
} from '../../shared/subscription-review'
import { api, ApiError, formatDate, message, SESSION_EXPIRED } from '../api'
import Feedback from './Feedback.vue'
import SubscriptionEvents from './SubscriptionEvents.vue'

const props = defineProps<{ userId: string; autoLoad?: boolean; initialScope?: SubscriptionHistoryScope }>()
const emptyScope = (): SubscriptionHistoryScope => ({ tradeOrderId: null, subscriptionId: null })
const initialScope = () => ({ ...emptyScope(), ...props.initialScope })
const items = ref<AdminSubscriptionHistoryItem[]>([])
const nextCursor = ref<string | null>(null)
const requested = ref(false)
const loaded = ref(false)
const loading = ref(false)
const error = ref('')
const tradeInput = ref(props.initialScope?.tradeOrderId ?? '')
const subscriptionInput = ref(props.initialScope?.subscriptionId ?? '')
const applied = ref(initialScope())
type ReadRequest = { action: 'refresh' | 'more'; scope: SubscriptionHistoryScope; before?: string }
const retryRequest = ref<ReadRequest>({ action: 'refresh', scope: initialScope() })
const selectedReceipt = ref<string | null>(null)
const backButton = ref<HTMLButtonElement>()
let receiptOpener: HTMLElement | null = null
let readingPosition: { element: HTMLElement; top: number; left: number }[] = []
const scopeLabel = computed(() => [
  applied.value.tradeOrderId && `交易 ${applied.value.tradeOrderId}`,
  applied.value.subscriptionId && `订阅 ${applied.value.subscriptionId}`,
].filter(Boolean).join(' · ') || '全部订阅记录')
let controller = new AbortController()
let generation = 0
let active = true

function reset() {
  generation++
  controller.abort(); controller = new AbortController()
  items.value = []; nextCursor.value = null
  requested.value = false; loaded.value = false; loading.value = false; error.value = ''
  tradeInput.value = props.initialScope?.tradeOrderId ?? ''
  subscriptionInput.value = props.initialScope?.subscriptionId ?? ''
  applied.value = initialScope(); retryRequest.value = { action: 'refresh', scope: initialScope() }
  selectedReceipt.value = null; receiptOpener = null; readingPosition = []
}
function stop() { active = false; reset(); controller.abort() }
const validTime = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const validPrice = (value: unknown) => value === null || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))
function validReview(value: SubscriptionReview | undefined) {
  if (value === undefined) return true // 旧服务只能展示历史，不能假装已有分类。
  return !!value && Object.hasOwn(subscriptionReviewLabels, value.category)
    && ['sandbox', 'production'].includes(value.environment)
    && Array.isArray(value.reasons) && value.reasons.every(reason => typeof reason === 'string')
    && !!value.rights && Object.hasOwn(subscriptionRightsLabels, value.rights.state)
    && (value.rights.checkedAt === null || validTime(value.rights.checkedAt))
    && !!value.refund && Object.hasOwn(subscriptionRefundLabels, value.refund.state)
    && (value.refund.amount === null || typeof value.refund.amount === 'string')
    && (value.refund.currency === null || typeof value.refund.currency === 'string')
    && Array.isArray(value.receipts) && value.receipts.every(receipt =>
      receipt && typeof receipt.id === 'string' && /^[1-9]\d*$/.test(receipt.id)
      && typeof receipt.event === 'string' && /^minis\.subscription\.[a-z0-9_.-]+$/.test(receipt.event)
      && validTime(receipt.eventCreatedAt) && validTime(receipt.recordedAt))
}
function validItem(item: AdminSubscriptionHistoryItem) {
  return !!item && typeof item.tradeOrderId === 'string' && !!item.tradeOrderId
    && typeof item.subscriptionId === 'string' && !!item.subscriptionId
    && ['create', 'renew', 'unknown'].includes(item.kind)
    && ['confirmed', 'unconfirmed', 'conflict'].includes(item.confirmation)
    && (item.confirmedAt === null || validTime(item.confirmedAt)) && validTime(item.createdAt)
    && validPrice(item.originalPrice) && validPrice(item.actualPrice)
    && (item.currency === null || (typeof item.currency === 'string' && !!item.currency.trim()))
    && typeof item.refundReported === 'boolean' && typeof item.revoked === 'boolean'
    && validReview(item.review)
}
function confirmation(item: AdminSubscriptionHistoryItem) {
  if (item.confirmation === 'conflict') return '需核对：记录冲突'
  const kind = { create: '创建', renew: '续期', unknown: '记录（类型待核对）' }[item.kind]
  return `${item.confirmation === 'confirmed' ? '已确认' : '未确认'}${kind}`
}
async function load(request: ReadRequest) {
  if (!active || loading.value || !props.userId || (request.action === 'more' && !request.before)) return
  const epoch = generation, target = props.userId, signal = controller.signal
  const current = () => active && epoch === generation && target === props.userId && !signal.aborted
  // 失败重试固定到当时的范围和游标，不读取后来改写的输入框。
  const selected = { ...request, scope: { ...request.scope } }
  loading.value = true; requested.value = true; error.value = ''; retryRequest.value = selected
  const query = new URLSearchParams({ limit: '20' })
  if (selected.scope.tradeOrderId) query.set('tradeOrderId', selected.scope.tradeOrderId)
  if (selected.scope.subscriptionId) query.set('subscriptionId', selected.scope.subscriptionId)
  if (selected.before) query.set('before', selected.before)
  try {
    const result = await api<AdminSubscriptionHistoryResponse>(
      `/admin/users/${encodeURIComponent(target)}/subscription-history?${query}`,
      { signal, notify401: false },
    )
    if (!current()) return
    if (!Array.isArray(result.items) || !result.items.every(validItem)
      || (result.nextCursor !== null && (typeof result.nextCursor !== 'string' || !result.nextCursor))) {
      throw new Error('订阅历史格式不正确，未更新已有记录，请重试读取。')
    }
    if ((result.scope === undefined && (selected.scope.tradeOrderId || selected.scope.subscriptionId))
      || (result.scope !== undefined && (!result.scope
        || result.scope.tradeOrderId !== selected.scope.tradeOrderId || result.scope.subscriptionId !== selected.scope.subscriptionId))
      || result.items.some(item => (selected.scope.tradeOrderId && item.tradeOrderId !== selected.scope.tradeOrderId)
        || (selected.scope.subscriptionId && item.subscriptionId !== selected.scope.subscriptionId))) {
      throw new Error('返回的订阅范围不一致，未替换已有记录，请重试。')
    }
    items.value = selected.action === 'more' ? [...items.value, ...result.items] : result.items
    nextCursor.value = result.nextCursor; loaded.value = true; applied.value = selected.scope
  } catch (cause) {
    if (!current()) return
    if (cause instanceof ApiError && (cause.status === 401 || (cause.status === 403 && cause.code === 'FORBIDDEN'))) {
      window.dispatchEvent(new Event(SESSION_EXPIRED))
    } else error.value = message(cause)
  } finally { if (current()) loading.value = false }
}
const refresh = () => load({ action: 'refresh', scope: applied.value })
function applyFilter() {
  return load({ action: 'refresh', scope: {
    tradeOrderId: tradeInput.value.trim() || null, subscriptionId: subscriptionInput.value.trim() || null,
  } })
}
async function openReceipt(id: string, event: Event) {
  receiptOpener = event.currentTarget as HTMLElement
  readingPosition = []
  for (let parent = receiptOpener.parentElement; parent && parent.tagName !== 'DIALOG'; parent = parent.parentElement) {
    if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) {
      readingPosition.push({ element: parent, top: parent.scrollTop, left: parent.scrollLeft })
    }
  }
  selectedReceipt.value = id
  await nextTick(); backButton.value?.focus()
}
async function returnToHistory() {
  selectedReceipt.value = null
  await nextTick()
  for (const position of readingPosition) {
    if (position.element.isConnected) position.element.scrollTo(position.left, position.top)
  }
  if (receiptOpener?.isConnected) receiptOpener.focus({ preventScroll: true })
  readingPosition = []
}
function refreshIfLoaded() {
  if (!active || !requested.value) return Promise.resolve()
  // 明确的平台核对已改变观察水位：较早的历史读取不能盖掉新分类。
  // 只重读已应用范围，不把输入框中尚未确认的筛选一起应用。
  generation++
  controller.abort(); controller = new AbortController()
  loading.value = false
  return refresh()
}
defineExpose({ refreshIfLoaded })
// 即使父组件没使用key，换目标也先清屏；只有明确的只读记录入口自动GET。
watch(() => [props.userId, props.initialScope?.tradeOrderId, props.initialScope?.subscriptionId], () => {
  reset(); if (props.autoLoad) void refresh()
}, { flush: 'sync' })
onMounted(() => {
  window.addEventListener(SESSION_EXPIRED, stop)
  if (props.autoLoad) void refresh()
})
onBeforeUnmount(() => { window.removeEventListener(SESSION_EXPIRED, stop); stop() })
</script>

<template>
  <section class="subscription-history" aria-labelledby="subscription-history-title" :aria-busy="loading">
    <div v-show="!selectedReceipt">
    <div class="section-heading">
      <div><h3 id="subscription-history-title">订阅历史流水</h3><p class="muted">已保存的交易与当前权益分开看。查看记录不向平台发起查询。</p></div>
      <button class="button" type="button" :disabled="loading" @click="refresh">{{ requested ? '刷新订阅历史' : '查看订阅历史流水' }}</button>
    </div>
    <template v-if="requested">
      <details class="history-filter">
        <summary>按完整编号定位</summary>
        <form class="filter-form" @submit.prevent="applyFilter">
          <label class="field"><span>交易编号（完整）</span><input v-model="tradeInput" maxlength="256" autocomplete="off" /></label>
          <label class="field"><span>订阅编号（完整）</span><input v-model="subscriptionInput" maxlength="256" autocomplete="off" /></label>
          <button class="button" type="submit" :disabled="loading">查找订阅记录</button>
          <p class="muted">留空并查找可恢复全部记录；输入不会自动应用，也不只搜索最近一页。</p>
        </form>
      </details>
      <p class="muted applied-scope" data-testid="subscription-history-scope">当前范围：{{ scopeLabel }}</p>
      <Feedback :loading="loading" :error="error" retry @retry="load(retryRequest)" />
      <p v-if="error && items.length" class="notice warning">下方保留上次成功读取的历史，本次读取尚未成功。</p>
      <div v-if="items.length" class="table-scroll history-scroll" tabindex="0" role="region" aria-label="订阅历史流水表格">
        <table class="history-table">
          <thead><tr><th scope="col">确认结果 / 编号</th><th scope="col">确认时间 / 记录时间</th><th scope="col">交易实际金额</th><th scope="col">退款通知 / 撤销标志</th></tr></thead>
          <tbody>
            <tr v-for="(item, index) in items" :key="`${item.subscriptionId}:${item.tradeOrderId}:${item.createdAt}:${index}`" data-testid="subscription-history-row" :data-kind="item.kind">
              <td>
                <span :class="['badge', ['rights_check', 'needs_review'].includes(item.review?.category || '') ? 'warning' : 'neutral']">{{ item.review ? subscriptionReviewLabels[item.review.category] : '分类尚未提供' }}</span>
                <strong>{{ confirmation(item) }}</strong>
                <details><summary>交易与订阅编号</summary><dl>
                  <dt>交易编号</dt><dd class="mono">{{ item.tradeOrderId }}</dd>
                  <dt>订阅编号</dt><dd class="mono">{{ item.subscriptionId }}</dd>
                </dl></details>
                <details v-if="item.review" class="review-evidence">
                  <summary>分类依据与原通知</summary>
                  <p>{{ item.review.environment === 'sandbox' ? '平台测试订阅' : '平台正式订阅' }}</p>
                  <p>{{ subscriptionRightsLabels[item.review.rights.state] }}<small v-if="item.review.rights.checkedAt !== null">观察时间：{{ formatDate(item.review.rights.checkedAt) }}</small></p>
                  <ul><li v-for="reason in item.review.reasons" :key="reason">{{ reason }}</li></ul>
                  <p>{{ subscriptionRefundLabels[item.review.refund.state] }}<small v-if="item.review.refund.amount !== null">原通知金额：{{ item.review.refund.amount }} {{ item.review.refund.currency || '币种未知' }}</small></p>
                  <p class="muted">退款通知不等于退款金额，不累计多次退款；实际金额缺失不用报价补齐。</p>
                  <div v-for="receipt in item.review.receipts" :key="receipt.id" class="receipt-link">
                    <button class="button" type="button" :aria-label="`查看原通知 ${receipt.id}`" @click="openReceipt(receipt.id, $event)">查看原通知 {{ receipt.id }}</button>
                    <small class="mono">{{ receipt.event }}</small><small>事件时间：{{ formatDate(receipt.eventCreatedAt) }}</small>
                  </div>
                  <p v-if="!item.review.receipts.length" class="muted">没有可定位的已处理通知。</p>
                </details>
              </td>
              <td data-label="确认 / 记录时间">{{ item.confirmedAt === null ? '尚无确认时间' : formatDate(item.confirmedAt) }}<small>{{ formatDate(item.createdAt) }}</small></td>
              <td data-label="交易实际金额"><span v-if="item.actualPrice === null">实际金额未知</span><span v-else class="amount">{{ item.actualPrice }} {{ item.currency || '币种未知' }}</span></td>
              <td data-label="退款 / 撤销"><span>{{ item.refundReported ? '收到退款通知（不代表退款金额）' : '未记录退款通知' }}</span><small>{{ item.revoked ? '该笔记录：已撤销' : '未标记撤销' }}</small></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else-if="loaded && !loading && !error" class="notice">{{ applied.tradeOrderId || applied.subscriptionId ? '没有匹配的订阅记录' : '暂无已保存订阅历史' }}；不能据此断言平台从未扣款。</p>
      <div v-if="items.length" class="form-actions wrap">
        <span class="muted">已显示 {{ items.length }} 条历史记录，不是累计扣款次数</span>
        <button v-if="nextCursor" class="button" type="button" :disabled="loading" @click="load({ action: 'more', scope: applied, before: nextCursor })">加载更多订阅历史</button>
        <span v-else-if="loaded" class="muted">已加载全部历史</span>
      </div>
    </template>
    </div>
    <div v-if="selectedReceipt" class="original-receipt">
      <button ref="backButton" class="button" type="button" @click="returnToHistory">返回订阅记录</button>
      <SubscriptionEvents :receipt-id="selectedReceipt" read-only />
    </div>
  </section>
</template>

<style scoped>
.subscription-history { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--line, var(--line)); min-width: 0; }
.section-heading { align-items: flex-start; flex-wrap: wrap; gap: .75rem; }
.section-heading h3 { margin: 0 0 .5rem; }
.section-heading p { margin: 0; }
.history-scroll { max-height: min(45vh, 420px); overflow: auto; }
.history-scroll:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
.history-table { min-width: 0; width: 100%; table-layout: fixed; }
.history-table td { vertical-align: top; overflow-wrap: anywhere; }
.history-table th:first-child { width: 29%; }
.history-table th:nth-child(2) { width: 24%; }
.history-table th:nth-child(3) { width: 20%; }
.history-table dl { display: block; margin: .5rem 0; }
.history-table dd { margin: .25rem 0 .75rem; }
summary { cursor: pointer; min-height: 44px; padding: .6rem 0; }
.amount { font-variant-numeric: tabular-nums; }
.wrap { flex-wrap: wrap; }
.filter-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; padding: .75rem 0; }
.filter-form p { grid-column: 1 / -1; margin: 0; }
.filter-form .field, .filter-form input { min-width: 0; width: 100%; }
.applied-scope { overflow-wrap: anywhere; }
.history-table strong, .history-table .badge { display: block; margin-bottom: .35rem; }
.review-evidence ul { padding-left: 1.1rem; }
.review-evidence li + li { margin-top: .5rem; }
.receipt-link { border-top: 1px solid var(--line); padding: .65rem 0; }
.original-receipt { min-width: 0; }
@media (max-width: 800px) {
  .history-scroll { max-height: none; overflow: visible; }
  .history-table, .history-table tbody, .history-table tr, .history-table td { display: block; width: 100%; min-width: 0; }
  .history-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .history-table tr { padding: .75rem; border-bottom: 1px solid var(--line); }
  .history-table td { padding: .5rem 0; border: 0; }
  .history-table td[data-label]::before { content: attr(data-label); display: block; color: var(--muted); margin-bottom: .25rem; }
  .filter-form { grid-template-columns: minmax(0, 1fr); }
}
</style>
