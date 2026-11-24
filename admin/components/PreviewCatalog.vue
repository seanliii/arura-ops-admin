<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { PreviewCatalogState, PreviewReceipt } from '../../shared/preview-catalog'
import { api, message } from '../api'
import Feedback from './Feedback.vue'

const state = ref<PreviewCatalogState>()
const selectedId = ref('')
const freeEpisodes = ref(1)
const episodePrice = ref(1)
const bundlePrice = ref(2)
const confirmed = ref(false)
const busy = ref(false)
const error = ref('')
const result = ref<PreviewReceipt>()
const selected = computed(() => state.value?.dramas.find(d => String(d.id) === selectedId.value))
const labels = { checking: '目标核对中', published: '已进入官方测试片库', failed: '明确失败，未发布本次内容', unknown: '结果未知，请先查询' }
const eligible = computed(() => state.value?.configured && selected.value?.ready && confirmed.value && !busy.value)
async function load() {
  if (busy.value) return
  busy.value = true; error.value = ''; confirmed.value = false
  try {
    state.value = await api<PreviewCatalogState>('/admin/preview-catalog')
    if (!selectedId.value && state.value.dramas.length === 1) selectedId.value = String(state.value.dramas[0].id)
  } catch (cause) { error.value = message(cause) }
  finally { busy.value = false }
}
async function publish() {
  if (!eligible.value || !selected.value) return
  const source = selected.value
  busy.value = true; error.value = ''; result.value = undefined
  try {
    const data = await api<{ receipt: PreviewReceipt }>('/admin/preview-catalog/publish', {
      method: 'POST', body: { dramaId: source.id, version: source.version, freeEpisodes: freeEpisodes.value,
        episodePrice: episodePrice.value, bundlePrice: bundlePrice.value },
    })
    result.value = data.receipt; confirmed.value = false
    state.value = await api<PreviewCatalogState>('/admin/preview-catalog')
  } catch (cause) { error.value = message(cause) }
  finally { busy.value = false }
}
async function check(receipt: PreviewReceipt, retry = false) {
  if (busy.value || (retry && receipt.state !== 'failed')) return
  busy.value = true; error.value = ''
  try {
    result.value = (await api<{ receipt: PreviewReceipt }>(`/admin/preview-catalog/${receipt.releaseId}/${retry ? 'retry' : 'reconcile'}`, {
      method: 'POST', body: {},
    })).receipt
    state.value = await api<PreviewCatalogState>('/admin/preview-catalog')
  } catch (cause) { error.value = message(cause) }
  finally { busy.value = false }
}
onMounted(load)
</script>

<template>
  <section class="panel preview-catalog" aria-label="官方测试内容发行">
    <div class="section-heading"><h2>从这份运营片库发行到官方测试</h2><button class="button" :disabled="busy" @click="load">刷新发行状态</button></div>
    <p class="notice">只分发所选剧目的文案、封面、平台单集 ID；不重传视频、不复制用户、会话、订单或权益，也不公开源草稿。目标会独立查询 TikTok 的审核、上架和在线版本。</p>
    <p class="notice warning">内容发行成功 ≠ 官方付款已通过。这里不是内部模拟站，不会把 TEST_CREDITS 搬进 TikTok；在手机的官方测试模式得到确认前不要付款。正式价格与收费开关不变。</p>
    <Feedback :loading="busy && !state" :error="error" />
    <p v-if="state && !state.configured" class="notice warning" role="status">{{ state.reason }}</p>
    <form v-if="state" @submit.prevent="publish">
      <label class="field"><span>源剧目</span>
        <select v-model="selectedId" aria-label="源剧目" :disabled="busy" @change="confirmed = false">
          <option value="">请选择这次要测试的作品</option>
          <option v-for="drama in state.dramas" :key="drama.id" :value="String(drama.id)">{{ drama.title }} · #{{ drama.id }} · {{ drama.episodeCount }}集</option>
        </select>
      </label>
      <section v-if="selected" class="readiness">
        <h3>源内容就绪检查</h3>
        <p>源版本 {{ selected.version }} · {{ selected.language }} · {{ selected.regions.join(' / ') }} · {{ selected.episodeCount }}集</p>
        <p v-if="selected.ready" class="notice" role="status">源内容记录满足分发条件；发送后还需目标独立查询确认。</p>
        <ul v-else class="notice warning" role="status"><li v-for="reason in selected.reasons" :key="reason">{{ reason }}</li></ul>
      </section>
      <fieldset class="form-grid" :disabled="busy || !state.configured">
        <label class="field"><span>目标免费集数</span><input v-model.number="freeEpisodes" type="number" min="0" :max="selected?.episodeCount || 0" step="1" required /></label>
        <label class="field"><span>目标单集测试价（Beans）</span><input v-model.number="episodePrice" type="number" min="1" step="1" required /></label>
        <label class="field"><span>目标整剧测试价（Beans）</span><input v-model.number="bundlePrice" type="number" min="1" step="1" required /></label>
      </fieldset>
      <p class="muted">两集首轮验收建议：第1集免费，第2集测试购买。数值只写入官方 staging，不改变源作品价格；实际免扣费由官方测试权限决定。</p>
      <label class="checkbox"><input v-model="confirmed" type="checkbox" :disabled="busy || !state.configured || !selected?.ready" /><span>仅同步所选内容到官方测试，不更改正式价格或复制账号订单</span></label>
      <button class="button primary" type="submit" :disabled="!eligible">同步到官方测试片库</button>
    </form>
    <section v-if="result" class="notice" data-testid="preview-release-result" aria-live="polite">
      <h3>{{ labels[result.state] }}</h3>
      <p>{{ result.message }}</p>
      <p>源 #{{ result.sourceDramaId }} / v{{ result.sourceVersion }} → 目标 {{ result.targetDramaId ? `#${result.targetDramaId}` : '未确认' }}；{{ result.episodeCount }}集，前{{ result.freeEpisodes }}集免费。</p>
      <p v-if="result.errorCode">{{ result.errorCode }}</p>
    </section>
    <section v-if="state" class="history">
      <h3>发行记录</h3>
      <p v-if="!state.receipts.length" class="muted">尚未发行官方测试内容。</p>
      <article v-for="receipt in state.receipts" :key="receipt.releaseId" class="receipt">
        <strong>源 #{{ receipt.sourceDramaId }} / v{{ receipt.sourceVersion }} · {{ labels[receipt.state] }}</strong>
        <p>{{ receipt.message }}</p>
        <p class="muted small-text">发行编号 {{ receipt.releaseId }} · 目标 {{ receipt.targetDramaId || '未确认' }} · 最后确认 {{ new Date(receipt.updatedAt).toLocaleString() }}</p>
        <div class="inline wrap">
          <button class="button" :disabled="busy" @click="check(receipt)">查询发行结果</button>
          <button v-if="receipt.state === 'failed'" class="button" :disabled="busy" @click="check(receipt, true)">重试失败的发行</button>
        </div>
      </article>
    </section>
  </section>
</template>

<style scoped>
.preview-catalog { min-width: 0; overflow-wrap: anywhere; }
form { display: grid; gap: 16px; }
.readiness { padding: 12px 0; }
.history { margin-top: 24px; }
.receipt { padding: 16px 0; border-top: 1px solid var(--line, #ddd); }
select, input { min-height: 44px; }
</style>
