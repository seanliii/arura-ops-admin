<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ContentOperationsDetail, ReadinessIssue } from '../../shared/content-operations'
import { api, formatDate, message } from '../api'
import Feedback from './Feedback.vue'

const props = defineProps<{ dramaId: number; version: number; disabled?: boolean }>()
const emit = defineEmits<{ locate: [issue: ReadinessIssue]; media: [] }>()
const data = ref<ContentOperationsDetail>(), loading = ref(false), error = ref('')
const actions = [{ id: 'draft', label: '保存草稿', before: '草稿' },
  { id: 'review', label: '送审', before: '送审前' }, { id: 'publish', label: '上架', before: '上架前' }] as const
const groups = [{ id: 'success', label: '已导入单集' }, { id: 'failed', label: '需要处理' },
  { id: 'unknown', label: '结果待核对' }, { id: 'pending', label: '处理中' }, { id: 'cancelled', label: '已取消后续处理' }] as const
const reviewLabels = ['未提审', '审核中', '已批准', '已拒绝', '已撤回', '申诉中', '申诉批准', '申诉拒绝']
const queryState = computed(() => data.value?.platform.syncedAt ? formatDate(data.value.platform.syncedAt) : '未记录成功查询')
let controller: AbortController | undefined, epoch = 0
async function load() {
  const current = ++epoch
  controller?.abort(); controller = new AbortController()
  const signal = controller.signal
  loading.value = true; error.value = ''
  try {
    const result = await api<ContentOperationsDetail>(`/admin/dramas/${props.dramaId}/operations`, { signal })
    if (current === epoch) data.value = result
  } catch (cause) { if (!signal.aborted && current === epoch) error.value = message(cause) }
  finally { if (current === epoch) loading.value = false }
}
watch(() => [props.dramaId, props.version], () => { void load() }, { immediate: true })
onBeforeUnmount(() => { epoch++; controller?.abort() })
</script>

<template>
  <section class="panel operations-preparation" aria-label="作品准备与审核回执">
    <div class="section-heading">
      <div><h3>审核与上架</h3><p class="muted small-text">先看当前结果，再处理缺项。读取本页不会送审、同步平台或公开作品。</p></div>
      <button class="button quiet" :disabled="loading || disabled" @click="load">更新本地准备与回执</button>
    </div>
    <Feedback :loading="loading" :error="error" retry @retry="load" />
    <template v-if="data">
      <div data-testid="content-review-summary" class="review-summary">
        <strong>{{ data.summary.label }}</strong>
        <p class="muted small-text">下一步：{{ data.summary.nextAction.label }}。本地作品版本 {{ data.version }}；媒资版本 {{ data.platform.platformVersion ?? '未记录' }}。</p>
        <p class="small-text">平台最近成功查询：{{ queryState }}<span v-if="data.platform.reviewStatus !== null"> · {{ reviewLabels[data.platform.reviewStatus] ?? '平台返回未知状态' }}</span></p>
        <p v-if="data.platform.nextQueryAt" class="muted small-text">下次平台查询安排：{{ formatDate(data.platform.nextQueryAt) }}。{{ data.platform.nextQueryAt <= data.generatedAt ? '已到安排时间，尚未观察到下一次处理；不是新的查询回执。' : '这是本地任务安排，不是平台审核完成时间。' }}</p>
        <p v-if="data.platform.queryIssue" class="notice warning">上次查询未成功：{{ data.platform.queryIssue.message }}（{{ formatDate(data.platform.queryIssue.at) }}）。上面的结果仍是最后一次成功记录，不代表刚刚查到了新状态。</p>
        <p v-if="data.platform.needsSync && data.platform.syncedAt" class="muted small-text">当前本地资料与已查询版本仍需核对；不能把旧版本的通过当作当前版本可上架。</p>
      </div>
      <div data-testid="content-readiness" class="readiness-grid">
        <section v-for="action in actions" :key="action.id">
          <h4>{{ data.readiness[action.id].ready ? `可${action.label}` : action.before }}</h4>
          <p class="muted small-text">{{ data.readiness[action.id].ready ? '当前记录满足本步骤校验；实际执行仍会重新检查。' : `${data.readiness[action.id].issues.length} 项需核对，不影响先整理草稿。` }}</p>
          <details v-if="data.readiness[action.id].issues.length">
            <summary>查看具体缺项</summary>
            <ul><li v-for="(issue, index) in data.readiness[action.id].issues" :key="`${issue.code}:${index}`"><button type="button" class="text-link" :disabled="disabled" @click="emit('locate', issue)">{{ issue.label }} →</button></li></ul>
          </details>
        </section>
      </div>
      <details class="receipt-details">
        <summary>版本与提审记录</summary>
        <p class="muted small-text">一次提审是一轮，状态查询不增加轮次。媒资版本不是应用预览包版本；具体原因只展示已有回执。</p>
        <ol v-if="data.platform.rounds.length" class="review-rounds">
          <li v-for="round in data.platform.rounds" :key="round.requestId" data-testid="review-round">
            <strong>媒资版本 {{ round.platformVersion ?? '未记录' }} · 第 {{ round.round }} 轮</strong>
            <p>本地版本 {{ round.localVersion }} · {{ formatDate(round.submittedAt) }}</p>
            <p>{{ round.message || (round.acknowledged ? '平台已受理；最终审核结果另查' : '尚无受理确认，先核对原请求') }}</p>
            <small v-if="!round.observations.length">本轮没有成功查询的状态观测，不推断审核内部进度。</small>
            <ul v-else><li v-for="observation in round.observations" :key="observation.observed_at">{{ formatDate(observation.observed_at) }} · {{ observation.review_status === null ? '未提供审核状态' : reviewLabels[observation.review_status] ?? '未知状态' }}</li></ul>
          </li>
        </ol>
        <p v-else class="muted">没有已保存的提审记录。草稿、上传完成不等于已提交审核。</p>
        <p class="muted small-text">{{ data.platform.resultReason }}</p>
      </details>
      <details v-if="Object.values(data.uploads.counts).some(count => count > 0)" class="receipt-details">
        <summary>原上传任务与需要继续的项目</summary>
        <p class="muted small-text">{{ data.uploads.scope }}</p>
        <section v-for="group in groups.filter(item => data!.uploads.counts[item.id])" :key="group.id" class="upload-group">
          <h4>{{ group.label }} · {{ data.uploads.counts[group.id] }}</h4>
          <ul><li v-for="task in data.uploads.groups[group.id]" :key="task.id">第 {{ task.seq }} 集 · {{ task.title }}<small>{{ task.message }}{{ task.hasKnownVideo && !task.episodeId ? ' · 已有视频记录，先核对，不要重传。' : '' }}</small></li></ul>
        </section>
        <button class="button" :disabled="disabled" @click="emit('media')">回原上传工作区</button>
      </details>
    </template>
  </section>
</template>
<style scoped>
.review-summary { padding: 16px; background: var(--surface-subtle); border-radius: 10px; margin: 12px 0 18px; overflow-wrap: anywhere; }
.review-summary strong { font-size: 1.0625rem; }
.readiness-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
.readiness-grid section { min-width: 0; }
.readiness-grid h4 { margin-bottom: 6px; }
.readiness-grid ul, .upload-group ul { padding-left: 20px; }
.readiness-grid li { margin: 8px 0; }
.readiness-grid .text-link { min-height: 44px; padding: 4px 0; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.receipt-details { border-top: 1px solid var(--line); margin-top: 12px; }
.receipt-details > summary { color: var(--muted); }
.review-rounds { padding-left: 22px; }
.review-rounds > li { padding: 12px 0; overflow-wrap: anywhere; }
.upload-group { margin: 12px 0; }
.upload-group small { display: block; }
@media(max-width:700px) { .readiness-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }.operations-preparation .section-heading { flex-wrap: wrap; } }
</style>
