<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ApiError, SESSION_EXPIRED, dramaStatus, formatBytes, formatDate, message } from '../api'
import {
  createCloudUploadSession, restoreCloudUploadSession, loadCloudUploadContext, importCloudUploadEpisode,
  nextCloudSequence, sortCloudFiles, validateCloudFile,
  type CloudUploadContext, type CloudUploadPhase, type CloudUploadSession, type CloudUploadState,
} from '../cloud-uploader'
import Feedback from './Feedback.vue'
import MediaDeliveryPanel from './MediaDeliveryPanel.vue'

const props = defineProps<{ dramaId: number | null; disabled?: boolean; revision?: number }>()
const emit = defineEmits<{ busy: [value: boolean]; changed: []; pending: [value: boolean] }>()
const context = shallowRef<CloudUploadContext | null>(null)
// 这里仅保存session的公开状态；File、临时凭据和SDK实例都留在适配器私有内存。
const rows = shallowRef<CloudUploadState[]>([])
const sessions = new Map<string, CloudUploadSession>()
const loading = ref(false), running = ref(false), confirmed = ref(false)
const importing = ref<string | null>(null)
const delivery = ref<InstanceType<typeof MediaDeliveryPanel>>()
const deliveryRequested = ref(false), deliveryAccepted = ref(false), deliveryWorking = ref(false)
const error = ref(''), notice = ref('')
let generation = 0, stopQueue = false, disposed = false, expired = false, refreshPending = false
let readController: AbortController | undefined, importController: AbortController | undefined
// 切换剧目会清空context，但不能丢掉本页所属管理员，避免换号后把旧上传内存交给新账号。
let sessionOwnerId: string | undefined
const active = computed(() => rows.value.some(row => row.busy))
const busy = computed(() => loading.value || running.value || active.value || importing.value !== null || deliveryWorking.value)
const deliveryCount = computed(() => Math.max(1, ...(context.value?.drama?.episodeSeqs ?? []), ...rows.value.filter(r => r.phase !== 'cancelled').map(r => r.seq)))
const editable = computed(() => context.value?.drama?.status === 'draft' && context.value.drama.id === props.dramaId)
const available = computed(() => context.value?.availability.configured === true)
const startable = computed(() => rows.value.filter(row => row.hasFile && !row.busy && ['queued', 'error'].includes(row.phase)))
const verifiedCount = computed(() => rows.value.filter(row => row.phase === 'verified').length)
watch(() => rows.value.some(row => row.hasFile && !['verified', 'cancelled'].includes(row.phase)), value => emit('pending', value), { immediate: true })
const labels: Record<CloudUploadPhase, string> = {
  queued: '等待开始', creating: '保存任务', credentials: '取得临时上传权限', uploading: '正在直传云端',
  paused: '已暂停 · 仅本页可继续', refreshing: '刷新临时权限', awaiting_verification: '待核验',
  verifying: 'BytePlus文件核验中', verified: 'BytePlus已核验 · 待导入本地草稿',
  cancelling: '正在取消任务', cancelled: '已取消', interrupted: '中断 / 待核对', error: '失败，可核对后重试',
}
watch(busy, value => emit('busy', value), { immediate: true })

function removedImport(row: CloudUploadState) {
  return row.task?.importedAt != null && row.task.importedEpisodeId === null
}
function canImport(row: CloudUploadState) {
  return row.phase === 'verified' && row.task?.status === 'verified' &&
    row.task.importedAt === null && row.task.importedEpisodeId === null
}
function statusLabel(row: CloudUploadState) {
  if (importing.value === row.id) return '正在导入本地草稿单集'
  if (row.phase !== 'verified') return labels[row.phase]
  if (removedImport(row)) return 'BytePlus已核验 · 原导入单集已删除'
  if (row.task?.importedEpisodeId != null) return 'BytePlus已核验 · 已导入本地单集'
  return canImport(row) ? labels.verified : 'BytePlus已核验 · 导入记录待核对'
}
function registrationLabel(row: CloudUploadState) {
  if (row.registeringVideo) return 'TikTok视频登记 / 核对中'
  const status = row.task?.videoRegistration?.status
  if (!status) return 'TikTok视频未登记'
  return {
    checking: 'TikTok视频正在核对', sending: 'TikTok视频正在登记', registered: 'TikTok视频已登记',
    failed: 'TikTok视频登记失败', unknown: 'TikTok视频登记结果未知 · 仅核对',
  }[status]
}
const invalidSequence = computed(() => {
  const occupied = new Set([
    ...(context.value?.drama?.episodeSeqs ?? []),
    ...(context.value?.tasks.filter(task => task.status !== 'cancelled' && task.importedAt === null).map(task => task.seq) ?? []),
  ])
  const used = new Set<number>()
  for (const row of rows.value.filter(row => row.hasFile && !row.locked)) {
    if (!Number.isSafeInteger(row.seq) || row.seq < 1 || used.has(row.seq)) return '待上传集号必须为正整数，且不能重复。'
    if (occupied.has(row.seq)) return `第 ${row.seq} 集已有内容或云上传任务，请更改待上传集号。`
    if (!row.title.trim()) return '请填写每个待上传文件的单集标题。'
    used.add(row.seq)
  }
  return ''
})
function attach(session: CloudUploadSession) {
  sessions.set(session.state.id, session)
  rows.value = [...rows.value, session.state]
}
function sessionOptions(epoch: number) {
  return {
    autoRegisterVideo: () => !deliveryAccepted.value,
    onChange(state: CloudUploadState) {
      if (disposed || expired || epoch !== generation) return
      const index = rows.value.findIndex(row => row.id === state.id)
      if (index < 0) return
      const next = [...rows.value]
      next[index] = state
      rows.value = next
    },
    onChanged() { if (!disposed && !expired && epoch === generation) emit('changed') },
  }
}
async function load(preserveFeedback = false) {
  if (disposed || expired) return
  if (busy.value) { refreshPending = true; return }
  refreshPending = false
  const epoch = generation, target = props.dramaId
  readController?.abort()
  const controller = readController = new AbortController()
  loading.value = true
  if (!preserveFeedback) error.value = ''
  try {
    const result = await loadCloudUploadContext(target, { signal: controller.signal, expectedOwnerId: sessionOwnerId })
    if (disposed || expired || epoch !== generation || target !== props.dramaId || controller.signal.aborted) return
    sessionOwnerId = result.ownerId
    const currentDrama = context.value?.drama
    if (currentDrama && result.drama?.id === currentDrama.id && result.drama.version < currentDrama.version) {
      error.value ||= '返回的剧目版本较旧，已保留刚才的结果，请稍后刷新任务核对。'
      return
    }
    // 导入不可撤销成“从未导入”；删除则会保留importedAt，仍需采用该历史状态。
    const tasks = result.tasks.map(task => {
      const previous = rows.value.find(row => row.task?.id === task.id)?.task
      return previous && (previous.updatedAt > task.updatedAt || (previous.importedAt != null && task.importedAt === null) ||
        (previous.videoRegistration && (!task.videoRegistration || previous.videoRegistration.updatedAt > task.videoRegistration.updatedAt))) ? previous : task
    })
    const visibleIds = new Set(tasks.map(task => task.id))
    for (const row of rows.value) if (row.task && !visibleIds.has(row.task.id)) {
      sessions.get(row.id)?.dispose()
      sessions.delete(row.id)
    }
    rows.value = rows.value.filter(row => !row.task || visibleIds.has(row.task.id))
    context.value = { ...result, tasks }
    for (const task of tasks) {
      const existing = rows.value.find(row => row.task?.id === task.id)
      // 不因普通列表刷新丢掉本页File或尚未被服务器收到的候选VID。
      if (existing && !['verified', 'cancelled'].includes(task.status) &&
        (existing.hasFile || (existing.candidateVid && !task.candidateVid))) continue
      if (existing) {
        sessions.get(existing.id)?.dispose()
        sessions.delete(existing.id)
        rows.value = rows.value.filter(row => row.id !== existing.id)
      }
      attach(restoreCloudUploadSession(task, sessionOptions(epoch)))
    }
  } catch (cause) {
    if (!disposed && !expired && epoch === generation && !controller.signal.aborted) {
      if (cause instanceof ApiError && cause.status === 403) window.dispatchEvent(new Event(SESSION_EXPIRED))
      else if (cause instanceof ApiError && cause.status === 401) sessionExpired()
      else error.value = message(cause)
    }
  } finally {
    if (epoch === generation) {
      loading.value = false
      if (readController === controller) readController = undefined
      if (refreshPending && !busy.value) void load(preserveFeedback)
    }
  }
}
function reset() {
  generation++; stopQueue = true; readController?.abort(); importController?.abort()
  readController = undefined; importController = undefined; importing.value = null
  for (const session of sessions.values()) session.dispose()
  sessions.clear(); rows.value = []; context.value = null
  running.value = false; loading.value = false; confirmed.value = false; refreshPending = false
  deliveryRequested.value = false; deliveryAccepted.value = false
}
watch(() => props.dramaId, () => {
  reset(); error.value = ''; notice.value = ''
  void load()
}, { immediate: true })
watch(() => props.revision, () => { void load() })
function sessionExpired() {
  expired = true; reset(); sessionOwnerId = undefined; error.value = ''; notice.value = ''; emit('busy', false)
}
onMounted(() => window.addEventListener(SESSION_EXPIRED, sessionExpired))
onBeforeUnmount(() => {
  disposed = true; reset()
  window.removeEventListener(SESSION_EXPIRED, sessionExpired)
  emit('busy', false)
})

function selectFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = sortCloudFiles(Array.from(input.files ?? []))
  input.value = ''
  if (!editable.value || !available.value || busy.value || props.disabled || !context.value || props.dramaId === null) return
  confirmed.value = false; notice.value = ''; error.value = ''
  const problems: string[] = []
  let seq = nextCloudSequence(context.value.drama?.episodeSeqs ?? [], context.value.tasks,
    rows.value.filter(row => row.phase !== 'cancelled' && (!row.task || row.task.importedAt === null)).map(row => row.seq))
  for (const file of files) {
    const invalid = validateCloudFile(file, context.value.availability.maxBytes)
    if (invalid) { problems.push(`${file.name}：${invalid}`); continue }
    if (rows.value.some(row => row.phase !== 'cancelled' && (!row.task || row.task.importedAt === null) &&
      row.fileName === file.name && row.fileBytes === file.size)) {
      problems.push(`${file.name}：队列已有同名同大小文件，未重复加入。`); continue
    }
    attach(createCloudUploadSession({
      dramaId: props.dramaId, seq: seq++, title: file.name.replace(/\.mp4$/i, '').slice(0, 200),
      file, maxBytes: context.value.availability.maxBytes,
    }, sessionOptions(generation)))
  }
  error.value = problems.join('\n')
}
function edit(row: CloudUploadState, field: 'seq' | 'title', event: Event) {
  if (busy.value || props.disabled || row.locked) return
  const value = (event.target as HTMLInputElement).value
  sessions.get(row.id)?.edit(field === 'seq' ? { seq: Number(value) } : { title: value })
  confirmed.value = false
}
function move(row: CloudUploadState, step: -1 | 1) {
  if (busy.value || props.disabled || row.locked) return
  const queued = rows.value.filter(row => row.hasFile && !row.locked)
  const other = queued[queued.findIndex(item => item.id === row.id) + step]
  if (!other) return
  const old = row.seq
  sessions.get(row.id)?.edit({ seq: other.seq })
  sessions.get(other.id)?.edit({ seq: old })
  const next = [...rows.value], index = next.findIndex(item => item.id === row.id), otherIndex = next.findIndex(item => item.id === other.id)
  ;[next[index], next[otherIndex]] = [next[otherIndex], next[index]]
  rows.value = next; confirmed.value = false
}
async function start() {
  if (busy.value || props.disabled || !available.value || !editable.value || !confirmed.value || invalidSequence.value) return
  const epoch = generation, batch = [...startable.value]
  if (!batch.length) return
  if (deliveryRequested.value) {
    if (!await delivery.value?.authorize(deliveryCount.value) || disposed || expired || epoch !== generation) return
    deliveryAccepted.value = true
  }
  running.value = true; stopQueue = false; error.value = ''; notice.value = ''
  try {
    for (const row of batch) {
      if (disposed || expired || epoch !== generation || stopQueue) break
      const session = sessions.get(row.id)
      if (!session) break
      await session.start()
      if (session.state.phase !== 'verified') { stopQueue = true; break }
    }
  } finally {
    if (!disposed && !expired && epoch === generation) {
      running.value = false; confirmed.value = false
      notice.value = stopQueue
        ? '本轮已停止，其他未开始文件仍保留。核验失败请重试同一任务，不要重复上传。'
        : deliveryAccepted.value
          ? '本批文件已核验，自动交付任务将继续导入、登记和提交审核。后续状态可在“自动交付到TikTok”查看，页面可关闭。'
          : '本轮BytePlus核验及TikTok视频登记尝试结束，请分别核对状态。需逐项点击“导入为草稿单集”；未启用自动交付，不会自动提审或上线。'
      if (refreshPending && !active.value) void load()
    }
  }
}
async function verify(row: CloudUploadState) {
  if (props.disabled || row.busy || running.value || loading.value || importing.value !== null) return
  await sessions.get(row.id)?.verify()
  if (refreshPending && !busy.value) void load()
}
async function registerVideo(row: CloudUploadState) {
  if (busy.value || props.disabled || row.task?.status !== 'verified' || row.task.videoRegistration?.status === 'registered') return
  const epoch = generation, target = props.dramaId
  await sessions.get(row.id)?.registerVideo()
  if (disposed || expired || epoch !== generation || target !== props.dramaId) return
  if (refreshPending && !busy.value) void load()
}
async function importEpisode(row: CloudUploadState) {
  const current = context.value, drama = current?.drama
  const original = sessions.get(row.id)
  if (busy.value || props.disabled || !editable.value || !current || !drama || !original || !canImport(row) || !row.task ||
    original.state.task?.id !== row.task.id) return
  const epoch = generation, target = drama.id
  const controller = importController = new AbortController()
  const live = () => !disposed && !expired && epoch === generation && target === props.dramaId &&
    importController === controller && !controller.signal.aborted
  importing.value = row.id; error.value = ''; notice.value = ''
  try {
    const result = await importCloudUploadEpisode(row.task, drama, { signal: controller.signal })
    if (!live() || context.value !== current || sessions.get(row.id) !== original) return
    const restored = restoreCloudUploadSession(result.task, sessionOptions(epoch))
    original.dispose(); sessions.delete(row.id); sessions.set(restored.state.id, restored)
    rows.value = rows.value.map(item => item.id === row.id ? restored.state : item)
    context.value = {
      ...current,
      drama: { ...drama, version: result.dramaVersion, episodeSeqs: [...new Set([...drama.episodeSeqs, result.task.seq])] },
      tasks: [...current.tasks.filter(task => task.id !== result.task.id), result.task],
    }
    notice.value = '本次导入已确认，仅建立本地草稿单集，未审核／未上线；本操作不写 TikTok episodeID，也不发布视频。'
    refreshPending = true
    emit('changed')
  } catch (cause) {
    if (!live()) return
    if (cause instanceof ApiError && cause.status === 401) { sessionExpired(); return }
    error.value = message(cause)
    // 服务端可能已完成写入但响应丢失；先读回原任务，绝不自动重发导入或创建新任务。
    refreshPending = true
    emit('changed')
  } finally {
    if (live()) {
      importing.value = null; importController = undefined
      if (refreshPending && !busy.value) void load(true)
    }
  }
}
async function cancel(row: CloudUploadState) {
  const removed = removedImport(row)
  if ((row.phase === 'verified' && !removed) || row.phase === 'cancelled' || row.phase === 'cancelling' ||
    importing.value !== null || loading.value || (removed && (busy.value || props.disabled))) return
  const prompt = removed
    ? `取消第 ${row.seq} 集「${row.title}」的旧上传记录并释放集号？原导入单集已删除，不会重新建立；此操作不会删除云端视频或发布内容。`
    : `取消第 ${row.seq} 集「${row.title}」的云上传任务？本页将停止传输；可能已产生的云端文件不会自动删除，也不会被关联或上线。`
  if (!window.confirm(prompt)) return
  const epoch = generation, target = props.dramaId
  stopQueue = true
  await sessions.get(row.id)?.cancel()
  if (disposed || expired || epoch !== generation || target !== props.dramaId) return
  if (removed && sessions.get(row.id)?.state.phase === 'cancelled') notice.value = '旧上传记录已取消，集号可用于新上传；云端视频未删除。'
  confirmed.value = false
  if (refreshPending && !busy.value) void load()
}
function remove(row: CloudUploadState) {
  if (busy.value || props.disabled || row.locked) return
  sessions.get(row.id)?.dispose(); sessions.delete(row.id)
  rows.value = rows.value.filter(item => item.id !== row.id)
  confirmed.value = false
}
</script>

<template>
  <section class="panel cloud-upload-panel" aria-label="云端视频上传" :aria-busy="busy">
    <div class="section-heading">
      <div><h2>云端视频上传</h2><p class="muted">视频直接上传到已配置的视频云；传完后会继续核验。</p></div>
      <button class="button" :disabled="busy || disabled" @click="load()">刷新云上传任务</button>
    </div>
    <Feedback :loading="loading" :error="error" />
    <div v-if="context && !available" class="notice warning">
      <strong>云端上传尚未配置，不能开始上传</strong>
      <ul><li v-for="reason in context.availability.reasons" :key="reason">{{ reason }}</li></ul>
    </div>
    <p v-if="dramaId === null" class="notice">请先在素材工作区选择一个草稿剧目。</p>
    <p v-else-if="context && !context.drama" class="notice warning">未找到目标剧目，请刷新或重新选择。</p>
    <p v-else-if="context?.drama && !editable" class="notice warning">只有草稿剧目可以上传新视频；请先在剧目管理中下架或恢复为草稿。</p>
    <details><summary>上传位置与处理说明</summary>
    <div v-if="context" class="cloud-target">
      <span>目标：{{ context.drama?.title ?? '未选择' }}<template v-if="context.drama"> · #{{ context.drama.id }}</template></span>
      <span>空间：{{ context.availability.spaceName ?? '未配置' }} · 区域：{{ context.availability.region ?? '未配置' }}</span>
      <span v-if="context.availability.maxBytes > 0">单文件上限：{{ formatBytes(context.availability.maxBytes) }}</span>
    </div>
    <p class="notice">视频通过官方SDK直传BytePlus，100%只是传输进度，仍需服务器核实文件归属和内容。普通上传会登记已有VID，之后可手动导入草稿；确认下方“自动交付到 TikTok”后，服务器会等本批文件全部核验，再继续导入、登记剧目、提审和查询。只有另行勾选“通过后自动上架”才会公开；登记或提审成功不表示已经可播放，不会重复上传视频。</p>
    </details>
    <p class="notice warning">上传前需确认视频云的自动发布已关闭、原片受访问保护。本页不会更改空间权限；服务器还会核验未发布状态。</p>
    <label class="field upload-drop">
      <span>选择云端 MP4 视频（可多选）</span>
      <small>按文件名数字排序，从已有剧集和未取消任务的最大集号继续编号；开始前可调整顺序、集号和标题。</small>
      <input data-testid="cloud-file-input" aria-label="选择云端 MP4 视频（可多选）" type="file" accept=".mp4,video/mp4" multiple
        :disabled="!available || !editable || busy || disabled" @change="selectFiles" />
    </label>
    <div v-if="rows.length" class="table-scroll" role="region" aria-label="云上传任务表格" tabindex="0">
      <table class="cloud-upload-table">
        <thead><tr><th>文件 / 任务</th><th>集号</th><th>本地单集标题</th><th>进度与核验</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id" data-testid="cloud-upload-row" :data-task-id="row.task?.id">
            <td><strong>{{ row.fileName }}</strong><small>{{ formatBytes(row.fileBytes) }}</small><small v-if="row.task">任务：{{ row.task.id }}</small></td>
            <td><input :value="row.seq" :aria-label="`${row.fileName} 云上传集号`" type="number" min="1" step="1"
              :disabled="row.locked || busy || disabled" @input="edit(row, 'seq', $event)" /></td>
            <td><input :value="row.title" :aria-label="`${row.fileName} 云上传标题`" maxlength="200"
              :disabled="row.locked || busy || disabled" @input="edit(row, 'title', $event)" /></td>
            <td>
              <span :class="['badge', row.phase === 'verified' && !removedImport(row) ? 'good' : 'neutral']">{{ statusLabel(row) }}</span>
              <span v-if="row.task?.status === 'verified'" data-testid="cloud-video-registration-status"
                :data-status="row.task.videoRegistration?.status ?? 'not_registered'"
                :class="['badge', row.task.videoRegistration?.status === 'registered' ? 'good' : 'neutral']">{{ registrationLabel(row) }}</span>
              <small v-if="row.task?.videoRegistration?.message">{{ row.task.videoRegistration.message }}</small>
              <small v-if="row.task?.videoRegistration?.confirmedAt">TikTok视频登记确认：{{ formatDate(row.task.videoRegistration.confirmedAt) }}</small>
              <small v-if="row.task?.status === 'verified' && row.task.videoRegistration?.status !== 'registered'">视频登记未完成；可导入本地草稿，不代表已可播放。</small>
              <progress :value="row.percent" max="100" :aria-label="`${row.fileName} 云上传进度`"></progress>
              <small>{{ row.percent }}%<template v-if="row.percent === 100 && !['verified', 'cancelled'].includes(row.phase) && !row.task?.verifiedAt"> · 待核验</template></small>
              <small v-if="row.task?.verifiedAt">核验时间：{{ formatDate(row.task.verifiedAt) }}</small>
              <template v-if="row.task?.importedEpisodeId != null">
                <small>本地单集 ID：{{ row.task.importedEpisodeId }}</small>
                <small>导入时为草稿，未审核／未上线；平台当前状态请在“平台媒资”查询。</small>
                <small v-if="context?.drama">本地剧目状态：{{ dramaStatus[context.drama.status] }}</small>
              </template>
              <small v-if="row.task?.importedAt">导入时间：{{ formatDate(row.task.importedAt) }}</small>
              <small v-if="removedImport(row)">
                原导入单集已删除，旧任务不会再次建集。
                {{ row.phase === 'cancelled' ? '旧记录已取消，集号已释放。' : '可取消旧记录释放集号后重新上传；不会删除云端视频。' }}
              </small>
              <p v-if="row.error" class="row-error" role="alert">{{ row.error }}</p>
              <small v-if="!row.hasFile && !row.candidateVid && !['verified', 'cancelled'].includes(row.phase)">没有本页原文件／分片会话，不能跨页续传。</small>
              <small v-if="row.candidateVid && row.task?.status !== 'verified' && row.phase !== 'cancelled'">已有候选VID，重试仅核验同一任务，不再上传文件。</small>
            </td>
            <td><div class="cloud-row-actions">
              <button v-if="!deliveryAccepted && row.task?.status === 'verified' && row.task.videoRegistration?.status !== 'registered'"
                class="button small" data-testid="cloud-register-video" :disabled="busy || disabled"
                @click="registerVideo(row)">登记/核对TikTok视频</button>
              <button v-if="!deliveryAccepted && canImport(row)" class="button small primary" data-testid="cloud-import"
                :disabled="busy || disabled || !editable" @click="importEpisode(row)">导入为草稿单集</button>
              <template v-if="!row.locked">
                <button class="button small" :disabled="busy || disabled" :aria-label="`上移 ${row.fileName}`" @click="move(row, -1)">上移</button>
                <button class="button small" :disabled="busy || disabled" :aria-label="`下移 ${row.fileName}`" @click="move(row, 1)">下移</button>
                <button class="button small" :disabled="busy || disabled" :aria-label="`移除云上传 ${row.fileName}`" @click="remove(row)">移除</button>
              </template>
              <button v-if="row.phase === 'uploading' || (row.phase === 'refreshing' && row.percent < 100)" class="button small" @click="sessions.get(row.id)?.pause()">暂停</button>
              <button v-if="row.phase === 'paused'" class="button small" @click="sessions.get(row.id)?.resume()">继续上传（仅本页）</button>
              <button v-if="row.candidateVid && row.task?.status !== 'verified' && !['verified', 'cancelled', 'cancelling'].includes(row.phase)" class="button small"
                :disabled="row.busy || running || loading || importing !== null || disabled" @click="verify(row)">重试核验</button>
              <button v-if="row.locked && row.phase !== 'cancelled' && (row.phase !== 'verified' || removedImport(row))" class="button small danger"
                :disabled="row.phase === 'cancelling' || loading || importing !== null || (removedImport(row) && (busy || disabled))"
                @click="cancel(row)">{{ removedImport(row) ? '取消旧记录（释放集号）' : '取消任务' }}</button>
            </div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="!loading" class="empty-state compact">尚无云上传任务。选择文件后先核对，不会自动开始上传。</p>
    <p v-if="invalidSequence" class="notice warning" role="alert">{{ invalidSequence }}</p>
    <MediaDeliveryPanel v-if="context?.drama" ref="delivery" :drama-id="context.drama.id" :version="context.drama.version"
      :episode-count="deliveryCount" upload-mode :disabled="disabled || running || active || loading || importing !== null"
      @requested="deliveryRequested = $event" @active="deliveryAccepted = $event" @busy="deliveryWorking = $event" @changed="load(true); emit('changed')" />
    <label v-if="startable.length" class="checkbox">
      <input v-model="confirmed" data-testid="cloud-confirm" type="checkbox" :disabled="busy || disabled || !!invalidSequence" />
      <span>我已核对顺序、集数与标题，确认上传至指定云端空间；{{ deliveryRequested ? '本批按上方确认的自动交付任务继续处理。' : '文件核验后将已有VID登记到TikTok；未启用自动交付，不自动提审或上架。' }}</span>
    </label>
    <div class="form-actions wrap">
      <button class="button primary" data-testid="cloud-start"
        :disabled="busy || disabled || !available || !editable || !confirmed || !startable.length || !!invalidSequence" @click="start">{{ deliveryRequested ? '上传并自动交付' : '开始云端上传' }}</button>
      <span class="muted">云端已核验 {{ verifiedCount }} / {{ rows.length }} · 暂停仅保留本页内存，请勿关闭页面。</span>
    </div>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.cloud-upload-panel { min-width: 0; overflow-wrap: anywhere; }
.cloud-target { display: flex; flex-wrap: wrap; gap: .5rem 1rem; margin: .9rem 0; font-size: .875rem; }
.cloud-upload-table { min-width: 760px; }
.cloud-upload-table td { vertical-align: top; }
.cloud-upload-table small { display: block; margin-top: .35rem; color: var(--muted, #677080); }
.cloud-upload-table td:first-child { max-width: 240px; overflow-wrap: anywhere; }
.cloud-upload-table td:nth-child(2) input { width: 80px; }
.cloud-upload-table progress { display: block; width: 100%; margin-top: .5rem; }
.cloud-row-actions { display: flex; gap: .4rem; flex-wrap: wrap; max-width: 190px; }
.row-error { margin: .5rem 0; max-width: 280px; color: var(--danger); font-size: .875rem; }
.table-scroll { max-width: 100%; overflow-x: auto; }
</style>
