<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { api, formatDate, message } from '../api'
import Feedback from './Feedback.vue'

interface PaymentReview {
  id: string
  orderId: string
  tradeOrderId: string
  event: 'minis.trade_order.redeem.refund_traceback'
  status: 'pending_review'
  amountRaw: string | null
  payloadSha256: string
  receivedAt: number
  isSandbox: boolean | null
}
interface ReviewPage { reviews: PaymentReview[]; nextCursor: string | null }
type LoadAction = 'refresh' | 'more'
const reviews = ref<PaymentReview[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const retryAction = ref<LoadAction>('refresh')
const controller = new AbortController()

async function load(action: LoadAction = 'refresh') {
  if (loading.value || (action === 'more' && nextCursor.value === null)) return
  loading.value = true; error.value = ''; retryAction.value = action
  const query = new URLSearchParams({ limit: '20' })
  if (action === 'more' && nextCursor.value !== null) query.set('before', nextCursor.value)
  try {
    // 普通错误在本区展示；401必须走全局失效清屏，不能保留上一会话的通知。
    const page = await api<ReviewPage>(`/admin/payment-reviews?${query}`, {
      signal: controller.signal,
    })
    if (!Array.isArray(page.reviews) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')
      || page.reviews.some(review => review.amountRaw !== null && typeof review.amountRaw !== 'string')) {
      throw new Error('通知返回格式不正确，未更新已有记录，请重试。')
    }
    // 每项代表一次投递，不按指纹去重，不换算或累计 amountRaw。
    reviews.value = action === 'more' ? [...reviews.value, ...page.reviews] : page.reviews
    nextCursor.value = page.nextCursor
    loaded.value = true
  } catch (cause) {
    if (!controller.signal.aborted) error.value = message(cause)
  } finally { loading.value = false }
}
onMounted(() => load())
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <section class="panel" aria-label="待核对追回通知" :aria-busy="loading">
    <div class="section-heading">
      <div><h2>待核对追回通知</h2><p class="muted">只读通知记录，不更改订单、权益或退款状态。</p></div>
      <button class="button" type="button" :disabled="loading" @click="load('refresh')">刷新通知</button>
    </div>
    <p class="notice warning">部分追回通知，单位及累计方式待平台确认；每行是一次通知投递，不自动累加、不代表全额退款。</p>
    <Feedback :error="error" :loading="loading" retry @retry="load(retryAction)" />
    <div v-if="reviews.length" class="table-scroll" tabindex="0" role="region" aria-label="追回通知投递表格">
      <table class="review-table">
        <thead><tr><th>投递 ID / 接收时间</th><th>订单 ID / 平台订单 ID</th><th>事件 / 状态</th><th>金额原始字段（未换算）</th><th>载荷指纹 SHA-256</th><th>通知环境标记</th></tr></thead>
        <tbody>
          <tr v-for="review in reviews" :key="review.id" data-testid="payment-review-row">
            <td><span class="mono">{{ review.id }}</span><small>{{ formatDate(review.receivedAt) }}</small></td>
            <td><span class="mono">{{ review.orderId }}</span><small class="mono">{{ review.tradeOrderId }}</small></td>
            <td><span class="mono">{{ review.event }}</span><small>待核对 · {{ review.status }}</small></td>
            <td class="mono raw-amount" data-testid="payment-review-amount">{{ review.amountRaw === null ? '未提供' : review.amountRaw }}</td>
            <td class="mono">{{ review.payloadSha256 }}</td>
            <td>{{ review.isSandbox === null ? '未提供（null）' : review.isSandbox ? 'Sandbox（true）' : '非 Sandbox（false）' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="loaded && !loading && !error" class="empty-state compact">
      <h3>暂无待核对通知</h3><p>这里只显示服务器已保存的通知投递，不推断是否发生退款。</p>
    </div>
    <div v-if="reviews.length || nextCursor !== null" class="form-actions wrap">
      <span class="muted">已显示 {{ reviews.length }} 次通知投递</span>
      <button v-if="nextCursor !== null" class="button" type="button" :disabled="loading" @click="load('more')">加载更多通知</button>
      <span v-else-if="loaded" class="muted">已加载全部通知</span>
    </div>
  </section>
</template>

<style scoped>
.review-table { min-width: 1020px; table-layout: fixed; }
.review-table td { vertical-align: top; overflow-wrap: anywhere; }
.review-table th:nth-child(1) { width: 15%; }
.review-table th:nth-child(2) { width: 18%; }
.review-table th:nth-child(3) { width: 20%; }
.review-table th:nth-child(4) { width: 20%; }
.review-table th:nth-child(5) { width: 16%; }
.raw-amount { white-space: pre-wrap; }
</style>
