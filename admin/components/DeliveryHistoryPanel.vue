<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { DeliveryHistory, DeliveryHistoryRow } from '../../shared/content-operations'
import { DELIVERY_STATUS_LABELS, type MediaDeliveryStatus } from '../../shared/media-delivery'
import { OPERATOR_LANGUAGE_LABELS } from '../../shared/catalog-channel'
import { api, formatDate, message } from '../api'
import Feedback from './Feedback.vue'
import DeliveryEfficiencyPanel from './DeliveryEfficiencyPanel.vue'
import DeliveryWorkTimer from './DeliveryWorkTimer.vue'
import { allowAdminNavigation } from '../draft-navigation'
import { useDeliveryWorkLocks } from '../delivery-work-locks'

const props = defineProps<{ region?: string; language?: string; dramaId?: number | string | null }>()
const emit = defineEmits<{ locked: [value: boolean] }>()
const { locked, setLocked } = useDeliveryWorkLocks(value => emit('locked', value))
const data = ref<DeliveryHistory>(), loading = ref(false), error = ref('')
const queryId = ref(String(props.dramaId ?? '')), appliedId = ref(queryId.value), page = ref(1)
const mode = ref<'history' | 'efficiency'>('history')
function selectMode(value: typeof mode.value) { if (allowAdminNavigation()) mode.value = value }
let generation = 0, controller: AbortController | undefined
const elapsed = (ms: number) => `${Math.floor(ms / 60000)} 分 ${Math.floor(ms / 1000) % 60} 秒`
function timeLabel(job: DeliveryHistoryRow) {
  if (job.status === 'cancelled') return '取消不计成功耗时'
  if (job.status === 'complete') return job.completedDurationMs === null
    ? '已完成；缺少完成时点，耗时未知' : `完成耗时：${elapsed(job.completedDurationMs)}`
  return job.ongoingAgeMs === null ? '时点未记录' : `尚未完成，距创建：${elapsed(job.ongoingAgeMs)}`
}
async function load() {
  if (locked.value) return
  const epoch = ++generation
  controller?.abort(); controller = new AbortController()
  const signal = controller.signal
  loading.value = true; error.value = ''; data.value = undefined
  const params = new URLSearchParams({ region: props.region ?? '', language: props.language ?? '',
    dramaId: appliedId.value, page: String(page.value), pageSize: '25' })
  try {
    const result = await api<DeliveryHistory>(`/admin/delivery-history?${params}`, { signal })
    if (epoch !== generation) return
    if (result.pagination.page > result.pagination.pages) { page.value = result.pagination.pages; return load() }
    data.value = result
  } catch (cause) { if (!signal.aborted && epoch === generation) error.value = message(cause) }
  finally { if (epoch === generation) loading.value = false }
}
function search() {
  if (!allowAdminNavigation()) return
  appliedId.value = String(queryId.value).trim(); page.value = 1; void load()
}
function turn(delta: number) { if (allowAdminNavigation()) { page.value += delta; void load() } }
watch(() => [props.region, props.language, props.dramaId], (_, previous) => {
  if (!previous || props.dramaId !== previous[2]) queryId.value = appliedId.value = String(props.dramaId ?? '')
  page.value = 1; void load()
}, { immediate: true })
onBeforeUnmount(() => { generation++; controller?.abort() })
</script>

<template>
  <section class="delivery-history" aria-label="交付历史记录">
    <div class="delivery-modes" role="group" aria-label="交付记录视角">
      <button type="button" class="button quiet" :aria-pressed="mode === 'history'" :disabled="locked" @click="selectMode('history')">交付历史</button>
      <button type="button" class="button quiet" :aria-pressed="mode === 'efficiency'" :disabled="locked" @click="selectMode('efficiency')">上架效率</button>
    </div>
    <p v-if="locked" class="notice small-text" role="status">先核对原计时操作，再查询、翻页或切换范围。折叠不会撤销已发出的操作。</p>
    <DeliveryEfficiencyPanel v-if="mode === 'efficiency'" :region="region" :language="language" :drama-id="appliedId" @locked="setLocked('efficiency', $event)" />
    <template v-else>
    <form class="delivery-filters" @submit.prevent="search">
      <label class="field"><span>作品编号</span><input v-model="queryId" aria-label="交付作品编号" type="number" min="1" step="1" placeholder="全部作品" /></label>
      <button class="button" :disabled="loading || locked" type="submit">查询交付记录</button>
    </form>
    <Feedback :loading="loading" :error="error" retry @retry="load" />
    <template v-if="data">
      <p class="muted small-text" data-testid="delivery-scope">
        {{ data.scope.region || '全部发行地区' }} · {{ OPERATOR_LANGUAGE_LABELS[data.scope.contentLanguage || ''] || data.scope.contentLanguage || '全部实际语言' }}。
        {{ data.scope.basis }}。截至 {{ formatDate(data.observedAt) }}。
      </p>
      <ol v-if="data.jobs.length" class="delivery-rows">
        <li v-for="job in data.jobs" :key="job.id" :data-testid="`delivery-row-${job.id}`">
          <div class="delivery-title"><strong>{{ job.title }}</strong><small>#{{ job.dramaId }} · 本批 {{ job.expectedEpisodes }} 集 · 媒资版本 {{ job.platformVersion ?? '未记录' }}</small></div>
          <div class="delivery-state"><span :class="['badge', job.status === 'complete' ? 'good' : 'neutral']">{{ DELIVERY_STATUS_LABELS[job.status as MediaDeliveryStatus] || '未识别的任务状态' }}</span><p>{{ job.message }}</p></div>
          <div class="delivery-time"><span>{{ timeLabel(job) }}</span><small>创建于 {{ formatDate(job.createdAt) }}</small><small v-if="job.completedAt !== null">完成观测 {{ formatDate(job.completedAt) }}</small><small v-if="job.nextRunAt !== null">自动处理安排 {{ formatDate(job.nextRunAt) }}{{ job.nextRunAt <= data.observedAt ? '（已到时间，尚待处理观测）' : '（不是审核完成时间）' }}</small></div>
          <DeliveryWorkTimer class="history-work-timer" :job-id="job.id" @locked="setLocked(job.id, $event)" />
        </li>
      </ol>
      <p v-else class="empty-state compact" data-testid="delivery-empty">这个范围没有交付记录。没有任务不等于已经审核或上架。</p>
      <div class="delivery-pagination" data-testid="delivery-pagination" aria-live="polite">
        <span>共 {{ data.pagination.total }} 批 · 第 {{ data.pagination.page }} / {{ data.pagination.pages }} 页</span>
        <div class="inline">
          <button class="button small quiet" :disabled="loading || locked || page <= 1" aria-label="上一页交付" @click="turn(-1)">上一页</button>
          <button class="button small quiet" :disabled="loading || locked || page >= data.pagination.pages" aria-label="下一页交付" @click="turn(1)">下一页</button>
        </div>
      </div>
    </template>
    </template>
  </section>
</template>

<style scoped>
.delivery-history { min-width: 0; overflow-wrap: anywhere; }
.delivery-modes { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.delivery-modes [aria-pressed="true"] { color: var(--accent); background: var(--accent-soft); border-color: var(--accent-border); }
.history-work-timer { grid-column: 1 / -1; }
.delivery-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 14px 0; }
.delivery-filters .field { margin: 0; width: 180px; min-width: 0; }
.delivery-filters input { min-width: 0; width: 100%; }
.delivery-rows { padding: 0; margin: 18px 0; list-style: none; }
.delivery-rows > li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1fr); gap: 20px; padding: 18px 0; border-top: 1px solid var(--line); }
.delivery-title small, .delivery-time small { display: block; color: var(--muted); margin-top: 6px; font-size: .875rem; }
.delivery-state .badge { white-space: normal; }
.delivery-state p { margin: 8px 0 0; font-size: .875rem; color: var(--muted); }
.delivery-time { font-variant-numeric: tabular-nums; }
.delivery-pagination { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; color: var(--muted); font-size: .875rem; }
@media(max-width:760px) { .delivery-rows > li { grid-template-columns: minmax(0, 1fr); gap: 12px; } }
@media(max-width:420px) { .delivery-filters .field { flex: 1 1 100%; } }
</style>
