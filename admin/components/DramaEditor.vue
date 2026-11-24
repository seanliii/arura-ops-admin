<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { Asset, Drama } from '../../shared/contracts'
import { api, ApiError, dramaStatus, message, safeCover } from '../api'
import Feedback from './Feedback.vue'
import FileUpload from './FileUpload.vue'
import EpisodeEditor from './EpisodeEditor.vue'
import PlatformMediaPanel from './PlatformMediaPanel.vue'
import RegistrationMetadataEditor from './RegistrationMetadataEditor.vue'
import DramaLocalizationEditor from './DramaLocalizationEditor.vue'
import DramaEditionsPanel from './DramaEditionsPanel.vue'
import { OPERATOR_LANGUAGE_LABELS as CONTENT_LANGUAGE_LABELS } from '../../shared/catalog-channel'
import { DRAMA_TEXT_LOCALES } from '../../shared/drama-localizations'
import ContentDeliveryEditor from './ContentDeliveryEditor.vue'
import { useDraftNavigationGuard } from '../draft-navigation'
import { LAUNCH_MARKETS, MARKET_LABELS } from '../../shared/launch-markets'
import MediaDeliveryPanel from './MediaDeliveryPanel.vue'
import ContentReadinessPanel from './ContentReadinessPanel.vue'
import type { ReadinessIssue } from '../../shared/content-operations'
import type { AnalysisEvidence } from '../operations-context'
import { newOperationNote, noteChanged, saveOperationContext, type OperationRestore } from '../operations-history'
import OperationNote from './OperationNote.vue'
import OperationsHistory from './OperationsHistory.vue'

const props = defineProps<{ drama: Drama | null; initialLanguage?: string; initialRegion?: string; initialStep?: 'basic' | 'episodes' | 'publish'; analysis?: AnalysisEvidence | null }>()
const emit = defineEmits<{ saved: [drama: Drama]; close: []; media: [id: number]; 'context-consumed': [] }>()
const step = ref<'basic' | 'episodes' | 'publish'>(props.initialStep ?? 'basic')
const editorHeading = ref<HTMLElement>()
const editorRoot = ref<HTMLElement>()
const manualPlatformOpened = ref(false)
const rulesOpen = ref(false), metadataOpen = ref(false)
const form = reactive({
  title: '', desc: '', category: '未分类', tags: '', freeEpisodes: 0, language: '',
  episodePrice: 0, bundlePrice: 0, rightsConfirmed: false, isSample: false, regionText: 'JP',
})
const snapshot = ref('')
const cover = ref<Asset | null>(null)
// undefined 表示不改；null 表示明确清除。历史资产不伪装为一次新上传。
const historicalCover = ref<string | null | undefined>(undefined)
const operationNote = ref(newOperationNote()), restoredFrom = ref('')
const writeEvidence = ref(props.analysis ?? null)
const busy = ref(false)
const fileBusy = ref(false)
const editionBusy = ref(false)
const episodeBusy = ref(false), episodeDirty = ref(false)
const deliveryBusy = ref(false), deliveryDirty = ref(false)
const mediaBusy = ref(false)
const metadataBusy = ref(false)
const metadataDirty = ref(false)
const localizationBusy = ref(false)
const localizationDirty = ref(false)
const localizationLocked = computed(() => localizationBusy.value || localizationDirty.value || deliveryBusy.value || deliveryDirty.value || editionBusy.value)
const platformDirty = ref(false)
const platformEditorKey = ref(0)
const error = ref('')
const success = ref('')
const conflict = ref(false)
const dirty = computed(() => JSON.stringify(form) !== snapshot.value || !!cover.value ||
  historicalCover.value !== undefined || !!restoredFrom.value || noteChanged(operationNote.value))
const published = computed(() => props.drama?.status === 'published')
const regions = computed(() => [...new Set(form.regionText.split(/[,，\s]+/).filter(Boolean).map(value => value.toUpperCase()))])
const selectedRegions = computed({
  get: () => regions.value,
  set: (value: string[]) => { form.regionText = value.join(', ') },
})
const regionChoices = computed(() => [...new Set([...LAUNCH_MARKETS, ...(props.drama?.regions ?? [])])])
const stepBusy = computed(() => busy.value || fileBusy.value || mediaBusy.value || metadataBusy.value || localizationBusy.value || deliveryBusy.value || editionBusy.value || episodeBusy.value)
const restoreBlocked = computed(() => stepBusy.value ? '当前操作仍在处理，请稍后载入。' :
  published.value ? '已发布作品不可直接回退，请先在原入口核对状态。' :
  episodeDirty.value || metadataDirty.value || localizationLocked.value || platformDirty.value
    ? '先保存或放弃单集、成片、发行、多语或平台表单的修改，再载入历史草稿。' : '')
function clearOperation() {
  operationNote.value = newOperationNote(); restoredFrom.value = ''; writeEvidence.value = null
  emit('context-consumed')
}
async function selectStep(value: typeof step.value) {
  if (stepBusy.value || (!props.drama && value !== 'basic')) return
  step.value = value
  await nextTick()
  editorHeading.value?.focus({ preventScroll: true })
  window.scrollTo({ top: 0 })
}
async function locateIssue(issue: ReadinessIssue) {
  if (stepBusy.value) return
  if (['rightsConfirmed', 'freeEpisodes', 'regions'].includes(issue.field)) rulesOpen.value = true
  if (issue.field === 'registration') metadataOpen.value = true
  await selectStep(issue.step)
  await nextTick()
  const target = editorRoot.value?.querySelector<HTMLElement>(`[data-readiness-field="${issue.field.replace(/[^a-zA-Z]/g, '')}"]`)
  target?.closest('details')?.setAttribute('open', '')
  target?.scrollIntoView({ block: 'center' }); target?.focus({ preventScroll: true })
}
useDraftNavigationGuard(
  () => dirty.value || metadataDirty.value || localizationDirty.value || deliveryDirty.value || platformDirty.value || episodeDirty.value,
  () => stepBusy.value,
)
function adoptForm(drama: Drama | null) {
  Object.assign(form, {
    title: drama?.title ?? '', desc: drama?.desc ?? '', category: drama?.category ?? '未分类',
    language: drama?.language ?? props.initialLanguage ?? '',
    regionText: drama ? drama.regions.join(', ') : props.initialRegion || 'JP',
    tags: drama?.tags.join(', ') ?? '', freeEpisodes: drama?.freeEpisodes ?? 0,
    episodePrice: drama?.episodePrice ?? 0, bundlePrice: drama?.bundlePrice ?? 0,
    rightsConfirmed: drama?.rightsConfirmed ?? false, isSample: drama?.isSample ?? false,
  })
  snapshot.value = JSON.stringify(form)
  cover.value = null; historicalCover.value = undefined
}
watch(() => props.drama, (drama, previous) => {
  if (previous && drama && previous.id === drama.id && dirty.value) return
  adoptForm(drama)
  if (previous) clearOperation()
}, { immediate: true })
async function restoreDraft(proposal: OperationRestore) {
  if (!props.drama || restoreBlocked.value) return
  if (proposal.kind !== 'drama' || proposal.key !== String(props.drama.id) || proposal.currentVersion !== props.drama.version) {
    error.value = '当前作品版本已变化，请先重新加载服务器版本，再载入历史草稿。'; conflict.value = true; return
  }
  if (dirty.value && !window.confirm('载入历史将替换本页未保存的基本资料和备注，是否继续？其他业务不会被写入。')) return
  adoptForm(props.drama); clearOperation()
  const draft = proposal.draft
  for (const field of ['title', 'desc', 'category'] as const) if (typeof draft[field] === 'string') form[field] = draft[field]
  if (Array.isArray(draft.tags)) form.tags = draft.tags.join(', ')
  if (Object.hasOwn(draft, 'coverAssetId')) historicalCover.value = draft.coverAssetId
  restoredFrom.value = proposal.id
  error.value = ''; conflict.value = false
  success.value = '已载入改前草稿，尚未保存。核对后按“保存剧目”，届时会重新检查当前条件。'
  await selectStep('basic')
}
function close() {
  if (stepBusy.value) return
  if (deliveryBusy.value) return
  if ((dirty.value || metadataDirty.value || localizationDirty.value || deliveryDirty.value || platformDirty.value || episodeDirty.value) && !window.confirm('有尚未保存的修改（包括单集、成片资料、发行资料、多语文案和平台表单），确定返回列表吗？上传成功的文件仍保留在资产列表。')) return
  emit('close')
}
function markPlatformDirty(event: Event) {
  // 平台组件只报告 busy；在接入处观察真实表单编辑，不修改其内部状态或接口。
  if (event.target instanceof Element && event.target.matches('input, select, textarea')) platformDirty.value = true
}
function resetPlatformDraft() {
  if (stepBusy.value || episodeDirty.value || localizationLocked.value) return
  if (!window.confirm('放弃尚未执行的平台表单修改，并重新读取本地记录？不会请求外部平台。')) return
  platformDirty.value = false
  platformEditorKey.value++
}
async function save() {
  if (busy.value || fileBusy.value || mediaBusy.value || metadataBusy.value || localizationLocked.value) return
  busy.value = true; error.value = ''; success.value = ''; conflict.value = false
  try {
    const { language, regionText, ...details } = form
    const nextRegions = [...new Set(regionText.split(/[,，\s]+/).filter(Boolean).map(v => v.toUpperCase()))].sort()
    if ((!props.drama && !nextRegions.length) || nextRegions.some(v => !/^[A-Z]{2}$/.test(v))) throw new Error('请选择有效的发行地区；不确定时可保留当前服务地区')
    const body = {
      ...details, title: form.title.trim(), category: form.category.trim(),
      tags: form.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
      // PATCH 只在主动改选时更新音轨或地区；旧草稿的空值不自动补成某个市场。
      ...(!props.drama || language !== props.drama.language ? { language } : {}),
      ...(!props.drama || JSON.stringify(nextRegions) !== JSON.stringify([...props.drama.regions].sort()) ? { regions: nextRegions } : {}),
      ...(props.drama ? { version: props.drama.version } : {}),
      ...(cover.value ? { coverAssetId: cover.value.id } : historicalCover.value !== undefined ? { coverAssetId: historicalCover.value } : {}),
      ...(props.drama ? { operationContext: saveOperationContext(operationNote.value, writeEvidence.value, restoredFrom.value) } : {}),
    }
    const result = await api<{ drama: Drama }>(
      props.drama ? `/admin/dramas/${props.drama.id}` : '/admin/dramas',
      { method: props.drama ? 'PATCH' : 'POST', body },
    )
    snapshot.value = JSON.stringify(form); cover.value = null; historicalCover.value = undefined; clearOperation()
    emit('saved', result.drama)
    success.value = '资料已保存。草稿不会自动上架，也不会开启收费。'
  } catch (cause) {
    error.value = message(cause)
    conflict.value = cause instanceof ApiError && cause.status === 409
  } finally { busy.value = false }
}
async function refresh(confirmDiscard = false) {
  if (!props.drama || busy.value || metadataBusy.value || localizationLocked.value || episodeBusy.value || episodeDirty.value) return
  if (dirty.value && !confirmDiscard) return
  if (confirmDiscard && dirty.value && !window.confirm('重新读取将放弃尚未保存的表单修改，是否继续？')) return
  busy.value = true; error.value = ''
  try {
    const result = await api<{ drama: Drama }>(`/admin/dramas/${props.drama.id}`)
    if (confirmDiscard) { snapshot.value = JSON.stringify(form); cover.value = null; historicalCover.value = undefined; clearOperation() }
    emit('saved', result.drama)
    conflict.value = false
  } catch (cause) { error.value = message(cause) }
  finally { busy.value = false }
}
async function publish(action: 'publish' | 'unpublish') {
  if (!props.drama || stepBusy.value || episodeDirty.value || metadataDirty.value || localizationLocked.value) return
  const text = action === 'publish'
    ? '确认发布到本应用片库？服务器将检查封面、视频、连续集数与版权。这不是提交 TikTok 审核。'
    : '确认下架？下架会立即影响本应用片库和播放授权，不会操作外部平台。'
  if (!window.confirm(text)) return
  busy.value = true; error.value = ''; success.value = ''; conflict.value = false
  try {
    const result = await api<{ drama: Drama }>(`/admin/dramas/${props.drama.id}/${action}`, {
      method: 'POST', body: { version: props.drama.version },
    })
    emit('saved', result.drama)
    success.value = action === 'publish' ? '已发布到本应用片库；未提交外部平台审核。' : '已下架，片库与播放授权以服务器状态为准。'
  } catch (cause) {
    error.value = message(cause)
    conflict.value = cause instanceof ApiError && cause.status === 409
  } finally { busy.value = false }
}
</script>

<template>
  <section ref="editorRoot" class="editor" aria-label="剧目编辑" @keydown.esc="close">
    <div class="section-heading">
      <div><button class="back-link" :disabled="stepBusy" @click="close">← 返回剧目列表</button><h2 ref="editorHeading" tabindex="-1">{{ drama ? drama.title : '新建剧目' }}</h2></div>
      <span v-if="drama" class="badge">{{ dramaStatus[drama.status] }}</span>
    </div>
    <div class="editor-steps" role="tablist" aria-label="剧目操作步骤">
      <button id="drama-basic-tab" type="button" role="tab" aria-label="1 基本资料" :aria-selected="step === 'basic'" aria-controls="drama-basic-panel" :disabled="stepBusy" @click="selectStep('basic')"><strong>1</strong><span>基本资料</span></button>
      <button id="drama-episodes-tab" type="button" role="tab" aria-label="2 视频与字幕" :aria-selected="step === 'episodes'" aria-controls="drama-episodes-panel" :disabled="!drama || stepBusy" @click="selectStep('episodes')"><strong>2</strong><span>视频与字幕</span></button>
      <button id="drama-publish-tab" type="button" role="tab" aria-label="3 上架与收费" :aria-selected="step === 'publish'" aria-controls="drama-publish-panel" :disabled="!drama || stepBusy" @click="selectStep('publish')"><strong>3</strong><span>审核与上架</span></button>
    </div>
    <Feedback :error="error" :success="success" />
    <button v-if="conflict" class="button" :disabled="busy || localizationLocked" @click="refresh(true)">重新加载服务器版本</button>
    <p v-if="published" class="notice warning">已发布内容不可编辑，请先下架。服务端仍会检查发布状态与版本。</p>
    <p v-else-if="dirty && drama" class="notice">有未保存的修改。请先保存，再发布或管理单集。</p>
    <p v-if="episodeDirty && step !== 'episodes'" class="notice">有未保存的单集修改。可以查看其他步骤，保存其他资料前请回到“视频与字幕”处理该单集。</p>
    <ContentReadinessPanel v-if="drama && step === 'publish'" :drama-id="drama.id" :version="drama.version"
      :disabled="stepBusy" @locate="locateIssue" @media="emit('media', drama!.id)" />
    <form v-show="step !== 'episodes'" class="panel" @submit.prevent="save" :aria-busy="busy">
      <div v-show="step === 'basic'" id="drama-basic-panel" role="tabpanel" aria-labelledby="drama-basic-tab">
      <div class="section-heading"><div><h3>{{ drama ? '基础信息' : '先建一个草稿' }}</h3><p v-if="!drama" class="muted">先填剧名和视频里的说话语言，就能保存。封面、介绍和收费都可以稍后设置。</p></div></div>
      <fieldset :disabled="stepBusy || episodeDirty || localizationLocked || published" class="form-grid">
        <label class="field"><span>剧目标题 <small>必填</small></span><input v-model="form.title" aria-label="剧目标题" required maxlength="200" placeholder="例如：收留我的危险男孩" /></label>
        <label class="field">
          <span>视频原声语言 <small>必填</small></span>
          <select v-model="form.language" data-readiness-field="language" aria-label="内容语言" :required="!drama">
            <option v-if="!drama" value="" disabled>请选择实际内容语言</option>
            <option v-if="drama && !DRAMA_TEXT_LOCALES.some(code => code === drama?.language)" :value="drama.language">
              {{ drama.language === 'und' ? '未确定 und（保留原值）' : drama.language ? `其他语言 ${drama.language}（保留原值）` : '未填写（保留原值）' }}
            </option>
            <option v-for="code in DRAMA_TEXT_LOCALES" :key="code" :value="code">{{ CONTENT_LANGUAGE_LABELS[code] }}</option>
          </select>
          <small>按实际说话语言选；如果观众看的是另一种语言字幕，在第2步设置。</small>
        </label>
      </fieldset>
      <details class="optional-fields" :open="!!drama">
        <summary>介绍、封面与分类（可后补）</summary>
      <fieldset :disabled="stepBusy || episodeDirty || localizationLocked || published" class="form-grid">
        <label class="field span-2"><span>剧目简介 <small>可后补</small></span><textarea v-model="form.desc" aria-label="剧目简介" rows="3" maxlength="5000" placeholder="用几句话告诉观众这部剧讲什么"></textarea></label>
        <details class="span-2 optional-fields"><summary>分类与标签（可选）</summary><div class="form-grid">
          <label class="field"><span>分类</span><input v-model="form.category" aria-label="分类" maxlength="80" list="drama-categories" /><datalist id="drama-categories"><option>爱情</option><option>奇幻</option><option>悬疑</option><option>喜剧</option><option>家庭</option></datalist></label>
          <label class="field"><span>标签（逗号分隔）</span><input v-model="form.tags" placeholder="青春, 爱情" maxlength="500" /></label>
        </div></details>
      </fieldset>
      <div class="cover-editor" data-readiness-field="cover" tabindex="-1">
        <img v-if="published && drama && safeCover(drama.cover)" :src="safeCover(drama.cover)" alt="剧目封面预览" />
        <div class="grow"><FileUpload kind="cover" label="选择剧目封面" :disabled="busy || episodeBusy || episodeDirty || mediaBusy || metadataBusy || localizationLocked || published" @uploaded="cover = $event; historicalCover = undefined" @busy="fileBusy = $event" /><p class="muted small-text">支持 JPG / PNG / WebP。文件上传后需保存剧目；服务器检查实际格式和大小。</p></div>
      </div>
      <p v-if="historicalCover !== undefined" class="notice" data-testid="historical-cover-draft">{{ historicalCover === null ? '将清除封面（尚未保存）' : '已载入历史封面（尚未保存）' }}；仍需保存，服务器会核对原资产。</p>
      <p v-if="drama?.cover && !published" class="muted small-text">已保存封面。草稿图片不会公开给观众。</p>
      </details>
      </div>
      <div v-show="step === 'publish'" id="drama-publish-panel" role="tabpanel" aria-labelledby="drama-publish-tab">
        <details class="optional-fields" :open="rulesOpen" @toggle="rulesOpen = ($event.target as HTMLDetailsElement).open">
        <summary>观看规则与发行范围</summary>
        <h3>确认观看规则和发行范围</h3>
        <p class="muted">这里的修改只保存到草稿，不会自动收费或发布。已有价格保持原值。</p>
        <fieldset class="form-grid" :disabled="stepBusy || episodeDirty || localizationLocked || published">
          <label class="field"><span>免费集数</span><input v-model.number="form.freeEpisodes" data-readiness-field="freeEpisodes" type="number" min="0" step="1" /><small>按集号计算：填10就是前10集免费，不是看10次。</small></label>
          <label class="field"><span>单集价格</span><input v-model.number="form.episodePrice" type="number" min="0" step="1" /><small>需要收费时再设置；保存金额不会自动启用真钱支付。</small></label>
          <label class="field"><span>整剧价格</span><input v-model.number="form.bundlePrice" type="number" min="0" step="1" /><small>真实交易价格仍以平台实际返回为准。</small></label>
          <details class="span-2 optional-fields"><summary data-readiness-field="regions">发行地区 · {{ regions.map(code => MARKET_LABELS[code] || code).join('、') || '未设置' }}</summary>
            <p class="muted">只勾选有发行权的地区。语言可跨地区使用；勾选不会开通TikTok市场。</p>
            <div class="region-options"><label v-for="code in regionChoices" :key="code" class="checkbox"><input v-model="selectedRegions" type="checkbox" :value="code" />{{ MARKET_LABELS[code] || code }}</label></div>
            <span class="muted small-text" data-testid="drama-regions">{{ regions.join(', ') || '未设置' }}</span>
          </details>
          <label class="checkbox span-2"><input v-model="form.rightsConfirmed" data-readiness-field="rightsConfirmed" type="checkbox" /><span>已确认作品、封面、视频与字幕具有合法使用权<br /><small>云上传和上架前需要确认；创建草稿时不必勾选。</small></span></label>
          <details class="span-2 optional-fields"><summary>测试内容标记（仅测试时使用）</summary><label class="checkbox"><input v-model="form.isSample" type="checkbox" /><span>标记为样例内容（仍需满足发布校验）</span></label></details>
        </fieldset>
        </details>
      </div>
      <OperationNote v-if="drama && (step === 'basic' || rulesOpen)" v-model="operationNote"
        :has-evidence="!!writeEvidence" :disabled="stepBusy || episodeDirty || metadataDirty || localizationLocked || published" />
      <div v-show="step === 'basic' || rulesOpen" class="form-actions wrap"><button class="button primary" type="submit" :disabled="stepBusy || episodeDirty || localizationLocked || published">{{ busy ? '保存中…' : drama ? '保存剧目' : '保存草稿并继续' }}</button><button v-if="drama && step === 'basic'" type="button" class="button" :disabled="stepBusy" @click="selectStep('episodes')">下一步：视频与字幕</button><span class="muted small-text">{{ dirty && drama ? '有未保存的修改' : '保存不会自动上架' }}</span></div>
    </form>
    <OperationsHistory v-if="drama" :kind="'drama'" :target-key="String(drama.id)" :version="drama.version"
      :restore-blocked="restoreBlocked" @restore="restoreDraft" />
    <div v-show="step === 'episodes'" id="drama-episodes-panel" role="tabpanel" aria-labelledby="drama-episodes-tab">
    <section v-if="drama" class="panel" data-readiness-field="episodes" tabindex="-1">
      <div class="section-heading"><div><h3>单集与字幕</h3><p class="muted">{{ drama.totalEpisodes ? `已保存 ${drama.totalEpisodes} 集。核对顺序后，再准备上架。` : '草稿已建立。接下来添加视频，文件会按名称中的数字排列。' }}</p></div><button class="button primary" :disabled="stepBusy || episodeDirty || metadataDirty || dirty || localizationLocked || published" @click="emit('media', drama.id)">上传多集视频</button></div>
      <EpisodeEditor :drama="drama" :disabled="busy || dirty || fileBusy || mediaBusy || metadataBusy || metadataDirty || localizationLocked || published" @busy="episodeBusy = $event" @dirty="episodeDirty = $event" @changed="refresh()" @saved="emit('saved', $event)" />
    </section>
    <ContentDeliveryEditor v-if="drama" :drama="drama"
      :disabled="stepBusy || episodeDirty || dirty || metadataDirty || localizationDirty || platformDirty"
      @saved="emit('saved', $event)" @busy="deliveryBusy = $event" @dirty="deliveryDirty = $event" />
    <button v-if="drama" type="button" class="button" :disabled="stepBusy" @click="selectStep('publish')">下一步：上架与收费</button>
    </div>
    <div v-show="step === 'basic'">
    <details v-if="drama" class="panel optional-fields"><summary>其他语言介绍（可选，不是必填）</summary>
    <DramaLocalizationEditor :drama="drama"
      :disabled="stepBusy || episodeDirty || dirty || metadataDirty || deliveryDirty || platformDirty"
      @saved="emit('saved', $event)" @busy="localizationBusy = $event" @dirty="localizationDirty = $event" />
    </details>
    <details v-if="drama" class="panel optional-fields"><summary>同一作品的其他配音或字幕版本（可选）</summary>
    <DramaEditionsPanel :drama="drama"
      :disabled="stepBusy || episodeDirty || dirty || metadataDirty || localizationLocked || platformDirty"
      @open="emit('saved', $event)" @busy="editionBusy = $event" />
    </details>
    </div>
    <div v-show="step === 'publish'">
    <details v-if="drama" class="panel optional-fields" :open="metadataOpen" @toggle="metadataOpen = ($event.target as HTMLDetailsElement).open">
    <summary data-readiness-field="registration">送审所需的发行资料</summary>
    <RegistrationMetadataEditor :drama="drama" :disabled="stepBusy || episodeDirty || dirty || localizationLocked"
      @saved="emit('saved', $event)" @busy="metadataBusy = $event" @dirty="metadataDirty = $event" />
    </details>
    <MediaDeliveryPanel v-if="drama" :drama-id="drama.id" :version="drama.version" :episode-count="drama.episodes.length"
      :disabled="stepBusy || episodeDirty || dirty || metadataDirty || localizationLocked"
      @changed="refresh()" @busy="mediaBusy = $event" />
    <section v-if="drama" class="panel">
      <h3>{{ published ? '当前已在本应用上架' : '上架给观众' }}</h3>
      <p class="muted">草稿保存和视频上传都不会自动上架。正式环境还需TikTok审核、授权和上架状态通过，服务器会再次检查。</p>
      <button v-if="published" class="button danger" :disabled="stepBusy || episodeDirty || localizationLocked" @click="publish('unpublish')">下架剧目</button>
      <button v-else class="button primary" :disabled="stepBusy || episodeDirty || metadataDirty || dirty || localizationLocked" @click="publish('publish')">发布到本应用</button>
    </section>
    <details v-if="drama" class="panel optional-fields" @toggle="manualPlatformOpened = manualPlatformOpened || ($event.target as HTMLDetailsElement).open" @input.capture="markPlatformDirty" @change.capture="markPlatformDirty">
      <summary>平台技术排查（正常上传与提审不需要）</summary>
      <p v-if="platformDirty" class="notice">
        平台表单已修改，多语编辑暂不可用，避免保存后刷新覆盖输入。
        <button type="button" class="button" data-testid="localization-reset-platform"
          :disabled="busy || fileBusy || mediaBusy || metadataBusy || localizationLocked" @click="resetPlatformDraft">放弃未执行的平台表单修改</button>
      </p>
      <PlatformMediaPanel v-if="manualPlatformOpened" :key="platformEditorKey" :drama="drama" :disabled="busy || episodeBusy || episodeDirty || dirty || fileBusy || metadataBusy || metadataDirty || localizationLocked" @busy="mediaBusy = $event" @changed="refresh()" />
    </details>
    </div>
  </section>
</template>
<style scoped>
.region-summary { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.editor-steps { display: flex; gap: 8px; margin: 4px 0 22px; }
.editor-steps button { display: flex; align-items: center; gap: 10px; flex: 1; padding: 12px 14px; min-height: 48px; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; color: var(--muted); }
.editor-steps button[aria-selected="true"] { color: var(--accent); border-color: var(--action); background: var(--accent-soft); }
.editor-steps strong { display: grid; place-items: center; border: 1px solid currentColor; border-radius: 50%; width: 24px; height: 24px; font-size: 0.875rem; flex-shrink: 0; }
.optional-fields > summary { cursor: pointer; font-size: 1rem; color: var(--muted); padding: 8px 0; }
.optional-fields[open] > summary { margin-bottom: 16px; }
.optional-fields > .panel { margin: 0; border: 0; padding: 12px 0 0; }
.region-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 18px; }
.field small { font-weight: 400; }
.readiness { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 14px 0; font-size: 1rem; }
.readiness .button { white-space: normal; text-align: left; }
@media(max-width:640px) { .editor-steps { gap: 5px; } .editor-steps button { padding: 10px 6px; justify-content: center; gap: 5px; font-size: 0.875rem; } .editor-steps strong { display: none; } .region-options { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
