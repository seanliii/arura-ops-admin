<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { api, message, formatDate } from '../api'
import type { MediaDeliveryState } from '../../shared/media-delivery'
import { DELIVERY_STATUS_LABELS } from '../../shared/media-delivery'
import Feedback from './Feedback.vue'
import DeliveryWorkTimer from './DeliveryWorkTimer.vue'

const props = defineProps<{ dramaId: number; version: number; episodeCount: number; disabled?: boolean; uploadMode?: boolean }>()
const emit = defineEmits<{ changed: []; busy: [value: boolean]; requested: [value: boolean]; active: [value: boolean] }>()
const expanded = ref(false), working = ref(false), loading = ref(false), confirmed = ref(false), autoPublish = ref(false)
const timerLocked = ref(false)
const state = ref<MediaDeliveryState | null>(null), error = ref(''), success = ref(''), needsRead = ref(false)
const expected = ref(Math.max(1, props.episodeCount))
const job = computed(() => state.value?.job)
const active = computed(() => !!job.value && !['complete', 'cancelled'].includes(job.value.status))
let mounted = true, generation = 0, readId = 0, timer: ReturnType<typeof setTimeout> | undefined
let notifiedVersion = 0, controller: AbortController | undefined
let pending: { fingerprint: string; requestId: string } | undefined
watch(() => working.value || timerLocked.value, value => emit('busy', value), { flush: 'sync' })
watch(timerLocked, value => {
  if (value) { readId++; controller?.abort(); loading.value = false; clearTimeout(timer) }
  else schedule()
}, { flush: 'sync' })
watch(confirmed, value => emit('requested', value))
watch(active, value => emit('active', value))
watch(() => props.episodeCount, value => { if (!active.value) expected.value = Math.max(1, value) })
watch(() => props.dramaId, () => {
  generation++; readId++; clearTimeout(timer); controller?.abort(); state.value = null; confirmed.value = false
  error.value = ''; success.value = ''; needsRead.value = false; pending = undefined
  if (expanded.value) void load()
})
onBeforeUnmount(() => { mounted = false; generation++; clearTimeout(timer); controller?.abort(); emit('busy', false); emit('requested', false) })
function schedule() {
  clearTimeout(timer)
  if (mounted && expanded.value && active.value && !timerLocked.value) timer = setTimeout(() => void load(true), 5000)
}
async function load(quiet = false) {
  if (!mounted || loading.value || working.value || timerLocked.value) return
  clearTimeout(timer)
  const epoch = generation, id = props.dramaId, ticket = ++readId
  controller?.abort()
  const abort = controller = new AbortController()
  loading.value = !quiet
  try {
    const value = await api<MediaDeliveryState>(`/admin/dramas/${id}/delivery`, { signal: abort.signal })
    if (!mounted || epoch !== generation || ticket !== readId || abort.signal.aborted || id !== props.dramaId) return
    if (value.dramaId !== id || !Number.isSafeInteger(value.localVersion) || !Array.isArray(value.reasons)) throw new Error('交付回执不完整，请重新读取')
    state.value = value; error.value = ''; needsRead.value = false
    if (value.localVersion !== props.version && notifiedVersion !== value.localVersion) {
      notifiedVersion = value.localVersion; emit('changed')
    }
  } catch (e) { if (mounted && epoch === generation && ticket === readId && !abort.signal.aborted) { error.value = message(e); needsRead.value = true } }
  finally { if (mounted && epoch === generation && ticket === readId) { loading.value = false; schedule() } }
}
function toggle(event: Event) {
  expanded.value = (event.currentTarget as HTMLDetailsElement).open
  if (expanded.value) void load()
  else clearTimeout(timer)
}
async function authorize(count = expected.value): Promise<boolean> {
  if (props.disabled || working.value || timerLocked.value || !confirmed.value || needsRead.value || active.value || !state.value?.configured) return false
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000) { error.value = '请填写本批最终集数，不是预计全剧总集数'; return false }
  const id = props.dramaId, epoch = generation, version = state.value.localVersion
  const input = { version, expectedEpisodes: count, autoPublish: autoPublish.value, confirmed: true }
  const fingerprint = JSON.stringify([id, input])
  if (pending?.fingerprint !== fingerprint) pending = { fingerprint, requestId: crypto.randomUUID() }
  working.value = true; readId++; controller?.abort(); loading.value = false; clearTimeout(timer); error.value = ''; success.value = ''
  try {
    const value = await api<MediaDeliveryState>(`/admin/dramas/${id}/delivery`, {
      method: 'POST', body: { ...input, requestId: pending.requestId },
    })
    if (!mounted || epoch !== generation || id !== props.dramaId) return false
    if (value.dramaId !== id || !value.job || value.job.dramaId !== id ||
      value.job.expectedEpisodes !== count || value.job.autoPublish !== autoPublish.value) throw new Error('服务器未确认这份交付任务，请先读取原任务，不要重新开始')
    state.value = value; pending = undefined; confirmed.value = false
    success.value = '本批自动交付已安排。文件全部上传核验完成后，可关闭页面；后续登记、审核查询由服务器继续。'
    emit('changed')
    return true
  } catch (e) { if (mounted && epoch === generation) { error.value = message(e); needsRead.value = true } return false }
  finally { working.value = false; schedule() }
}
async function operate(action: 'pause' | 'resume' | 'cancel' | 'publish') {
  if (!job.value?.owner || working.value || timerLocked.value || props.disabled || !state.value) return
  if (['cancel', 'publish'].includes(action) && !window.confirm(action === 'publish'
    ? '确认将已核对通过的当前版本上架，并发布到本应用片库？不会开启真钱收费或发布整个应用。'
    : '停止后续自动交付？已提交的审核或上架请求不能撤回，原视频和回执不会删除。')) return
  const id = props.dramaId, epoch = generation
  working.value = true; readId++; controller?.abort(); loading.value = false; clearTimeout(timer); error.value = ''; success.value = ''
  try {
    const value = await api<MediaDeliveryState>(`/admin/dramas/${id}/delivery/${job.value.id}/${action}`, {
      method: 'POST', body: ['resume', 'publish'].includes(action) ? { version: props.version, confirmed: true } : {},
    })
    if (!mounted || epoch !== generation) return
    if (value.dramaId !== id || value.job?.id !== job.value.id) throw new Error('原任务回执不匹配，请重新读取')
    state.value = value; emit('changed')
  } catch (e) { if (mounted && epoch === generation) { error.value = message(e); needsRead.value = true } }
  finally { working.value = false; schedule() }
}
defineExpose({ authorize, load })
</script>
<template>
  <details class="panel delivery-panel" aria-label="自动交付TikTok" @toggle="toggle">
    <summary><strong>自动交付到 TikTok</strong><span>{{ uploadMode ? '上传完成后由服务器接着处理' : '一次确认，自动登记、提审和查询结果' }}</span></summary>
    <p v-if="timerLocked" class="notice small-text" role="status">本批有待核对的计时操作，请展开后核对原操作，再切换剧目或返回。自动交付不会因此停止。</p>
    <div v-show="expanded" class="delivery-body">
      <p class="notice">不用再去两个后台重复建剧。系统按本批实际成片登记；审核由TikTok完成。只有明确选择“通过后自动上架”才会公开本版本，普通保存草稿不触发发布。</p>
      <Feedback :loading="loading" :error="error" :success="success" />
      <button type="button" class="button small" data-testid="delivery-refresh" :disabled="working || loading || timerLocked" @click="load()">刷新交付任务</button>
      <div v-if="state && !state.configured" class="notice warning"><strong>当前环境不能执行真实TikTok交付</strong><ul><li v-for="reason in state.reasons" :key="reason">{{ reason }}</li></ul></div>
      <section v-if="job" class="delivery-status" aria-label="交付任务状态" :data-status="job.status">
        <h3>{{ DELIVERY_STATUS_LABELS[job.status] }}</h3>
        <p role="status">{{ job.message }}</p>
        <dl><dt>本批集数</dt><dd>{{ job.expectedEpisodes }}</dd><dt>通过后自动上架</dt><dd>{{ job.autoPublish ? '是' : '否，仅提审' }}</dd><dt>最后更新</dt><dd>{{ formatDate(job.updatedAt) }}</dd></dl>
        <p v-if="job.nextRunAt" class="muted">下次计划查询：{{ formatDate(job.nextRunAt) }}；不需要反复点击。</p>
        <p v-if="job.albumId" class="muted">平台剧目 {{ job.albumId }} · 内容版本 {{ job.platformVersion ?? '登记中' }}</p>
        <p v-if="job.errorCode" class="mono small-text">{{ job.errorCode }}</p>
        <div v-if="job.owner" class="inline wrap">
          <button v-if="job.canPause" type="button" class="button" :disabled="working || timerLocked" @click="operate('pause')">暂停自动处理</button>
          <button v-if="job.canResume && job.status !== 'ready_to_publish'" type="button" class="button" :disabled="working || needsRead || timerLocked" @click="operate('resume')">确认当前资料并继续</button>
          <button v-if="job.status === 'ready_to_publish'" type="button" class="button primary" :disabled="working || needsRead || timerLocked" @click="operate('publish')">上架并发布片库</button>
          <button v-if="active" type="button" class="button" :disabled="working || timerLocked" @click="operate('cancel')">取消后续交付</button>
        </div>
        <p v-else class="muted">此任务由另一管理员确认，仅展示状态，不接管其授权。</p>
        <DeliveryWorkTimer :key="job.id" :job-id="job.id" :disabled="working || disabled" @locked="timerLocked = $event" />
      </section>
      <fieldset v-if="!active" :disabled="disabled || working || timerLocked || !state?.configured || needsRead">
        <label class="field"><span>本批交付完成时共多少集</span><input v-model.number="expected" data-testid="delivery-episode-count" type="number" min="1" max="10000" step="1" :readonly="uploadMode" /><small>等待这批集数全部到齐再登记，不把第一集上传完成当整批完成。</small></label>
        <label class="checkbox"><input v-model="autoPublish" type="checkbox" data-testid="delivery-auto-publish" /><span>审核通过后，自动设置在线版本、授权当前App、上架并发布到本应用片库</span></label>
        <label class="checkbox"><input v-model="confirmed" type="checkbox" data-testid="delivery-confirm" /><span>我已确认本批内容、音轨、版权和发行资料，允许服务器在上传完成后自动登记并提交TikTok审核。{{ autoPublish ? '本批同时授权通过后自动上架。' : '本批只自动提审，不自动上架。' }}不改变价格，不开启真实支付。</span></label>
        <button v-if="!uploadMode" type="button" class="button primary" data-testid="delivery-start" :disabled="!confirmed || working" @click="authorize()">一键交付到TikTok</button>
        <p v-else class="muted">勾选确认后，使用下面的“上传并自动交付”开始本批。</p>
      </fieldset>
      <p class="muted small-text">文件还在传输时须保留上传页面；全部文件核验后，服务器持久任务不依赖浏览器。暂停不能撤回已发出的平台请求，已保存回执和源文件不会删除。</p>
    </div>
  </details>
</template>
<style scoped>
summary { cursor:pointer; display:flex; flex-wrap:wrap; align-items:center; gap:8px 18px; min-height:44px; }
summary span { color:var(--muted); font-size: 1rem; }
.delivery-body { display:grid; gap:16px; padding-block-start:18px; }
fieldset { border:0; min-width:0; display:grid; gap:18px; }
.delivery-status { border:1px solid var(--line); border-radius:12px; padding:18px; display:grid; gap:12px; overflow-wrap:anywhere; }
dl { display:grid; grid-template-columns: minmax(100px,1fr) 2fr; gap:8px 16px; font-size: 1rem; } dt { color:var(--muted); }
ul { padding-inline-start:20px; }
</style>
