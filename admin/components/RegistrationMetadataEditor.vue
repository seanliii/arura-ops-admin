<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Drama, SessionInfo } from '../../shared/contracts'
import { emptyRegistrationMetadata, type RegistrationMetadata } from '../../shared/registration-metadata'
import { api, ApiError, message, SESSION_EXPIRED } from '../api'

const props = defineProps<{ drama: Drama; disabled?: boolean }>()
const emit = defineEmits<{ saved: [drama: Drama]; busy: [value: boolean]; dirty: [value: boolean] }>()
const toForm = (metadata = emptyRegistrationMetadata()) => ({
  releaseStatus: metadata.releaseStatus ?? '', year: metadata.year === null ? '' : String(metadata.year),
  dramaType: metadata.dramaType === null ? '' : String(metadata.dramaType),
  albumStatus: metadata.albumStatus === null ? '' : String(metadata.albumStatus),
  totalEpisodes: metadata.totalEpisodes === null ? '' : String(metadata.totalEpisodes),
  tagIds: [...metadata.tagList].sort((a, b) => a - b).join(', '),
})
const form = reactive(toForm())
const snapshot = ref('')
const busy = ref(false), needsRead = ref(false), expired = ref(false)
const error = ref(''), success = ref('')
const resultNotice = ref<HTMLElement>()
const dirty = computed(() => JSON.stringify(form) !== snapshot.value)
const published = computed(() => props.drama.status === 'published')
const blocked = computed(() => !!props.disabled || busy.value || published.value || expired.value)
const yearLabel = computed(() => form.releaseStatus === 'unreleased' ? '计划首发年份' : '首次发行年份')
let ownerId: string | undefined, acceptedVersion: number | undefined
let mounted = true, request: AbortController | undefined

watch(() => props.drama, (drama, previous) => {
  if (!previous || drama.id !== previous.id || !dirty.value) {
    Object.assign(form, toForm(drama.registrationMetadata))
    snapshot.value = JSON.stringify(form)
    if (previous && drama.id !== previous.id) {
      request?.abort(); ownerId = undefined; acceptedVersion = undefined
      error.value = ''; success.value = ''; needsRead.value = false; expired.value = false
    }
  } else if (drama.version !== previous.version && drama.version !== acceptedVersion) {
    // 基础信息或其他管理员更新了版本：不覆盖未保存输入，也不悄悄重试。
    needsRead.value = true; success.value = ''
  }
}, { immediate: true })
watch(dirty, value => { emit('dirty', value); success.value = '' })
watch(busy, value => emit('busy', value), { flush: 'sync' })

function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = '' }
}
window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => {
  mounted = false; request?.abort()
  window.removeEventListener('beforeunload', beforeUnload)
  emit('busy', false); emit('dirty', false)
})

function numberOrNull(value: string, label: string, min: number, max: number): number | null {
  if (!value.trim()) return null
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label}须为 ${min}–${max} 的整数，也可暂不填写。`)
  }
  return number
}
function payload(): RegistrationMetadata {
  const year = numberOrNull(form.year, yearLabel.value, 1900, 2200)
  const totalEpisodes = numberOrNull(form.totalEpisodes, '预计总集数', 1, 10000)
  const tagList = !form.tagIds.trim() ? [] : [...new Set(form.tagIds.split(/[,，]/).map(part => {
    const tag = numberOrNull(part.trim(), '平台标签 ID', 1, 2147483647)
    if (tag === null) throw new Error('平台标签 ID 之间不能有空项；未知标签时可全部留空。')
    return tag
  }))].sort((a, b) => a - b)
  if (tagList.length > 20) throw new Error('平台标签 ID 最多填写 20 个不同 ID，也可暂不填写。')
  return {
    releaseStatus: (form.releaseStatus || null) as RegistrationMetadata['releaseStatus'],
    year, totalEpisodes, tagList,
    dramaType: (form.dramaType ? Number(form.dramaType) : null) as RegistrationMetadata['dramaType'],
    albumStatus: (form.albumStatus ? Number(form.albumStatus) : null) as RegistrationMetadata['albumStatus'],
  }
}
function sameMetadata(actual: RegistrationMetadata | undefined, expected: RegistrationMetadata): boolean {
  return !!actual && actual.releaseStatus === expected.releaseStatus && actual.year === expected.year &&
    actual.dramaType === expected.dramaType && actual.albumStatus === expected.albumStatus &&
    actual.totalEpisodes === expected.totalEpisodes && Array.isArray(actual.tagList) &&
    JSON.stringify([...actual.tagList].sort((a, b) => a - b)) === JSON.stringify(expected.tagList)
}
async function checkOwner(signal: AbortSignal) {
  // 401 在本区暂停写入并保留输入；重登后必须是同一管理员，不能跨账户重放草稿。
  const { user } = await api<SessionInfo>('/auth/me', { signal, notify401: false })
  if (!user || user.role !== 'admin') throw new ApiError(401, 'SESSION_EXPIRED', '请先在另一标签页重新登录同一管理员，再回此页刷新。')
  if (ownerId !== undefined && ownerId !== user.id) {
    window.dispatchEvent(new Event(SESSION_EXPIRED))
    throw new ApiError(401, 'SESSION_CHANGED', '管理员已变化，请重新打开剧目，不能沿用前一账户的草稿。')
  }
  ownerId = user.id
}
async function perform(action: 'save' | 'refresh') {
  if (busy.value || props.disabled || (action === 'save' && (published.value || expired.value || needsRead.value))) return
  let metadata: RegistrationMetadata | undefined
  if (action === 'save') {
    try { metadata = payload() }
    catch (cause) { error.value = message(cause); success.value = ''; return }
  }
  const id = props.drama.id, version = props.drama.version
  const controller = request = new AbortController()
  const live = () => mounted && !controller.signal.aborted && props.drama.id === id
  busy.value = true; error.value = ''; success.value = ''
  try {
    await checkOwner(controller.signal)
    if (!live()) return
    const latest = action === 'save'
      ? (await api<{ drama: Drama }>(`/admin/dramas/${id}`, {
        method: 'PATCH', body: { version, registrationMetadata: metadata },
        signal: controller.signal, notify401: false,
      })).drama
      : (await api<{ dramas: Drama[] }>('/admin/dramas', {
        signal: controller.signal, notify401: false,
      })).dramas.find(drama => drama.id === id)
    if (!live()) return
    if (!latest || latest.id !== id || !Number.isSafeInteger(latest.version) ||
      latest.version < version || (action === 'save' && (latest.version <= version || !sameMetadata(latest.registrationMetadata, metadata!)))) {
      throw new Error('服务器尚未确认本次资料及新版本，输入已保留。请先刷新服务器资料核对，不要重复保存。')
    }
    acceptedVersion = latest.version
    if (action === 'save' || !dirty.value) Object.assign(form, toForm(latest.registrationMetadata))
    snapshot.value = JSON.stringify(toForm(latest.registrationMetadata))
    needsRead.value = false; expired.value = false
    emit('saved', latest)
    await nextTick()
    if (!live()) return
    if (action === 'save') {
      success.value = '发行资料已由服务器确认，仅存后台，不会登记/审核/发布。'
      await nextTick()
      resultNotice.value?.focus({ preventScroll: true })
    }
  } catch (cause) {
    if (!live()) return
    error.value = message(cause); needsRead.value = true
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) expired.value = true
  } finally {
    if (live()) { request = undefined; busy.value = false }
  }
}
</script>

<template>
  <section class="panel registration-metadata" aria-label="发行与制作资料" :aria-busy="busy">
    <div class="section-heading"><div><h3>发行与制作资料</h3><p class="muted">分步填写、独立保存。草稿和未齐全的资料也可保存。</p></div></div>
    <p class="notice">保存仅存后台，不会登记/审核/发布。“尚未发行”与“连载中”可以同时成立，分别描述此前发行情况和制作进度。</p>
    <p class="muted">内容语言：{{ drama.language || '未填写' }} · 发行地区：{{ drama.regions.join(', ') || '未设置' }}。原声、地区及版权确认沿用上方基础信息，本区不会更改价格或字幕。</p>
    <p data-testid="metadata-uploaded-count">已上传 {{ drama.episodes.length }} 集，不代表全剧总集数。</p>
    <p v-if="published" class="notice warning">已发布内容不可编辑，请先下架。</p>
    <p v-else-if="disabled && !busy" class="notice warning">请先保存上方基础资料，或等待上传及其他操作结束，再保存发行资料。</p>
    <p v-if="error" role="alert" class="notice error" data-testid="metadata-error">{{ error }}</p>
    <p v-if="expired" class="notice warning">登录失效，已暂停写入，未保存输入保留在此页。请在另一标签页登录同一管理员，再点击下方刷新；离开本页可能丢失未保存输入。</p>
    <p v-if="needsRead" class="notice warning">尚未确认当前服务器版本。请先刷新服务器资料，保留本页输入后核对，再决定是否保存；不会自动重试。</p>
    <button v-if="needsRead" type="button" class="button" data-testid="metadata-refresh" :disabled="busy || disabled" @click="perform('refresh')">刷新服务器资料并保留输入</button>
    <form novalidate @submit.prevent="perform('save')">
      <fieldset :disabled="blocked" class="form-grid">
        <label class="field">
          <span>此前发行情况</span>
          <select v-model="form.releaseStatus" data-testid="metadata-release-status">
            <option value="">暂未填写</option><option value="unreleased">尚未发行</option><option value="released">已经发行</option>
          </select>
        </label>
        <label class="field">
          <span>{{ yearLabel }}</span>
          <input v-model="form.year" data-testid="metadata-year" :aria-label="yearLabel" type="text" inputmode="numeric" maxlength="4" autocomplete="off" />
          <small>可暂不填写，不默认今年。未发行填计划年份，已发行填首次实际发行年份。</small>
        </label>
        <label class="field">
          <span>制作类型</span>
          <select v-model="form.dramaType" data-testid="metadata-drama-type">
            <option value="">暂未填写</option><option value="1">AI制作（AIGC）</option><option value="2">漫剧</option>
            <option value="3">真人配音</option><option value="4">真人本地化</option>
          </select>
        </label>
        <label class="field">
          <span>制作进度</span>
          <select v-model="form.albumStatus" data-testid="metadata-album-status">
            <option value="">暂未填写</option><option value="2">连载中（未完结）</option><option value="3">已完结</option>
          </select>
        </label>
        <label class="field span-2">
          <span>预计总集数（可暂不填）</span>
          <input v-model="form.totalEpisodes" data-testid="metadata-total-episodes" type="text" inputmode="numeric" autocomplete="off" />
          <small>填写预计整部作品的集数；尚不确定可留空，不会用已上传集数代填。</small>
        </label>
        <details class="span-2 metadata-advanced">
          <summary>高级：平台标签 ID</summary>
          <label class="field">
            <span>平台标签 ID（可暂不填）</span>
            <input v-model="form.tagIds" data-testid="metadata-tag-ids" type="text" autocomplete="off" placeholder="已确认的 ID，以逗号分隔" />
            <small>仅填写平台提供的真实分类 ID，最多 20 个。尚无确认的字典时留空，不提供猜测标签或默认 ID。</small>
          </label>
        </details>
      </fieldset>
      <div class="form-actions">
        <button class="button primary" type="submit" :disabled="blocked || needsRead">{{ busy ? '正在确认服务器资料…' : '保存发行资料' }}</button>
        <span class="muted small-text">与基础信息分开保存；年份、总集数和平台标签均可留空。</span>
      </div>
    </form>
    <p v-if="success" ref="resultNotice" tabindex="-1" role="status" class="notice" data-testid="metadata-success">{{ success }}</p>
  </section>
</template>

<style scoped>
.registration-metadata { min-width: 0; overflow-wrap: anywhere; }
.registration-metadata .notice { display: block; }
.registration-metadata form { margin-top: 1rem; }
.registration-metadata select { min-height: 44px; }
.registration-metadata [role="status"] { margin-top: 1rem; }
.metadata-advanced { min-width: 0; }
.metadata-advanced summary { cursor: pointer; padding: .75rem 0; min-height: 44px; }
.metadata-advanced .field { margin-top: .75rem; }
</style>
