<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { api, formatDate, message } from '../api'
import { evidenceScope } from '../operations-context'
import { changeFields, changeValue, operationMetrics, reviewLabels, reviewMetric,
  type OperationChange, type OperationRestore, type OperationReview } from '../operations-history'
import Feedback from './Feedback.vue'

const props = defineProps<{ kind: 'drama' | 'catalog'; targetKey: string; version: number; restoreBlocked?: string }>()
const emit = defineEmits<{ restore: [draft: OperationRestore] }>()
const open = ref(false), loaded = ref(false), loading = ref(false), reading = ref(false), error = ref('')
const rows = ref<OperationChange[]>([]), nextCursor = ref<number | null>(null)
const review = ref<OperationReview | null>(null)
let generation = 0, controller: AbortController | undefined
function cancel() { generation++; controller?.abort(); loading.value = false; reading.value = false }
function start() { cancel(); controller = new AbortController(); return { epoch: generation, signal: controller.signal } }
async function load(more = false) {
  const { epoch, signal } = start()
  loading.value = true; error.value = ''; review.value = null
  try {
    const query = new URLSearchParams({ kind: props.kind, key: props.targetKey })
    if (more && nextCursor.value) query.set('before', String(nextCursor.value))
    const result = await api<{ changes: OperationChange[]; nextCursor: number | null }>(`/admin/operations/changes?${query}`, { signal })
    if (epoch !== generation) return
    if (!Array.isArray(result.changes) || result.changes.some(r => r.kind !== props.kind || r.key !== props.targetKey)) throw new Error('改动记录不属于当前对象，请重新读取')
    rows.value = more ? [...rows.value, ...result.changes] : result.changes
    nextCursor.value = result.nextCursor; loaded.value = true
  } catch (e) { if (epoch === generation && !signal.aborted) error.value = message(e) }
  finally { if (epoch === generation) loading.value = false }
}
function toggled(event: Event) {
  open.value = (event.target as HTMLDetailsElement).open
  if (open.value && !loaded.value) void load()
}
async function inspect(row: OperationChange, action: 'restore' | 'review') {
  if (loading.value || reading.value || (action === 'restore' && props.restoreBlocked)) return
  const { epoch, signal } = start()
  reading.value = true; error.value = ''; review.value = null
  try {
    if (action === 'restore') {
      const result = await api<OperationRestore>(`/admin/operations/changes/${encodeURIComponent(row.id)}/restore`, { signal })
      if (epoch !== generation) return
      if (result.readOnly !== true || result.id !== row.id || result.kind !== props.kind || result.key !== props.targetKey) throw new Error('历史草稿回执与当前对象不一致')
      if (!result.allowed) { error.value = result.blockers.join('；') || '当前条件不允许载入这次历史草稿'; return }
      emit('restore', result)
    } else {
      const result = await api<OperationReview>(`/admin/operations/changes/${encodeURIComponent(row.id)}/review`, { signal })
      if (epoch !== generation) return
      if (result.readOnly !== true || result.causal !== false || result.change?.id !== row.id) throw new Error('复查回执不完整，请重新读取')
      review.value = result
    }
  } catch (e) { if (epoch === generation && !signal.aborted) error.value = message(e) }
  finally { if (epoch === generation) reading.value = false }
}
watch(() => [props.kind, props.targetKey], () => {
  cancel(); loaded.value = false; rows.value = []; review.value = null; error.value = ''; nextCursor.value = null
  if (open.value) void load()
})
watch(() => props.version, () => {
  cancel(); loaded.value = false; review.value = null
  if (open.value) void load()
})
onBeforeUnmount(cancel)
</script>

<template>
  <details class="operations-history" data-testid="operations-history" @toggle="toggled">
    <summary>最近改动与复查</summary>
    <div class="history-intro"><p class="muted">查看以前为什么改、具体改了什么。载入历史只改草稿，再次保存才生成新版本。</p>
      <button class="button quiet" type="button" :disabled="loading || reading" @click="load()">刷新改动记录</button></div>
    <Feedback :loading="loading" :error="error" />
    <p v-if="loaded && !rows.length" class="muted">暂无改动记录。后续保存的实际修改会在这里保留；不补造以前的历史。</p>
    <details v-for="row in rows" :key="row.id" class="change-row" data-testid="change-row">
      <summary><span><strong>版本 {{ row.beforeVersion }} → {{ row.afterVersion }}</strong> · {{ row.changes.map(c => changeFields[c.field] ?? c.field).join('、') }}</span><small>{{ formatDate(row.createdAt) }}</small></summary>
      <div class="change-body">
        <p>{{ row.context.reason || '未填写原因（普通编辑无需填写）' }}</p>
        <p class="muted">{{ operationMetrics[row.context.primaryMetric] }} · 前后各观察 {{ row.context.observationDays }} 天{{ row.context.restoredFrom ? ' · 由历史草稿重新保存' : '' }}</p>
        <details v-if="row.context.evidence" class="evidence-note"><summary>原分析依据</summary>
          <p>{{ row.context.evidence.title }} · 读取于 {{ formatDate(row.context.evidence.generatedAt) }}</p>
          <p>{{ evidenceScope(row.context.evidence.filters) }}</p></details>
        <dl class="change-values">
          <div v-for="item in row.changes" :key="item.field">
            <dt>{{ changeFields[item.field] ?? item.field }}</dt>
            <dd><small>改前</small><span>{{ changeValue(item.field, item.before) }}</span></dd>
            <dd><small>改后</small><span>{{ changeValue(item.field, item.after) }}</span></dd>
          </div>
        </dl>
        <div class="inline wrap"><button class="button" type="button" :disabled="loading || reading" @click="inspect(row, 'review')">查看改后表现</button>
          <button class="button quiet" type="button" :disabled="loading || reading || !!restoreBlocked" @click="inspect(row, 'restore')">载入改前草稿</button></div>
        <p v-if="restoreBlocked" class="muted">{{ restoreBlocked }}</p>
        <p class="muted small-text">回退仍检查当前权限和供给；不会恢复价格、版权声明、原视频或审核结论。</p>
        <section v-if="review?.change.id === row.id" class="operation-review" data-testid="operation-review" aria-label="改动复查结果">
          <h3>{{ reviewLabels[review.status] ?? '结果待核对' }}</h3>
          <p v-for="reason in review.reasons" :key="reason">{{ reason }}</p>
          <p class="muted">只作前后观察，不能归因，也不能把样本门槛当成统计显著性。排除修改当天 {{ review.windows.excludedChangeDay }}。</p>
          <div class="review-pair">
            <article v-for="side in (['before', 'after'] as const)" :key="side">
              <h4>{{ side === 'before' ? '改前' : '改后' }} · 版本 {{ review.versionPair[side] }}</h4>
              <p class="muted">{{ review.windows[side].from }} — {{ review.windows[side].to }}</p>
              <small>{{ operationMetrics[review.primaryMetric] }}</small>
              <strong class="review-value">{{ reviewMetric(review[side], review.primaryMetric).value }}</strong>
              <small>{{ reviewMetric(review[side], review.primaryMetric).sample }}</small>
            </article>
          </div>
          <details><summary>复查范围与保护指标</summary>
            <p>{{ evidenceScope(review.scope) }}</p>
            <p v-for="adjustment in review.scopeAdjustments" :key="adjustment">{{ adjustment }}</p>
            <template v-if="review.guardrails">
              <div v-for="side in (['before', 'after'] as const)" :key="side" class="guardrail">
                <h4>{{ side === 'before' ? '改前' : '改后' }}</h4>
                <p>播放错误 {{ review.guardrails[side].playbackErrors }} 次 · 保存时可用内容 {{ review.guardrails[side].availableContent }} 部</p>
                <p v-if="!review.guardrails[side].refunds.length">未观察到可归属退款记录；不代表全账本没有退款。</p>
                <p v-for="refund in review.guardrails[side].refunds" :key="refund.currency">{{ refund.currency }}：{{ refund.orders }} 笔退款 · {{ refund.amount }}（原记录单位，不折算收入）</p>
                <p>{{ review.guardrails[side].dataQuality.detailIncomplete ? '历史明细不完整' : '历史明细未标记缺失' }} · 首帧信号不可用 {{ review.guardrails[side].dataQuality.unavailableFrameSignals }} 次</p>
              </div>
              <p class="muted">{{ review.guardrails.note }}</p>
            </template>
            <p>{{ review.interpretation }}</p>
          </details>
          <p class="muted small-text">未归属的订单不计入这份复查，履约问题仍到原订单核对。</p>
        </section>
      </div>
    </details>
    <button v-if="nextCursor" type="button" class="button" :disabled="loading || reading" @click="load(true)">更早的改动</button>
  </details>
</template>

<style scoped>
.operations-history { min-width: 0; border-top: 1px solid var(--line); margin-top: 18px; }
.operations-history > summary { color: var(--muted); }
.history-intro { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding: 0 0 14px; }
.history-intro p { flex: 1 1 260px; font-size: .875rem; }
.change-row { border-top: 1px solid var(--line); min-width: 0; }
.change-row > summary { overflow-wrap: anywhere; }
.change-row > summary > small { display: block; padding-left: 18px; }
.change-body { padding: 8px 0 22px; display: grid; gap: 14px; min-width: 0; }
.change-values { margin: 0; }
.change-values > div { display: grid; grid-template-columns: 110px minmax(0, 1fr) minmax(0, 1fr); gap: 16px; padding: 12px 0; border-top: 1px solid var(--line); }
.change-values dt { font-weight: 600; }.change-values dd { margin: 0; min-width: 0; }
.change-values dd > * { display: block; white-space: pre-wrap; overflow-wrap: anywhere; }
.evidence-note, .operation-review { overflow-wrap: anywhere; }
.operation-review { background: var(--surface-subtle); border-radius: 8px; padding: 18px; display: grid; gap: 12px; }
.review-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.review-pair article { min-width: 0; border-top: 1px solid var(--control-border); padding-top: 12px; }
.review-value { display: block; font-size: 1.375rem; font-variant-numeric: tabular-nums; margin: 6px 0; }
.guardrail { padding: 12px 0; border-top: 1px solid var(--line); }
@media(max-width:640px) {
  .change-values > div { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .review-pair { grid-template-columns: minmax(0, 1fr); }
  .operation-review { padding: 14px; }
}
</style>
