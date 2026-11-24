<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { DeliveryWorkReceipt, DeliveryWorkState, WorkAction } from '../../shared/delivery-efficiency'
import { efficiencyDuration } from '../../shared/delivery-efficiency'
import { api, ApiError, formatDate, message } from '../api'
import { useDraftNavigationGuard } from '../draft-navigation'
import Feedback from './Feedback.vue'

const props = defineProps<{ jobId: string; disabled?: boolean }>()
const emit = defineEmits<{ locked: [value: boolean] }>()
const expanded = ref(false), state = ref<DeliveryWorkState>(), loading = ref(false), busy = ref(false)
const error = ref(''), success = ref(''), retryOriginal = ref(false)
const pending = ref<{ jobId: string; requestId: string; action: WorkAction }>()
let generation = 0, controller: AbortController | undefined
const labels = { idle: '尚未开始', running: '正在计时', paused: '已暂停', finished: '本次已结束' }
const locked = computed(() => loading.value || busy.value || !!pending.value || props.disabled)
// 已发出的请求不是能“放弃”的输入；必须先核对结果，不能用草稿确认框丢掉请求号。
useDraftNavigationGuard(() => false, () => busy.value || !!pending.value)
watch(() => busy.value || !!pending.value, value => emit('locked', value), { immediate: true, flush: 'sync' })
const path = () => `/admin/delivery-work/${encodeURIComponent(props.jobId)}`
function valid(value: DeliveryWorkState) {
  if (value.jobId !== props.jobId || !Object.hasOwn(labels, value.status)) throw new Error('计时状态不属于当前批次，请重新读取')
  return value
}
async function load() {
  if (busy.value || pending.value) return
  const epoch = ++generation
  controller?.abort(); controller = new AbortController()
  loading.value = true; state.value = undefined; error.value = ''
  try {
    const data = await api<DeliveryWorkState>(path(), { signal: controller.signal })
    if (epoch === generation) state.value = valid(data)
  } catch (e) { if (epoch === generation) error.value = message(e) }
  finally { if (epoch === generation) loading.value = false }
}
async function perform(action?: WorkAction, recover = false) {
  // 父级会因本请求锁住切换；这个禁用状态不能反过来阻止原号核对/重试。
  if (busy.value || loading.value || (props.disabled && !pending.value)) return
  if (!pending.value && action) pending.value = { jobId: props.jobId, requestId: crypto.randomUUID(), action }
  const operation = pending.value
  if (!operation) return
  const epoch = ++generation
  controller?.abort(); controller = new AbortController()
  busy.value = true; error.value = ''; success.value = ''; retryOriginal.value = false
  let saved = false
  try {
    const result = await api<DeliveryWorkReceipt>(recover ? `${path()}/requests/${operation.requestId}` : path(),
      { method: recover ? 'GET' : 'POST', body: recover ? undefined : { action: operation.action, requestId: operation.requestId }, signal: controller.signal })
    if (epoch !== generation) return
    if (result.jobId !== operation.jobId || result.requestId !== operation.requestId || result.action !== operation.action)
      throw new Error('回执不属于原计时操作，请继续核对，不要另开一次')
    valid(result.state)
    pending.value = undefined; saved = true; success.value = '已核对原操作。仅记录本人时间，不改变自动交付。'
  } catch (e) {
    if (epoch !== generation) return
    if (e instanceof ApiError && e.status === 409) {
      pending.value = undefined; state.value = undefined
      error.value = `${message(e)}。请重新读取本人计时后再操作。`
    } else if (recover && e instanceof ApiError && e.status === 404) {
      retryOriginal.value = true; error.value = '未找到原操作。可用原编号重试，不会另开一次。'
    } else error.value = `${message(e)} 原操作结果待核对，其他计时操作暂不可用。`
  } finally {
    if (epoch === generation) busy.value = false
  }
  // 原回执固定不变；随后再读本人当前状态，避免把旧回执当最新状态。
  if (saved && epoch === generation) await load()
}
function toggle(event: Event) {
  expanded.value = (event.currentTarget as HTMLDetailsElement).open
  if (expanded.value && !state.value && !pending.value) void load()
}
watch(() => props.jobId, () => {
  generation++; controller?.abort(); state.value = undefined; pending.value = undefined
  loading.value = false; busy.value = false; error.value = ''; success.value = ''
  if (expanded.value) void load()
})
onBeforeUnmount(() => { generation++; controller?.abort(); emit('locked', false) })
</script>

<template>
  <details class="work-timer" :data-testid="`work-timer-${jobId}`" @toggle="toggle">
    <summary>本人的人工计时</summary>
    <div v-if="expanded" class="timer-body">
      <p class="muted small-text">只在明确操作后记录。离开工作前请暂停；关页不会自动暂停。不影响服务器自动交付，也不缩短平台审核。</p>
      <Feedback :error="error" :success="success" :loading="loading" />
      <div v-if="state" class="timer-state" aria-live="polite">
        <strong>{{ labels[state.status] }}</strong>
        <span>已闭合记录 {{ efficiencyDuration(state.closedMs) }}</span>
        <small v-if="state.runningSince !== null">本段开始 {{ formatDate(state.runningSince) }}，尚未结束，不计入已确认人工时长。</small>
        <small v-else-if="state.status === 'idle'">没有人工记录不等于没有工作；不推算历史用时。</small>
      </div>
      <div v-if="pending" class="timer-actions">
        <button type="button" class="button" :disabled="busy || loading" @click="perform(undefined, true)">核对原计时操作</button>
        <button v-if="retryOriginal" type="button" class="button primary" :disabled="busy || loading" @click="perform()">用原编号重试计时</button>
      </div>
      <div v-else class="timer-actions">
        <button v-if="state?.canStart" type="button" class="button" :disabled="locked" @click="perform('start')">开始人工计时</button>
        <button v-if="state?.status === 'running'" type="button" class="button" :disabled="locked" @click="perform('pause')">暂停人工计时</button>
        <button v-if="state && ['running', 'paused'].includes(state.status)" type="button" class="button" :disabled="locked" @click="perform('finish')">结束本次人工计时</button>
        <button type="button" class="button quiet" :disabled="locked" @click="load">重新读取本人计时</button>
      </div>
      <p v-if="state && !state.canStart && state.status !== 'running'" class="muted small-text">已完成或取消的批次不能新开始；已有计时仍可结束。</p>
    </div>
  </details>
</template>

<style scoped>
.work-timer { min-width: 0; overflow-wrap: anywhere; border-top: 1px solid var(--line); }
.timer-body { display: grid; gap: 12px; padding: 8px 0 14px; }
.timer-state { display: grid; gap: 5px; }
.timer-state > span { font-variant-numeric: tabular-nums; }
.timer-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.timer-actions .button { white-space: normal; text-align: start; }
@media(max-width:420px) { .timer-actions > button { flex: 1 1 100%; } }
</style>
