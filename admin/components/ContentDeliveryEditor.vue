<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Drama, SessionInfo } from '../../shared/contracts'
import { DRAMA_TEXT_LOCALES } from '../../shared/drama-localizations'
import { OPERATOR_LANGUAGE_LABELS as CONTENT_LANGUAGE_LABELS } from '../../shared/catalog-channel'
import { audienceLanguage } from '../../shared/content-delivery'
import { api, ApiError, message } from '../api'
import Feedback from './Feedback.vue'
const props = defineProps<{ drama: Drama; disabled: boolean }>()
const emit = defineEmits<{ saved: [drama: Drama]; busy: [value: boolean]; dirty: [value: boolean] }>()
const toForm = (d: Drama) => ({
  contentLocale: audienceLanguage(d) ?? '', subtitleMode: d.delivery?.subtitleMode ?? 'unknown',
  subtitleLanguage: d.delivery?.subtitleLanguage ?? '', label: d.delivery?.label ?? '',
  master: d.productionSources?.master ?? '', audio: d.productionSources?.audio ?? '',
  subtitles: d.productionSources?.subtitles ?? '', notes: d.productionSources?.notes ?? '',
})
const form = reactive<Record<keyof ReturnType<typeof toForm>, string>>(toForm(props.drama))
const baseline = ref(''), busy = ref(false), error = ref(''), success = ref(''), needsRead = ref(false), expired = ref(false)
const dirty = computed(() => JSON.stringify(form) !== baseline.value)
let mounted = true, request: AbortController | undefined, ownerId: string | undefined, acceptedVersion: number | undefined
watch(() => props.drama, (d, previous) => {
  if (!previous || d.id !== previous.id || !dirty.value) {
    Object.assign(form, toForm(d))
    baseline.value = JSON.stringify(form); error.value = ''; success.value = ''
    if (previous && d.id !== previous.id) {
      request?.abort(); ownerId = undefined; acceptedVersion = undefined; needsRead.value = false; expired.value = false
    }
  } else if (d.version !== previous.version && d.version !== acceptedVersion) {
    needsRead.value = true; success.value = ''
  }
}, { immediate: true })
watch(dirty, value => { emit('dirty', value); success.value = '' }, { immediate: true })
watch(() => form.subtitleMode, value => { if (value === 'none' || value === 'unknown') form.subtitleLanguage = '' })
onBeforeUnmount(() => { mounted = false; request?.abort(); emit('busy', false); emit('dirty', false) })
async function checkOwner(signal: AbortSignal) {
  const { user } = await api<SessionInfo>('/auth/me', { signal, notify401: false })
  if (!user || user.role !== 'admin') throw new ApiError(401, 'SESSION_EXPIRED', '登录已过期，请在另一标签页登录同一管理员，再回来刷新成片资料。')
  if (ownerId !== undefined && ownerId !== user.id) throw new ApiError(401, 'SESSION_CHANGED', '管理员已变化，请重新打开剧目，不能沿用前一账户的未保存输入。')
  ownerId = user.id
}
async function perform(action: 'save' | 'refresh') {
  if (props.disabled || busy.value || (action === 'save' && (props.drama.status === 'published' || needsRead.value || expired.value))) return
  const d = props.drama, controller = request = new AbortController()
  const live = () => mounted && !controller.signal.aborted && request === controller && props.drama.id === d.id
  busy.value = true; emit('busy', true); error.value = ''; success.value = ''
  const delivery = { contentLocale: form.contentLocale || null, subtitleMode: form.subtitleMode, subtitleLanguage: form.subtitleLanguage || null, label: form.label.trim() }
  const productionSources = { master: form.master.trim(), audio: form.audio.trim(), subtitles: form.subtitles.trim(), notes: form.notes.trim() }
  try {
    await checkOwner(controller.signal)
    if (!live()) return
    const latest = action === 'save'
      ? (await api<{ drama: Drama }>(`/admin/dramas/${d.id}`, {
        method: 'PATCH', body: { version: d.version, delivery, productionSources }, signal: controller.signal, notify401: false,
      })).drama
      : (await api<{ dramas: Drama[] }>('/admin/dramas', { signal: controller.signal, notify401: false })).dramas.find(row => row.id === d.id)
    if (!live()) return
    if (!latest || latest.id !== d.id || !Number.isSafeInteger(latest.version) || latest.version < props.drama.version ||
      (action === 'save' && (latest.version !== d.version + 1 ||
        JSON.stringify(latest.delivery) !== JSON.stringify(delivery) ||
        JSON.stringify(latest.productionSources) !== JSON.stringify(productionSources)))) {
      throw new Error('保存回执与填写内容不一致，输入已保留。请刷新成片资料核对，不要重复提交。')
    }
    const serverForm = toForm(latest)
    if (action === 'refresh') {
      const previous = JSON.parse(baseline.value) as typeof form
      // Preserve edited fields; adopt server updates to untouched fields so saving does not undo a colleague's work.
      for (const key of Object.keys(form) as (keyof typeof form)[]) {
        if (form[key] === previous[key]) form[key] = serverForm[key]
      }
    } else Object.assign(form, serverForm)
    baseline.value = JSON.stringify(serverForm)
    acceptedVersion = latest.version; needsRead.value = false; expired.value = false
    emit('saved', latest)
    await nextTick()
    if (!live()) return
    success.value = action === 'save'
      ? '成片资料与私有留档索引已保存。原视频、订单和平台记录未替换。'
      : '已读取服务器版本；本页改过的字段保留，请核对后再保存。'
  } catch (e) {
    if (!live()) return
    error.value = message(e)
    needsRead.value = !(e instanceof ApiError && e.status === 400)
    if (e instanceof ApiError && [401, 403].includes(e.status)) expired.value = true
  } finally {
    if (live()) { request = undefined; busy.value = false; emit('busy', false) }
  }
}
</script>
<template>
  <form class="panel delivery-editor" aria-label="本地化成片与制作留档" @submit.prevent="perform('save')">
    <div class="section-heading"><div><h3>观众语言与字幕</h3><p class="muted">这部成片给哪种语言的观众看？按实际配音或字幕选择即可。</p></div><span class="badge">原声：{{ CONTENT_LANGUAGE_LABELS[drama.language] ?? drama.language }}</span></div>
    <Feedback :error="error" :success="success" />
    <p v-if="expired" class="notice warning">已暂停写入，未保存输入仍在本页。请在另一标签页登录同一管理员后再刷新。</p>
    <p v-if="needsRead" class="notice warning">尚未确认服务器当前资料，不会自动重试保存。先读取最新版本，保留本页改过的字段，再核对。</p>
    <button v-if="needsRead" type="button" class="button" :disabled="disabled || busy" @click="perform('refresh')">刷新成片资料并保留输入</button>
    <fieldset class="form-grid" :disabled="disabled || busy || drama.status === 'published'">
      <label class="field"><span>主要服务的内容语言</span><select v-model="form.contentLocale" aria-label="主要服务的内容语言"><option value="">尚未确认</option><option v-for="code in DRAMA_TEXT_LOCALES" :key="code" :value="code">{{ CONTENT_LANGUAGE_LABELS[code] }}</option></select><small>例如英语配音加日语字幕，可以放入日语频道。</small></label>
      <label class="field"><span>字幕方式</span><select v-model="form.subtitleMode" aria-label="字幕方式"><option value="unknown">尚未确认</option><option value="none">无字幕</option><option value="burned">画面自带（烧录字幕）</option><option value="external">独立字幕文件（可切换）</option></select></label>
      <label v-if="['burned','external'].includes(form.subtitleMode)" class="field"><span>字幕语言</span><select v-model="form.subtitleLanguage" aria-label="字幕语言" required><option value="">请选择字幕语言</option><option v-for="code in DRAMA_TEXT_LOCALES" :key="code" :value="code">{{ CONTENT_LANGUAGE_LABELS[code] }}</option></select></label>
      <p v-if="form.subtitleMode === 'burned'" class="muted small-text span-2">视频画面已有字幕，不需要再上传字幕文件，也不能在播放器中关闭。</p>
      <p v-else-if="form.subtitleMode === 'external'" class="notice span-2">请给每集关联对应字幕文件，不能只勾选“有字幕”。</p>
      <details class="source-intro span-2"><summary>制作留档与版本备注（可选）</summary>
      <p class="muted">已有成片可以直接运营。以下仅为以后重新配音、改字幕保留资料位置；没有这些文件可不填。</p>
      <div class="form-grid">
      <label class="field"><span>成片标识</span><input v-model="form.label" aria-label="成片标识" maxlength="80" placeholder="例如：英语原声 · 日语字幕版" /></label>
      <label class="field"><span>无字母版位置</span><input v-model="form.master" aria-label="无字母版位置" maxlength="1500" placeholder="受控存储的素材编号／目录" /></label>
      <label class="field"><span>分离音轨位置</span><input v-model="form.audio" aria-label="分离音轨位置" maxlength="1500" placeholder="对白／音乐音效分轨目录" /></label>
      <label class="field"><span>可编辑字幕位置</span><input v-model="form.subtitles" aria-label="可编辑字幕位置" maxlength="1500" placeholder="字幕时间轴／工程目录" /></label>
      <label class="field"><span>制作备注</span><textarea v-model="form.notes" aria-label="制作备注" rows="2" maxlength="1500" /></label>
      </div><small>仅管理员可见。不要填密码或临时签名链接；保存位置不代表文件已备份。</small>
      </details>
    </fieldset>
    <div class="form-actions"><button class="button primary" type="submit" :disabled="disabled || busy || needsRead || expired || !dirty || drama.status === 'published'">{{ busy ? '保存中…' : '保存成片资料' }}</button><span class="muted small-text">音轨语言在基础信息中设置。修改观众成片前应下架，重新核对平台审核。</span></div>
  </form>
</template>
<style scoped>fieldset { border:0; padding:0; min-width:0; }.source-intro { border-top:1px solid var(--line); padding-top:14px; }.source-intro summary { cursor:pointer; font-size: 1rem; color:var(--muted); margin-bottom:14px; }.delivery-editor small { line-height:1.65; }</style>
