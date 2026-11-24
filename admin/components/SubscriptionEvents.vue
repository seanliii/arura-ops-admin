<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SubscriptionProcessing } from '../../shared/subscriptions'
import type { SubscriptionLedgerLocation } from '../../shared/subscription-review'
import { api, ApiError, formatDate, message, SESSION_EXPIRED } from '../api'
import Feedback from './Feedback.vue'

interface Receipt {
  id: string
  event: string
  eventCreatedAt: number
  receivedAt: number
  receivingMode: 'local' | 'staging' | 'production'
  sourceEnvironment: string
  userId: string | null
  payloadSha256: string
  deliveryCount: number
  status: string
  knownEvent: boolean
  processing?: SubscriptionProcessing
  ledgerLocation?: SubscriptionLedgerLocation | null
}
interface Page { events: Receipt[]; nextCursor: string | null }
const props = defineProps<{ receiptId?: string | null; readOnly?: boolean }>()
const emit = defineEmits<{ 'open-ledger': [location: SubscriptionLedgerLocation, opener: HTMLElement] }>()
const events = ref<Receipt[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const success = ref('')
const reprocessing = ref<string | null>(null)
const receiptInput = ref(props.receiptId ?? '')
const appliedReceipt = ref(props.receiptId ?? '')
type ReadRequest = { action: 'refresh' | 'more'; receiptId: string; before?: string }
const retryRequest = ref<ReadRequest>({ action: 'refresh', receiptId: props.receiptId ?? '' })
let controller = new AbortController()
let generation = 0
const modeLabels = { local: '本地', staging: '预发布', production: '正式' }
const environmentLabels = { sandbox: '平台测试订阅', production: '平台正式订阅', unknown: '来源环境未知' }
const processingLabels: Record<SubscriptionProcessing['status'], string> = {
  unprocessed: '尚未处理（未确认入账）',
  recorded: '已记录（不等于当前会员有效）',
  duplicate: '重复通知，不重复入账',
  pending_binding: '待匹配用户或订阅',
  pending_environment: '待环境核实',
  invalid: '需核对：通知无效',
  unsupported: '需核对：暂不支持的事件',
  conflict: '需核对：记录冲突',
  retryable_error: '暂时失败，待重试（未确认入账）',
}
let active = true
const current = () => active && !controller.signal.aborted
const validTime = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function validProcessing(value: unknown): value is SubscriptionProcessing {
  if (!value || typeof value !== 'object') return false
  const item = value as SubscriptionProcessing
  return Object.hasOwn(processingLabels, item.status) && Object.hasOwn(environmentLabels, item.environment)
    && (item.reason === null || typeof item.reason === 'string')
    && (item.updatedAt === null || validTime(item.updatedAt)) && (item.retryAt === null || validTime(item.retryAt))
}
function reset() {
  generation++
  controller.abort(); controller = new AbortController()
  events.value = []; nextCursor.value = null; loaded.value = false
  loading.value = false; reprocessing.value = null; error.value = ''; success.value = ''
  receiptInput.value = props.receiptId ?? ''; appliedReceipt.value = props.receiptId ?? ''
  retryRequest.value = { action: 'refresh', receiptId: props.receiptId ?? '' }
}
function stop() { active = false; reset(); controller.abort() }
function permissionLost(cause: unknown) {
  if (cause instanceof ApiError && (cause.status === 401 || (cause.status === 403 && cause.code === 'FORBIDDEN'))) {
    window.dispatchEvent(new Event(SESSION_EXPIRED))
    return true
  }
  return false
}

function validReceipt(item: Receipt): boolean {
  return !!item && typeof item.id === 'string' && /^[1-9]\d*$/.test(item.id)
    && typeof item.event === 'string' && /^minis\.subscription\.[a-z0-9_.-]+$/.test(item.event)
    && Number.isSafeInteger(item.eventCreatedAt) && item.eventCreatedAt > 0
    && Number.isSafeInteger(item.receivedAt) && item.receivedAt > 0
    && Object.hasOwn(modeLabels, item.receivingMode)
    && typeof item.sourceEnvironment === 'string' && typeof item.status === 'string'
    && (item.userId === null || typeof item.userId === 'string')
    && typeof item.payloadSha256 === 'string' && /^[a-f0-9]{64}$/.test(item.payloadSha256)
    && Number.isSafeInteger(item.deliveryCount) && item.deliveryCount >= 1
    && typeof item.knownEvent === 'boolean'
    && (item.processing === undefined || validProcessing(item.processing))
    && (item.ledgerLocation == null || (
      typeof item.ledgerLocation.userId === 'string' && !!item.ledgerLocation.userId
      && typeof item.ledgerLocation.subscriptionId === 'string' && !!item.ledgerLocation.subscriptionId
      && (item.ledgerLocation.tradeOrderId === null || (typeof item.ledgerLocation.tradeOrderId === 'string' && !!item.ledgerLocation.tradeOrderId))))
}
async function load(request: ReadRequest) {
  if (!current() || loading.value || (request.action === 'more' && !request.before)) return false
  const selected = { ...request }, epoch = generation, signal = controller.signal
  const stillCurrent = () => current() && generation === epoch && !signal.aborted
  loading.value = true; error.value = ''; success.value = ''; retryRequest.value = selected
  const query = new URLSearchParams({ limit: '20' })
  if (selected.receiptId) query.set('receiptId', selected.receiptId)
  if (selected.before) query.set('before', selected.before)
  try {
    const page = await api<Page>(`/admin/subscription-events?${query}`, {
      signal, notify401: false,
    })
    if (!stillCurrent()) return false
    if (!Array.isArray(page.events) || !page.events.every(validReceipt)
      || (selected.receiptId && page.events.some(event => event.id !== selected.receiptId))
      || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !/^[1-9]\d*$/.test(page.nextCursor)))) {
      throw new Error('订阅通知格式不正确，未更新已有记录，请重试。')
    }
    events.value = selected.action === 'more' ? [...events.value, ...page.events] : page.events
    nextCursor.value = page.nextCursor
    loaded.value = true; appliedReceipt.value = selected.receiptId
    return true
  } catch (cause) {
    if (stillCurrent() && !permissionLost(cause)) error.value = message(cause)
    return false
  } finally { if (stillCurrent()) loading.value = false }
}
const refresh = () => load({ action: 'refresh', receiptId: appliedReceipt.value })
function applyFilter() {
  const id = receiptInput.value.trim()
  if (id && (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    error.value = '请填写完整的数字通知编号，或清空后查找全部。'; return
  }
  return load({ action: 'refresh', receiptId: id })
}
function openLedger(event: Receipt, source: Event) {
  if (!props.readOnly && event.ledgerLocation) emit('open-ledger', event.ledgerLocation, source.currentTarget as HTMLElement)
}
async function reprocess(event: Receipt) {
  if (props.readOnly || !current() || loading.value || reprocessing.value !== null || !events.value.some(item => item.id === event.id)) return
  const epoch = generation
  const stillCurrent = () => current() && generation === epoch
  reprocessing.value = event.id; error.value = ''; success.value = ''
  retryRequest.value = { action: 'refresh', receiptId: appliedReceipt.value }
  try {
    const result = await api<{ processing: SubscriptionProcessing }>(
      `/admin/subscription-events/${encodeURIComponent(event.id)}/reprocess`,
      { method: 'POST', body: {}, signal: controller.signal, notify401: false },
    )
    if (!stillCurrent()) return
    if (!validProcessing(result.processing)) throw new Error('重处理响应格式不正确，请先刷新列表核对。')
    // 只刷新服务端事实；不把按钮点击或响应状态当成手工付款/会员开通。
    const refreshed = await refresh()
    if (stillCurrent()) success.value = refreshed
      ? `通知 ${event.id} 已重新处理并刷新列表，处理记录不等于当前会员有效。`
      : `通知 ${event.id} 的处理响应已返回，但列表尚未刷新成功，请重试读取。`
  } catch (cause) {
    if (stillCurrent() && !permissionLost(cause)) {
      const problem = message(cause)
      // 503也可能已经保存了retryable_error；只重读事实，绝不重放原POST。
      const refreshed = await refresh()
      if (stillCurrent()) error.value = `${problem} ${refreshed ? '列表已重新读取' : '列表暂未刷新成功'}；重处理未完成或结果未确认，需要时再次明确点击该通知的重新处理。`
    }
  } finally { if (stillCurrent()) reprocessing.value = null }
}
watch(() => props.receiptId, () => { reset(); void refresh() }, { flush: 'sync' })
onMounted(() => { window.addEventListener(SESSION_EXPIRED, stop); void refresh() })
onBeforeUnmount(() => { window.removeEventListener(SESSION_EXPIRED, stop); stop() })
</script>

<template>
  <section :class="['panel', { 'compact-receipt': readOnly }]" :aria-label="readOnly ? '原订阅通知' : '订阅通知收件箱'" :aria-busy="loading || reprocessing !== null">
    <div class="section-heading">
      <div><h2>{{ readOnly ? '原订阅通知' : '订阅通知收件箱' }}</h2><p class="muted">查看已保存、已验签的安全摘要；不显示通知原文或凭据。</p></div>
      <button class="button" type="button" :disabled="loading || reprocessing !== null" @click="refresh">刷新订阅通知</button>
    </div>
    <p class="muted">接收成功不代表已付款或已发放会员；{{ readOnly ? '此处只读，不重新处理。' : '重新处理仅按原服务器规则执行，不提供模拟开通或退款。' }}</p>
    <details v-if="!readOnly" class="receipt-filter">
      <summary>按通知编号定位</summary>
      <form class="receipt-search" @submit.prevent="applyFilter">
        <label class="field"><span>通知编号（完整）</span><input v-model="receiptInput" inputmode="numeric" maxlength="16" autocomplete="off" /></label>
        <button class="button" type="submit" :disabled="loading || reprocessing !== null">查找订阅通知</button>
      </form>
    </details>
    <p class="muted" data-testid="subscription-receipt-scope">当前范围：{{ appliedReceipt ? `通知 ${appliedReceipt}` : '全部订阅通知' }}</p>
    <Feedback :loading="loading || reprocessing !== null" :error="error" :success="success" retry @retry="load(retryRequest)" />
    <p v-if="error && events.length" class="notice warning">保留上次成功读取的通知和范围，本次读取尚未成功。</p>
    <div v-if="events.length" class="table-scroll receipt-scroll" tabindex="0" role="region" aria-label="订阅通知投递表格">
      <table class="receipt-table">
        <thead><tr><th scope="col">投递编号 / 用户</th><th scope="col">事件 / 处理状态</th><th scope="col">事件时间 / 接收时间</th><th scope="col">来源与接收环境</th><th scope="col">相同原文投递次数 / 指纹</th><th v-if="!readOnly" scope="col">已保存收件操作</th></tr></thead>
        <tbody><tr v-for="event in events" :key="event.id" data-testid="subscription-event-row">
          <td data-label="投递编号 / 用户"><span class="mono">{{ event.id }}</span><small class="mono">{{ event.userId || '尚未绑定用户' }}</small></td>
          <td data-label="事件 / 处理状态">
            <span class="mono">{{ event.event }}</span>
            <small :data-processing="event.processing?.status || 'unprocessed'" :class="{ 'warning-text': event.processing?.status !== 'recorded' }">
              {{ event.processing ? processingLabels[event.processing.status] : '已接收，尚无处理结果' }}
            </small>
            <small v-if="event.processing">处理更新：{{ event.processing.updatedAt === null ? '尚无处理时间' : formatDate(event.processing.updatedAt) }}</small>
            <small v-if="event.processing?.retryAt">建议重试时间：{{ formatDate(event.processing.retryAt) }}</small>
            <small v-if="!event.knownEvent && !event.processing">新事件类型，待核对官方协议</small>
          </td>
          <td data-label="事件 / 接收时间">{{ formatDate(event.eventCreatedAt) }}<small>{{ formatDate(event.receivedAt) }}</small></td>
          <td data-label="来源与接收环境"><span>{{ event.processing ? environmentLabels[event.processing.environment] : '来源环境待核实' }}</span><small>接收服务：{{ modeLabels[event.receivingMode] }}</small></td>
          <td data-label="相同原文投递"><strong>{{ event.deliveryCount }}</strong><small>次数不是扣款次数</small><details><summary>通知指纹</summary><small class="mono">{{ event.payloadSha256 }}</small></details></td>
          <td v-if="!readOnly" data-label="可用操作">
            <div class="receipt-actions">
              <button v-if="event.ledgerLocation" class="button" type="button" :aria-label="`查看通知 ${event.id} 的关联账本`" @click="openLedger(event, $event)">查看关联账本</button>
              <button class="button small" type="button" :aria-label="`重新处理通知 ${event.id}`" :disabled="loading || reprocessing !== null" @click="reprocess(event)">{{ reprocessing === event.id ? '处理中…' : '重新处理' }}</button>
            </div>
            <small>按服务器规则重处理，不覆盖状态或金额</small>
          </td>
        </tr></tbody>
      </table>
    </div>
    <div v-else-if="loaded && !loading && !error" class="empty-state compact">
      <h3>{{ appliedReceipt ? '没有匹配的订阅通知' : '暂无订阅通知' }}</h3><p>这里只显示服务器已保存的通知，不推断平台是否发生订阅。</p>
    </div>
    <div v-if="events.length" class="form-actions wrap">
      <span class="muted">已显示 {{ events.length }} 次通知投递</span>
      <button v-if="nextCursor" class="button" type="button" :disabled="loading || reprocessing !== null" @click="load({ action: 'more', receiptId: appliedReceipt, before: nextCursor })">加载更多订阅通知</button>
      <span v-else-if="loaded" class="muted">已加载全部通知</span>
    </div>
  </section>
</template>

<style scoped>
.receipt-scroll { max-height: min(65vh, 640px); overflow: auto; }
.receipt-scroll:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
.receipt-table { min-width: 0; table-layout: fixed; }
.receipt-table td { vertical-align: top; overflow-wrap: anywhere; }
.receipt-table th:nth-child(1) { width: 13%; }
.receipt-table th:nth-child(2) { width: 26%; }
.receipt-table th:nth-child(3) { width: 18%; }
.receipt-table th:nth-child(4) { width: 15%; }
.receipt-table th:nth-child(6) { width: 15%; }
.section-heading, .wrap { flex-wrap: wrap; gap: .75rem; }
.receipt-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
.receipt-search { display: flex; align-items: end; gap: .75rem; flex-wrap: wrap; padding: .75rem 0; }
.receipt-search .field { margin: 0; flex: 1 1 220px; }
.receipt-search input { min-width: 0; max-width: 100%; }
summary { cursor: pointer; min-height: 44px; padding: .6rem 0; }
.compact-receipt { margin-top: .75rem; padding: .75rem; min-width: 0; }
.compact-receipt .receipt-scroll { max-height: none; overflow: visible; }
.compact-receipt .receipt-table, .compact-receipt tbody, .compact-receipt tr, .compact-receipt td { display: block; width: 100%; min-width: 0; }
.compact-receipt thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.compact-receipt tr { padding: .75rem; border-bottom: 1px solid var(--line); }
.compact-receipt td { padding: .5rem 0; border: 0; }
.compact-receipt td[data-label]::before { content: attr(data-label); display: block; color: var(--muted); margin-bottom: .25rem; }
@media (max-width: 1100px) {
  .receipt-table, .receipt-table tbody, .receipt-table tr, .receipt-table td { display: block; width: 100%; min-width: 0; }
  .receipt-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .receipt-table tr { padding: .75rem; border-bottom: 1px solid var(--line); }
  .receipt-table td { padding: .5rem 0; border: 0; }
  .receipt-table td[data-label]::before { content: attr(data-label); display: block; color: var(--muted); margin-bottom: .25rem; }
}
</style>
