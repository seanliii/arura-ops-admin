<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { Asset } from '../../shared/contracts'
import { api, formatBytes, formatDate, message, publicAssetUrl } from '../api'
import Feedback from './Feedback.vue'

const props = defineProps<{ revision: number }>()
const assets = ref<Asset[]>([])
const loading = ref(false)
const error = ref('')
const kind = ref('')
const query = ref('')
const labels = { video: '视频', cover: '封面', subtitle: '字幕' }
const shown = computed(() => assets.value.filter(asset =>
  (!kind.value || asset.kind === kind.value) && `${asset.originalName} ${asset.id}`.toLowerCase().includes(query.value.toLowerCase()),
))
async function load() {
  if (loading.value) return
  loading.value = true; error.value = ''
  try { assets.value = (await api<{ assets: Asset[] }>('/admin/assets')).assets }
  catch (cause) { error.value = message(cause) }
  finally { loading.value = false }
}
watch(() => props.revision, load)
onMounted(load)
defineExpose({ load })
</script>

<template>
  <section class="panel" aria-label="资产列表">
    <div class="section-heading"><div><h2>服务器资产</h2><p class="muted">包含已完成但未关联的文件。这里只列安全元数据，不展示服务器存储路径。封面与字幕的公开查看权限由服务器决定，草稿可能返回不可用。</p></div><button class="button" :disabled="loading" @click="load">刷新资产</button></div>
    <div class="toolbar"><label class="field search-field"><span>搜索资产</span><input v-model="query" type="search" placeholder="文件名或资产 ID" /></label><label class="field"><span>素材类型</span><select v-model="kind"><option value="">全部类型</option><option value="video">视频</option><option value="cover">封面</option><option value="subtitle">字幕</option></select></label></div>
    <Feedback :error="error" :loading="loading" retry @retry="load" />
    <div v-if="shown.length" class="table-scroll" tabindex="0" role="region" aria-label="资产列表表格"><table><thead><tr><th>文件名</th><th>类型</th><th>大小</th><th>资产 ID</th><th>上传时间</th><th>查看</th></tr></thead>
      <tbody><tr v-for="asset in shown" :key="asset.id"><td class="file-name">{{ asset.originalName }}</td><td>{{ labels[asset.kind] }}</td><td>{{ formatBytes(asset.bytes) }}</td><td class="mono selectable">{{ asset.id }}</td><td>{{ formatDate(asset.createdAt) }}</td><td><span v-if="asset.kind === 'video'" class="muted">私有视频 · 无公开链接</span><a v-else class="text-link" :href="publicAssetUrl(asset)" target="_blank" rel="noopener noreferrer">查看{{ labels[asset.kind] }} ↗</a></td></tr></tbody>
    </table></div>
    <div v-else-if="!loading && !error" class="empty-state compact"><h3>{{ assets.length ? '没有匹配的资产' : '尚无已上传素材' }}</h3><p>上传成功后可在这里查询，失败时请刷新后核对再重试。</p></div>
  </section>
</template>
