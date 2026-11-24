<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { DeliveryEfficiency, EfficiencyRound } from '../../shared/delivery-efficiency'
import { efficiencyDuration as elapsed } from '../../shared/delivery-efficiency'
import { DELIVERY_STATUS_LABELS, type MediaDeliveryStatus } from '../../shared/media-delivery'
import { OPERATOR_LANGUAGE_LABELS } from '../../shared/catalog-channel'
import { api, formatDate, message } from '../api'
import { allowAdminNavigation } from '../draft-navigation'
import { useDeliveryWorkLocks } from '../delivery-work-locks'
import Feedback from './Feedback.vue'
import DeliveryWorkTimer from './DeliveryWorkTimer.vue'

const props = defineProps<{ region?: string; language?: string; dramaId?: number | string | null }>()
const emit = defineEmits<{ locked: [value: boolean] }>()
const { locked, setLocked } = useDeliveryWorkLocks(value => emit('locked', value))
const today = Math.floor(Date.now() / 86400000) * 86400000
const date = (days: number) => new Date(today + days * 86400000).toISOString().slice(0, 10)
const from = ref(date(-7)), to = ref(date(-1))
const applied = ref({ from: from.value, to: to.value })
const data = ref<DeliveryEfficiency>(), loading = ref(false), error = ref('')
const pages = reactive({ page: 1, activePage: 1, roundPage: 1 })
const opened = reactive({ coverage: false, manual: false, platform: false, completed: false, active: false })
const unapplied = computed(() => from.value !== applied.value.from || to.value !== applied.value.to)
let generation = 0, controller: AbortController | undefined
const results: Record<EfficiencyRound['result'], string> = {
  approved: '已观察通过', rejected: '已观察退回', withdrawn: '已观察撤回', waiting: '仍在等待', unknown: '结果未知',
}
const pct = (v: number | null) => v === null ? '暂无分母' : `${(100 * v).toFixed(1)}%`
async function load() {
  if (locked.value) return
  const epoch = ++generation
  controller?.abort(); controller = new AbortController()
  loading.value = true; error.value = ''; data.value = undefined
  const params = new URLSearchParams({ ...applied.value, region: props.region || '', language: props.language || '',
    dramaId: String(props.dramaId ?? ''), page: String(pages.page), activePage: String(pages.activePage), roundPage: String(pages.roundPage) })
  try {
    const value = await api<DeliveryEfficiency>(`/admin/delivery-efficiency?${params}`, { signal: controller.signal })
    if (epoch !== generation) return
    let adjusted = false
    for (const [key, total] of [['page', value.completed.pagination.pages], ['activePage', value.activity.pagination.pages], ['roundPage', value.platform.pagination.pages]] as const) {
      if (pages[key] > total) { pages[key] = total; adjusted = true }
    }
    if (adjusted) return load()
    data.value = value
  } catch (e) { if (epoch === generation) error.value = message(e) }
  finally { if (epoch === generation) loading.value = false }
}
function apply() {
  if (!allowAdminNavigation()) return
  applied.value = { from: from.value, to: to.value }
  pages.page = pages.activePage = pages.roundPage = 1
  void load()
}
function turn(key: keyof typeof pages, delta: number) {
  if (!allowAdminNavigation()) return
  pages[key] += delta; void load()
}
function toggle(key: keyof typeof opened, event: Event) { opened[key] = (event.currentTarget as HTMLDetailsElement).open }
watch(() => [props.region, props.language, props.dramaId], () => {
  pages.page = pages.activePage = pages.roundPage = 1; void load()
}, { immediate: true })
onBeforeUnmount(() => { generation++; controller?.abort() })
</script>

<template>
  <section class="efficiency" aria-label="上架效率分析">
    <header><h3>上架效率</h3><p class="muted small-text">先看交付耗时，再区分平台等待与人工工作。不以速度替代审核或上架结果。</p></header>
    <form class="efficiency-filters" @submit.prevent="apply">
      <label class="field"><span>完成开始日期（UTC）</span><input v-model="from" type="date" required :max="date(0)" /></label>
      <label class="field"><span>完成结束日期（UTC）</span><input v-model="to" type="date" required :max="date(0)" /></label>
      <button class="button" type="submit" :disabled="loading || locked">查询上架效率</button>
    </form>
    <p v-if="unapplied" class="muted small-text">日期尚未应用，下面仍是上次查询范围。</p>
    <Feedback :loading="loading" :error="error" retry @retry="load" />
    <template v-if="data">
      <p class="muted small-text" data-testid="efficiency-scope">
        {{ data.scope.from }} — {{ data.scope.to }} · UTC · {{ data.scope.region || '全部发行地区' }} ·
        {{ OPERATOR_LANGUAGE_LABELS[data.scope.contentLanguage || ''] || data.scope.contentLanguage || '全部实际语言' }}
        {{ data.scope.dramaId ? `· 作品 #${data.scope.dramaId}` : '' }}。截至 {{ formatDate(data.generatedAt) }}。
        <strong v-if="data.scope.partialDay">今天尚未结束。</strong>
      </p>
      <dl class="efficiency-metrics" data-testid="efficiency-summary">
        <div><dt>完成耗时中位数 · P50</dt><dd>{{ elapsed(data.completed.p50Ms) }}</dd></div>
        <div><dt>较慢批次耗时 · P95</dt><dd>{{ elapsed(data.completed.p95Ms) }}</dd></div>
        <div><dt>区间内有效完成样本</dt><dd>{{ data.completed.count }} <small>批</small></dd></div>
      </dl>
      <p v-if="!data.completed.count" class="empty-state compact">这个完成日期范围没有有效计时样本，不能用零耗时表示。</p>
      <details :open="opened.coverage" @toggle="toggle('coverage', $event)">
        <summary>时间口径与缺测</summary>
        <div class="explanation" data-testid="efficiency-coverage">
          <p>{{ data.scope.basis }}</p>
          <p>全部历史已完成 {{ data.coverage.completedJobs }} 批，有效计时 {{ data.coverage.timedJobs }} 批，覆盖 {{ pct(data.coverage.ratio) }}；
            缺少有效时点 {{ data.coverage.unknownJobs }} 批，其中逆序或异常时点 {{ data.coverage.invalidJobs }} 批。取消 {{ data.excluded.cancelledJobs }} 批不计成功。</p>
          <p>从创建到首次完成观测，完成后固定；P50/P95按全部匹配样本排序取最近秩，不受翻页影响。缺完成时点的历史无法归入某个完成日，不以最后更新时间补造。</p>
        </div>
      </details>
      <details :open="opened.manual" @toggle="toggle('manual', $event)">
        <summary>人工主动用时</summary>
        <div class="explanation" data-testid="efficiency-manual">
          <strong>{{ elapsed(data.manual.closedUnionMs) }} · 已闭合人工记录</strong>
          <p>本完成区间 {{ data.manual.cohortJobs }} 批中，{{ data.manual.recordedJobs }} 批有闭合记录，覆盖 {{ pct(data.manual.coverage) }}；
            {{ data.manual.openIntervals }} 段尚未结束，未计入。{{ data.manual.contributors }} 位操作者提供闭合记录。</p>
          <p>同人并行批次取时间并集，不同人相加；只反映明确开始与结束的记录，不自动判断人是否离开。计时可晚于交付完成；刷新此报告才更新汇总，未记录不当作零工作。</p>
        </div>
      </details>
      <details :open="opened.platform" @toggle="toggle('platform', $event)">
        <summary>平台等待与返工</summary>
        <div class="explanation" data-testid="efficiency-platform">
          <p>按所选 UTC 区间的<strong>提交日</strong>，不是完成日：{{ data.platform.attempts }} 次请求，{{ data.platform.acknowledged }} 次已受理，
            {{ data.platform.resolved }} 轮有结果观测，{{ data.platform.resubmissionsAfterRejection }} 次同版本退回后再次受理。</p>
          <p>下界是最后一次仍等待的观测，上界是第一次结果观测；不是TikTok内部准确结束时刻。查询次数不算提交轮次，不按时间猜测归属哪一批。</p>
          <ol class="efficiency-rows">
            <li v-for="r in data.platform.rounds" :key="r.requestId">
              <strong>{{ r.title }} · 媒资版本 {{ r.platformVersion }} · 第 {{ r.round }} 轮</strong>
              <span>{{ results[r.result] }}{{ r.acknowledged ? '' : ' · 尚未确认受理' }}</span>
              <span v-if="r.upperBoundMs !== null">{{ r.lowerBoundMs === null ? '下界未知' : elapsed(r.lowerBoundMs) }} ～ {{ elapsed(r.upperBoundMs) }}</span>
              <span v-else>{{ r.lowerBoundMs === null ? '可观察区间未知' : `已观察至少等待 ${elapsed(r.lowerBoundMs)}，尚无上界` }}</span>
              <small>提交 {{ formatDate(r.submittedAt) }}{{ r.observedAt === null ? '' : ` · 结果/等待观测 ${formatDate(r.observedAt)}` }}</small>
            </li>
          </ol>
          <p v-if="!data.platform.attempts">此提交日期范围没有审核请求。没有请求不是已通过。</p>
          <div class="efficiency-pages"><span>第 {{ data.platform.pagination.page }} / {{ data.platform.pagination.pages }} 页</span>
            <button class="button quiet" :disabled="loading || locked || pages.roundPage <= 1" aria-label="上一页审核轮次" @click="turn('roundPage', -1)">上一页</button>
            <button class="button quiet" :disabled="loading || locked || pages.roundPage >= data.platform.pagination.pages" aria-label="下一页审核轮次" @click="turn('roundPage', 1)">下一页</button>
          </div>
        </div>
      </details>
      <details :open="opened.completed" @toggle="toggle('completed', $event)">
        <summary>已完成批次</summary>
        <ol class="efficiency-rows" data-testid="efficiency-completed-rows">
          <li v-for="j in data.completed.jobs" :key="j.id">
            <strong>{{ j.title }} · #{{ j.dramaId }}</strong><span>完成耗时 {{ elapsed(j.durationMs) }}</span>
            <small>完成观测 {{ formatDate(j.completedAt!) }}</small>
            <DeliveryWorkTimer :job-id="j.id" @locked="setLocked(j.id, $event)" />
          </li>
        </ol>
        <div class="efficiency-pages"><span>共 {{ data.completed.count }} 批 · 第 {{ data.completed.pagination.page }} / {{ data.completed.pagination.pages }} 页</span>
          <button class="button quiet" :disabled="loading || locked || pages.page <= 1" aria-label="上一页已完成批次" @click="turn('page', -1)">上一页</button>
          <button class="button quiet" :disabled="loading || locked || pages.page >= data.completed.pagination.pages" aria-label="下一页已完成批次" @click="turn('page', 1)">下一页</button>
        </div>
      </details>
      <details :open="opened.active" @toggle="toggle('active', $event)">
        <summary>当前活动批次</summary>
        <p class="muted small-text">同一作品范围当前共 {{ data.activity.pagination.total }} 批，不受完成日期筛选。创建至今的年龄不是完成耗时，也不是全部在人工操作。</p>
        <ol class="efficiency-rows" data-testid="efficiency-active-rows">
          <li v-for="j in data.activity.jobs" :key="j.id">
            <strong>{{ j.title }} · #{{ j.dramaId }}</strong>
            <span>{{ DELIVERY_STATUS_LABELS[j.status as MediaDeliveryStatus] || '任务状态待核对' }} · 距创建 {{ elapsed(j.ageMs) }}</span>
            <DeliveryWorkTimer :job-id="j.id" @locked="setLocked(j.id, $event)" />
          </li>
        </ol>
        <div class="efficiency-pages"><span>第 {{ data.activity.pagination.page }} / {{ data.activity.pagination.pages }} 页</span>
          <button class="button quiet" :disabled="loading || locked || pages.activePage <= 1" aria-label="上一页当前活动" @click="turn('activePage', -1)">上一页</button>
          <button class="button quiet" :disabled="loading || locked || pages.activePage >= data.activity.pagination.pages" aria-label="下一页当前活动" @click="turn('activePage', 1)">下一页</button>
        </div>
      </details>
    </template>
  </section>
</template>

<style scoped>
.efficiency { display: grid; gap: 14px; min-width: 0; padding-top: 18px; overflow-wrap: anywhere; }
.efficiency-filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
.efficiency-filters .field { min-width: 0; flex: 1 1 180px; margin: 0; }
.efficiency-filters input { width: 100%; min-width: 0; max-width: 100%; }
.efficiency-metrics { margin: 4px 0 8px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
.efficiency-metrics > div { border-top: 1px solid var(--line); padding-top: 14px; }
.efficiency-metrics dt { color: var(--muted); font-size: .875rem; }
.efficiency-metrics dd { margin: 8px 0 0; font-size: 1.375rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.efficiency > details { border-top: 1px solid var(--line); }
.explanation { display: grid; gap: 12px; padding: 8px 0 14px; font-size: .875rem; color: var(--muted); }
.explanation strong, .efficiency-rows strong { color: var(--text); }
.efficiency-rows { list-style: none; padding: 0; margin: 0; }
.efficiency-rows > li { display: grid; gap: 8px; min-width: 0; padding-block: 16px; border-bottom: 1px solid var(--line); }
.efficiency-pages { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding-top: 12px; }
.efficiency-pages > span { flex: 1 1 150px; font-size: .875rem; color: var(--muted); }
@media(max-width:600px) { .efficiency-metrics { grid-template-columns: minmax(0, 1fr); gap: 12px; } .efficiency-filters > button { width: 100%; } }
</style>
