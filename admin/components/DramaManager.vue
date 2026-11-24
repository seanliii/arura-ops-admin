<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Drama } from '../../shared/contracts'
import type { ContentListFilters, ContentOperationSummary, ContentWorkView, PageInfo } from '../../shared/content-operations'
import { api, dramaStatus, message, safeCover } from '../api'
import Feedback from './Feedback.vue'
import DramaEditor from './DramaEditor.vue'
import AuroraMark from '../../shared/AuroraMark.vue'
import CatalogChannelEditor from './CatalogChannelEditor.vue'
import { OPERATOR_LANGUAGE_LABELS as CONTENT_LANGUAGE_LABELS } from '../../shared/catalog-channel'
import { DRAMA_TEXT_LOCALES } from '../../shared/drama-localizations'
import { audienceLanguage } from '../../shared/content-delivery'
import { LAUNCH_MARKETS, MARKET_LABELS } from '../../shared/launch-markets'
import type { AnalysisEvidence } from '../operations-context'
import { newContentFilters } from '../content-workspace'
import DeliveryHistoryPanel from './DeliveryHistoryPanel.vue'
import { allowAdminNavigation } from '../draft-navigation'

const props = defineProps<{ revision: number; filters?: ContentListFilters; initialView?: 'list' | 'home'; initialDramaId?: number | null; initialEditorStep?: 'basic' | 'episodes' | 'publish'; initialCreating?: boolean; uploadAfterCreate?: boolean; analysis?: AnalysisEvidence | null; analysisHome?: { region: string; locale: string } | null }>()
const emit = defineEmits<{ media: [id: number]; changed: []; editing: [id: number | null]; view: [value: 'list' | 'home']; 'cancel-create': []; 'filter-change': [value: ContentListFilters] }>()
const initial = props.filters ?? newContentFilters(true)
const dramas = ref<Drama[]>([])
const fullDramas = ref<Drama[]>([])
const operations = ref<Record<number, ContentOperationSummary>>({})
const counts = ref({ all: 0, action: 0, review: 0, published: 0 })
const pagination = ref<PageInfo>({ page: initial.page, pageSize: 25, total: 0, pages: 1 })
const workView = ref<ContentWorkView>(initial.workView)
const page = ref(initial.page)
const listScroll = ref(initial.scrollY)
const workViews = [{ id: 'all', label: '全部' }, { id: 'action', label: '待我处理' },
  { id: 'review', label: '审核进度' }, { id: 'published', label: '已上架' }] as const
const selected = ref<Drama | null>(null)
const creating = ref(!!props.initialCreating)
const editorInitialStep = ref<'basic' | 'episodes' | 'publish'>('basic')
const loading = ref(false)
const error = ref('')
const deliveryMounted = ref(false), deliveryLocked = ref(false)
const query = ref(initial.query)
const status = ref(initial.status)
const market = ref(props.analysisHome?.region ?? initial.region)
const language = ref(props.analysisHome?.locale ?? (initial.language || (props.initialView === 'home' ? 'en' : '')))
const view = ref<'list' | 'home'>(props.initialView ?? 'list')
watch(language, value => { try { localStorage.setItem('aurora:admin:content-language', value) } catch { /* 筛选仍可用。 */ } }, { immediate: true })
const channelLocked = ref(false)
// 保存或切换写入范围后消费一次依据；页外的“返回分析”阅读上下文仍保留。
const writeAnalysis = ref(props.analysis ?? null)
const activeMarket = ref('JP')
const homeMarket = computed(() => market.value || activeMarket.value)
const markets = computed(() => [...new Set([...LAUNCH_MARKETS, activeMarket.value, ...dramas.value.flatMap(d => d.regions), ...fullDramas.value.flatMap(d => d.regions)])])
function remember(top?: number) {
  if (!selected.value && !creating.value && view.value === 'list') listScroll.value = top ?? window.scrollY
  emit('filter-change', { query: query.value, status: status.value, region: market.value,
    language: language.value, workView: workView.value, page: page.value, scrollY: listScroll.value })
}
// 必须在切换页面/插入编辑器之前记位置，卸载时浏览器滚动锚点可能已经改变。
defineExpose({ remember })
let initialDramaOpened = false
let generation = 0, controller: AbortController | undefined
async function load(restorePosition = false) {
  const epoch = ++generation
  controller?.abort(); controller = new AbortController()
  const signal = controller.signal
  loading.value = true; error.value = ''
  try {
    if (view.value === 'home') {
      // 编排消费完整片库，不能把分页的第一页误当全部可选作品。
      const result = await api<{ dramas: Drama[]; catalogRegion?: string }>('/admin/dramas', { signal })
      if (epoch !== generation) return
      fullDramas.value = result.dramas; activeMarket.value = result.catalogRegion ?? 'JP'
    } else {
      const params = new URLSearchParams({ q: query.value, status: status.value, region: market.value,
        language: language.value, view: workView.value, page: String(page.value), pageSize: '25' })
      const result = await api<{ dramas: Drama[]; operations: Record<number, ContentOperationSummary>;
        pagination: PageInfo; counts: typeof counts.value; catalogRegion: string }>(`/admin/content-operations?${params}`, { signal })
      if (epoch !== generation) return
      if (result.pagination.page > result.pagination.pages) { page.value = result.pagination.pages; return }
      dramas.value = result.dramas; operations.value = result.operations
      pagination.value = result.pagination; counts.value = result.counts; activeMarket.value = result.catalogRegion
    }
    if (props.initialDramaId && !initialDramaOpened) {
      initialDramaOpened = true
      const result = await api<{ drama: Drama }>(`/admin/dramas/${props.initialDramaId}`, { signal })
      if (epoch !== generation) return
      selected.value = result.drama; editorInitialStep.value = props.initialEditorStep ?? 'episodes'
    }
    if (restorePosition && !selected.value && !creating.value && view.value === 'list') {
      await nextTick(); window.scrollTo({ top: listScroll.value })
    }
  }
  catch (cause) { if (!signal.aborted && epoch === generation) error.value = message(cause) }
  finally { if (epoch === generation) loading.value = false }
}
watch([query, status, market, language, workView, page], (values, old) => {
  if (values[2] !== old[2] || values[3] !== old[3]) writeAnalysis.value = null
  if (values.slice(0, 5).some((v, i) => v !== old[i]) && page.value !== 1) { page.value = 1; return }
  remember(0); void load()
})
function saved(drama: Drama) {
  const continueToUpload = creating.value && props.uploadAfterCreate
  const index = dramas.value.findIndex(d => d.id === drama.id)
  if (index === -1) dramas.value.unshift(drama)
  else dramas.value[index] = drama
  if (creating.value) editorInitialStep.value = 'episodes'
  selected.value = drama
  creating.value = false
  emit('changed')
  if (continueToUpload) emit('media', drama.id)
}
async function openEditor(drama: Drama | null, step: 'basic' | 'episodes' | 'publish' = 'basic') {
  if (!allowAdminNavigation()) return
  remember()
  emit('editing', drama?.id ?? null)
  editorInitialStep.value = step
  selected.value = drama; creating.value = !drama
  await nextTick(); window.scrollTo({ top: 0 })
}
async function close() {
  emit('editing', null)
  if (creating.value) emit('cancel-create')
  creating.value = false; selected.value = null
  await load(true)
}
onMounted(() => load(true))
onBeforeUnmount(() => { generation++; controller?.abort() })
</script>

<template>
  <section class="drama-workspace" aria-label="剧目工作区">
    <div v-if="!selected && !creating">
      <section class="workspace-scope" aria-label="语言内容工作区">
        <div class="toolbar workspace-toolbar">
          <label class="field language-field"><span>内容语言</span><select v-model="language" aria-label="内容频道语言" :disabled="channelLocked || deliveryLocked"><option value="">全部语言</option><option v-for="code in DRAMA_TEXT_LOCALES" :key="code" :value="code">{{ CONTENT_LANGUAGE_LABELS[code] }}</option></select></label>
          <button v-if="view === 'list'" class="button quiet" :disabled="!language || channelLocked || deliveryLocked" :title="!language ? '选择一种内容语言后编排首页' : undefined" @click="emit('view', 'home')">编排该语言主页</button>
          <button v-else class="button quiet" :disabled="channelLocked" @click="emit('view', 'list')">查看该语言剧目</button>
        <details class="workspace-regions">
          <summary>{{ market ? `发行地区 · ${MARKET_LABELS[market] || market}` : '发行地区' }}</summary>
          <div class="region-popover">
          <label class="field"><span>管理地区</span><select v-model="market" aria-label="管理地区" :disabled="channelLocked || deliveryLocked"><option value="">{{ view === 'home' ? `跟随当前服务 · ${MARKET_LABELS[activeMarket] || activeMarket}` : '全部地区' }}</option><option v-for="code in markets" :key="code" :value="code">{{ MARKET_LABELS[code] || '历史地区' }} · {{ code }}{{ LAUNCH_MARKETS.some(target => target === code) ? '' : '（历史配置）' }}</option></select></label>
          <p class="muted small-text">语言决定整理哪套内容；地区只限制在哪里发行。同一种语言可服务多个地区。当前服务为{{ MARKET_LABELS[activeMarket] || activeMarket }}，这里的筛选不会开通新市场或改变作品权限。</p>
          </div>
        </details>
          <button v-if="view === 'list'" class="button primary workspace-create" :disabled="channelLocked || deliveryLocked" @click="openEditor(null)">＋ 新建剧目</button>
        </div>
        <p v-if="channelLocked" class="muted small-text">请先保存或放弃主页修改，再切换语言。</p>
        <p v-if="deliveryLocked" class="notice small-text" role="status">交付历史里有待核对的计时操作。请展开“交付历史与耗时”核对原操作，再切换范围或进入编辑。</p>
      </section>
      <Feedback v-if="view === 'home'" :loading="loading" :error="error" retry @retry="load()" />
      <aside v-if="view === 'home' && analysis" class="notice">
        <p data-testid="analysis-write-scope"><strong>当前编排写入范围：</strong>{{ homeMarket }} × {{ language || '请先选择频道语言' }}。日期、设备等只作为上方分析依据，不改变此范围。</p>
        <p data-testid="analysis-candidate-scope">现有候选使用当前市场与频道的滚动近7天；不包含报告的自选日期、设备、界面语言等全部筛选。载入候选只是草稿，保存前不会改变首页。</p>
      </aside>
      <CatalogChannelEditor v-if="view === 'home' && language && !loading && !error" :key="`${homeMarket}/${language}`" :region="homeMarket" :active-region="activeMarket" :locale="language" :dramas="fullDramas"
        :analysis="writeAnalysis" @context-consumed="writeAnalysis = null" @locked="channelLocked = $event" />
      <p v-else-if="view === 'home' && !language" class="notice">先在上面选一种语言，就可以整理它的首页。</p>
      <div v-if="view === 'list'" class="panel library-panel">
        <div class="content-views" role="tablist" aria-label="内容工作视图">
          <button v-for="item in workViews" :key="item.id" role="tab" type="button"
            :aria-selected="workView === item.id" @click="workView = item.id">{{ item.label }} <small>{{ counts[item.id] }}</small></button>
        </div>
        <div class="library-toolbar">
          <label class="field search-field"><span class="sr-only">搜索剧目</span><input v-model="query" type="search" aria-label="搜索剧目" maxlength="200" placeholder="搜索剧名、分类或编号" /></label>
          <label class="field"><span class="sr-only">发布状态</span><select v-model="status" aria-label="发布状态"><option value="">全部状态</option><option value="draft">草稿</option><option value="published">已发布</option><option value="archived">已下架</option></select></label>
          <button v-if="query || status || market || language" class="button quiet" :disabled="deliveryLocked" @click="query = ''; status = ''; market = ''; language = ''">清空筛选</button>
          <button class="button quiet" :disabled="loading" @click="load()">刷新列表</button>
        </div>
        <h2 class="sr-only">剧目列表</h2>
        <Feedback :loading="loading" :error="error" retry @retry="load()" />
        <div v-if="dramas.length && !error" class="table-scroll" tabindex="0" role="region" aria-label="剧目列表表格" :aria-busy="loading">
          <table>
            <thead><tr><th>剧目</th><th>状态</th><th>视频</th><th>内容语言</th><th>操作</th></tr></thead>
            <tbody><tr v-for="drama in dramas" :key="drama.id">
              <td data-column="作品"><div class="drama-cell"><img v-if="drama.status === 'published' && safeCover(drama.cover)" :src="safeCover(drama.cover)" alt="" /><span v-else class="cover-placeholder" aria-hidden="true"><AuroraMark :size="28" /></span><div><strong>{{ drama.title }}</strong><small>#{{ drama.id }} · {{ drama.category }}</small></div></div></td>
              <td data-column="状态"><span :class="['badge', drama.status === 'published' ? 'good' : 'neutral']">{{ dramaStatus[drama.status] }}</span><small class="operation-reason">{{ operations[drama.id]?.label }}</small></td>
              <td data-column="视频">{{ drama.totalEpisodes }} 集<small>前 {{ drama.freeEpisodes }} 集免费</small></td>
              <td data-column="语言">{{ CONTENT_LANGUAGE_LABELS[audienceLanguage(drama) ?? ''] ?? '待确认' }}<small>原声：{{ CONTENT_LANGUAGE_LABELS[drama.language] ?? drama.language }}{{ drama.delivery?.subtitleMode === 'burned' ? ' · 自带字幕' : drama.delivery?.subtitleMode === 'external' ? ' · 独立字幕' : '' }}</small></td>
              <td data-column="操作"><div class="inline wrap"><button v-if="operations[drama.id]?.nextAction.step === 'publish'" class="button small" :disabled="loading || deliveryLocked" :aria-label="`${operations[drama.id]!.nextAction.label} ${drama.title}`" @click="openEditor(drama, 'publish')">{{ operations[drama.id]!.nextAction.label }}</button><button class="button small" :disabled="channelLocked || loading || deliveryLocked" :aria-label="`管理 ${drama.title}`" @click="openEditor(drama)">编辑资料</button><button class="button small quiet" :disabled="loading || deliveryLocked" :aria-label="`管理视频 ${drama.title}`" @click="openEditor(drama, 'episodes')">管理视频</button></div></td>
            </tr></tbody>
          </table>
        </div>
        <div v-else-if="!loading && !error" class="empty-state"><h3>{{ query || status || language || market || workView !== 'all' ? '这个范围没有匹配的作品' : '还没有剧目' }}</h3><p>{{ query || status || language || market || workView !== 'all' ? '可以调整筛选，或切换工作视图。' : '点击“新建剧目”，开始准备第一部作品。' }}</p></div>
        <div class="library-caption" data-testid="content-pagination" aria-live="polite"><span>共 {{ pagination.total }} 部 · 第 {{ pagination.page }} / {{ pagination.pages }} 页</span><div class="inline"><button class="button small quiet" aria-label="上一页内容" :disabled="loading || page <= 1" @click="page--">上一页</button><button class="button small quiet" aria-label="下一页内容" :disabled="loading || page >= pagination.pages" @click="page++">下一页</button></div></div>
      </div>
      <details v-if="view === 'list'" class="panel delivery-history-entry" @toggle="deliveryMounted = deliveryMounted || ($event.target as HTMLDetailsElement).open">
        <summary>交付历史与耗时</summary>
        <DeliveryHistoryPanel v-if="deliveryMounted" :region="market" :language="language" @locked="deliveryLocked = $event" />
      </details>
    </div>
    <DramaEditor v-else :key="selected?.id ?? 'new'" :drama="selected" :initial-step="editorInitialStep" :initial-language="language" :initial-region="market || activeMarket"
      :analysis="writeAnalysis?.dramaId === selected?.id ? writeAnalysis : null" @context-consumed="writeAnalysis = null"
      @saved="saved" @close="close" @media="emit('media', $event)" />
  </section>
</template>
<style scoped>
.workspace-toolbar { margin: 0; gap: 12px; align-items: center; }
.workspace-toolbar .language-field { display: flex; flex-direction: row; align-items: center; gap: 10px; min-width: 0; }
.language-field > span { font-size: .875rem; white-space: nowrap; color: var(--muted); }
.language-field select { width: 208px; min-width: 0; }
.workspace-create { margin-left: auto; }
.workspace-scope { margin-bottom: 12px; }
.workspace-scope > p { margin-top: 8px; }
.workspace-regions { position: relative; color: var(--muted); font-size: .875rem; }
.workspace-regions summary { cursor: pointer; padding: 10px 8px; }
.region-popover { position: absolute; z-index: 8; top: 48px; right: 0; width: 340px; max-width: calc(100vw - 40px); background: var(--panel); padding: 20px; border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 12px 40px #0002; }
.workspace-regions .field { width: 100%; margin: 0 0 12px; }
.library-panel { padding: 0; overflow: hidden; }
.library-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 18px 8px; }
.library-toolbar .field { margin: 0; width: 144px; }
.library-toolbar .search-field { flex: 1; min-width: 220px; max-width: none; }
.library-caption { display: flex; justify-content: space-between; gap: 12px; padding: 8px 20px 14px; color: var(--muted); font-size: .875rem; }
.library-panel :deep(.table-scroll) { margin: 0; border: 0; border-radius: 0; }
.library-panel :deep(.notice), .library-panel :deep(.loading) { margin-inline: 18px; }
.library-panel .drama-cell { min-width: 225px; }
.content-views { display: flex; gap: 4px; padding: 4px 14px 0; border-bottom: 1px solid var(--line); }
.content-views button { min-height: 48px; padding: 10px 14px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); }
.content-views button[aria-selected="true"] { border-bottom-color: var(--action); color: var(--accent); font-weight: 600; }
.content-views small { margin-left: 4px; color: inherit; font-variant-numeric: tabular-nums; }
.operation-reason { max-width: 240px; overflow-wrap: anywhere; }
.delivery-history-entry { margin-top: 18px; }
@media(max-width:900px) { .workspace-toolbar { gap: 8px; }.workspace-toolbar .quiet { padding-inline: 8px; font-size: .875rem; }.workspace-create { margin-left: 0; }.library-toolbar .search-field { min-width: 180px; } }
@media(max-width:640px) {
  .content-views { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding-inline: 8px; }
  .content-views button { padding-inline: 4px; }
  .library-caption { flex-wrap: wrap; align-items: center; }
  .workspace-toolbar .language-field { flex: 1 1 100%; }.language-field select { width: auto; flex: 1; }
  .workspace-create { margin-left: auto; }.region-popover { position: static; margin-top: 8px; width: 100%; }.workspace-regions[open] { order: 5; flex-basis: 100%; }
  .library-toolbar { padding: 14px; gap: 8px; }.library-toolbar .search-field { flex-basis: 100%; }.library-caption { padding: 4px 14px 12px; }
  .library-panel table { min-width: 0; display: block; }.library-panel thead { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
  .library-panel tbody { display: block; }.library-panel tr { display: grid; grid-template-columns: 1fr 1fr; padding: 16px; border-top: 1px solid var(--line); gap: 10px; }
  .library-panel td { border: 0; padding: 0; display: block; min-width: 0; }.library-panel td:first-child, .library-panel td:last-child, .library-panel td:nth-child(4) { grid-column: 1 / -1; }
  .library-panel .drama-cell { min-width: 0; }.library-panel .drama-cell strong { overflow-wrap: anywhere; }.library-panel td:last-child .inline { justify-content: flex-end; }
}
</style>
