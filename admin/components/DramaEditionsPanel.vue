<script setup lang="ts">
import { ref } from 'vue'
import type { Drama } from '../../shared/contracts'
import { CONTENT_LANGUAGE_LABELS } from '../../shared/catalog-channel'
import { DRAMA_TEXT_LOCALES } from '../../shared/drama-localizations'
import { api, message } from '../api'
import Feedback from './Feedback.vue'
const props = defineProps<{ drama: Drama; disabled: boolean }>()
const emit = defineEmits<{ open: [drama: Drama]; busy: [value: boolean] }>()
const language = ref(''), label = ref(''), busy = ref(false), error = ref('')
let pending: { fingerprint: string; requestId: string } | undefined
async function select(id: number) {
  if (busy.value || props.disabled) return
  busy.value = true; emit('busy', true); error.value = ''
  try {
    const { dramas } = await api<{ dramas: Drama[] }>('/admin/dramas')
    const next = dramas.find(d => d.id === id && (d.workId ?? d.id) === (props.drama.workId ?? props.drama.id))
    if (!next) throw new Error('该版本不可用，请重新加载')
    emit('open', next)
  } catch (e) { error.value = message(e) }
  finally { busy.value = false; emit('busy', false) }
}
async function create() {
  if (!language.value || busy.value || props.disabled) return
  busy.value = true; emit('busy', true); error.value = ''
  try {
    const input = { version: props.drama.version, language: language.value, regions: props.drama.regions, delivery: { label: label.value.trim() } }
    const fingerprint = JSON.stringify([props.drama.id, input])
    if (pending?.fingerprint !== fingerprint) pending = { fingerprint, requestId: crypto.randomUUID() }
    const result = await api<{ drama: Drama }>(`/admin/dramas/${props.drama.id}/editions`, {
      method: 'POST', body: { ...input, requestId: pending.requestId },
    })
    if (result.drama.language !== language.value || result.drama.workId !== (props.drama.workId ?? props.drama.id)) throw new Error('版本关联返回异常，请刷新')
    pending = undefined; emit('open', result.drama)
  } catch (e) { error.value = message(e) }
  finally { busy.value = false; emit('busy', false) }
}
</script>
<template>
  <section class="panel" aria-label="同作品语言版本">
    <div class="section-heading"><div><h3>相关成片 · 可选关联</h3><p class="muted">只有确实是同一作品的译制版才关联。不同频道可以有完全不同的剧；重制后剧情/集数不同，请从列表新建独立剧目。</p></div></div>
    <Feedback :error="error" />
    <div class="inline wrap">
      <button v-for="edition in drama.editions ?? []" :key="edition.id" class="button edition-link" :disabled="disabled || busy || edition.id === drama.id" @click="select(edition.id)">{{ edition.label || CONTENT_LANGUAGE_LABELS[edition.language] || edition.language }} · #{{ edition.id }}{{ edition.id === drama.id ? '（当前）' : '' }}</button>
    </div>
    <form class="edition-create" @submit.prevent="create">
      <label class="field"><span>新成片的音轨语言</span><select v-model="language" aria-label="新语言视频版本" :disabled="disabled || busy" required><option value="" disabled>请选择实际原声/配音</option><option v-for="code in DRAMA_TEXT_LOCALES" :key="code" :value="code">{{ CONTENT_LANGUAGE_LABELS[code] }} · {{ code }}</option></select></label>
      <label class="field"><span>新成片标识</span><input v-model="label" aria-label="新成片标识" :disabled="disabled || busy" maxlength="80" placeholder="例如：英语原声 · 日语字幕版" /></label>
      <button class="button" :disabled="disabled || busy || !language">新建关联成片草稿</button>
    </form>
    <p class="muted small-text">只复制文案、封面和作品关联，不复制视频、TikTok ID、审核、定价或版权确认。同音轨的不同字幕成片可以并存，网络重试不会重复创建；其他成片的购买不会自动扩权。创建后填写内容频道、字幕和独立上传的视频。</p>
  </section>
</template>
<style scoped>
.edition-create { display:flex; gap:12px; align-items:end; flex-wrap:wrap; margin:20px 0; }
.edition-create .field { flex:1; min-width:200px; }
.edition-link { min-width:0; max-width:100%; white-space:normal; overflow-wrap:anywhere; text-align:start; }
</style>
