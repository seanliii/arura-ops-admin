<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Drama, PlatformMediaAction, PlatformMediaOperationStatus, PlatformMediaResponse, PlatformMediaState } from '../../shared/contracts'
import { api, formatDate, message } from '../api'
import Feedback from './Feedback.vue'
import PlatformRegistrationPanel from './PlatformRegistrationPanel.vue'

const props = defineProps<{ drama: Drama; disabled?: boolean }>()
const emit = defineEmits<{ changed: []; busy: [value: boolean] }>()
const media = ref<PlatformMediaState | null>(null)
const album = ref('')
const targetVersion = ref('')
const loading = ref(false)
const working = ref(false)
const registrationBusy = ref(false)
const error = ref('')
const success = ref('')
let loadId = 0
let mounted = true
const busy = computed(() => loading.value || working.value || registrationBusy.value)
const blocked = computed(() => busy.value || props.disabled)
const unresolved = new Set<PlatformMediaOperationStatus>(['submitting', 'unknown', 'awaiting_sync'])
const pendingWrite = computed(() => media.value?.operations.some(op => op.action !== 'sync' && unresolved.has(op.status)) ?? false)
const writing = computed(() => media.value?.operations.some(op => op.action !== 'sync' && op.status === 'submitting') ?? false)
const sameSelection = computed(() => album.value.trim() === media.value?.albumId && Number(targetVersion.value) === media.value?.platformVersion)
const approved = computed(() => media.value?.reviewStatus === 2 || media.value?.reviewStatus === 6)
const fresh = computed(() => media.value && !media.value.needsSync && media.value.syncedLocalVersion === props.drama.version)
const canWrite = computed(() => !blocked.value && media.value?.configured && sameSelection.value && !pendingWrite.value)
const reviewLabels = ['未提审', '审核中', '已批准', '已拒绝', '已撤回', '申诉中', '申诉批准', '申诉拒绝']
const publishLabels = ['默认 / 未上架', '已上架', '已下架']
const actionLabels: Record<PlatformMediaAction, string> = {
  sync: '查询同步', submit_review: '提交该版本审核', set_online: '设为在线版本',
  authorize_app: '授权当前App', list: '平台上架', delist: '平台下架',
}
const statusLabels: Record<PlatformMediaOperationStatus, string> = {
  submitting: '处理中', succeeded: '已确认', failed: '失败', unknown: '未知待核对',
  awaiting_sync: '待查询确认', superseded: '旧查询已丢弃', reconciled: '后续查询已核对',
}
const endpoint = () => `/admin/dramas/${props.drama.id}/platform-media`
watch(busy, value => emit('busy', value))
function adopt(value: PlatformMediaState, selection = false) {
  media.value = value
  if (selection) {
    album.value = value.albumId ?? ''
    targetVersion.value = value.platformVersion === null ? '' : String(value.platformVersion)
  }
}
async function load(refreshParent = false) {
  const request = ++loadId, dramaId = props.drama.id
  loading.value = true
  try {
    const result = await api<PlatformMediaResponse>(endpoint())
    if (!mounted || request !== loadId || props.drama.id !== dramaId) return
    adopt(result.media, !media.value)
    if (refreshParent && result.media.localVersion !== props.drama.version) emit('changed')
  } catch (cause) {
    if (mounted && request === loadId) error.value = message(cause)
  } finally {
    if (mounted && request === loadId) loading.value = false
  }
}
watch(() => [props.drama.id, props.drama.version], (next, previous) => {
  if (!previous || next[0] !== previous[0]) {
    media.value = null; album.value = ''; targetVersion.value = ''; error.value = ''; success.value = ''
  }
  void load()
}, { immediate: true })
onBeforeUnmount(() => { mounted = false; loadId++; emit('busy', false) })

function selectedVersion(): number {
  const value = Number(targetVersion.value)
  if (!/^[1-9]\d*$/.test(targetVersion.value) || !Number.isSafeInteger(value)) throw new Error('platformVersion（关联平台版本）必须是正整数')
  return value
}
async function sync(verifyAccess = false) {
  if (blocked.value || writing.value || !media.value?.configured) return
  error.value = ''; success.value = ''
  let platformVersion: number
  const albumId = album.value.trim()
  try {
    // 用字符串比较int64上限；前端构建目标不依赖BigInt，不能先转成Number丢失精度。
    if (!/^[1-9]\d{0,18}$/.test(albumId) || (albumId.length === 19 && albumId > '9223372036854775807')) {
      throw new Error('albumId必须填写已有平台Album的正int64字符串，不能是空值、网址或自造名称')
    }
    platformVersion = selectedVersion()
  } catch (cause) { error.value = message(cause); return }
  if (media.value.albumId && !sameSelection.value && !window.confirm(
    '更换关联会替换本地单集的平台映射。只查询已有平台版本，不创建剧目或上传文件。确认继续？',
  )) return
  working.value = true
  try {
    const result = await api<PlatformMediaResponse>(`${endpoint()}/sync`, {
      method: 'POST', body: { albumId, platformVersion, version: props.drama.version, requestId: crypto.randomUUID(), verifyAccess },
    })
    loadId++
    adopt(result.media, true)
    success.value = result.operation?.message ?? '查询已完成'
    emit('changed')
  } catch (cause) {
    error.value = message(cause)
    await load()
    emit('changed') // 明确失效也可能推进本地version；不能让父组件拿旧版本继续发布。
  } finally { working.value = false }
}
async function mutate(action: Exclude<PlatformMediaAction, 'sync'>) {
  if (!canWrite.value || !media.value?.albumId || media.value.platformVersion === null) return
  const impact = action === 'delist'
    ? '会停止该剧目的平台可播放状态；不会删除购入权益或自动退款。'
    : action === 'list'
      ? '会申请改变平台上架状态；收到回执后仍需查询确认，本地发布是另一步。'
      : action === 'authorize_app'
        ? '只授权服务器配置的当前App，不允许指定其他App。'
        : '收到受理回执不代表已经审核批准或可以播放，之后必须查询确认。'
  if (!window.confirm(`确认执行真实平台操作「${actionLabels[action]}」？\nAlbum ID：${media.value.albumId}\n平台版本：${media.value.platformVersion}\n本地版本：${props.drama.version}\n${impact}`)) return
  working.value = true; error.value = ''; success.value = ''
  try {
    const result = await api<PlatformMediaResponse>(`${endpoint()}/operations`, {
      method: 'POST', body: {
        action, version: props.drama.version, platformVersion: media.value.platformVersion,
        requestId: crypto.randomUUID(), confirmed: true,
      },
    })
    loadId++
    adopt(result.media)
    success.value = result.operation?.message ?? '请求已记录，请查询核对'
    emit('changed')
  } catch (cause) {
    error.value = message(cause)
    await load()
    emit('changed')
  } finally { working.value = false }
}
function useRegistration(value: { albumId: string; platformVersion: number }) {
  if (blocked.value) return
  album.value = value.albumId
  targetVersion.value = String(value.platformVersion)
  // 仅接入已有查询。审核、授权和上架仍是之后各自明确确认的操作。
  void sync()
}
</script>

<template>
  <PlatformRegistrationPanel :drama="drama" :disabled="disabled || loading || working"
    @busy="registrationBusy = $event" @changed="load(true); emit('changed')" @registered="useRegistration" />
  <section class="panel platform-media" aria-label="平台媒资" :aria-busy="busy">
    <div class="section-heading">
      <div><h3>平台媒资</h3><p class="muted">已有平台剧目：关联 → 查询 → 提审 → 设在线版本 → 当前App授权 → 平台上架。</p></div>
      <button class="button" type="button" :disabled="blocked" @click="error = ''; load(true)">刷新本地操作记录</button>
    </div>
    <p class="notice">已有平台剧目可在此关联查询。新建／更新草稿请先完成上方登记；内容语言按剧目真实原声提交，与发行地区分开记录。平台登记成功不等于审核通过或已上线。</p>
    <Feedback :loading="loading" :error="error" :success="success" />
    <template v-if="media">
      <p v-if="!media.configured" class="notice warning">服务器尚未配置平台应用凭据，平台按钮不可用。本地样例的上传、发布和播放保持原有流程。</p>
      <p v-else-if="media.mode === 'local'" class="notice warning">当前是本地模式，但本面板的写操作会请求真实平台，必须逐项确认；本地发布仍检查本地文件。</p>
      <form class="form-grid media-link" novalidate @submit.prevent="sync(false)">
        <label class="field"><span>已有平台 Album ID</span><input v-model="album" aria-label="已有平台 Album ID" :aria-describedby="`album-help-${drama.id}`" inputmode="numeric" autocomplete="off" maxlength="19" :disabled="blocked || drama.status === 'published'" /><small :id="`album-help-${drama.id}`">完整保留平台长ID，不能填写本地剧目编号。</small></label>
        <label class="field"><span>关联平台版本</span><input v-model="targetVersion" aria-label="关联平台版本" :aria-describedby="`version-help-${drama.id}`" type="text" inputmode="numeric" autocomplete="off" :disabled="blocked || drama.status === 'published'" /><small :id="`version-help-${drama.id}`">明确指定版本；不会自动选择最新版本。</small></label>
        <label v-if="media.versions.length" class="field"><span>已查询版本（选择后需再次查询）</span><select v-model="targetVersion" :disabled="blocked || drama.status === 'published'"><option v-for="version in media.versions" :key="version.version" :value="String(version.version)">版本 {{ version.version }} · {{ version.reviewStatus === null ? '未返回审核状态' : reviewLabels[version.reviewStatus] }}</option></select></label>
        <div class="form-actions"><button class="button primary" type="submit" :disabled="blocked || writing || !media.configured">关联并查询指定版本</button></div>
      </form>
      <p v-if="drama.status === 'published'" class="muted">已发布内容可以查询状态；更换album或关联版本需先从本应用下架。</p>
      <dl class="media-status">
        <div><dt>已关联 Album ID</dt><dd>{{ media.albumId ?? '尚未关联' }}</dd></div>
        <div><dt>本地版本 / 已同步本地版本</dt><dd>{{ media.localVersion }} / {{ media.syncedLocalVersion ?? '—' }}</dd></div>
        <div><dt>关联平台版本 / 平台当前草稿版本</dt><dd>{{ media.platformVersion ?? '—' }} / {{ media.currentVersion ?? '—' }}</dd></div>
        <div><dt>平台在线版本</dt><dd>{{ media.onlineVersion ?? '未设置' }}</dd></div>
        <div><dt>对应版本审核状态</dt><dd>{{ media.reviewStatus === null ? '未查询' : reviewLabels[media.reviewStatus] }}</dd></div>
        <div><dt>平台上/下架状态</dt><dd>{{ media.publishStatus === null ? '未查询' : publishLabels[media.publishStatus] }}</dd></div>
        <div><dt>当前App播放权限</dt><dd>{{ media.authorization === 'authorized' ? '平台已确认' : '尚未确认' }}</dd></div>
        <div><dt>最后成功查询时间</dt><dd>{{ media.syncedAt ? formatDate(media.syncedAt) : '尚未成功查询' }}</dd></div>
      </dl>
      <p v-if="media.readyToPublish" class="notice">平台发布条件已满足。本地发布仍会检查版权、封面、连续集数和本地版本；审核通过本身不等于已上线。</p>
      <ul v-else class="media-reasons"><li v-for="reason in media.reasons" :key="reason">{{ reason }}</li></ul>
      <p v-if="pendingWrite" class="notice warning">有处理中、未知或待查询确认的操作，已禁止重复写入。请先查询同一album和版本；授权结果未知时，现有官方查询接口不能证明授权成功，需向平台核对，不能盲目重发。</p>
      <div class="inline wrap media-actions">
        <button class="button" :disabled="!canWrite || !fresh || media.reviewStatus === null || ![0, 3, 4, 7].includes(media.reviewStatus)" @click="mutate('submit_review')">提交该版本审核</button>
        <button class="button" :disabled="!canWrite || !fresh || !approved || media.onlineVersion === media.platformVersion" @click="mutate('set_online')">设为在线版本</button>
        <button class="button" :disabled="!canWrite || !fresh || media.authorization === 'authorized'" @click="mutate('authorize_app')">授权当前App</button>
        <button class="button primary" :disabled="!canWrite || !fresh || !approved || media.onlineVersion !== media.platformVersion || media.publishStatus === 1" @click="mutate('list')">平台上架</button>
        <button class="button primary" :disabled="blocked || writing || !media.configured || !sameSelection || !approved || media.onlineVersion !== media.platformVersion || media.publishStatus !== 1" @click="sync(true)">核验当前App播放权限</button>
        <button class="button danger" :disabled="!canWrite || !media.albumId || media.publishStatus === 2" @click="mutate('delist')">平台下架</button>
      </div>
      <div v-if="media.episodes.length" class="table-scroll" role="region" aria-label="平台单集映射" tabindex="0">
        <table><thead><tr><th>本地集号</th><th>平台 episode_id</th><th>BytePlus vid</th></tr></thead><tbody><tr v-for="episode in media.episodes" :key="episode.localEpisodeId"><td>{{ episode.seq }}</td><td>{{ episode.episodeId }}</td><td>{{ episode.vid }}</td></tr></tbody></table>
      </div>
      <section class="media-history" aria-label="媒资操作记录">
        <h4>操作记录</h4>
        <p v-if="!media.operations.length" class="muted">尚无操作。打开此页面只读取本地记录，不自动请求平台。</p>
        <ol v-else>
          <li v-for="op in media.operations" :key="op.requestId">
            <div class="inline wrap"><strong>{{ actionLabels[op.action] }}</strong><span :class="['badge', ['unknown', 'failed'].includes(op.status) ? 'warning' : 'neutral']">{{ statusLabels[op.status] }}</span><time>{{ formatDate(op.updatedAt) }}</time></div>
            <p>请求ID：<code>{{ op.requestId }}</code> · 平台版本 {{ op.platformVersion }} · 发起时本地版本 {{ op.localVersion }}</p>
            <p v-if="op.reviewId">平台审核任务ID：{{ op.reviewId }}</p>
            <p>{{ op.message }}<span v-if="op.errorCode">（{{ op.errorCode }}）</span></p>
          </li>
        </ol>
      </section>
    </template>
  </section>
</template>

<style scoped>
.platform-media { min-width: 0; overflow-wrap: anywhere; }
.media-link { margin: 1rem 0; }
.media-status { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .9rem 1.25rem; margin: 1.25rem 0; }
.media-status div { min-width: 0; }
.media-status dt { color: var(--muted, #626b78); font-size: .875rem; margin-bottom: .25rem; }
.media-status dd { margin: 0; font-weight: 600; }
.media-reasons { padding-left: 1.3rem; line-height: 1.8; }
.media-actions { margin: 1rem 0; }
.table-scroll { max-width: 100%; }
.media-history { margin-top: 1.5rem; }
.media-history ol { list-style: none; padding: 0; }
.media-history li { padding: .85rem 0; border-bottom: 1px solid var(--border, #e4e7eb); }
.media-history p { margin: .4rem 0 0; font-size: .875rem; }
.media-history time { color: var(--muted, #626b78); font-size: .8rem; }
.media-history code { white-space: normal; }
@media (max-width: 600px) {
  .media-status { grid-template-columns: 1fr; }
  .media-actions > button { flex: 1 1 45%; }
}
</style>
