<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Asset, Drama, Episode } from '../../shared/contracts'
import type { EpisodeTitleReceipt } from '../../shared/content-operations'
import type { TitleCsvPreview } from '../episode-title-csv'
import { api, ApiError, message } from '../api'
import FileUpload from './FileUpload.vue'
import Feedback from './Feedback.vue'
import EpisodeTitleImport from './EpisodeTitleImport.vue'
import { useDraftNavigationGuard } from '../draft-navigation'

const props = defineProps<{ drama: Drama; disabled: boolean }>()
const emit = defineEmits<{ changed: []; saved: [drama: Drama]; dirty: [value: boolean]; busy: [value: boolean] }>()
const episodes = computed(() => [...props.drama.episodes].sort((a, b) => a.seq - b.seq))
const selected = ref<Episode | null>(null)
const editing = ref(false)
const form = reactive({ seq: 1, title: '', durationSeconds: 0, assetId: '', subtitleAssetId: '' })
const assets = ref<Asset[]>([])
const videos = computed(() => assets.value.filter(asset => asset.kind === 'video'))
const subtitles = computed(() => assets.value.filter(asset => asset.kind === 'subtitle'))
const assetsLoading = ref(false)
const assetsError = ref('')
const controller = new AbortController()
const busy = ref(false)
const fileBusy = ref(false)
const error = ref('')
const success = ref('')
const snapshot = ref('')
type TitleChange = { episodeId: number; seq: number | null; oldTitle: string | null; title: string }
type TitleIntent = { requestId: string; version: number; confirmed: true; changes: { episodeId: number; title: string }[] }
const titleChanges = ref<TitleChange[]>([])
const batchVersion = ref(props.drama.version)
const batchPreview = ref(false), batchBusy = ref(false), batchConflict = ref(false), batchNotFound = ref(false)
const batchError = ref(''), batchResult = ref<EpisodeTitleReceipt>()
const batchIntent = ref<TitleIntent>()
const csvOpen = ref(false), csvDirty = ref(false), csvBusy = ref(false), csvStaged = ref(false)
const csvSkipped = ref(0)
const batchHeading = ref<HTMLElement>()
const singleDirty = computed(() => editing.value && JSON.stringify(form) !== snapshot.value)
const dirty = computed(() => singleDirty.value || titleChanges.value.length > 0 || !!batchIntent.value || csvDirty.value)
const batchLocked = computed(() => props.disabled || busy.value || fileBusy.value || csvBusy.value || batchBusy.value || !!batchIntent.value || editing.value)
const changeFor = (id: number) => titleChanges.value.find(row => row.episodeId === id)
function openCsv() {
  if (batchLocked.value || titleChanges.value.length) return
  csvOpen.value = true; csvStaged.value = false; csvSkipped.value = 0
  batchResult.value = undefined; batchError.value = ''; batchConflict.value = false
}
function closeCsv() {
  if (batchLocked.value) return
  if ((csvDirty.value || titleChanges.value.length) && !window.confirm('放弃这批未保存的CSV输入？已保存的标题和视频不受影响。')) return
  csvOpen.value = false; csvDirty.value = false; csvStaged.value = false
  titleChanges.value = []; batchPreview.value = false; batchConflict.value = false; batchError.value = ''
}
async function stageCsv(preview: TitleCsvPreview) {
  if (batchLocked.value || titleChanges.value.length || props.drama.status !== 'draft') return
  titleChanges.value = preview.rows.filter(r => r.code === 'ready').map(r => ({
    episodeId: r.episodeId!, seq: r.seq, oldTitle: r.oldTitle, title: r.title,
  }))
  batchVersion.value = preview.version; batchPreview.value = true; batchResult.value = undefined
  batchError.value = ''; batchConflict.value = false; csvStaged.value = true; csvDirty.value = false
  csvSkipped.value = preview.counts.invalid
  await nextTick()
  // CSV映射和原单集表同时收起后，不能依赖focus隐式滚动到新确认区。
  batchHeading.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
  batchHeading.value?.focus({ preventScroll: true })
}
function chooseTitle(episode: Episode, checked: boolean) {
  if (batchLocked.value || csvOpen.value || (checked && titleChanges.value.length >= 100)) return
  csvSkipped.value = 0
  if (!titleChanges.value.length) batchVersion.value = props.drama.version
  batchResult.value = undefined; batchError.value = ''; batchPreview.value = false
  if (checked) titleChanges.value.push({ episodeId: episode.id, seq: episode.seq, oldTitle: episode.title, title: episode.title })
  else titleChanges.value = titleChanges.value.filter(row => row.episodeId !== episode.id)
}
function changeTitle(id: number, title: string) {
  if (batchLocked.value) return
  const row = changeFor(id)
  if (row) row.title = title
  batchPreview.value = false
}
function discardTitles() {
  if (batchBusy.value || batchIntent.value) return
  if (titleChanges.value.length && !window.confirm('放弃这批未保存的标题修改？已保存的单集和视频不受影响。')) return
  titleChanges.value = []; batchPreview.value = false; batchConflict.value = false; batchError.value = ''
  csvStaged.value = false
}
async function acceptReceipt(receipt: EpisodeTitleReceipt) {
  batchResult.value = receipt; batchIntent.value = undefined; batchPreview.value = false
  titleChanges.value = []; batchVersion.value = receipt.afterVersion
  batchError.value = ''; batchBusy.value = false; batchNotFound.value = false
  await nextTick()
  emit('changed')
}
async function sendTitles(retryOriginal = false) {
  if (batchBusy.value || props.disabled || batchConflict.value) return
  if (!retryOriginal) {
    if (!batchPreview.value || !titleChanges.value.length || batchIntent.value) return
    batchIntent.value = { requestId: crypto.randomUUID(), version: batchVersion.value, confirmed: true,
      changes: titleChanges.value.map(({ episodeId, title }) => ({ episodeId, title })) }
  }
  if (!batchIntent.value || (retryOriginal && !batchNotFound.value)) return
  batchBusy.value = true; batchError.value = ''; batchNotFound.value = false
  try {
    const receipt = await api<EpisodeTitleReceipt>(`/admin/dramas/${props.drama.id}/episode-titles`,
      { method: 'POST', body: batchIntent.value })
    await acceptReceipt(receipt)
  } catch (cause) {
    const rejected = cause instanceof ApiError && cause.status >= 400 && cause.status < 500
    if (rejected) {
      batchIntent.value = undefined; batchPreview.value = false
      batchConflict.value = cause.status === 409
      batchError.value = message(cause)
    } else {
      // 不确定请求是否写入时，只能先核对同一个请求，不能生成新编号再发。
      batchError.value = `${message(cause)} 保存结果尚未确认，请先核对原批次。`
    }
  } finally { batchBusy.value = false }
}
async function checkTitles() {
  if (!batchIntent.value || batchBusy.value) return
  batchBusy.value = true; batchError.value = ''; batchNotFound.value = false
  try {
    await acceptReceipt(await api<EpisodeTitleReceipt>(
      `/admin/dramas/${props.drama.id}/episode-titles/${encodeURIComponent(batchIntent.value.requestId)}`))
  } catch (cause) {
    batchNotFound.value = cause instanceof ApiError && cause.status === 404
    batchError.value = batchNotFound.value ? '暂未找到原批次，可保留同一编号和内容重试；不会另建一批。' : message(cause)
  } finally { batchBusy.value = false }
}
async function checkBatchVersion() {
  if (batchBusy.value || batchIntent.value) return
  batchBusy.value = true; batchError.value = ''
  try {
    const { drama } = await api<{ drama: Drama }>(`/admin/dramas/${props.drama.id}`)
    batchVersion.value = drama.version
    for (const row of titleChanges.value) {
      const current = drama.episodes.find(episode => episode.id === row.episodeId)
      row.oldTitle = current?.title ?? null; row.seq = current?.seq ?? row.seq
    }
    batchConflict.value = drama.status !== 'draft'; batchPreview.value = false
    emit('saved', drama)
    batchError.value = drama.status !== 'draft' ? '作品已不是私有草稿。本批没有写入，不能自动下架继续修改。'
      : '已读取最新版本，保留你的新标题。请重新预览差异后确认。'
  } catch (cause) { batchError.value = message(cause) }
  finally { batchBusy.value = false }
}
function editFailedTitles() {
  if (!batchResult.value || props.disabled || batchBusy.value) return
  batchVersion.value = batchResult.value.afterVersion
  titleChanges.value = batchResult.value.rows.filter(row => row.status === 'failed')
    .map(({ episodeId, seq, oldTitle, title }) => ({ episodeId, seq, oldTitle, title }))
  batchResult.value = undefined; batchPreview.value = false; batchError.value = ''; batchConflict.value = false
}
const editHeading = ref<HTMLElement>()
useDraftNavigationGuard(() => dirty.value, () => busy.value || fileBusy.value || batchBusy.value || csvBusy.value)
watch(dirty, value => emit('dirty', value), { immediate: true })
watch(() => busy.value || fileBusy.value || batchBusy.value || csvBusy.value, value => emit('busy', value), { immediate: true })
async function loadAssets() {
  if (assetsLoading.value) return
  assetsLoading.value = true; assetsError.value = ''
  try { assets.value = (await api<{ assets: Asset[] }>('/admin/assets', { signal: controller.signal })).assets }
  catch (cause) { if (!controller.signal.aborted) assetsError.value = message(cause) }
  finally { assetsLoading.value = false }
}
async function edit(episode?: Episode) {
  if (busy.value || fileBusy.value || batchBusy.value || titleChanges.value.length || batchIntent.value || csvOpen.value || props.disabled) return
  if (dirty.value && !window.confirm('当前单集有未保存修改，放弃后编辑另一集？')) return
  selected.value = episode ?? null
  Object.assign(form, {
    seq: episode?.seq ?? Math.max(0, ...episodes.value.map(item => item.seq)) + 1,
    title: episode?.title ?? '', durationSeconds: episode?.durationSeconds ?? 0,
    assetId: episode?.assetId ?? '', subtitleAssetId: episode?.subtitleAssetId ?? '',
  })
  snapshot.value = JSON.stringify(form)
  editing.value = true; error.value = ''; success.value = ''
  void loadAssets()
  await nextTick()
  editHeading.value?.focus()
}
function uploadedSubtitle(asset: Asset) {
  if (!assets.value.some(item => item.id === asset.id)) assets.value.unshift(asset)
  form.subtitleAssetId = asset.id
}
function close() {
  if (busy.value || fileBusy.value) return
  if (dirty.value && !window.confirm('关闭单集编辑？未保存的修改不会关联到单集，上传成功的字幕仍保留在资产列表。')) return
  selected.value = null; editing.value = false
}
async function save() {
  if (!editing.value || busy.value || fileBusy.value || props.disabled || assetsLoading.value) return
  if (!selected.value && !form.assetId) { error.value = '请选择已上传的视频资产。'; return }
  busy.value = true; error.value = ''; success.value = ''
  try {
    await api<{ episode: Episode }>(selected.value ? `/admin/episodes/${selected.value.id}` : `/admin/dramas/${props.drama.id}/episodes`, {
      method: selected.value ? 'PATCH' : 'POST', body: {
        seq: form.seq, title: form.title.trim(), durationSeconds: form.durationSeconds,
        assetId: form.assetId || null, subtitleAssetId: form.subtitleAssetId || null,
      },
    })
    selected.value = null; editing.value = false; success.value = '单集信息已保存。'
    busy.value = false
    await nextTick()
    emit('changed')
  } catch (cause) { error.value = message(cause) }
  finally { busy.value = false }
}
async function remove(episode: Episode) {
  if (busy.value || batchBusy.value || titleChanges.value.length || batchIntent.value || csvOpen.value || props.disabled) return
  if (!window.confirm(`确认删除第 ${episode.seq} 集「${episode.title}」？服务器会拒绝删除已发布或已有关联购买的单集。素材资产不会在这里删除。`)) return
  busy.value = true; error.value = ''; success.value = ''
  try {
    await api(`/admin/episodes/${episode.id}`, { method: 'DELETE' })
    selected.value = null; editing.value = false; busy.value = false
    await nextTick(); emit('changed'); success.value = '单集已删除，请检查剩余集数是否连续。'
  } catch (cause) { error.value = message(cause) }
  finally { busy.value = false }
}
onBeforeUnmount(() => { controller.abort(); emit('dirty', false); emit('busy', false) })
</script>

<template>
  <Feedback :error="error" :success="success" />
  <p v-if="episodes.length && drama.status === 'draft'" class="muted small-text">勾选多集可一起整理标题；视频、集号、价格和权利不改。</p>
  <button v-if="episodes.length && drama.status === 'draft' && !csvOpen" type="button" class="button quiet"
    :disabled="batchLocked || !!titleChanges.length" @click="openCsv">用CSV整理标题</button>
  <EpisodeTitleImport v-if="csvOpen" :drama="drama" :disabled="disabled || busy || fileBusy || batchBusy || !!batchIntent"
    :staged="csvStaged" :saved="!!batchResult" @prepare="stageCsv" @dirty="csvDirty = $event" @busy="csvBusy = $event" @close="closeCsv" />
  <div v-if="episodes.length && !csvStaged" class="table-scroll episode-list" tabindex="0" role="region" aria-label="单集列表表格">
    <table><thead><tr><th>集数</th><th>标题</th><th>时长（秒）</th><th>视频</th><th>字幕</th><th>操作</th></tr></thead>
      <tbody><tr v-for="episode in episodes" :key="episode.id">
        <td><label v-if="drama.status === 'draft'" class="checkbox title-choice"><input type="checkbox"
          :aria-label="`选择第 ${episode.seq} 集标题`" :checked="!!changeFor(episode.id)"
          :disabled="batchLocked || csvOpen || (!changeFor(episode.id) && titleChanges.length >= 100)"
          @change="chooseTitle(episode, ($event.target as HTMLInputElement).checked)" />{{ episode.seq }}</label><span v-else>{{ episode.seq }}</span></td>
        <td><template v-if="changeFor(episode.id)"><small>原：{{ changeFor(episode.id)!.oldTitle ?? '单集已移除' }}</small><input
          :value="changeFor(episode.id)!.title" :aria-label="`第 ${episode.seq} 集新标题`" maxlength="1000" :disabled="batchLocked"
          @input="changeTitle(episode.id, ($event.target as HTMLInputElement).value)" /></template><template v-else>{{ episode.title }}</template></td><td>{{ episode.durationSeconds }}</td>
        <td><span :class="['badge', episode.mediaReady ? 'good' : 'neutral']">{{ episode.byteplusVid
          ? (episode.platformEpisodeId ? '平台剧集已关联' : '云端视频 · 待平台登记')
          : episode.mediaReady ? '已关联' : '未就绪' }}</span></td><td>{{ episode.subtitleAssetId ? '已关联独立字幕' : drama.delivery?.subtitleMode === 'burned' ? '字幕已在画面中' : '未关联独立字幕' }}</td>
        <td><div class="inline wrap"><button class="button small" :disabled="disabled || busy || fileBusy || batchBusy || csvOpen || !!titleChanges.length || !!batchIntent" :aria-label="`编辑第 ${episode.seq} 集`" @click="edit(episode)">编辑单集</button><button class="button small danger" :disabled="disabled || busy || fileBusy || batchBusy || csvOpen || !!titleChanges.length || !!batchIntent" :aria-label="`删除第 ${episode.seq} 集`" @click="remove(episode)">删除单集</button></div></td>
      </tr></tbody>
    </table>
  </div>
  <div v-else-if="!episodes.length" class="empty-state compact"><h3>还没有单集</h3><p>可上传新 MP4，也可使用服务器已有视频创建单集，不必重新传文件。</p></div>
  <section v-if="titleChanges.length || batchIntent || batchResult" class="title-batch" aria-label="批量整理标题" :aria-busy="batchBusy">
    <Feedback :error="batchError" />
    <div v-if="titleChanges.length && !batchIntent" class="inline wrap"><strong>已选 {{ titleChanges.length }} 集</strong><button class="button" :disabled="batchLocked || batchConflict" @click="batchPreview = true">预览标题修改</button><button class="button quiet" :disabled="batchBusy" @click="discardTitles">放弃这批输入</button></div>
    <button v-if="batchConflict" class="button" :disabled="batchBusy" @click="checkBatchVersion">读取最新版本并保留输入</button>
    <div v-if="batchPreview" data-testid="title-batch-preview" class="batch-diff">
      <h4 ref="batchHeading" tabindex="-1">核对旧 → 新 · 作品版本 {{ batchVersion }}</h4>
      <ul><li v-for="row in titleChanges" :key="row.episodeId"><strong>第 {{ row.seq ?? '未知' }} 集</strong><span>{{ row.oldTitle ?? '单集已移除' }} → {{ row.title.trim() || '空标题（本行不会保存）' }}</span><small v-if="row.title.trim().length > 200">超过200字，本行不会保存</small></li></ul>
      <p class="muted small-text">按行返回结果；有效标题可保存，失败项留待修正。只修改本作品的普通标题，不上传、不提审、不公开。</p>
      <button v-if="!batchIntent" class="button primary" :disabled="batchLocked || batchConflict" @click="sendTitles()">{{ batchBusy ? '保存中…' : '确认保存这批标题' }}</button>
    </div>
    <div v-if="batchIntent" class="notice warning" role="status"><p>正在核对同一个批次；不要另建一批重复保存。</p><button class="button" :disabled="batchBusy" @click="checkTitles">核对原批次结果</button><button v-if="batchNotFound" class="button" :disabled="batchBusy" @click="sendTitles(true)">用原编号重试这批标题</button></div>
    <div v-if="batchResult" data-testid="title-batch-result" role="status" class="batch-diff">
      <h4>成功 {{ batchResult.counts.saved }} · 未改动 {{ batchResult.counts.unchanged }} · 失败 {{ batchResult.counts.failed }}</h4>
      <p v-if="csvSkipped" class="muted small-text">另有 {{ csvSkipped }} 条CSV记录未提交，须修正匹配或源版本后再导入；不计入本次保存成功。</p>
      <p class="muted small-text">版本 {{ batchResult.beforeVersion }} → {{ batchResult.afterVersion }}。这是原批次的已保存回执。</p>
      <ul><li v-for="row in batchResult.rows" :key="row.episodeId"><span>第 {{ row.seq ?? '未知' }} 集 · {{ row.title || '空标题' }}</span><small>{{ row.message }}</small></li></ul>
      <button v-if="batchResult.counts.failed" class="button" :disabled="disabled || batchBusy" @click="editFailedTitles">只整理失败项</button>
    </div>
  </section>
  <button v-if="!editing" type="button" class="button" :disabled="disabled || busy || batchBusy || csvOpen || !!titleChanges.length || !!batchIntent" @click="edit()">使用已有视频创建单集</button>
  <form v-if="editing" class="episode-form" aria-label="编辑单集" @submit.prevent="save" @keydown.esc.stop="close">
    <div class="section-heading"><h3 ref="editHeading" tabindex="-1">{{ selected ? `编辑第 ${selected.seq} 集` : '使用已有视频创建单集' }}</h3><button type="button" class="button small" :disabled="busy || fileBusy" @click="close">关闭编辑</button></div>
    <p v-if="dirty" class="notice">单集有未保存修改；切换步骤会保留输入，离开这部剧前请保存或放弃。</p>
    <p class="muted small-text">目标剧目：{{ drama.title }}。请核对集数与资产；这里只关联已上传文件，不生成视频公开地址。</p>
    <Feedback :error="assetsError" :loading="assetsLoading" retry @retry="loadAssets" />
    <fieldset class="form-grid" :disabled="disabled || busy">
      <label class="field"><span>单集序号</span><input v-model.number="form.seq" type="number" min="1" step="1" required /></label>
      <label class="field"><span id="episode-title-label">单集标题</span><input v-model="form.title" required maxlength="200" placeholder="填写这一集的题目，不是整部剧名" aria-labelledby="episode-title-label" aria-describedby="episode-title-help" />
        <small id="episode-title-help" class="muted">显示在播放画面和剧集目录。集号由系统单独显示，这里填写本集题目；没有独立题目时可填“第N集”，前台只显示一次集号，不编造题目或翻译。</small>
      </label>
      <label class="field"><span>时长（秒）</span><input v-model.number="form.durationSeconds" type="number" min="0" step="0.01" required /></label>
      <label class="field"><span>选择已有视频</span><select v-model="form.assetId" :required="!selected" :disabled="assetsLoading">
        <option value="">{{ selected ? '无本地视频（平台集可保留）' : '请选择视频资产' }}</option>
        <option v-if="form.assetId && !videos.some(asset => asset.id === form.assetId)" :value="form.assetId">当前关联 · {{ form.assetId }}</option>
        <option v-for="asset in videos" :key="asset.id" :value="asset.id">{{ asset.originalName }} · {{ asset.id }}</option>
      </select></label>
      <label class="field"><span>选择已有字幕</span><select v-model="form.subtitleAssetId" :disabled="assetsLoading || fileBusy">
        <option value="">不关联字幕</option>
        <option v-if="form.subtitleAssetId && !subtitles.some(asset => asset.id === form.subtitleAssetId)" :value="form.subtitleAssetId">当前关联 · {{ form.subtitleAssetId }}</option>
        <option v-for="asset in subtitles" :key="asset.id" :value="asset.id">{{ asset.originalName }} · {{ asset.id }}</option>
      </select></label>
    </fieldset>
    <FileUpload :key="selected?.id ?? 'new'" kind="subtitle" label="选择 VTT 字幕" :disabled="disabled || busy || assetsLoading" @uploaded="uploadedSubtitle" @busy="fileBusy = $event" />
    <p class="muted small-text">新上传字幕会自动选中；也可改选已有字幕，或选择“不关联字幕”移除关联。保存后生效。</p>
    <button class="button primary" type="submit" :disabled="disabled || busy || fileBusy || assetsLoading">{{ busy ? '保存中…' : selected ? '保存单集' : '创建单集' }}</button>
  </form>
</template>
<style scoped>
.title-choice { min-height: 44px; margin: 0; gap: 10px; }
.title-batch { margin: 16px 0; padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-subtle); }
.batch-diff { margin-top: 16px; }
.batch-diff h4[tabindex] { scroll-margin-top: 12px; }
.batch-diff ul { list-style: none; margin: 12px 0; padding: 0; }
.batch-diff li { display: grid; gap: 4px; padding: 10px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.batch-diff .button { margin-top: 12px; }
.episode-list input:not([type="checkbox"]) { min-width: 160px; }
@media(max-width:640px) {
  .episode-list table, .episode-list tbody { display: block; min-width: 0; }
  .episode-list thead { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
  .episode-list tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); padding: 14px; gap: 8px; border-bottom: 1px solid var(--line); }
  .episode-list td { display: block; padding: 0; border: 0; min-width: 0; overflow-wrap: anywhere; }
  .episode-list td:nth-child(2), .episode-list td:last-child { grid-column: 1 / -1; }
  .episode-list td:nth-child(2) { grid-row: 2; }
  .episode-list td:nth-child(3)::before { content: '时长（秒） '; color: var(--muted); }
  .episode-list input:not([type="checkbox"]) { min-width: 0; }
  .title-batch { padding: 12px; }
}
</style>
