<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, message } from '../api'
import { ANALYTICS_TIMEZONES, ANALYTICS_DEVICE_SYSTEMS, ANALYTICS_CONNECTION_TYPES, ANALYTICS_NETWORK_QUALITIES } from '../../shared/analytics'
import { OPERATOR_LANGUAGE_LABELS as CONTENT_LANGUAGE_LABELS } from '../../shared/catalog-channel'
import { LAUNCH_MARKETS, MARKET_LABELS } from '../../shared/launch-markets'
import Feedback from './Feedback.vue'
import AnalyticsTrend from './AnalyticsTrend.vue'
import DeliveryHistoryPanel from './DeliveryHistoryPanel.vue'
import ContinuationSummary from './ContinuationSummary.vue'
import { evidenceScope, localDay, shiftDay, newAnalysisState, type AnalysisAction, type AnalysisState } from '../operations-context'
import { continuationValue, maturityLabel, fulfillmentState, type ContinuationResult } from '../operations-results'
import { allowAdminNavigation } from '../draft-navigation'

type Row = Record<string, any>
interface Report {
  available: boolean; dataState: string; reason?: string; generatedAt: number
  scope: Row; filters: Row; overview: Row; pipeline: Row; rates: Record<string, Row>; quality: Row
  funnel: Row[]; money: Row[]; content: Row[]; contentTitles: Row[]; episodes:Row[];episodeTitles:Row[];sections: Row[]
  retention: Row[]; timeline: Row[]; timelineScope: string; experiments: Row[]; delivery: Row[]
  currentOrderStates: Row[]; subscriptionLedger: Row; pendingRefundReviews: number; cautions: string[];alerts:Row[]
  orderTimings?: { paymentToEntitlement: Row; entitlementToResume: Row }
  continuation?: ContinuationResult
  retentionScope?: Row
  fulfillment?: Row
}
const props = defineProps<{ state?: AnalysisState }>()
const emit = defineEmits<{ state: [value: AnalysisState]; action: [value: AnalysisAction] }>()
const initial = props.state ?? newAnalysisState()
const tabs = [
  { id: 'overview', label: '概览' }, { id: 'content', label: '内容表现' }, { id: 'paths', label: '关键路径' },
] as const
const tab = ref(initial.tab), detail = ref(initial.detail)
const selectedId = ref(initial.contentId), selectedLanguage = ref(initial.contentLanguage), moreFilters = ref(initial.moreFilters)
const filters = ref({ ...initial.filters })
const appliedFilters = ref(initial.appliedFilters ? { ...initial.appliedFilters } : undefined)
const contentSort = ref(initial.contentSort ?? 'viewingVisits')
const contentLens = ref(initial.contentLens ?? 'start')
const writeMarket = ref(''), writeLocale = ref('')
const deviceLabels:Record<string,string>={ios:'iOS',android:'Android',windows:'Windows',macos:'macOS',linux:'Linux',other:'其他 / 未识别'}
const networkLabels:Record<string,string>={wifi:'Wi-Fi',cellular:'蜂窝网络',ethernet:'有线以太网',bluetooth:'蓝牙',wimax:'WiMAX',
  mixed:'混合接入',none:'无连接（浏览器报告）',other:'其他接入',unknown:'未提供 / 未识别'}
const networkSourceLabels:Record<string,string>={browser:'浏览器接口提供',unavailable:'浏览器未提供接口',unrecorded:'旧记录未采集来源'}
const playerLabels:Record<string,string>={local:'HTML视频播放器',tiktok:'TikTok播放器',unknown:'未记录'}
const qualityLabel=(value:string)=>value==='unknown'?'未提供 / 未识别':`${value} 档估计`
const networkLabel=(value:string)=>networkLabels[value]??`旧字段 ${value}（含义未区分）`
const report = ref<Report>(), loading = ref(false), error = ref('')
const deliveryLocked = ref(false)
const comparison = ref<Report>(), comparing = ref(false), comparisonError = ref(''), showComparison = ref(initial.showComparison ?? false)
let generation = 0, controller: AbortController | undefined
const environment = computed(() => ({production:'正式环境',official_test:'官方免扣费测试',internal:'内部演练 · 非真钱'}[report.value?.scope?.environment as string] ?? '正在核对实际环境'))
const title = (id: number) => report.value?.contentTitles.find(d=>d.id===id)?.title ?? `剧目 #${id}`
const episodeTitle=(id:number)=>{const e=report.value?.episodeTitles.find(e=>e.id===id);return e?`第${e.seq}集 · ${e.title}`:`单集 #${id}`}
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('zh-CN',{maximumFractionDigits:1}) : '—'
const percentage = (v: number | null | undefined) => v==null ? '暂无数据' : `${(v*100).toFixed(1)}%`
const milliseconds = (v: number | null | undefined) => v==null ? '未采集' : `${Math.round(v)} ms`
const duration = (ms: number | null | undefined) => ms==null ? '未记录' : `${Math.max(0,Math.floor(ms/60000))} 分钟`
const when = (value: number) => new Intl.DateTimeFormat('zh-CN',{timeZone:report.value?.scope.timezone??'Asia/Shanghai',
  year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(value)
const contentRows = computed(() => [...(report.value?.content ?? [])].sort((a, b) =>
  (contentSort.value === 'click' ? (b.clickRate?.value ?? -1) - (a.clickRate?.value ?? -1) : b[contentSort.value] - a[contentSort.value]) || a.dramaId - b.dramaId))
const selected = computed(() => report.value?.contentTitles.find(d => d.id === selectedId.value))
const selectedRow = computed(() => report.value?.content.find(d => d.dramaId === selectedId.value && (!selectedLanguage.value || d.contentLanguage === selectedLanguage.value)))
const selectedEpisodes = computed(() => report.value?.episodes.filter(row => row.dramaId === selectedId.value &&
  (row.contentLanguage ?? '') === selectedLanguage.value) ?? [])
const maturedD1 = computed(() => {
  const rows = report.value?.retention.filter(row => row.maturity?.d1 === 'mature' && row.d1 != null) ?? []
  const denominator = rows.reduce((sum, row) => sum + row.size, 0), numerator = rows.reduce((sum, row) => sum + row.d1, 0)
  return { denominator, numerator, value: denominator ? numerator / denominator : null }
})
const kpis = computed(()=>!report.value?.overview?[]:[
  ['有效观看访次',number(report.value.overview.viewingVisits),'访次不是去重人数'],
  ['下一集接续率',continuationValue(report.value.continuation),
    report.value.continuation ? `${report.value.continuation.rate.numerator} / ${report.value.continuation.rate.denominator} 个可接续起点；供给未知 ${report.value.continuation.exclusions.unknownSupply}` : '不拿相邻两集播放总数相除'],
  ['次日回访率',percentage(maturedD1.value.value),`${maturedD1.value.numerator} / ${maturedD1.value.denominator} 个已成熟登录账户；匿名不混算`],
])
const riskOrders = computed<Row[]>(() => report.value?.fulfillment?.orders.filter((row: Row) => row.needsReview) ?? [])
function retentionCell(row: Row, offset: 'd1' | 'd7' | 'd30') {
  return row.maturity?.[offset] === 'mature' && row[offset] != null
    ? `${row[offset]} · ${percentage(row[`${offset}Rate`])}` : maturityLabel(row.maturity?.[offset])
}
function remember() {
  emit('state', { filters: { ...filters.value }, tab: tab.value, detail: detail.value, contentId: selectedId.value,
    contentLanguage: selectedLanguage.value, scrollY: window.scrollY,
    focusId: selectedId.value ? 'analytics-content-detail' : document.activeElement?.getAttribute('data-testid') ?? '',
    moreFilters: moreFilters.value, appliedFilters: appliedFilters.value && { ...appliedFilters.value },
    contentSort: contentSort.value, contentLens: contentLens.value, showComparison: showComparison.value })
}
// 离页之前由父级调用，不能在卸载时记录：新页面插入会先改变浏览器的滚动锚点。
defineExpose({ remember })
watch([filters, tab, detail, selectedId, selectedLanguage, moreFilters, contentSort, contentLens, showComparison], remember, { deep: true })
async function load(input = { ...filters.value }) {
  if (deliveryLocked.value) return
  const epoch=++generation
  controller?.abort(); controller=new AbortController()
  loading.value=true; error.value=''; report.value=undefined
  const query=new URLSearchParams()
  for(const [key,value] of Object.entries(input)) if(value!=='' && value!==null)query.set(key,String(value))
  try {
    const value=await api<Report>(`/admin/analytics/report?${query}`,{signal:controller.signal})
    if(epoch!==generation)return
    if(!value || typeof value.available!=='boolean' || (value.available && !Array.isArray(value.funnel)))throw Error('统计回执不完整，未显示为0')
    report.value=value
    appliedFilters.value = { ...input, includeSamples: Boolean(value.filters?.includeSamples) }
    if(value.available && input.includeSamples===null && filters.value.includeSamples===null) filters.value.includeSamples=Boolean(value.filters.includeSamples)
    writeMarket.value = String(value.filters.market ?? '')
    writeLocale.value = String(value.filters.channelLanguage || selectedLanguage.value || value.filters.contentLanguage || '')
    comparison.value = undefined
    if (showComparison.value) void compare()
  } catch(e) { if(epoch===generation)error.value=message(e) }
  finally {if(epoch===generation)loading.value=false}
}
function range(days:number) {
  if (!allowAdminNavigation()) return
  filters.value.to = shiftDay(localDay(Date.now(), filters.value.timezone), -1)
  filters.value.from = shiftDay(filters.value.to, -(days - 1))
  selectedId.value = null
  void load()
}
function today() {
  if (!allowAdminNavigation()) return
  filters.value.from = filters.value.to = localDay(Date.now(), filters.value.timezone)
  selectedId.value = null; void load()
}
async function compare() {
  const value = report.value
  if (!showComparison.value || !value) { comparison.value = undefined; return }
  if (value.filters.to >= localDay(Date.now(), value.filters.timezone)) {
    comparisonError.value = '今天尚未结束，请选择完整自然日再与前期比较。'; return
  }
  const epoch = generation
  const days = Math.round((Date.parse(value.filters.to) - Date.parse(value.filters.from)) / 86400000) + 1
  const previous: Row = { ...value.filters, from: shiftDay(value.filters.from, -days), to: shiftDay(value.filters.from, -1) }
  delete previous.environment
  const query = new URLSearchParams()
  for (const [key, val] of Object.entries(previous)) if (val !== '' && val != null) query.set(key, String(val))
  comparing.value = true; comparisonError.value = ''
  try { const result = await api<Report>(`/admin/analytics/report?${query}`, { signal: controller?.signal })
    if (epoch === generation && showComparison.value) comparison.value = result
  } catch (e) { if (epoch === generation) comparisonError.value = message(e) }
  finally { if (epoch === generation) comparing.value = false }
}
async function inspect(row: Row) {
  selectedId.value = row.dramaId; selectedLanguage.value = row.contentLanguage ?? report.value?.filters.contentLanguage ?? ''
  writeMarket.value = String(report.value?.filters.market ?? '')
  writeLocale.value = String(report.value?.filters.channelLanguage || selectedLanguage.value || '')
  await nextTick()
  const panel = document.querySelector<HTMLElement>('[data-testid="analytics-content-detail"]')
  panel?.scrollIntoView({ block: 'start' }); panel?.focus({ preventScroll: true })
}
function act(target: AnalysisAction['target']) {
  if (!report.value || !selectedId.value || (target === 'home' && (!writeMarket.value || !writeLocale.value))) return
  remember()
  emit('action', { target, evidence: { filters: { ...report.value.filters }, generatedAt: report.value.generatedAt,
    title: title(selectedId.value), dramaId: selectedId.value, contentLanguage: selectedLanguage.value },
    region: writeMarket.value, locale: writeLocale.value })
}
function inspectOrder(row: Row) {
  if (!report.value || !row.orderId || !row.dramaId) return
  remember()
  emit('action', { target: 'orders', orderId: row.orderId, evidence: {
    filters: { ...report.value.filters }, generatedAt: report.value.generatedAt,
    title: row.title || title(row.dramaId), dramaId: row.dramaId,
    contentLanguage: String(report.value.filters.contentLanguage ?? ''),
  } })
}
function applyFilters() { if (allowAdminNavigation()) { selectedId.value = null; void load() } }
function refreshReport() { void load(appliedFilters.value ?? { ...filters.value }) }
function selectView(nextTab = tab.value, nextDetail = detail.value) {
  if (allowAdminNavigation()) { tab.value = nextTab; detail.value = nextDetail }
}
function drillEnvironment(row:Row) {
  for(const key of ['deviceOS','playerType','networkType','networkQuality','networkSource','buildId'] as const) filters.value[key]=row[key]??''
  detail.value='quality';void load()
}
onMounted(async () => {
  await load(initial.appliedFilters ?? { ...filters.value }); await nextTick()
  const target = initial.focusId
    ? document.querySelector<HTMLElement>(`[data-testid="${initial.focusId.replace(/[^a-z0-9_-]/gi, '')}"]`)
    : null
  target?.focus({ preventScroll: true })
  window.scrollTo({ top: initial.scrollY })
  // 像素位置只适用于原布局。字号、窗口或详情高度变化后，以原对象为锚，
  // 只在标题离开视口时修正，不把正常往返一律送回页面顶部。
  const anchor = target?.querySelector<HTMLElement>('h3') ?? target
  const rect = anchor?.getBoundingClientRect()
  if (rect && (rect.top < 0 || rect.bottom > window.innerHeight)) target?.scrollIntoView({ block: 'start' })
})
onBeforeUnmount(()=>{generation++;controller?.abort()})
</script>

<template>
  <section class="analytics-shell" aria-label="运营数据中心">
    <div class="analytics-intro panel">
      <div><strong>先看表现，再去处理具体作品</strong>
        <p class="muted small-text">发行市场不是观众所在地；实际国家尚未采集。</p></div>
      <span class="badge environment" data-testid="analytics-environment">{{ environment }}</span>
    </div>
    <form class="panel filters" @submit.prevent="applyFilters()">
      <label class="field"><span>开始日期</span><input v-model="filters.from" type="date" required /></label>
      <label class="field"><span>结束日期</span><input v-model="filters.to" type="date" required /></label>
      <label class="field"><span>发行市场（不是观众国籍）</span><select v-model="filters.market"><option value="">全部发行市场</option><option v-for="market in LAUNCH_MARKETS" :key="market" :value="market">{{ MARKET_LABELS[market] }}</option><option v-if="filters.market && !LAUNCH_MARKETS.some(market => market === filters.market)" :value="filters.market">历史市场 · {{ MARKET_LABELS[filters.market] || filters.market }}</option></select></label>
      <label class="field"><span>实际内容语言</span><select v-model="filters.contentLanguage" aria-label="实际内容语言"><option value="">全部</option><option v-for="(label,code) in CONTENT_LANGUAGE_LABELS" :key="code" :value="code" :hidden="['zh','und'].includes(code)">{{ label }}</option></select></label>
      <details class="more-filters" :open="moreFilters" @toggle="moreFilters = ($event.currentTarget as HTMLDetailsElement).open"><summary>更多筛选 · 时区、频道、设备与来源</summary><div class="expanded-filters">
      <label class="field"><span>报告时区</span><select v-model="filters.timezone"><option v-for="zone in ANALYTICS_TIMEZONES" :key="zone">{{ zone }}</option></select></label>
      <label class="field"><span>界面语言</span><select v-model="filters.uiLanguage"><option value="">全部</option><option v-for="(label,code) in CONTENT_LANGUAGE_LABELS" :key="code" :value="code" :hidden="['zh','und'].includes(code)">{{ label }}</option></select></label>
      <label class="field"><span>用户选择的频道语言</span><select v-model="filters.channelLanguage"><option value="">全部</option><option v-for="(label,code) in CONTENT_LANGUAGE_LABELS" :key="code" :value="code" :hidden="['zh','und'].includes(code)">{{ label }}</option></select></label>
      <label class="field"><span>剧目 / 成片 ID</span><input v-model="filters.dramaId" type="number" min="1" placeholder="全部" /></label>
      <label class="field"><span>单集 ID</span><input v-model="filters.episodeId" type="number" min="1" placeholder="全部" /></label>
      <label class="field"><span>栏目 ID</span><input v-model="filters.sectionId" maxlength="100" placeholder="全部" /></label>
      <label class="field"><span>内容版本</span><input v-model="filters.contentVersion" type="number" min="1" step="1" placeholder="全部" /></label>
      <label class="field"><span>媒资版本</span><input v-model="filters.mediaVersion" type="number" min="1" step="1" placeholder="全部" /></label>
      <label class="field"><span>片单版本</span><input v-model="filters.channelVersion" type="number" min="0" step="1" placeholder="全部；0为初始自动片单" /></label>
      <label class="field"><span>入口来源</span><select v-model="filters.entrySource"><option value="">全部</option><option value="catalog">主页 / 频道</option><option value="search">搜索</option><option value="history">历史续播</option><option value="favorite">收藏</option><option value="direct">直接进入</option><option value="unknown">未识别</option></select></label>
      <label class="field"><span>设备系统（浏览器报告）</span><select v-model="filters.deviceOS" data-testid="analytics-device-os"><option value="">全部</option><option v-for="os in ANALYTICS_DEVICE_SYSTEMS" :key="os" :value="os">{{ deviceLabels[os] }}</option></select><small>分类不是独立真机证明，不保存完整设备指纹。</small></label>
      <label class="field"><span>播放器</span><select v-model="filters.playerType" data-testid="analytics-player-type"><option value="">全部</option><option v-for="(label,type) in playerLabels" :key="type" :value="type">{{ label }}</option></select></label>
      <label class="field"><span>网络接入类型</span><select v-model="filters.networkType" data-testid="analytics-network-type"><option value="">全部</option><option v-for="type in ANALYTICS_CONNECTION_TYPES" :key="type" :value="type">{{ networkLabel(type) }}</option><optgroup label="旧记录原字段（未区分速度和接入）"><option v-for="type in ['slow-2g','2g','3g','4g']" :key="type" :value="type">{{ networkLabel(type) }}</option></optgroup></select></label>
      <label class="field"><span>网络质量估计</span><select v-model="filters.networkQuality" data-testid="analytics-network-quality"><option value="">全部</option><option v-for="quality in ANALYTICS_NETWORK_QUALITIES" :key="quality" :value="quality">{{ qualityLabel(quality) }}</option></select><small>例如Wi-Fi也可能显示4g档估计；不是运营商制式，也不是主动测速。</small></label>
      <label class="field"><span>网络信息来源</span><select v-model="filters.networkSource" data-testid="analytics-network-source"><option value="">全部</option><option v-for="(label,source) in networkSourceLabels" :key="source" :value="source">{{ label }}</option></select></label>
      <label class="field"><span>前端版本</span><input v-model="filters.buildId" data-testid="analytics-build-id" maxlength="100" placeholder="全部，或明确的发布版本号" /></label>
      <label class="checkbox"><input v-model="filters.includeSamples" type="checkbox" />包含标识为测试的内容（仍保留环境隔离）</label>
      </div></details>
      <div class="form-actions"><button class="button primary" :disabled="loading || deliveryLocked">应用筛选</button><button type="button" class="button" :disabled="loading || deliveryLocked" @click="range(7)">近7天</button><button type="button" class="button" :disabled="loading || deliveryLocked" @click="range(30)">近30天</button><button type="button" class="button" :disabled="loading || deliveryLocked" @click="today">今天（未结束）</button><button type="button" class="button quiet" :disabled="loading || deliveryLocked" @click="refreshReport">更新数据</button></div>
    </form>
    <Feedback :loading="loading" :error="error" />
    <div v-if="report && !report.available" class="notice warning">{{ report.reason || '当前统计不可用，不表示没有用户或成交。' }}</div>
    <template v-if="report?.available">
      <div data-testid="analytics-ready" class="data-status">
        <span data-testid="analytics-last-seen">最近记录：{{ report.scope.lastReceivedAt ? when(report.scope.lastReceivedAt) : '尚未收到' }}</span>
        <span v-if="report.pipeline.pendingBusinessFacts">待同步交易事实：{{ report.pipeline.pendingBusinessFacts }}</span>
        <span>观察窗口 / 时区：{{ report.filters?.from ?? filters.from }} ～ {{ report.filters?.to ?? filters.to }} · {{ report.scope.timezone }}</span>
      </div>
      <p v-if="report.dataState==='empty'" class="notice">该范围内尚无新统计记录。可能尚未开始采集或当前筛选没有命中，不能据此宣称全站没有用户。</p>
      <p v-if="report.scope.detailMetricsIncomplete" class="notice warning">这段日期包含已超过30天并清理的行为明细。趋势、金额与最小化留存记录仍在；下方去重访次、逐步漏斗和细节只反映尚保留的窗口，不是整个日期范围的完整结果。请缩小时间范围核对。</p>
      <p v-if="report.pipeline.pendingBusinessFacts" class="notice warning">有交易事实等待汇总，当前报表尚未追齐。原订单与权益不受此影响。</p>
      <p v-if="report.pipeline.pendingHistory" class="notice warning">还有 {{ report.pipeline.pendingHistory }} 笔历史订单等待导入。只读取账本中真实记录的交易，不补造历史点击或播放。</p>
      <p v-for="alert in report.alerts" :key="alert.id" class="notice warning" role="status">{{ alert.message }}</p>
      <section v-if="riskOrders.length" class="notice warning fulfillment-risks" data-testid="analytics-risks" aria-label="需要核对的订单">
        <strong>{{ riskOrders.length }} 笔已确认付款订单需要核对权益</strong>
        <p class="small-text">来自当前报告范围与查询时账本。这里不会扣款、退款或补发权益。</p>
        <ul><li v-for="row in riskOrders" :key="row.orderId"><span>{{ row.title }}<small>{{ fulfillmentState[row.state] || '待核对' }} · {{ row.orderId }}</small></span>
          <button type="button" class="button" :aria-label="`核对原订单 ${row.orderId}`" @click="inspectOrder(row)">核对原订单</button></li></ul>
      </section>
      <div class="analytics-tabs" role="tablist" aria-label="数据分析页签">
        <button v-for="item in tabs" :key="item.id" type="button" role="tab" class="button" :class="{primary:tab===item.id}"
          :aria-selected="tab===item.id" :data-testid="`analytics-tab-${item.id}`" :disabled="deliveryLocked" @click="selectView(item.id, '')">{{ item.label }}</button>
      </div>
      <section v-if="tab==='overview' && !detail" data-testid="analytics-panel-overview">
        <div class="stat-grid analytics-kpis"><article v-for="item in kpis" :key="item[0]" class="stat-card"><span>{{ item[0] }}</span><strong>{{ item[1] }}</strong><small>{{ item[2] }}</small></article></div>
        <label class="checkbox"><input v-model="showComparison" type="checkbox" @change="compare" />与等长完整前期比较</label>
        <Feedback :loading="comparing" :error="comparisonError" />
        <AnalyticsTrend :points="report.timeline as any" :from="report.filters.from" :to="report.filters.to" :comparison="comparison?.timeline as any" :comparison-from="comparison?.filters.from" />
        <section class="panel"><h3>值得查看</h3>
          <p v-if="!report.content.some(row => !row.smallSample)" class="muted">数据积累中。样本不足，不生成“爆款”或自动下架建议。</p>
          <ul v-else class="insights"><li v-for="row in report.content.filter(row => !row.smallSample).slice(0,3)" :key="`${row.dramaId}:${row.contentLanguage}`">
            {{ title(row.dramaId) }}：{{ row.exposedVisits }} 个曝光访次，{{ row.viewingVisits }} 个有效观看访次；先核对位置与接续。
            <button type="button" class="text-link" @click="tab='content';inspect(row)">看这部剧</button>
          </li></ul>
          <button type="button" class="button quiet" @click="tab='content'">查看所有内容表现</button>
        </section>
      </section>
      <section v-if="tab==='content' && !detail && !selectedId" data-testid="analytics-panel-content" class="panel">
        <div class="section-heading"><h3>内容表现</h3><label class="field"><span class="sr-only">内容表现视角</span><select v-model="contentLens"><option value="start">获得开看</option><option value="continue">接着看</option><option value="return">回来</option></select></label></div>
        <p class="muted small-text">点击列标题只排序这张报表，不改观众片单。小样本保留观察，不自动推荐或发布。</p>
        <p class="muted" data-testid="analytics-click-definition">{{ report.scope.clickDefinition }}</p>
        <div class="table-scroll content-table" tabindex="0"><table><thead><tr>
          <th>作品 / 实际语言</th><th><button type="button" class="text-link" @click="contentSort='exposedVisits'">曝光访次 ↓</button></th>
          <th v-if="contentLens==='start'"><button type="button" class="text-link" @click="contentSort='click'">曝光后点击率 ↓</button></th>
          <th><button type="button" class="text-link" @click="contentSort='viewingVisits'">有效观看访次 ↓</button></th><th>{{ contentLens==='return' ? '成熟D1回访' : '下一集接续率' }}</th><th>操作</th></tr></thead>
          <tbody><tr v-for="row in contentRows" :key="`${row.dramaId}:${row.contentLanguage}`">
            <td data-column="作品"><strong>{{ title(row.dramaId) }}</strong><small>{{ CONTENT_LANGUAGE_LABELS[row.contentLanguage] || '实际语言未记录' }} · #{{ row.dramaId }}</small><small v-if="row.smallSample">小样本</small></td>
            <td data-column="曝光访次">{{ row.exposedVisits }}</td>
            <td v-if="contentLens==='start'" data-column="点击率">{{ percentage(row.clickRate.value) }}<small>{{ row.clickRate.numerator }}/{{ row.clickRate.denominator }} · 原始点击 {{ row.rawClicks ?? '未采集' }}</small></td>
            <td data-column="观看访次">{{ row.viewingVisits }}</td>
            <td data-column="接续 / 回访">{{ contentLens==='return' ? '进入作品核对成熟窗口' : continuationValue(row.continuation) }}</td>
            <td data-column="操作"><button type="button" class="button small" :data-testid="`content-inspect-${row.dramaId}`" @click="inspect(row)">查看</button></td>
          </tr></tbody></table></div>
        <p v-if="!report.content.length" class="empty-state compact">暂无符合筛选的内容表现</p>
        <details class="subheading"><summary>频道位置、逐集原始统计与实验</summary>
        <h3 class="subheading">逐集观看表现</h3><p class="muted">按实际单集记录对照，点击单集只缩小统计范围，不改变观看权限。</p>
        <p class="muted" data-testid="analytics-episode-definition">{{ report.scope.episodeGroupingDefinition }}</p>
        <div class="table-scroll" tabindex="0"><table><thead><tr><th>单集 / 实际语言 / 版本</th><th>请求播放</th><th>实际首帧</th><th>有效观看访次</th><th>合格完成</th><th>实际观看时长</th></tr></thead><tbody><tr v-for="row in report.episodes" :key="row.scopeKey"><td><button type="button" class="text-link" @click="filters.episodeId=String(row.episodeId);load()">{{ episodeTitle(row.episodeId) }}</button><small>{{ CONTENT_LANGUAGE_LABELS[row.contentLanguage] || '实际语言未记录' }}</small><small>内容版本 {{ row.contentVersion ?? '未记录' }} · 媒资版本 {{ row.mediaVersion ?? '未记录' }}</small></td><td>{{ row.requests }}</td><td>{{ row.firstFrames }}</td><td>{{ row.qualifiedVisits }}</td><td>{{ row.continuation?.completeOrigins ?? '待核对' }}</td><td>{{ number(row.watchSeconds) }} 秒</td></tr></tbody></table></div>
        <h3 class="subheading">频道与位置</h3><div class="table-scroll" tabindex="0"><table><thead><tr><th>栏目</th><th>位置（从0计）</th><th>片单配置版本</th><th>曝光次数</th><th>点击次数</th></tr></thead><tbody><tr v-for="row in report.sections" :key="`${row.sectionId}:${row.position}:${row.channelVersion}`"><td>{{ row.sectionId||'未识别' }}</td><td>{{ row.position??'未知' }}</td><td>{{ row.channelVersion??'未记录' }}</td><td>{{ row.impressions }}</td><td>{{ row.clicks }}</td></tr></tbody></table></div>
        <h3 class="subheading">受控顺序实验</h3><p class="muted">在“首页编排”保存候选和实验。只有明确启用的同片单顺序对照才分流；下表是实际收到的分组记录，样本不足不宣布赢家。</p>
        <div v-if="report.experiments.length" class="table-scroll" tabindex="0"><table><thead><tr><th>实验ID</th><th>组别</th><th>曝光访次</th><th>点击访次</th><th>确认付款</th><th>样本</th></tr></thead><tbody><tr v-for="row in report.experiments" :key="`${row.experimentId}:${row.variant}`"><td>{{ row.experimentId }}</td><td>{{ row.variant }}</td><td>{{ row.exposureVisits }}</td><td>{{ row.clickVisits }}</td><td>{{ row.paidOrders }}</td><td>{{ row.smallSample?'小样本':'继续观察质量与留存' }}</td></tr></tbody></table></div>
        <p v-else class="empty-state compact">尚未收到当前筛选下的实验曝光，不自动启动或分配真实流量。</p>
        </details>
      </section>
      <section v-if="tab==='content' && selectedId && !detail" class="panel content-detail" data-testid="analytics-content-detail" tabindex="-1">
        <button type="button" class="back-link" @click="selectedId=null">← 返回内容表现</button>
        <h3>{{ title(selectedId) }} <span class="badge">{{ CONTENT_LANGUAGE_LABELS[selectedLanguage] || '实际语言待核对' }}</span></h3>
        <p class="muted small-text">{{ evidenceScope(report.filters) }}</p>
        <p v-if="selectedRow" class="notice">{{ selectedRow.viewingVisits }} 个有效观看访次；{{ selectedRow.continuation?.completeOrigins ?? '待核对' }} 次合格完成。{{ selectedRow.smallSample ? '样本较少，先核对可用性，不急着改变排序。' : '可结合逐集表现查看下一步，不代表统计因果。' }}</p>
        <p v-else class="notice">当前报告未命中这部剧的记录，保留原选择方便返回；不是观看量为0。</p>
        <p>当前作品状态：{{ {draft:'私有草稿',published:'本应用已上架',archived:'已下架'}[selected?.status as string] || '待核对' }}。平台审核与本地上架分开核对。</p>
        <div class="inline wrap detail-actions">
          <button type="button" class="button" @click="act('edit')">编辑这部剧</button>
          <button type="button" class="button" @click="act('episodes')">补充后续集</button>
          <button type="button" class="button" @click="act('review')">查看审核</button>
        </div>
        <div class="arrange-target">
          <label class="field"><span>编排发行市场</span><select v-model="writeMarket"><option value="">选择一个写入市场</option><option v-for="market in (selected?.regions ?? LAUNCH_MARKETS)" :key="market" :value="market">{{ MARKET_LABELS[market] || market }} · {{ market }}</option></select></label>
          <label class="field"><span>编排频道语言</span><select v-model="writeLocale"><option value="">选择频道语言</option><option v-for="(label,code) in CONTENT_LANGUAGE_LABELS" :key="code" :value="code" :hidden="['zh','und'].includes(code)">{{ label }} · {{ code }}</option></select></label>
          <button type="button" class="button primary" :disabled="!writeMarket || !writeLocale" @click="act('home')">去首页编排</button>
        </div>
        <p class="muted small-text">编排按发行市场×频道语言写入；原报告的设备、日期等会继续作为分析依据保留。选择“全部”时须先明确写入范围。</p>
        <h4>逐集表现</h4>
        <div class="episode-rows"><article v-for="row in selectedEpisodes" :key="row.scopeKey"><strong>{{ episodeTitle(row.episodeId) }}</strong>
          <small>{{ CONTENT_LANGUAGE_LABELS[row.contentLanguage] || '实际语言未记录' }} · 内容版本 {{ row.contentVersion ?? '未记录' }} · 媒资版本 {{ row.mediaVersion ?? '未记录' }}</small>
          <p>请求 {{ row.requests }} · 首帧 {{ row.firstFrames }} · 有效观看 {{ row.qualifiedVisits }} 访次 · 合格完成 {{ row.continuation?.completeOrigins ?? '待核对' }}</p>
          <ContinuationSummary :value="row.continuation" /></article></div>
        <p v-if="!selectedEpisodes.length" class="empty-state compact">没有命中当前范围的逐集记录</p>
      </section>
      <section v-if="tab==='paths' && !detail" class="path-grid" data-testid="analytics-panel-paths">
        <article class="panel"><h3>发现 → 开看</h3><p>同访次曝光后点击：{{ percentage(report.rates.click.value) }}（{{ report.rates.click.numerator }} / {{ report.rates.click.denominator }}）。</p><p class="muted">直达、搜索与历史续播不是首页曝光流失；播放请求到首帧另按播放尝试查看。</p><button type="button" class="button" @click="detail='quality'">核对首帧与播放质量</button></article>
        <article class="panel"><h3>本集 → 下一集</h3><ContinuationSummary :value="report.continuation" /><button type="button" class="button" @click="tab='content'">查看逐集内容表现</button></article>
        <article class="panel"><h3>受限内容 → 付款 → 继续看</h3><p>确认 {{ report.overview.paidOrders }} 笔付款；续播只计具备同单关联的可观察记录。</p><p class="muted">没有回来播放不等于扣款或发权失败。付费说明缺记录时不能补成完整转化。</p><button type="button" class="button" data-testid="analytics-tab-conversion" @click="detail='conversion'">核对订单与权益路径</button></article>
      </section>
      <nav class="detail-links" aria-label="更多运营分析">
        <button type="button" class="button quiet" data-testid="analytics-tab-retention" :disabled="deliveryLocked" @click="selectView(tab, 'retention')">成熟回访详情</button>
        <button type="button" class="button quiet" data-testid="analytics-tab-quality" :disabled="deliveryLocked" @click="selectView(tab, 'quality')">播放质量详情</button>
        <button type="button" class="button quiet" data-testid="analytics-tab-delivery" :disabled="deliveryLocked" @click="selectView(tab, 'delivery')">原内容交付记录</button>
        <button v-if="detail" type="button" class="button" :disabled="deliveryLocked" @click="selectView(tab, '')">返回{{ tabs.find(item => item.id===tab)?.label }}</button>
      </nav>
      <section v-if="detail==='conversion'" data-testid="analytics-panel-conversion">
        <section v-if="report.fulfillment" class="panel" data-testid="analytics-fulfillment"><h3>同一订单：付款后是否可看</h3>
          <p>观察到确认付款 {{ report.fulfillment.observedPaidOrders }} 笔；其中关联明确 {{ report.fulfillment.matchedPaidOrders }} 笔，当前有效权益 {{ report.fulfillment.currentValidEntitlements }} 笔，观察到有效续播 {{ report.fulfillment.observedResumedOrders }} 笔。</p>
          <p class="muted">另有 {{ report.fulfillment.validWithoutObservedResume }} 笔当前有权益、未观察到续播，不当作支付故障；关联或环境未知 {{ report.fulfillment.unknownOrders }} 笔。</p>
          <details><summary>查看同单明细与核对口径</summary><p class="muted">{{ report.fulfillment.definition }}</p>
          <ul class="fulfillment-orders"><li v-for="row in report.fulfillment.orders" :key="row.orderId"><span>{{ row.title }}<small>{{ fulfillmentState[row.state] || '待核对' }} · {{ row.resumeObserved ? '观察到续播' : '未观察到有效续播' }}<br />{{ row.orderId }}</small></span><button v-if="row.dramaId" type="button" class="button" :aria-label="`只读查看订单 ${row.orderId}`" @click="inspectOrder(row)">只读查看</button></li></ul></details>
        </section>
        <section class="panel"><h3>从看到剧到付款后续播</h3><p class="muted">同一关联路径逐步核对；直接进入和缺少观测的路径不会伪装成完整主页漏斗。</p>
          <p class="muted" data-testid="analytics-order-path-definition">{{ report.scope.orderPathDefinition }}</p>
          <div v-if="report.orderTimings" class="analytics-kpis" data-testid="analytics-order-timings">
            <article class="stat-card"><span>付款确认 → 权益生效 · P50 / P95</span><strong>{{ milliseconds(report.orderTimings.paymentToEntitlement.p50) }} / {{ milliseconds(report.orderTimings.paymentToEntitlement.p95) }}</strong>
              <small>配对 {{ report.orderTimings.paymentToEntitlement.samples }} / 全部 {{ report.orderTimings.paymentToEntitlement.totalPaidOrders }} 笔；未配对 {{ report.orderTimings.paymentToEntitlement.unpairedOrders }} 笔，不等于发权失败</small></article>
            <article class="stat-card"><span>权益生效 → 观察到续播 · P50 / P95</span><strong>{{ milliseconds(report.orderTimings.entitlementToResume.p50) }} / {{ milliseconds(report.orderTimings.entitlementToResume.p95) }}</strong>
              <small>观察到 {{ report.orderTimings.entitlementToResume.samples }} / 配对权益 {{ report.orderTimings.entitlementToResume.grantedOrders }} 笔；另 {{ report.orderTimings.entitlementToResume.unobservedOrders }} 笔未观察到，不一定不能播放</small></article>
          </div>
          <p class="muted" data-testid="analytics-order-timing-definition">{{ report.scope.orderTimingDefinition }}</p>
          <p class="muted">续播覆盖：全部 {{ report.rates.resumed.totalPaidOrders }} 笔确认订单中，{{ report.rates.resumed.denominator }} 笔具备关联和可观察条件；另外 {{ report.rates.resumed.unobservableOrders }} 笔不当作流失。</p>
          <ol class="funnel"><li v-for="step in report.funnel" :key="step.id"><span>{{ step.label }}</span><div class="funnel-track"><i :style="{width:`${report.funnel[0].count ? step.count/report.funnel[0].count*100 : 0}%`}" /></div><strong>{{ step.count }}</strong><small>{{ step.fromPrevious ? percentage(step.fromPrevious.value) : '起点' }}</small></li></ol>
        </section>
        <section class="panel" data-testid="analytics-money"><h3>已确认记账金额 · 保留原单位</h3><p class="notice warning">TEST_CREDITS不是收入，Beans不是美元。以下不是平台净结算、利润或广告ROI。</p>
          <p v-if="report.money.some(row=>row.unpriced)" class="notice warning">存在已确认交易但价格尚未确认的记录。金额只展示已知部分，不能把它当作完整收入；后补价格不会增加成交次数。</p>
          <div class="table-scroll" tabindex="0"><table><thead><tr><th>单位 / 币种</th><th>历史确认金额</th><th>确认退款</th><th>已知净变动</th><th>确认交易 / 退款笔数</th><th>0额 / 价格缺项</th></tr></thead><tbody><tr v-for="row in report.money" :key="row.currency"><td>{{ row.currency }}</td><td><bdi dir="ltr">{{ row.gross }}</bdi></td><td><bdi dir="ltr">{{ row.refunds }}</bdi></td><td><bdi dir="ltr">{{ row.net }}</bdi></td><td>{{ row.confirmedOrders }} / {{ row.refundedOrders }}</td><td>{{ row.zeroValueOrders }} / {{ row.unpriced }}</td></tr></tbody></table></div><p v-if="!report.money.length" class="empty-state compact">该范围没有确认的金额记录</p>
          <h3 class="subheading">内容购买与内部VIP账本现态（不按上述筛选截断）</h3><div class="inline wrap"><span v-for="row in report.currentOrderStates" :key="`${row.status}:${row.currency}`" class="badge">{{ row.status }} · {{ row.count }} 笔 · {{ row.currency }}</span></div>
          <h3 class="subheading">官方订阅账本 · 不自动分摊到剧目</h3>
          <p v-if="!report.subscriptionLedger.configured" class="muted">此环境未启用原生订阅统计，内部体验VIP不是官方订阅。</p>
          <p v-else class="muted">确认交易 {{ report.subscriptionLedger.confirmed }} · 退款 {{ report.subscriptionLedger.refunded }} · 回执冲突 {{ report.subscriptionLedger.conflicts }}。恢复续订与取消不当作新收款。</p>
          <p v-if="report.subscriptionLedger.conflicts" class="notice warning">订阅存在回执冲突，请先核对原业务回执，不据此自动推广或变更权益。</p>
          <p class="muted">部分退款待复核记录：{{ report.pendingRefundReviews }}。尚未核定的退款不擅自冲减全部订单。</p>
        </section>
      </section>
      <section v-if="detail==='retention'" data-testid="analytics-panel-retention" class="panel">
        <h3>首次已观察有效观看后的回访</h3><p class="muted">{{ report.retentionScope?.cohortDefinition || '只对可识别的登录账户计算；不是一生首次观看。' }}</p>
        <p class="muted">{{ report.retentionScope?.maturityDefinition || '成熟条件尚未返回，不将空白补成0。' }}</p>
        <p v-if="report.retentionScope">本范围匿名有效观看 {{ report.retentionScope.anonymousViewingVisits }} 访次，未混入跨日账户组。</p>
        <div class="table-scroll" tabindex="0"><table><thead><tr><th>首次已观察日</th><th>账户数</th><th>次日</th><th>第7日</th><th>第30日</th></tr></thead><tbody><tr v-for="row in report.retention" :key="row.day"><td>{{ row.day }}</td><td>{{ row.size }}</td><td>{{ retentionCell(row,'d1') }}</td><td>{{ retentionCell(row,'d7') }}</td><td>{{ retentionCell(row,'d30') }}</td></tr></tbody></table></div>
        <p v-if="!report.retention.length" class="empty-state compact">尚无可计算的登录用户队列，不展示虚假的0%留存。</p>
      </section>
      <section v-if="detail==='quality'" data-testid="analytics-panel-quality">
        <section class="panel" data-testid="analytics-network-scope">
          <h3>按设备与网络定位，不把缺少信息当作正常</h3>
          <p class="muted">{{ report.scope.deviceNetworkDefinition }}</p>
          <p class="muted">{{ report.scope.playbackGroupingDefinition }}</p>
          <p class="muted">{{ report.scope.stallDefinition }}</p>
          <div v-if="report.quality.networkCoverage" class="data-status">
            <span>播放记录 {{ report.quality.networkCoverage.observedPlaybacks }}</span>
            <span>浏览器提供网络信息 {{ report.quality.networkCoverage.browserReported }}</span>
            <span>接口未提供 {{ report.quality.networkCoverage.browserUnavailable }}</span>
            <span>旧记录未采集 {{ report.quality.networkCoverage.unrecorded }}</span>
            <span>有速度档位估计 {{ report.quality.networkCoverage.qualityKnown }}</span>
            <span v-if="report.quality.stallCoverage">卡顿可测 {{ report.quality.stallCoverage.measuredPlaybacks }} · 未测/旧口径 {{ report.quality.stallCoverage.unmeasuredPlaybacks }}</span>
          </div>
        </section>
        <div class="stat-grid analytics-kpis"><article class="stat-card"><span>首帧 P50</span><strong>{{ milliseconds(report.quality.firstFrame.p50) }}</strong><small>{{ report.quality.firstFrame.samples }} 条实际帧信号</small></article><article class="stat-card"><span>首帧 P95</span><strong>{{ milliseconds(report.quality.firstFrame.p95) }}</strong><small>不是接口响应时间</small></article><article class="stat-card"><span>播放中卡顿占比</span><strong>{{ report.quality.stallRatio.value==null?'未采集':percentage(report.quality.stallRatio.value) }}</strong><small>只计可测记录；首次加载与拖动等待排除</small></article><article class="stat-card"><span>缺少首帧观测</span><strong>{{ report.quality.firstFrame.unavailableRequests }}</strong><small>未采集，不是0毫秒</small></article></div>
        <section class="panel"><h3>设备 / 网络 / 发布版本对照</h3><p class="muted">点击“只看这一组”会应用对应筛选；记录只反映浏览器提供的信息。</p>
          <div class="table-scroll" tabindex="0" data-testid="analytics-environment-table"><table><thead><tr><th>系统 / 播放器</th><th>接入与质量</th><th>来源</th><th>前端版本</th><th>请求 / 首帧</th><th>首帧P95</th><th>错误播放</th><th>操作</th></tr></thead>
            <tbody><tr v-for="row in report.quality.environments" :key="JSON.stringify([row.deviceOS,row.playerType,row.networkType,row.networkQuality,row.networkSource,row.buildId])">
              <td>{{ deviceLabels[row.deviceOS]||'其他 / 未识别' }}<small>{{ playerLabels[row.playerType]||'未记录' }}</small></td>
              <td>{{ networkLabel(row.networkType) }}<small>{{ qualityLabel(row.networkQuality) }}</small></td>
              <td>{{ networkSourceLabels[row.networkSource]||'旧记录未采集来源' }}</td><td>{{ row.buildId||'未记录' }}</td>
              <td>{{ row.requests }} / {{ row.firstFrames }}</td><td>{{ milliseconds(row.p95) }}</td><td>{{ row.errors }}</td>
              <td><button type="button" class="button small" @click="drillEnvironment(row)">只看这一组</button></td>
            </tr></tbody></table></div>
          <p v-if="!report.quality.environments?.length" class="empty-state compact">此筛选下尚无播放记录，不表示这类设备或网络一定没有问题。</p>
        </section>
        <section class="panel"><h3>错误与前端版本</h3><div class="table-scroll" tabindex="0"><table><thead><tr><th>错误代码</th><th>观察次数</th></tr></thead><tbody><tr v-for="row in report.quality.errors" :key="row.code"><td>{{ row.code }}</td><td>{{ row.count }}</td></tr></tbody></table></div>
          <div class="table-scroll subheading" tabindex="0"><table><thead><tr><th>前端版本</th><th>播放请求</th><th>有错误的播放</th></tr></thead><tbody><tr v-for="row in report.quality.errorsByRelease" :key="row.build"><td>{{ row.build }}</td><td>{{ row.requests }}</td><td>{{ row.errors }}</td></tr></tbody></table></div>
          <p class="notice">浏览器数据不能代替真实手机的声音、来电、切后台、弱网和官方SDK控件验收。</p>
        </section>
      </section>
      <section v-if="detail==='delivery'" data-testid="analytics-panel-delivery" class="panel">
        <h3>交付历史与耗时</h3><p class="muted">和内容管理共用原任务记录。审核中是平台等待，查询不会增加提审轮次。</p>
        <DeliveryHistoryPanel :region="report.filters.market" :language="report.filters.contentLanguage" :drama-id="report.filters.dramaId" @locked="deliveryLocked = $event" />
      </section>
      <details class="panel data-notes"><summary>数据怎么算？查看口径与限制</summary><ul><li v-for="note in report.cautions" :key="note">{{ note }}</li></ul></details>
    </template>
  </section>
</template>

<style scoped>
.analytics-shell { min-width:0; overflow-wrap:anywhere; }
.analytics-intro { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:12px 18px; margin-bottom:16px; }
.analytics-intro h2 { font-size: 1.3125rem; line-height:1.4; margin:4px 0 6px; }
.environment { white-space:normal; flex-shrink:0; max-width:210px; }
.filters { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:4px 16px; padding:18px; margin-bottom:12px; }
.filters .form-actions { grid-column:1/-1; display:flex; flex-wrap:wrap; gap:10px; margin-top:8px; }
.more-filters { grid-column:1/-1; margin:0; }.more-filters summary{cursor:pointer;min-height:30px;display:flex;align-items:center;font-size: 1rem;color:var(--muted);}
.expanded-filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 20px;padding-top:16px;}
.filters input,.filters select { width:100%; min-width:0; }
.filters > .field { margin-bottom:10px; }
.data-status { display:flex; gap:8px 22px; flex-wrap:wrap; font-size: 0.875rem; color:var(--success); margin:10px 0 18px; }
.analytics-tabs { display:flex; gap:8px; flex-wrap:wrap; margin:20px 0; }
.analytics-kpis { grid-template-columns:repeat(3,minmax(0,1fr)); margin-bottom:22px; }
.analytics-kpis .stat-card { min-width:0; display:grid; gap:12px; }
.analytics-kpis strong { font-size: 1.75rem; letter-spacing:-.5px; }
.chart { display:flex; gap:16px; align-items:end; padding:20px 0; max-width:100%; overflow-x:auto; min-height:200px; }
.chart-column { min-width:44px; flex:1; text-align:center; display:grid; gap:10px; font-size: 0.875rem; }
.chart-track { height:135px; display:flex; align-items:end; justify-content:center; }
.chart-track i { display:block; width:min(100%,44px); background:var(--chart); border-radius:5px 5px 0 0; }
.insights,.data-notes ul { padding-inline-start:20px; line-height:1.9; font-size: 1rem; }
.insights li { margin-block:9px; }.subheading { margin-top:26px; }
.text-link { border:0; padding:0; background:transparent; color:var(--accent); text-align:start; white-space:normal; }
td small { display:block; color:var(--muted); }.delivery-message { min-width:220px; white-space:normal; max-width:350px; }
.table-scroll { max-width:100%; overflow-x:auto; }.table-scroll table { min-width:660px; }
.funnel { list-style:none; margin:20px 0 0; padding:0; display:grid; gap:12px; }
.funnel li { display:grid; grid-template-columns:125px minmax(50px,1fr) 50px 70px; gap:12px; align-items:center; font-size: 1rem; }
.funnel-track { height:22px; background:var(--surface-subtle); border-radius:4px; overflow:hidden; }.funnel-track i { display:block; height:100%; background:var(--chart); }
.data-notes { margin-top:24px; color:var(--muted); }
.data-notes summary { cursor:pointer; font-size: 1rem; }
.analytics-shell,.content-detail { min-width:0; overflow-wrap:anywhere; }
.content-detail h3 { margin:16px 0; }.detail-actions { margin:16px 0; }
.arrange-target { display:flex; gap:12px; flex-wrap:wrap; align-items:center; padding-top:16px; border-top:1px solid var(--line); }
.arrange-target .field { min-width:0; flex:1 1 180px; }.arrange-target select { min-width:0; width:100%; }
.episode-rows { display:grid; gap:10px; margin-top:14px; }.episode-rows article { padding:14px; border:1px solid var(--line); border-radius:8px; }
.detail-links { display:flex; flex-wrap:wrap; gap:8px; margin:18px 0; }
.path-grid { display:grid; gap:16px; grid-template-columns:repeat(3,minmax(0,1fr)); }.path-grid .panel { min-width:0; }
.path-grid h3 { font-size:1.0625rem; }.path-grid p { margin:14px 0; }
.content-table .text-link { min-height:44px; }.content-table td { white-space:normal; }
.content-detail .badge { white-space:normal; }.section-heading .field { margin:0; min-width:0; }.section-heading select { max-width:100%; min-width:0; }
.fulfillment-risks ul,.fulfillment-orders { margin:12px 0 0; padding:0; list-style:none; }
.fulfillment-risks li,.fulfillment-orders li { display:flex; gap:16px; align-items:center; justify-content:space-between; padding:12px 0; border-top:1px solid var(--line); }
.fulfillment-risks li > span,.fulfillment-orders li > span { min-width:0; }.fulfillment-risks small,.fulfillment-orders small { display:block; color:var(--muted); }
.fulfillment-risks button,.fulfillment-orders button { flex-shrink:0; }
.episode-rows article > small { display:block; color:var(--muted); margin-top:6px; }
@media(max-width:600px) { .fulfillment-risks li,.fulfillment-orders li { align-items:flex-start; flex-direction:column; } }
@media(max-width:1000px){.analytics-kpis{grid-template-columns:repeat(2,minmax(0,1fr));}.filters,.expanded-filters{grid-template-columns:repeat(2,minmax(0,1fr));}}
@media(max-width:600px){.analytics-intro{flex-direction:column;}.analytics-intro h2{font-size: 1.25rem;}.filters,.expanded-filters{grid-template-columns:minmax(0,1fr);}.funnel li{grid-template-columns:100px minmax(35px,1fr) 30px 52px;gap:7px;font-size: 0.875rem;}.analytics-kpis strong{font-size: 1.375rem;}.analytics-tabs .button{font-size: 0.875rem;padding:8px 10px;}}
@media(max-width:800px) {
  .path-grid { grid-template-columns:minmax(0,1fr); }
  .content-table table,.content-table tbody,.content-table tr,.content-table td { display:block; min-width:0; width:100%; }
  .content-table thead { display:flex; flex-wrap:wrap; }.content-table th { font-size:.875rem; white-space:normal; }
  .content-table tr { padding:12px 0; border-bottom:1px solid var(--line); }.content-table td { border:0; padding:6px 8px; }
  .content-table td[data-column]::before { content:attr(data-column); display:inline-block; margin-right:12px; min-width:5em; color:var(--muted); font-size:.875rem; }
}
@media(max-width:420px) {
  .analytics-kpis { grid-template-columns:minmax(0,1fr); }.section-heading { flex-direction:column; align-items:stretch; }
  .funnel li { grid-template-columns:minmax(0,1fr) 46px; }.funnel-track { grid-column:1; }.funnel li small { grid-column:1/-1; }
}
</style>
