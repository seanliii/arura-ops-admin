<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Drama } from '../../shared/contracts'
import { DRAMA_TEXT_LOCALES, type DramaLocalizations, type DramaTextLocale } from '../../shared/drama-localizations'
import { api, message } from '../api'
import { OPERATOR_LANGUAGE_LABELS as labels } from '../../shared/catalog-channel'

const props = defineProps<{ drama: Drama; disabled?: boolean }>()
const emit = defineEmits<{ saved: [drama: Drama]; busy: [value: boolean]; dirty: [value: boolean] }>()
const titleLimit = 200, descLimit = 10000
const locale = ref<DramaTextLocale>(DRAMA_TEXT_LOCALES[0])
const form = reactive({ title: '', desc: '' })
const snapshot = ref('')
const busy = ref(false), needsRead = ref(false)
const error = ref(''), success = ref('')
const resultNotice = ref<HTMLElement>()
const dirty = computed(() => JSON.stringify(form) !== snapshot.value)
// 结果未知时，即使切语放弃输入，也不能让其他保存/刷新绕过版本核对。
const pending = computed(() => dirty.value || needsRead.value)
const published = computed(() => props.drama.status === 'published')
const blocked = computed(() => !!props.disabled || busy.value || published.value)
const direction = computed(() => locale.value === 'ar' ? 'rtl' : 'ltr')
const serverText = computed(() => props.drama.localizations?.[locale.value])
const toForm = (drama: Drama) => ({
  title: drama.localizations?.[locale.value]?.title ?? '',
  desc: drama.localizations?.[locale.value]?.desc ?? '',
})
let mounted = true, request: AbortController | undefined, acceptedVersion: number | undefined

function adopt(drama: Drama) {
  Object.assign(form, toForm(drama))
  snapshot.value = JSON.stringify(form)
}
watch(() => props.drama, (drama, previous) => {
  if (!previous || drama.id !== previous.id) {
    request?.abort(); busy.value = false; acceptedVersion = undefined
    needsRead.value = false; error.value = ''; success.value = ''
    locale.value = DRAMA_TEXT_LOCALES[0]
    adopt(drama)
  } else if (drama.version !== acceptedVersion) {
    if (pending.value) { needsRead.value = true; success.value = '' }
    else adopt(drama)
  }
}, { immediate: true })
watch(pending, value => emit('dirty', value), { flush: 'sync' })
watch(busy, value => emit('busy', value), { flush: 'sync' })
watch(form, () => { success.value = '' }, { flush: 'sync' })

function beforeUnload(event: BeforeUnloadEvent) {
  if (pending.value || busy.value) { event.preventDefault(); event.returnValue = '' }
}
window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => {
  mounted = false; request?.abort()
  window.removeEventListener('beforeunload', beforeUnload)
  emit('busy', false); emit('dirty', false)
})
function changeLocale(event: Event) {
  const select = event.target as HTMLSelectElement
  const next = select.value as DramaTextLocale
  if (blocked.value || !DRAMA_TEXT_LOCALES.includes(next) ||
    (dirty.value && !window.confirm('当前语言有尚未保存的文案。切换将放弃这些修改，是否继续？'))) {
    select.value = locale.value
    return
  }
  locale.value = next
  adopt(props.drama)
  success.value = ''
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')
function validLocalizations(value: unknown): value is DramaLocalizations {
  return record(value) && Object.entries(value).every(([key, text]) =>
    DRAMA_TEXT_LOCALES.includes(key as DramaTextLocale) && record(text) && Object.keys(text).length > 0 &&
    Object.entries(text).every(([field, content]) =>
      (field === 'title' || field === 'desc') && typeof content === 'string' && !!content.trim() &&
      content === content.trim() && content.length <= (field === 'title' ? titleLimit : descLimit)))
}
function validDrama(value: unknown): value is Drama {
  if (!record(value) || !validLocalizations(value.localizations)) return false
  if (!['title', 'desc', 'category', 'cover', 'language'].every(key => typeof value[key] === 'string') ||
    !['id', 'version', 'totalEpisodes', 'freeEpisodes', 'episodePrice', 'bundlePrice', 'createdAt', 'updatedAt']
      .every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) ||
    !['draft', 'published', 'archived'].includes(String(value.status)) ||
    typeof value.rightsConfirmed !== 'boolean' || typeof value.isSample !== 'boolean' ||
    !strings(value.regions) || !strings(value.tags) || !Array.isArray(value.episodes) ||
    !value.episodes.every(episode => record(episode) && typeof episode.title === 'string' &&
      Number.isSafeInteger(episode.id) && Number.isSafeInteger(episode.seq))) return false
  // 父级会同时刷新发行资料区；不能把破损的关联字段交给其表单。
  const metadata = value.registrationMetadata
  return metadata === undefined || (record(metadata) &&
    [null, 'released', 'unreleased'].includes(metadata.releaseStatus as null | string) &&
    ['year', 'dramaType', 'albumStatus', 'totalEpisodes'].every(key =>
      metadata[key] === null || Number.isSafeInteger(metadata[key])) &&
    Array.isArray(metadata.tagList) && metadata.tagList.every(Number.isSafeInteger))
}
function sameTexts(actual: DramaLocalizations, expected: DramaLocalizations) {
  return DRAMA_TEXT_LOCALES.every(key =>
    actual[key]?.title === expected[key]?.title && actual[key]?.desc === expected[key]?.desc)
}

async function perform(action: 'save' | 'refresh') {
  if (busy.value || props.disabled || (action === 'save' && (published.value || needsRead.value))) return
  const source = props.drama, id = source.id, version = source.version, language = locale.value
  const title = form.title.trim(), desc = form.desc.trim()
  if (action === 'save' && (title.length > titleLimit || desc.length > descLimit)) {
    error.value = `译名最多 ${titleLimit} 字，译文最多 ${descLimit} 字；均可留空。`
    return
  }
  const text = title || desc ? { title, desc } : null
  const expected = { ...source.localizations }
  if (text) expected[language] = { ...(title ? { title } : {}), ...(desc ? { desc } : {}) }
  else delete expected[language]
  const controller = request = new AbortController()
  const live = () => mounted && !controller.signal.aborted && props.drama.id === id
  busy.value = true; error.value = ''; success.value = ''
  try {
    // 使用默认 401 通知：登录失效立即由 App 卸载清屏，不缓存或跨账户重放草稿。
    const response = await api<unknown>(action === 'save' ? `/admin/dramas/${id}` : '/admin/dramas', {
      ...(action === 'save' ? { method: 'PATCH', body: { version, localizations: { [language]: text } } } : {}),
      signal: controller.signal,
    })
    if (!live()) return
    const latest: unknown = record(response)
      ? action === 'save' ? response.drama
        : Array.isArray(response.dramas) ? response.dramas.find(item => record(item) && item.id === id) : undefined
      : undefined
    if (!validDrama(latest) || latest.id !== id || latest.version < version ||
      (action === 'save' && (latest.version <= version || !sameTexts(latest.localizations!, expected) ||
        ['title', 'desc', 'language', 'regions'].some(key =>
          JSON.stringify(latest[key as keyof Drama]) !== JSON.stringify(source[key as keyof Drama]))))) {
      throw new Error('服务器尚未确认文案及版本，输入已保留。请先刷新服务器文案核对，不要重复保存。')
    }
    acceptedVersion = latest.version
    if (action === 'save' || !dirty.value) Object.assign(form, toForm(latest))
    snapshot.value = JSON.stringify(toForm(latest))
    needsRead.value = false
    emit('saved', latest)
    await nextTick()
    if (!live()) return
    if (action === 'save') {
      success.value = '当前语言文案已保存；仅存后台，平台同步需重新核对，不会自动请求平台。'
      await nextTick()
      resultNotice.value?.focus({ preventScroll: true })
    } else {
      success.value = '已读取服务器版本。下方展示服务器已保存文案；本页未保存输入保留，请核对后再决定保存。'
    }
  } catch (cause) {
    if (!live()) return
    error.value = message(cause); needsRead.value = true
  } finally {
    if (live()) { request = undefined; busy.value = false }
  }
}
</script>

<template>
  <section class="panel localization-editor" aria-label="多语剧名与简介" :aria-busy="busy">
    <div class="section-heading"><div><h3>多语剧名与简介</h3><p class="muted">每次编辑、独立保存一种语言；不同频道可以有不同剧，不必一次填写全部语言。</p></div></div>
    <p class="notice">译名或译文为空时，对应字段回到原文。本区不会改变原始标题、简介、内容语言或发行地区，也不会自动翻译配音或字幕。保存不会自动登记、提审或上架平台。</p>
    <div class="localization-original">
      <h4>原始文案（只读对照）</h4>
      <p data-testid="localization-original-title" dir="auto">{{ drama.title }}</p>
      <p data-testid="localization-original-desc" dir="auto">{{ drama.desc }}</p>
    </div>
    <p v-if="published" class="notice warning">已发布内容不可编辑，请先下架。</p>
    <p v-else-if="disabled && !busy" class="notice warning">请先保存或放弃其他编辑区的修改，并等待上传、保存或平台操作结束，再编辑多语文案。</p>
    <p v-if="error" role="alert" class="notice error" data-testid="localization-error">{{ error }}</p>
    <p v-if="needsRead" class="notice warning">尚未确认服务器结果。请先刷新服务器文案，保留本页输入后核对，再决定是否保存；不会自动重试。</p>
    <button v-if="needsRead" type="button" class="button" data-testid="localization-refresh"
      :disabled="busy || disabled" @click="perform('refresh')">刷新服务器文案并保留输入</button>
    <form @submit.prevent="perform('save')">
      <fieldset :disabled="blocked" class="form-grid">
        <label class="field span-2">
          <span>文案语言</span>
          <select :value="locale" data-testid="localization-locale" @change="changeLocale">
            <option v-for="key in DRAMA_TEXT_LOCALES" :key="key" :value="key" :lang="key">{{ labels[key] }} · {{ key }}</option>
          </select>
        </label>
        <label class="field span-2">
          <span>译名（可留空）</span>
          <textarea v-model="form.title" rows="2" :maxlength="titleLimit" autocomplete="off" data-testid="localization-title"
            :lang="locale" :dir="direction" :placeholder="drama.title"></textarea>
        </label>
        <label class="field span-2">
          <span>译文简介（可留空）</span>
          <textarea v-model="form.desc" rows="5" :maxlength="descLimit" autocomplete="off" data-testid="localization-desc"
            :lang="locale" :dir="direction" :placeholder="drama.desc"></textarea>
        </label>
      </fieldset>
      <div class="form-actions">
        <button class="button primary" type="submit" :disabled="blocked || needsRead">保存当前语言文案</button>
        <span class="muted small-text">{{ busy ? '正在确认服务器结果…' : '只保存当前语言；两项全空会删除该语言文案。' }}</span>
      </div>
    </form>
    <p v-if="success" ref="resultNotice" tabindex="-1" role="status" class="notice" data-testid="localization-success">{{ success }}</p>
    <div class="localization-comparison">
      <div>
        <h4>当前输入预览（空白回原文）</h4>
        <p data-testid="localization-preview-title" :lang="form.title.trim() ? locale : undefined" dir="auto">{{ form.title.trim() || drama.title }}</p>
        <p data-testid="localization-preview-desc" :lang="form.desc.trim() ? locale : undefined" dir="auto">{{ form.desc.trim() || drama.desc }}</p>
      </div>
      <div>
        <h4>服务器已保存文案 · v{{ drama.version }}（供核对）</h4>
        <p data-testid="localization-server-title" :lang="serverText?.title ? locale : undefined" dir="auto">{{ serverText?.title || drama.title }}</p>
        <p data-testid="localization-server-desc" :lang="serverText?.desc ? locale : undefined" dir="auto">{{ serverText?.desc || drama.desc }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.localization-editor { min-width: 0; overflow-wrap: anywhere; }
.localization-editor .notice { display: block; }
.localization-editor form { margin-top: 1rem; }
.localization-editor select, .localization-editor textarea { width: 100%; min-width: 0; max-width: 100%; min-height: 44px; }
.localization-editor textarea { resize: vertical; }
.localization-editor [role="status"] { margin-top: 1rem; }
.localization-original, .localization-comparison > div { min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 18px; }
.localization-original p, .localization-comparison p { white-space: pre-wrap; max-height: 18rem; overflow: auto; }
.localization-comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 18px; }
@media (max-width: 720px) { .localization-comparison { grid-template-columns: minmax(0, 1fr); } }
</style>
