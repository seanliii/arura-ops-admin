<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { Asset, Drama, Episode, Meta } from '../../shared/contracts'
import { api, ApiError, formatBytes, message, uploadAsset } from '../api'
import Feedback from './Feedback.vue'
import AssetLibrary from './AssetLibrary.vue'
import CloudUploadPanel from './CloudUploadPanel.vue'
import { OPERATOR_LANGUAGE_LABELS as CONTENT_LANGUAGE_LABELS } from '../../shared/catalog-channel'
import { audienceLanguage } from '../../shared/content-delivery'
import { readVideoDuration } from '../video-metadata'

type UploadState = 'queued' | 'uploading' | 'linking' | 'done' | 'failed' | 'cancelled'
interface QueueItem {
  id: number; file: File; seq: number; title: string; durationSeconds: number
  state: UploadState; progress: number; error: string; asset?: Asset; episodeId?: number
  metadata: 'reading' | 'ready' | 'unavailable'
}
const props = defineProps<{ initialDramaId: number | null; revision: number }>()
const emit = defineEmits<{ busy: [value: boolean]; pending: [value: boolean]; changed: []; 'target-change': [id: number | null]; edit: [id: number]; create: [] }>()
const dramas = ref<Drama[]>([])
const target = ref<number | ''>(props.initialDramaId ?? '')
const pendingTarget = ref<number | null>(null)
const queue = reactive<QueueItem[]>([])
const confirmed = ref(false)
const running = ref(false)
const cloudBusy = ref(false)
const cloudQueued = ref(false)
const uploadRightsConfirmed = ref(false), savingRights = ref(false)
const uploadMode = ref<'local' | 'cloud'>('local')
const uploadModeChosen = ref(false)
const anyUploading = computed(() => running.value || cloudBusy.value || savingRights.value)
function setCloudBusy(value: boolean) {
  cloudBusy.value = value; emit('busy', anyUploading.value)
  if (!value) applyPendingTarget()
}
const loading = ref(false)
const error = ref('')
const notice = ref('')
const assetRevision = ref(0)
const library = ref<InstanceType<typeof AssetLibrary>>()
let nextId = 0
let stopped = false
let disposed = false
let cancelUpload: (() => void) | undefined
const readController = new AbortController()
const currentDrama = computed(() => dramas.value.find(drama => drama.id === Number(target.value)))
const completeCount = computed(() => queue.filter(row => row.state === 'done').length)
const editable = computed(() => !!currentDrama.value && currentDrama.value.status !== 'published')
const pending = computed(() => queue.filter(row => row.state !== 'done'))
watch(() => pending.value.length > 0 || cloudQueued.value, value => emit('pending', value), { immediate: true })
watch(cloudQueued, value => { if (!value) applyPendingTarget() })
const readingMetadata = computed(() => queue.some(row => row.metadata === 'reading'))
const invalidSequence = computed(() => {
  const occupied = new Set(currentDrama.value?.episodes.map(episode => episode.seq) ?? [])
  const used = new Set<number>()
  for (const row of pending.value) {
    if (!Number.isInteger(row.seq) || row.seq < 1 || used.has(row.seq)) return '序号必须为正整数，且队列中不能重复。'
    // 已上传的失败任务允许核对服务器是否已创建成功，处理断网后丢失响应。
    if (occupied.has(row.seq) && !row.asset) return `第 ${row.seq} 集已经存在，请修改序号。`
    if (!row.title.trim()) return '请填写每一集的标题。'
    if (!Number.isFinite(row.durationSeconds) || row.durationSeconds < 0) return '时长必须是非负数字。'
    used.add(row.seq)
  }
  return ''
})
const stateLabels: Record<UploadState, string> = {
  queued: '等待上传', uploading: '上传中', linking: '正在关联单集', done: '已关联单集',
  failed: '失败，可重试', cancelled: '已取消，可重试',
}
async function load() {
  // 子面板挂载时也会读取云配置；不能因此跳过父级首次片库读取。
  // 只读列表可与云上传并行，目标选择/本地写操作仍由anyUploading限制。
  if (loading.value || running.value) return
  loading.value = true; error.value = ''
  try {
    const [catalog, meta] = await Promise.all([
      api<{ dramas: Drama[] }>('/admin/dramas', { signal: readController.signal }),
      api<Meta>('/meta', { signal: readController.signal }),
    ])
    dramas.value = catalog.dramas
    if (!uploadModeChosen.value) uploadMode.value = meta.mediaMode === 'tiktok' ? 'cloud' : 'local'
  } catch (cause) { if (!disposed) error.value = message(cause) }
  finally { loading.value = false }
}
watch(target, id => { uploadRightsConfirmed.value = false; emit('target-change', id === '' ? null : Number(id)) })
watch(() => props.initialDramaId, id => {
  if (id === null) return
  if (Number(target.value) === id) { pendingTarget.value = null; return }
  if (queue.length || anyUploading.value) {
    pendingTarget.value = id
    notice.value = '上传队列保留在原剧目下。清空队列记录后将切换到刚请求的剧目；已完成资产不会删除。'
  } else { pendingTarget.value = null; target.value = id }
})
watch(() => props.revision, () => { if (!running.value) void load() })
function selectFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? []).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }))
  input.value = ''
  if (!editable.value || anyUploading.value) return
  confirmed.value = false; error.value = ''; notice.value = ''
  const errors: string[] = []
  let seq = Math.max(0, ...(currentDrama.value?.episodes.map(e => e.seq) ?? []), ...queue.map(row => row.seq)) + 1
  for (const file of files) {
    if (!/\.mp4$/i.test(file.name) || (file.type && !['video/mp4', 'application/mp4', 'application/octet-stream'].includes(file.type))) {
      errors.push(`${file.name}：仅支持 MP4 视频。`); continue
    }
    if (file.size === 0) { errors.push(`${file.name}：空文件不能上传。`); continue }
    if (queue.some(row => row.file.name === file.name && row.file.size === file.size)) {
      errors.push(`重复文件：${file.name} 已在队列中，未再次加入。`); continue
    }
    queue.push({
      id: ++nextId, file: markRaw(file), seq: seq++, title: file.name.replace(/\.mp4$/i, ''),
      durationSeconds: 0, state: 'queued', progress: 0, error: '', metadata: 'reading',
    })
    const row = queue[queue.length - 1]!
    void readVideoDuration(file).then(seconds => {
      if (disposed || !queue.includes(row)) return
      if (seconds !== null && row.durationSeconds === 0 && row.state === 'queued') row.durationSeconds = seconds
      row.metadata = seconds === null ? 'unavailable' : 'ready'
    })
  }
  error.value = errors.join('\n')
}
async function confirmUploadRights() {
  const drama = currentDrama.value
  if (!drama || !editable.value || anyUploading.value || !uploadRightsConfirmed.value) return
  savingRights.value = true; emit('busy', true); error.value = ''
  try {
    const result = await api<{ drama: Drama }>(`/admin/dramas/${drama.id}`, {
      method: 'PATCH', body: { version: drama.version, rightsConfirmed: true },
    })
    if (result.drama.id !== drama.id || result.drama.rightsConfirmed !== true) throw new Error('版权确认结果尚未核实，请刷新剧目再检查')
    dramas.value = dramas.value.map(item => item.id === drama.id ? result.drama : item)
    uploadRightsConfirmed.value = false
    emit('changed')
  } catch (cause) { error.value = message(cause) }
  finally { savingRights.value = false; emit('busy', anyUploading.value); applyPendingTarget() }
}
function remove(row: QueueItem) {
  if (anyUploading.value) return
  queue.splice(queue.indexOf(row), 1); confirmed.value = false
  applyPendingTarget()
}
function applyPendingTarget() {
  if (!queue.length && !cloudQueued.value && !anyUploading.value && pendingTarget.value !== null) {
    target.value = pendingTarget.value
    pendingTarget.value = null
    notice.value = ''
  }
}
function clear() {
  if (anyUploading.value || !queue.length) return
  if (!window.confirm('清空本页队列记录？已完成的资产和单集不会删除，可在资产列表和剧目中查看。')) return
  queue.splice(0); confirmed.value = false; notice.value = ''; error.value = ''
  applyPendingTarget()
}
function cancel() {
  stopped = true
  cancelUpload?.()
  notice.value = '已请求停止后续任务。已完成资产与单集保留；已发出的单集保存请求会等待结果后停止。'
}
async function start() {
  if (anyUploading.value || readingMetadata.value || !confirmed.value || invalidSequence.value || !editable.value || !pending.value.length) return
  running.value = true; emit('busy', true); stopped = false; error.value = ''; notice.value = ''
  const dramaId = Number(target.value)
  try {
    for (const row of queue) {
      if (stopped || disposed) break
      if (row.state === 'done') continue
      row.error = ''
      try {
        // 每次重试/下一个单集都先核对，避免并发编辑或响应丢失导致重复创建。
        const fresh = await api<{ dramas: Drama[] }>('/admin/dramas', { signal: readController.signal })
        const drama = fresh.dramas.find(item => item.id === dramaId)
        if (!drama) throw new Error('目标剧目不存在，请刷新列表。')
        if (drama.status === 'published') throw new Error('剧目已发布，请先下架后继续上传管理。')
        const existing = drama.episodes.find(episode => episode.seq === row.seq)
        if (existing) {
          if (row.asset && existing.assetId === row.asset.id && existing.title === row.title.trim()) {
            row.episodeId = existing.id; row.state = 'done'; row.progress = 100; continue
          }
          throw new Error(`第 ${row.seq} 集已存在。请核对服务器记录并更改序号。`)
        }
        if (stopped || disposed) break
        if (!row.asset) {
          row.state = 'uploading'; row.progress = 0
          const task = uploadAsset(row.file, 'video', value => { row.progress = value })
          cancelUpload = task.cancel
          row.asset = await task.promise
          cancelUpload = undefined
          assetRevision.value++
        }
        if (stopped || disposed) { row.state = 'cancelled'; break }
        if (drama.episodes.some(e => e.assetId === row.asset!.id) || queue.some(other => other !== row && other.state === 'done' && other.asset?.id === row.asset!.id)) {
          throw new Error('服务器返回了已关联的重复视频资产，未创建重复单集。请核对文件内容。')
        }
        row.state = 'linking'
        // 不对写请求做自动重试；丢失响应时下次启动先查询实际单集。
        const result = await api<{ episode: Episode }>(`/admin/dramas/${dramaId}/episodes`, {
          method: 'POST', body: {
            seq: row.seq, title: row.title.trim(), durationSeconds: row.durationSeconds, assetId: row.asset.id,
          },
        })
        row.episodeId = result.episode.id; row.state = 'done'; row.progress = 100
      } catch (cause) {
        cancelUpload = undefined
        row.state = cause instanceof DOMException && cause.name === 'AbortError' ? 'cancelled' : 'failed'
        row.error = message(cause)
        if (cause instanceof ApiError && [401, 403, 409].includes(cause.status)) stopped = true
      }
    }
  } catch (cause) { if (!disposed) error.value = message(cause) }
  finally {
    running.value = false; cancelUpload = undefined; emit('busy', cloudBusy.value)
    confirmed.value = false
    if (!disposed) {
      notice.value = stopped
        ? `队列已停止。已完成 ${completeCount.value} / ${queue.length} 集，成功记录仍在下方。`
        : `本轮处理结束。已完成 ${completeCount.value} / ${queue.length} 集；失败项可修正后重新确认重试。`
      emit('changed')
      void load()
    }
  }
}
onMounted(load)
onBeforeUnmount(() => {
  disposed = true; stopped = true; readController.abort(); cancelUpload?.()
})
</script>

<template>
  <section aria-label="素材上传工作区">
    <p v-if="currentDrama" class="notice" data-testid="upload-content-context">
      当前剧目：{{ currentDrama.title }} · 频道 {{ CONTENT_LANGUAGE_LABELS[audienceLanguage(currentDrama) ?? ''] ?? '待确认' }}。
      {{ currentDrama.delivery?.subtitleMode === 'burned' ? '这份成片的字幕已在画面中，不必再挂字幕文件。' : '请核对这份成片的音轨和字幕，不会根据界面语言替换视频。' }}
    </p>
    <div class="panel upload-target">
      <div class="section-heading"><div><h2>{{ currentDrama ? '给这部剧添加视频' : '视频属于哪部剧？' }}</h2><p class="muted">新作品先建草稿；已有作品直接选择。上传后会回到这部剧继续管理。</p></div><button class="button primary" :disabled="anyUploading || queue.length > 0 || cloudQueued || loading" @click="emit('create')">新建剧目并上传</button></div>
      <div class="toolbar">
        <label class="field grow"><span>选择已有剧目</span><select v-model="target" aria-label="目标剧目" :disabled="anyUploading || queue.length > 0 || cloudQueued || loading"><option value="">请选择已有剧目</option><option v-for="drama in dramas" :key="drama.id" :value="drama.id">{{ drama.title }}{{ drama.status === 'published' ? '（已发布，需先下架）' : '' }}</option></select></label>
        <button class="button" :disabled="anyUploading || loading" @click="load">刷新剧目</button>
        <button v-if="currentDrama" type="button" class="button" :disabled="anyUploading || readingMetadata" @click="emit('edit', currentDrama.id)">返回这部剧</button>
      </div>
      <Feedback :error="error" :loading="loading" retry @retry="load" />
      <p v-if="!loading && !dramas.length && !error" class="empty-state compact">还没有作品。点击“新建剧目并上传”，填剧名和实际原声语言即可继续。</p>
      <p v-if="currentDrama?.status === 'published'" class="notice warning">此剧目已发布，不能新增或编辑单集。请到剧目管理先下架。</p>
      <p v-if="!loading" class="muted small-text">{{ uploadMode === 'cloud' ? '当前使用正式视频云上传，已自动选好上传位置。' : '当前使用本地演练上传，不会把视频交给TikTok。' }}请只上传作品素材，不要上传身份证或付款凭证。</p>
      <div v-if="uploadMode === 'cloud' && currentDrama && editable && !currentDrama.rightsConfirmed" class="upload-rights">
        <p>云上传前，只需再确认这部作品的使用权；其他发行资料可以稍后补齐。</p>
        <label class="checkbox"><input v-model="uploadRightsConfirmed" type="checkbox" :disabled="anyUploading" /><span>我确认有权上传和使用这部作品及其素材</span></label>
        <button type="button" class="button primary" :disabled="!uploadRightsConfirmed || anyUploading" @click="confirmUploadRights">{{ savingRights ? '保存中…' : '保存确认，继续上传' }}</button>
      </div>
    </div>
    <div v-show="uploadMode === 'local' && currentDrama" class="panel">
      <div class="section-heading"><div><h2>批量上传单集</h2><p class="muted">选择视频 → 核对顺序 → 开始上传</p></div></div>
      <label class="field upload-drop"><span>选择 MP4 视频（可多选）</span><small>本地上传：文件保存在业务服务器。文件名按数字排序，例如 2 在 10 前，请务必核对。</small><input type="file" accept=".mp4,video/mp4" multiple :disabled="!editable || anyUploading" @change="selectFiles" /></label>
      <p v-if="queue.length" class="muted small-text">已添加 {{ queue.length }} 个文件，见下方列表。还可以继续添加，不会清空已有文件。</p>
      <p class="muted small-text">集号和标题按文件名带入，时长会自动读取；只有读不到时才需要补填。</p>
      <div v-if="queue.length" class="table-scroll" tabindex="0" role="region" aria-label="待上传文件表格">
        <table class="upload-table"><thead><tr><th>文件</th><th>集数</th><th>单集标题</th><th>时长（秒）</th><th>进度 / 结果</th><th>操作</th></tr></thead>
          <tbody><tr v-for="row in queue" :key="row.id" data-testid="upload-row">
            <td class="file-name"><strong>{{ row.file.name }}</strong><small>{{ formatBytes(row.file.size) }}</small><small v-if="row.asset">资产 ID：{{ row.asset.id }}</small></td>
            <td><input v-model.number="row.seq" :aria-label="`${row.file.name} 集数`" type="number" min="1" step="1" :disabled="running || row.state === 'done'" @input="confirmed = false" /></td>
            <td><input v-model="row.title" :aria-label="`${row.file.name} 单集标题`" maxlength="200" :disabled="running || row.state === 'done'" @input="confirmed = false" /></td>
            <td><input v-model.number="row.durationSeconds" :aria-label="`${row.file.name} 时长（秒）`" type="number" min="0" step="0.001" :disabled="running || row.state === 'done'" @input="confirmed = false" /><small>{{ row.metadata === 'reading' ? '正在读取时长…' : row.metadata === 'ready' ? '已自动读取，可核对' : '未读到时长，请补填' }}</small></td>
            <td><span :class="['badge', row.state === 'done' ? 'good' : 'neutral']">{{ stateLabels[row.state] }}</span><progress :value="row.progress" max="100" :aria-label="`${row.file.name} 上传进度`"></progress><small v-if="row.state === 'uploading'">{{ row.progress }}%{{ row.progress === 99 ? ' · 等待服务器确认' : '' }}</small><p v-if="row.error" class="row-error" role="alert">{{ row.error }}</p><small v-if="row.asset && row.state !== 'done'">资产已保留，重试只关联单集。</small></td>
            <td><button class="button small" :disabled="running" :aria-label="`移除 ${row.file.name} 的队列记录`" @click="remove(row)">移除记录</button></td>
          </tr></tbody>
        </table>
      </div>
      <div v-else class="empty-state compact"><h3>等待添加 MP4 文件</h3><p>选择文件后会先展示可编辑的集数表，不会自动上传。</p></div>
      <p v-if="invalidSequence" class="notice warning" role="alert">{{ invalidSequence }}</p>
      <label v-if="queue.length" class="checkbox confirm-sequence"><input v-model="confirmed" type="checkbox" :disabled="running || readingMetadata || !!invalidSequence" /><span>我已核对文件顺序、集数和标题</span></label>
      <div class="form-actions wrap">
        <button class="button primary" :disabled="!confirmed || anyUploading || readingMetadata || !editable || !!invalidSequence || !pending.length" @click="start">{{ running ? '正在处理…' : '开始上传并创建单集' }}</button>
        <button v-if="running" class="button danger" @click="cancel">取消剩余上传</button>
        <button v-else-if="queue.length" class="button" @click="clear">清空队列记录</button>
        <span v-if="queue.length" class="muted">已完成 {{ completeCount }} / {{ queue.length }}</span>
      </div>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <button v-if="completeCount && currentDrama" type="button" class="button primary" :disabled="anyUploading" @click="emit('edit', currentDrama.id)">上传已完成，返回剧目继续</button>
    </div>
    <CloudUploadPanel v-show="uploadMode === 'cloud' && currentDrama" :drama-id="target === '' ? null : Number(target)" :disabled="running || savingRights || !editable || !currentDrama?.rightsConfirmed"
      :revision="revision" @busy="setCloudBusy" @pending="cloudQueued = $event" @changed="emit('changed')" />
    <details class="panel upload-more"><summary>其他上传方式与已有素材（通常不用）</summary>
      <label class="field"><span>上传方式</span><select :value="uploadMode" :disabled="anyUploading || queue.length > 0 || cloudQueued" @change="uploadMode = ($event.target as HTMLSelectElement).value as 'local' | 'cloud'; uploadModeChosen = true"><option value="cloud">TikTok视频云</option><option value="local">本地演练（不能替代TikTok播放）</option></select></label>
      <AssetLibrary ref="library" :revision="assetRevision" />
    </details>
  </section>
</template>
<style scoped>
.upload-target .toolbar { margin-bottom: 12px; }
.upload-more > summary { cursor: pointer; color: var(--muted); font-size: 1rem; }
.upload-more[open] > summary { margin-bottom: 18px; }
.upload-more > .field { max-width: 440px; }
.upload-rights { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 16px; font-size: 1rem; }
.upload-rights .checkbox { margin-top: 12px; }
</style>
