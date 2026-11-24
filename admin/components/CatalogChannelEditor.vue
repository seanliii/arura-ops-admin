<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Drama } from '../../shared/contracts'
import { OPERATOR_LANGUAGE_LABELS as CONTENT_LANGUAGE_LABELS, sortCatalog, type CatalogChannel, type CatalogMetrics, type CatalogSection, type CatalogSort } from '../../shared/catalog-channel'
import { api, message, safeCover } from '../api'
import Feedback from './Feedback.vue'
import { audienceLanguage } from '../../shared/content-delivery'
import { useDraftNavigationGuard } from '../draft-navigation'
import HomeSectionEditor from './HomeSectionEditor.vue'
import PositionSelect from './PositionSelect.vue'
import AnalyticsOperationsPanel from './AnalyticsOperationsPanel.vue'
import type { AnalyticsCandidate } from '../../shared/analytics-operations'
import { MARKET_LABELS } from '../../shared/launch-markets'
import type { AnalysisEvidence } from '../operations-context'
import { newOperationNote, noteChanged, saveOperationContext, type OperationRestore } from '../operations-history'
import OperationNote from './OperationNote.vue'
import OperationsHistory from './OperationsHistory.vue'

const props = defineProps<{ region: string; activeRegion?: string; locale: string; dramas: Drama[]; analysis?: AnalysisEvidence | null }>()
const emit = defineEmits<{ locked: [value: boolean]; 'context-consumed': [] }>()
const loading = ref(false), saving = ref(false), rechecking = ref(false), error = ref(''), success = ref('')
const value = ref<CatalogChannel | null>(null), serverChoice = ref<CatalogChannel | null>(null)
const operationNote = ref(newOperationNote()), restoredFrom = ref(''), automaticRestore = ref(false)
const writeEvidence = ref(props.analysis ?? null)
const pendingSave = ref<{ reset: boolean; version: number; content: string; draft: string } | null>(null)
const chosen = ref<number[]>([]), fallback = ref<'original' | 'strict'>('strict')
const sort = ref<CatalogSort>('manual'), sections = ref<CatalogSection[]>([])
const sectionsInvalid = ref(false), sectionsKey = ref(0), needsReview = ref(false)
const pane = ref<'titles' | 'sections' | 'preview'>('titles'), search = ref('')
const panes = [{ id: 'titles', title: '首页作品' }, { id: 'sections', title: '栏目与顺序' }, { id: 'preview', title: '编排预览' }] as const
const metrics = ref<Record<string, CatalogMetrics>>({}), metricScope = ref(''), metricsError = ref('')
const metricDefinition = ref(''), metricState = ref<'loading' | 'ready' | 'empty' | 'unavailable'>('loading')
const publicDramas = ref<Drama[]>([]), publicReady = ref(false), publicError = ref('')
const snapshot = ref('')
const encoded = () => JSON.stringify([chosen.value, fallback.value, sort.value, sections.value, automaticRestore.value])
const fullDraft = () => JSON.stringify([encoded(), operationNote.value, restoredFrom.value])
const contentKey = (channel: Pick<CatalogChannel, 'dramaIds' | 'fallback' | 'sort' | 'sections'>) => JSON.stringify([
  channel.dramaIds, channel.fallback, channel.sort ?? 'manual',
  (channel.sections ?? []).map(section => ({ ...section, title: section.title.trim() })),
])
const draftKey = () => contentKey({ dramaIds: chosen.value, fallback: fallback.value, sort: sort.value, sections: sections.value })
const dirty = computed(() => !!value.value && (encoded() !== snapshot.value || !!restoredFrom.value || noteChanged(operationNote.value)))
useDraftNavigationGuard(() => dirty.value, () => saving.value || rechecking.value)
watch(() => dirty.value || saving.value || rechecking.value, locked => emit('locked', locked), { immediate: true })
const candidates = computed(() => props.dramas.filter(drama => drama.regions.includes(props.region)))
const selectedDramas = computed(() => chosen.value.map(id => candidates.value.find(drama => drama.id === id)).filter((drama): drama is Drama => !!drama))
const orderedDramas = computed(() => automaticRestore.value
  ? publicDramas.value.filter(drama => audienceLanguage(drama) === props.locale)
  : sortCatalog(selectedDramas.value, sort.value, metrics.value))
const visibleCandidates = computed(() => {
  const rows = [...orderedDramas.value, ...candidates.value.filter(drama => !chosen.value.includes(drama.id))]
  const query = search.value.trim().toLowerCase()
  return rows.filter(drama => (chosen.value.includes(drama.id) || audienceLanguage(drama) === props.locale || fallback.value === 'original') &&
    `${drama.title} ${Object.values(drama.localizations ?? {}).map(v => v.title ?? '').join(' ')}`.toLowerCase().includes(query))
})
const currentService = computed(() => props.region === (props.activeRegion ?? props.region))
const publiclyAvailable = computed(() => new Set(publicDramas.value.map(drama => drama.id)))
const previewDramas = computed(() => currentService.value && publicReady.value
  ? orderedDramas.value.filter(drama => audienceLanguage(drama) === props.locale && publiclyAvailable.value.has(drama.id)) : [])
const otherLanguageDramas = computed(() => currentService.value && publicReady.value && fallback.value === 'original'
  ? orderedDramas.value.filter(drama => audienceLanguage(drama) !== props.locale && publiclyAvailable.value.has(drama.id)) : [])
const unavailableDramas = computed(() => automaticRestore.value ? [] : selectedDramas.value.filter(drama => !publiclyAvailable.value.has(drama.id) || (audienceLanguage(drama) !== props.locale && fallback.value === 'strict')))
const previewSections = computed(() => sections.value.map(section => {
  const selected = section.dramaIds.length ? section.dramaIds.map(id => previewDramas.value.find(drama => drama.id === id)).filter((drama): drama is Drama => !!drama) : previewDramas.value
  return { ...section, dramas: sort.value === 'manual' ? selected : previewDramas.value.filter(drama => selected.some(row => row.id === drama.id)) }
}))
const sortDescription = computed(() => sort.value === 'manual' ? '按你设置的位置展示；栏目的自选作品也可以单独调整位置。' : '按本语言最近7天的统计自动排作品，同分保留原先位置。栏目本身的先后仍由你决定。')
const endpoint = () => `/admin/catalog-channels/${encodeURIComponent(props.region)}/${encodeURIComponent(props.locale)}`
const viewerHref = window.location.pathname.replace(/admin\/?(?:.*)?$/, '') || '/'
let generation = 0
function validateChannel(channel: CatalogChannel) {
  if (!channel || channel.region !== props.region || channel.locale !== props.locale || !Number.isSafeInteger(channel.version) || !Array.isArray(channel.dramaIds)) throw new Error('主页回执不完整，请重试')
  return channel
}
function clearOperation(consumeEvidence = true) {
  operationNote.value = newOperationNote(); restoredFrom.value = ''; automaticRestore.value = false; pendingSave.value = null
  if (consumeEvidence) { writeEvidence.value = null; emit('context-consumed') }
}
function savedSnapshot(channel: CatalogChannel) {
  return JSON.stringify([
    channel.configured ? channel.dramaIds : candidates.value.filter(drama => audienceLanguage(drama) === props.locale).map(drama => drama.id),
    channel.fallback, channel.sort ?? 'manual', channel.sections ?? [], false,
  ])
}
function adopt(channel: CatalogChannel, preserveSectionEditor = false, consumeEvidence = true) {
  clearOperation(consumeEvidence)
  value.value = channel
  chosen.value = channel.configured ? [...channel.dramaIds] : candidates.value.filter(drama => audienceLanguage(drama) === props.locale).map(drama => drama.id)
  fallback.value = channel.fallback; sort.value = channel.sort ?? 'manual'
  sections.value = (channel.sections ?? []).map(section => ({ ...section, dramaIds: [...section.dramaIds] }))
  if (!preserveSectionEditor) sectionsKey.value++
  sectionsInvalid.value = false; snapshot.value = savedSnapshot(channel)
  needsReview.value = false; serverChoice.value = null
}
async function load() {
  const epoch = ++generation
  const initialLoad = !value.value
  loading.value = true; value.value = null; error.value = ''; success.value = ''; needsReview.value = false; serverChoice.value = null
  metrics.value = {}; metricScope.value = ''; metricsError.value = ''; metricDefinition.value = ''; metricState.value = 'loading'
  publicDramas.value = []; publicReady.value = false; publicError.value = ''
  try {
    const result = await api<{ channel: CatalogChannel }>(endpoint())
    if (epoch !== generation) return
    adopt(validateChannel(result.channel), false, !initialLoad)
    await Promise.all([readMetrics(), readPublic()])
  } catch (cause) { if (epoch === generation) error.value = message(cause) }
  finally { if (epoch === generation) loading.value = false }
}
watch(() => [props.region, props.locale], load, { immediate: true })
onBeforeUnmount(() => { generation++; emit('locked', false) })
function toggle(drama: Drama) {
  if (automaticRestore.value) return
  success.value = ''
  if (chosen.value.includes(drama.id)) {
    chosen.value = chosen.value.filter(id => id !== drama.id)
    sections.value = sections.value.map(section => ({ ...section, dramaIds: section.dramaIds.filter(id => id !== drama.id) }))
  } else if (chosen.value.length < 100) chosen.value.push(drama.id)
  else error.value = '一个语言首页最多选择100部作品，请先移除不需要的作品。'
}
function move(from: number, to: number) {
  if (automaticRestore.value || sort.value !== 'manual' || from < 0 || to < 0 || to >= chosen.value.length) return
  const ids = [...chosen.value]; const [id] = ids.splice(from, 1); ids.splice(to, 0, id!); chosen.value = ids
}
async function save(reset = false) {
  reset ||= automaticRestore.value
  if (!value.value || saving.value || rechecking.value || needsReview.value || (!reset && (sectionsInvalid.value || chosen.value.length > 100))) return
  const epoch = generation, before = value.value, expected = draftKey()
  pendingSave.value = { reset, version: before.version, content: expected, draft: fullDraft() }
  saving.value = true; error.value = ''; success.value = ''
  try {
    const result = await api<{ channel: CatalogChannel }>(endpoint(), {
      method: reset ? 'DELETE' : 'PUT',
      body: { version: before.version, ...(!reset ? { dramaIds: chosen.value, fallback: fallback.value, sort: sort.value, sections: sections.value } : {}),
        operationContext: saveOperationContext(operationNote.value, writeEvidence.value, restoredFrom.value) },
    })
    if (epoch !== generation) return
    const channel = validateChannel(result.channel)
    if (channel.version !== before.version + 1 || channel.configured === reset || (!reset && contentKey(channel) !== expected)) throw new Error('返回的主页配置与保存内容不一致，请核对服务器状态')
    adopt(channel, !reset)
    success.value = reset ? '已恢复只选本语言成片。' : '主页顺序与展示范围已保存。仅已发布且符合当前市场条件的成片会显示。'
    void readPublic()
  } catch (cause) {
    if (epoch === generation) { error.value = message(cause); needsReview.value = true }
  } finally { saving.value = false }
}
async function reconcile() {
  if (!value.value || saving.value || rechecking.value) return
  rechecking.value = true; error.value = ''; success.value = ''
  const epoch = generation
  try {
    const result = await api<{ channel: CatalogChannel }>(endpoint())
    if (epoch !== generation) return
    const channel = validateChannel(result.channel)
    const pending = pendingSave.value
    const saved = pending && channel.version === pending.version + 1 && (pending.reset
      ? !channel.configured && channel.dramaIds.length === 0 && channel.fallback === 'strict' &&
        channel.sort === 'manual' && !channel.sections?.length
      : channel.configured && contentKey(channel) === pending.content)
    if (saved && fullDraft() === pending.draft) {
      adopt(channel, !pending.reset); success.value = '已核对，刚才的修改已保存；没有重复提交。'; void readPublic()
    } else if (saved) {
      // 已提交的备注与依据只消费一次；新输入保留，以确认的服务器内容作为已保存基线。
      clearOperation()
      value.value = channel; snapshot.value = savedSnapshot(channel); needsReview.value = false; serverChoice.value = null
      success.value = '已核对，刚才提交的版本已保存；之后的编辑仍保留，尚未保存。'
      void readPublic()
    } else if (channel.version === value.value.version && channel.configured === value.value.configured && contentKey(channel) === contentKey(value.value)) {
      needsReview.value = false; serverChoice.value = null
      pendingSave.value = null
      success.value = '服务器尚未保存本次修改，输入已保留。可以继续编辑后点击“保存当前主页”。'
    } else {
      serverChoice.value = channel; needsReview.value = true
    }
  } catch (cause) { if (epoch === generation) error.value = message(cause) }
  finally { rechecking.value = false }
}
function adoptServer() {
  if (!serverChoice.value) return
  adopt(serverChoice.value); error.value = ''; success.value = '已采用刚核对的服务器版本。'
}
function discard() {
  if (!dirty.value || window.confirm('放弃未保存的主页修改并重新读取？')) void load()
}
function restoreDraft(proposal: OperationRestore) {
  if (!value.value || loading.value || saving.value || rechecking.value || needsReview.value) return
  if (proposal.kind !== 'catalog' || proposal.key !== `${props.region}/${props.locale}` || proposal.currentVersion !== value.value.version) {
    error.value = '当前主页版本已变化，请先核对服务器版本，再载入历史草稿。'; needsReview.value = true; return
  }
  const draft = proposal.draft
  if (typeof draft.configured !== 'boolean' || !Array.isArray(draft.dramaIds) || !Array.isArray(draft.sections)) {
    error.value = '历史片单回执不完整，请重新读取。'; return
  }
  if (dirty.value && !window.confirm('载入历史将替换本页未保存的编排和备注，是否继续？线上内容不会立即改变。')) return
  clearOperation()
  automaticRestore.value = !draft.configured
  chosen.value = draft.configured ? [...draft.dramaIds] : publicDramas.value.filter(drama => audienceLanguage(drama) === props.locale).map(drama => drama.id)
  fallback.value = draft.fallback ?? 'strict'; sort.value = draft.sort ?? 'manual'
  sections.value = draft.sections.map(section => ({ ...section, dramaIds: [...section.dramaIds] }))
  sectionsInvalid.value = false; sectionsKey.value++; restoredFrom.value = proposal.id
  error.value = ''; success.value = '已载入改前草稿，尚未保存。核对后使用“保存当前主页”，届时会重新检查当前条件。'
  if (automaticRestore.value) pane.value = 'preview'
}
async function readPublic() {
  const epoch = generation
  try {
    const result = await api<{ dramas: Drama[]; region: string }>('/catalog')
    if (epoch !== generation) return
    if (!Array.isArray(result.dramas) || result.region !== (props.activeRegion ?? props.region)) throw new Error('当前服务地区未核实')
    publicDramas.value = result.dramas; publicReady.value = true; publicError.value = ''
  } catch (cause) { if (epoch === generation) { publicReady.value = false; publicError.value = message(cause) } }
}
async function readMetrics() {
  const epoch = generation
  metricState.value = 'loading'; metricsError.value = ''
  try {
    const result = await api<{ metrics: Record<string, CatalogMetrics>; scope: string; definition: string; channelLanguage: string; dataState: 'ready' | 'empty' | 'unavailable' }>(`/admin/catalog-metrics/${encodeURIComponent(props.region)}?locale=${encodeURIComponent(props.locale)}`)
    if (epoch !== generation) return
    if (result.channelLanguage !== props.locale || !result.metrics || typeof result.metrics !== 'object' || !['ready', 'empty', 'unavailable'].includes(result.dataState)) throw new Error('统计回执不是当前内容频道，请刷新重试')
    metrics.value = result.metrics; metricScope.value = result.scope; metricDefinition.value = result.definition; metricState.value = result.dataState
  } catch (cause) {
    if (epoch === generation) { metrics.value = {}; metricScope.value = ''; metricsError.value = message(cause); metricState.value = 'unavailable' }
  }
}
const rate = (number: number | null | undefined) => number == null ? '暂无数据' : `${(number * 100).toFixed(1)}%`
function metricFor(drama: Drama) {
  const item = metrics.value[drama.id]
  return sort.value === 'plays' ? `${item?.plays ?? '暂无记录'} 次播放` : sort.value === 'playRate' ? `播放率 ${rate(item?.playRate)}` : `付费率 ${rate(item?.paidRate)}`
}
function applyCandidate(candidate: AnalyticsCandidate) {
  if (!value.value || dirty.value || saving.value || needsReview.value || candidate.channelVersion !== value.value.version || candidate.region !== props.region || candidate.locale !== props.locale || candidate.dramaIds.length !== chosen.value.length || candidate.dramaIds.some(id => !chosen.value.includes(id))) {
    error.value = '候选不是当前已保存主页的同一片单，请刷新后核对'; return
  }
  chosen.value = [...candidate.dramaIds]; sort.value = 'manual'
  sections.value = sections.value.map(section => ({ ...section, dramaIds: chosen.value.filter(id => section.dramaIds.includes(id)) }))
  success.value = '候选已载入编辑表单；线上未改变。请检查后使用“保存当前主页”。'
}
const confirmation = ref<'reset' | 'overwrite' | null>(null)
const dialog = ref<HTMLDialogElement>()
async function confirm(action: 'reset' | 'overwrite') { confirmation.value = action; await nextTick(); dialog.value?.showModal() }
async function confirmed() {
  const action = confirmation.value
  dialog.value?.close(); confirmation.value = null
  if (action === 'overwrite' && serverChoice.value) {
    value.value = serverChoice.value; serverChoice.value = null; needsReview.value = false
    await save()
  } else if (action === 'reset') await save(true)
}
async function paneKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = panes.findIndex(item => item.id === pane.value)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3
  pane.value = panes[next]!.id
  await nextTick(); document.getElementById(`home-${pane.value}-tab`)?.focus()
}
</script>

<template>
  <section class="panel channel-editor" aria-label="语言地区主页编排">
    <div class="channel-heading">
      <h2 class="sr-only">{{ CONTENT_LANGUAGE_LABELS[locale] ?? locale }}首页</h2>
      <div class="home-sort"><label class="field"><span>作品排序</span><select v-model="sort" aria-label="剧目排序方式" :disabled="loading || saving || rechecking || !value || automaticRestore"><option value="manual">手动顺序 · 我来安排</option><option value="plays">最近7天播放次数</option><option value="playRate">最近7天播放率</option><option value="paidRate">最近7天付费率</option></select></label><details class="sort-help"><summary>排序与保存说明</summary><div><p>{{ sortDescription }}</p><p>{{ metricState === 'unavailable' ? '统计暂不可用，当前保留原先位置，不借用其他语言的数据。' : '没有样本不会编造排名；统计更新后，实际顺序也可能变化。' }}</p><p>只修改 {{ CONTENT_LANGUAGE_LABELS[locale] ?? locale }} 首页 · {{ MARKET_LABELS[region] || region }}发行范围。所有区域统一保存；草稿未上架前不会对观众展示。</p></div></details></div>
      <div class="channel-save"><strong class="save-state" :class="{ unsaved: dirty }">{{ saving ? '正在保存' : needsReview ? '等待核对' : loading ? '正在读取' : !value ? '未读取' : dirty ? '有未保存修改' : value.configured ? '已保存' : '自动选片' }}</strong><button v-if="dirty" type="button" class="button quiet" :disabled="saving || rechecking" @click="discard">放弃未保存修改</button><button type="button" class="button primary" :disabled="loading || saving || rechecking || !value || needsReview || (!automaticRestore && (sectionsInvalid || chosen.length > 100))" @click="save()">{{ saving ? '保存中…' : '保存当前主页' }}</button></div>
    </div>
    <Feedback :loading="loading" :error="error" :success="success" />
    <div v-if="needsReview" class="recovery-panel">
      <p>本页输入已保留。先核对服务器有没有保存成功，再决定下一步，避免重复提交或覆盖别人的修改。</p>
      <button type="button" class="button" :disabled="rechecking || saving" @click="reconcile">{{ rechecking ? '正在核对…' : '核对服务器并保留输入' }}</button>
      <template v-if="serverChoice"><p class="notice warning">服务器已有新版本（{{ serverChoice.version }}），选择了 {{ serverChoice.dramaIds.length }} 部作品、{{ serverChoice.sections?.length ?? 0 }} 个栏目。本页修改未覆盖它。</p><div class="inline wrap"><button type="button" class="button" @click="adoptServer">采用服务器版本</button><button type="button" class="button danger" :disabled="sectionsInvalid" @click="confirm('overwrite')">用我的编排覆盖此版本</button></div></template>
    </div>
    <button v-if="error && !value" type="button" class="button" :disabled="loading" @click="load">重新读取主页配置</button>
    <fieldset :disabled="loading || saving || rechecking || !value">
      <p v-if="automaticRestore" class="notice" data-testid="automatic-restore-draft">已载入自动选片草稿，尚未保存。保存将取消这个语言的手动片单和栏目，只自动展示当前合法可用的本语言作品，不是保存空片单。若不采用，可放弃未保存修改。</p>

      <div class="home-tabs" role="tablist" aria-label="首页编排步骤" @keydown="paneKey"><button v-for="item in panes" :id="`home-${item.id}-tab`" :key="item.id" type="button" role="tab" :aria-selected="pane === item.id" :aria-controls="`home-${item.id}-panel`" :tabindex="pane === item.id ? 0 : -1" @click="pane = item.id">{{ item.title }}</button></div>
      <div v-show="pane === 'titles'" id="home-titles-panel" role="tabpanel" aria-labelledby="home-titles-tab">
        <div class="title-tools"><label class="field"><span class="sr-only">查找作品</span><input v-model="search" aria-label="查找首页作品" type="search" placeholder="搜索原剧名或译名" /></label><span class="muted small-text">勾选加入首页</span></div>
        <p v-if="!value?.configured && !automaticRestore" class="automatic-note">当前为自动片单。修改并保存后，采用你的选择。</p>
        <div class="home-title-list">
          <article v-for="drama in visibleCandidates" :key="drama.id" :class="['home-title-row', { picked: chosen.includes(drama.id) }]">
            <label class="home-title-choice"><input type="checkbox" :checked="chosen.includes(drama.id)" :disabled="automaticRestore || (!chosen.includes(drama.id) && chosen.length >= 100)" @change="toggle(drama)" /><img v-if="drama.status === 'published' && safeCover(drama.cover)" class="title-cover" :src="safeCover(drama.cover)" alt="" /><span><strong>{{ drama.title }}</strong><small>#{{ drama.id }} · {{ CONTENT_LANGUAGE_LABELS[audienceLanguage(drama) ?? ''] ?? '待确认语言' }} · {{ drama.status === 'published' ? '已上架' : '未上架' }}</small><small v-if="audienceLanguage(drama) !== locale">{{ fallback === 'original' ? '放在其他语言推荐区，不混进本语言栏目' : '语言不匹配，当前不会对观众展示' }}</small></span></label>
            <PositionSelect v-if="!automaticRestore && sort === 'manual' && chosen.includes(drama.id)" :label="`首页作品 ${drama.title} 的位置`" :index="chosen.indexOf(drama.id)" :total="chosen.length" @move="move(chosen.indexOf(drama.id), $event)" />
            <small v-else-if="chosen.includes(drama.id)" class="ranking-value">{{ metricFor(drama) }}</small>
          </article>
        </div>
        <div v-if="!visibleCandidates.length" class="empty-state compact"><h3>{{ search ? '没有找到这部作品' : '这个语言还没有可选作品' }}</h3><p>{{ search ? '试试原剧名或其他关键词。' : '先在剧目管理中补充该语言成片；不会把英语视频改个标签充当其他语言。' }}</p></div>
        <p v-if="!chosen.length && !automaticRestore" class="notice warning">当前未选择作品。保存后，这个语言首页将为空。</p>
        <p v-if="chosen.length > 100 && !automaticRestore" class="notice warning">自动片单超过100部。手动编排最多保留100部，请先取消不需要的作品，或继续使用自动选片。</p>
        <div class="form-actions"><button type="button" class="button" @click="pane = 'sections'">下一步：安排栏目</button></div>
      </div>
      <div v-show="pane === 'sections'" id="home-sections-panel" role="tabpanel" aria-labelledby="home-sections-tab">
        <HomeSectionEditor v-if="!automaticRestore" :key="sectionsKey" v-model="sections" :sort="sort" :dramas="selectedDramas.filter(drama => audienceLanguage(drama) === locale)" @invalid="sectionsInvalid = $event" />
        <p v-else class="muted">自动选片不使用手动栏目；可在预览中核对当前可展示作品。</p>
        <div class="form-actions"><button type="button" class="button" @click="pane = 'preview'">下一步：核对预览</button></div>
      </div>
      <div v-show="pane === 'preview'" id="home-preview-panel" role="tabpanel" aria-labelledby="home-preview-tab">
        <div class="section-heading"><div><h3>保存后会怎样展示？</h3><p class="muted">这是当前编排草稿的结构预览，不会写入线上；只列出服务器确认当前可展示的作品。</p></div><button class="button" type="button" @click="readPublic(); readMetrics()">重新核对展示条件</button></div>
        <p v-if="!currentService" class="notice warning">当前编排的地区不是此服务器服务的地区。本页不冒充该地区的实际观众结果，请在对应服务核对。</p>
        <p v-else-if="!publicReady" class="notice warning">当前展示条件未核实：{{ publicError || '正在读取' }}。暂不生成可能误导的观众预览。</p>
        <template v-else>
          <p class="muted">{{ automaticRestore ? '自动选片' : `已选 ${chosen.length} 部` }}，当前本语言可展示 {{ previewDramas.length }} 部{{ otherLanguageDramas.length ? `，其他语言推荐 ${otherLanguageDramas.length} 部` : '' }}。</p>
          <h4 class="preview-label">片单顺序</h4>
          <ol class="preview-order"><li v-for="drama in previewDramas" :key="drama.id" data-testid="home-preview-item" :data-drama-id="drama.id"><img v-if="safeCover(drama.cover)" :src="safeCover(drama.cover)" alt="" /><span>{{ drama.title }}<small>{{ drama.totalEpisodes }} 集 · 前 {{ drama.freeEpisodes }} 集免费</small></span></li></ol>
          <p v-if="!previewDramas.length" class="notice">当前没有符合展示条件的本语言作品。保存编排不会跳过草稿、发行权或平台审核条件。</p>
          <section v-for="section in previewSections" :key="section.id" class="preview-section"><h4>{{ section.title || '未命名栏目' }}</h4><ol><li v-for="drama in section.dramas" :key="drama.id">{{ drama.title }}</li></ol><p v-if="!section.dramas.length" class="muted">这个栏目目前没有可展示作品。</p></section>
          <section v-if="otherLanguageDramas.length" class="preview-section"><h4>其他语言推荐</h4><p v-for="drama in otherLanguageDramas" :key="drama.id">{{ drama.title }} · {{ CONTENT_LANGUAGE_LABELS[audienceLanguage(drama) ?? ''] }}</p></section>
          <div v-if="unavailableDramas.length" class="preview-excluded"><h4>已选择，但暂不展示</h4><p v-for="drama in unavailableDramas" :key="drama.id">{{ drama.title }} · 暂不展示：{{ audienceLanguage(drama) !== locale && fallback === 'strict' ? '语言不匹配' : drama.status !== 'published' ? '尚未上架' : '当前服务的发行或平台条件未满足' }}</p></div>
        </template>
        <a class="button" :href="viewerHref" target="_blank" rel="noreferrer">打开已保存的观众首页</a><p class="muted small-text">新标签显示服务器已保存内容，不是本页未保存预览；观众实际语言由其自己的设置决定。</p>
      </div>
      <details class="home-more"><summary>更多首页设置</summary>
        <label class="field"><span>其他语言作品</span><select v-model="fallback" aria-label="其他语言作品" :disabled="automaticRestore"><option value="strict">不展示：只显示本频道语言的成片</option><option value="original">展示：我勾选的其他语言作品放入独立推荐区</option></select><small>启用后可在“首页作品”里选择其他语言作品，不会改变视频原声或字幕。</small></label>
        <button v-if="value?.configured && !automaticRestore" type="button" class="button" :disabled="needsReview" @click="confirm('reset')">恢复自动选片</button><p class="muted small-text">恢复后取消这套手动片单和栏目，改为自动展示符合条件的本语言作品。操作前会再次确认。</p>
      </details>
      <details class="metrics-table"><summary>最近7天运营指标 · {{ metricScope || '读取中' }}</summary>
        <p class="muted" data-testid="channel-metrics-scope">只看 {{ region }}/{{ locale }} 内容频道；不把界面语言或原声音轨当频道，未记录频道语言的旧数据不混入。</p><p class="muted">{{ metricDefinition }}</p>
        <Feedback :error="metricsError" /><button type="button" class="button small" @click="readMetrics">刷新运营指标</button>
        <p v-if="metricState === 'loading'" class="muted">正在读取本频道统计……</p><p v-else-if="metricState === 'unavailable'" class="notice">本频道统计暂不可用；不拿地区总数代替，也不影响已保存的主页和观看权限。</p>
        <template v-else><p v-if="metricState === 'empty'" class="muted">本频道暂无可归属的记录；不等于其他语言没有观看或成交。</p><div class="table-scroll" tabindex="0" data-testid="channel-metrics-table"><table><thead><tr><th>剧目</th><th>曝光访问</th><th>播放次数</th><th>播放率</th><th>付费率</th><th>登录观看／买家</th></tr></thead><tbody><tr v-for="drama in candidates" :key="drama.id"><td>{{ drama.title }} #{{ drama.id }}</td><td>{{ metrics[drama.id]?.impressions ?? '暂无记录' }}</td><td>{{ metrics[drama.id]?.plays ?? '暂无记录' }}</td><td>{{ rate(metrics[drama.id]?.playRate) }}</td><td>{{ rate(metrics[drama.id]?.paidRate) }}</td><td>{{ metrics[drama.id]?.viewers ?? '—' }} / {{ metrics[drama.id]?.buyers ?? '—' }}</td></tr></tbody></table></div></template>
      </details>
      <AnalyticsOperationsPanel v-if="value" :channel="value" :dramas="dramas" :disabled="saving || dirty || needsReview" @apply="applyCandidate" />
      <OperationNote v-if="value" v-model="operationNote" :has-evidence="!!writeEvidence" :disabled="saving || rechecking || needsReview" />
      <OperationsHistory v-if="value" kind="catalog" :target-key="`${region}/${locale}`" :version="value.version"
        :restore-blocked="saving || rechecking || needsReview ? '先完成保存或核对服务器版本，再载入历史草稿。' : ''" @restore="restoreDraft" />
    </fieldset>

    <dialog ref="dialog" class="confirm-dialog" :aria-label="confirmation === 'overwrite' ? '确认覆盖主页' : '恢复自动选片'" @cancel="confirmation = null">
      <h2>{{ confirmation === 'overwrite' ? '用本页编排覆盖已核对版本？' : '恢复自动选片？' }}</h2><p>{{ confirmation === 'overwrite' ? '服务器中的片单和栏目会被本页输入替换。保存仍检查版本；期间若再被修改，将拒绝覆盖。' : '将取消这个语言的手动片单和栏目，改为展示符合条件的本语言作品。不会删除任何剧目或视频，也不会修改其他语言首页。' }}</p>
      <div class="form-actions wrap"><button type="button" class="button" autofocus @click="dialog?.close(); confirmation = null">取消</button><button type="button" class="button danger" @click="confirmed">{{ confirmation === 'overwrite' ? '确认覆盖此版本' : '确认恢复自动选片' }}</button></div>
    </dialog>
  </section>
</template>

<style scoped>
.channel-editor { padding: 0; }
.channel-heading { position: sticky; top: 0; z-index: 5; background: var(--panel); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; padding: 18px 22px; border-radius: 10px 10px 0 0; border-bottom: 1px solid var(--line); }
.channel-heading h2 { font-size: 1.125rem; }.channel-heading p { margin-top: 3px; }
fieldset { border: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; min-width: 0; padding: 0 22px 22px; }
.channel-editor > :deep(.notice), .channel-editor > :deep(.loading) { margin: 12px 22px; }
.home-sort { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 0; }
.home-sort .field { margin: 0; display: flex; flex-direction: row; align-items: center; gap: 12px; }
.home-sort .field > span { font-size: .875rem; color: var(--muted); white-space: nowrap; }.home-sort select { width: 228px; min-width: 0; }
.sort-help { position: relative; font-size: .875rem; color: var(--muted); margin-left: auto; }
.sort-help > div { position: absolute; z-index: 6; right: 0; top: 46px; width: 340px; max-width: calc(100vw - 60px); border: 1px solid var(--line); border-radius: 9px; box-shadow: 0 12px 40px #0002; padding: 18px; background: var(--panel); }.sort-help p + p { margin-top: 10px; }
.home-tabs { display: flex; gap: 26px; padding-top: 6px; border-bottom: 1px solid var(--line); }
.home-tabs button { border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); padding: 10px 0; min-height: 44px; font-size: 1rem; }
.home-tabs button[aria-selected="true"] { color: var(--accent); border-color: var(--action); font-weight: 650; }
.title-tools { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }.title-tools .field { margin: 0; flex: 1; }.title-tools > span { white-space: nowrap; }
.automatic-note { font-size: .875rem; color: var(--muted); margin-bottom: 12px; }
.home-title-list { display: grid; border-top: 1px solid var(--line); }
.home-title-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 12px 8px; border-bottom: 1px solid var(--line); }
.home-title-row.picked { background: var(--surface-subtle); }
.home-title-choice { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; cursor: pointer; min-height: 48px; }
.home-title-choice strong, .home-title-choice small { display: block; overflow-wrap: anywhere; }.home-title-choice small { margin-top: 4px; }
.title-cover { width: 38px; height: 50px; object-fit: cover; border-radius: 4px; }
.ranking-value { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.home-more, .metrics-table { min-width: 0; border-top: 1px solid var(--line); padding-top: 4px; }
.home-more summary, .metrics-table summary { color: var(--muted); font-size: .875rem; cursor: pointer; min-height: 44px; }
.home-more[open] > summary, .metrics-table[open] > summary { margin-bottom: 12px; }
.channel-save { display: flex; justify-content: flex-end; align-items: center; gap: 10px; flex-wrap: wrap; }
.save-state { color: var(--muted); font-size: .875rem; font-weight: 400; }.save-state.unsaved { color: var(--warning); }
.preview-label { margin: 16px 0 10px; }.preview-order { padding-left: 24px; }.preview-order li { padding: 10px 0; }.preview-order img { width: 40px; height: 54px; object-fit: cover; vertical-align: middle; margin-right: 14px; border-radius: 4px; }.preview-order span { display: inline-block; vertical-align: middle; }.preview-order small { display: block; }
.preview-section { border: 1px solid var(--line); border-radius: 9px; padding: 18px; margin: 14px 0; }.preview-section ol { padding-left: 24px; }.preview-section li { margin: 8px 0; }
.preview-excluded { background: var(--warning-soft); color: var(--warning); padding: 18px; border-radius: 9px; margin: 18px 0; }.preview-excluded p { font-size: .875rem; margin-top: 10px; }
.recovery-panel { display: grid; gap: 14px; border: 1px solid var(--control-border); padding: 18px; border-radius: 9px; margin: 16px 22px; }.recovery-panel > button { justify-self: start; }
@media(max-width:800px) { .channel-heading { padding: 16px; } fieldset { padding: 0 16px 18px; }.home-sort { gap: 6px; }.home-sort .field { width: 100%; }.home-sort select { width: auto; flex: 1; }.sort-help { margin-left: 0; }.sort-help > div { position: static; max-width: 100%; width: auto; box-shadow: none; }.home-tabs { gap: 14px; justify-content: space-between; }.home-title-row { flex-wrap: wrap; gap: 8px; padding: 12px 8px; }.home-title-choice { flex-basis: 100%; }.home-title-row :deep(.position-control) { margin-left: auto; }.title-tools > span { display: none; }.channel-save { gap: 8px; }.channel-save .save-state { display: none; } }
</style>
