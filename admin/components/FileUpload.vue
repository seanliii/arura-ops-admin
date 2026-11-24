<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import type { Asset } from '../../shared/contracts'
import { formatBytes, message, uploadAsset } from '../api'
import Feedback from './Feedback.vue'

const props = defineProps<{ kind: 'cover' | 'subtitle'; label: string; disabled?: boolean }>()
const emit = defineEmits<{ uploaded: [asset: Asset]; busy: [value: boolean] }>()
const file = ref<File>()
const busy = ref(false)
const progress = ref(0)
const error = ref('')
const done = ref<Asset>()
const preview = ref('')
let cancel: (() => void) | undefined
const accepts = { cover: 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp', subtitle: '.vtt,text/vtt' }
function select(event: Event) {
  const input = event.target as HTMLInputElement
  file.value = input.files?.[0]
  if (preview.value) URL.revokeObjectURL(preview.value)
  preview.value = props.kind === 'cover' && file.value && /\.(png|jpe?g|webp)$/i.test(file.value.name) ? URL.createObjectURL(file.value) : ''
  error.value = ''
  done.value = undefined
  input.value = ''
}
async function upload() {
  if (!file.value || busy.value || props.disabled) return
  error.value = ''
  const valid = props.kind === 'subtitle' ? /\.vtt$/i.test(file.value.name) : /\.(png|jpe?g|webp)$/i.test(file.value.name)
  if (!valid) { error.value = props.kind === 'subtitle' ? '请选择 VTT 字幕文件。' : '请选择 JPG、PNG 或 WebP 封面。'; return }
  busy.value = true
  emit('busy', true)
  progress.value = 0
  const task = uploadAsset(file.value, props.kind, value => { progress.value = value })
  cancel = task.cancel
  try { done.value = await task.promise; emit('uploaded', done.value) }
  catch (cause) { error.value = message(cause) }
  finally { busy.value = false; emit('busy', false); cancel = undefined }
}
onBeforeUnmount(() => {
  cancel?.()
  if (preview.value) URL.revokeObjectURL(preview.value)
})
</script>

<template>
  <div class="file-upload">
    <img v-if="preview" class="local-cover-preview" :src="preview" alt="本次选择的封面预览" />
    <label class="field">
      <span>{{ label }}</span>
      <input type="file" :accept="accepts[kind]" :disabled="disabled || busy" @change="select" />
    </label>
    <div v-if="file" class="inline wrap">
      <span class="muted">{{ file.name }} · {{ formatBytes(file.size) }}</span>
      <button type="button" class="button small" :disabled="disabled || busy || !!done" @click="upload">
        {{ busy ? '上传中…' : done ? '上传完成' : '上传文件' }}
      </button>
      <button v-if="busy" type="button" class="button small" @click="cancel?.()">取消上传</button>
    </div>
    <progress v-if="busy" :value="progress" max="100" :aria-label="`${label}进度`">{{ progress }}%</progress>
    <p v-if="done" class="muted" role="status">已上传 {{ done.originalName }}，保存后完成关联。</p>
    <Feedback :error="error" />
  </div>
</template>
