<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { api, formatDate, message, orderStatus } from '../api'
import { fulfillmentState } from '../operations-results'
import Feedback from './Feedback.vue'
import type { Order } from '../../shared/contracts'

interface Inspection {
  readOnly: true; checkedAt: number; environment: string | null; note: string
  order: Pick<Order, 'id' | 'title' | 'status' | 'amount' | 'currency' | 'createdAt' | 'paidAt'>
  outcome: { state: string; needsReview: boolean; receiptAt: number | null; refundAt: number | null;
    entitlementStartsAt: number | null; entitlementExpiresAt: number | null; revokedAt: number | null }
}
const props = defineProps<{ orderId: string }>()
const value = ref<Inspection>(), loading = ref(false), error = ref('')
const controller = new AbortController()
const time = (at: number | null | undefined) => at == null ? '未记录' : formatDate(at)
async function load() {
  if (loading.value) return
  loading.value = true; error.value = ''; value.value = undefined
  try {
    const result = await api<Inspection>(`/admin/orders/${encodeURIComponent(props.orderId)}/inspection`, { signal: controller.signal })
    if (controller.signal.aborted) return
    if (result.readOnly !== true || result.order?.id !== props.orderId || !result.outcome) throw Error('原订单回执不完整，未用最近订单代替。')
    value.value = result
  } catch (cause) { if (!controller.signal.aborted) error.value = message(cause) }
  finally { loading.value = false }
}
onMounted(load)
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <section class="panel order-inspection" data-testid="order-inspection" aria-label="原订单只读核对">
    <div class="section-heading"><h2>原订单核对</h2><span class="badge">只读</span></div>
    <p class="muted">按完整订单号查原账本，不受最近订单列表限制。</p>
    <p class="order-id">{{ orderId }}</p>
    <Feedback :loading="loading" :error="error" />
    <template v-if="value">
      <p :class="['notice', { warning: value.outcome.needsReview }]" role="status">
        <strong>{{ fulfillmentState[value.outcome.state] ?? '当前状态待核对' }}</strong>
        <span>检查时间：{{ time(value.checkedAt) }}</span>
      </p>
      <dl class="order-facts">
        <dt>内容</dt><dd>{{ value.order.title }}</dd>
        <dt>订单状态</dt><dd>{{ orderStatus[value.order.status] ?? value.order.status }}</dd>
        <dt>账本环境</dt><dd>{{ { internal:'内部演练 · 非真钱', official_test:'官方免扣费测试', production:'正式环境' }[value.environment ?? ''] || '无法确认' }}</dd>
        <dt>原记账金额</dt><dd>{{ value.order.amount }} {{ value.order.currency }}<small>保留原单位，不是净收入。</small></dd>
        <dt>付款确认</dt><dd>{{ time(value.order.paidAt) }}</dd>
        <dt>有效付款回执</dt><dd>{{ time(value.outcome.receiptAt) }}</dd>
        <dt>权益开始</dt><dd>{{ time(value.outcome.entitlementStartsAt) }}</dd>
        <dt>权益截止</dt><dd>{{ value.outcome.entitlementStartsAt == null ? '未记录权益' : value.outcome.entitlementExpiresAt == null ? '未设置截止' : time(value.outcome.entitlementExpiresAt) }}</dd>
        <dt v-if="value.outcome.revokedAt">撤销时间</dt><dd v-if="value.outcome.revokedAt">{{ time(value.outcome.revokedAt) }}</dd>
        <dt v-if="value.outcome.refundAt">退款回执</dt><dd v-if="value.outcome.refundAt">{{ time(value.outcome.refundAt) }}</dd>
      </dl>
      <p class="muted">{{ value.note }}</p>
    </template>
    <button type="button" class="button" :disabled="loading" @click="load">重新读取原订单</button>
  </section>
</template>

<style scoped>
.order-inspection { min-width:0; overflow-wrap:anywhere; max-width:900px; }
.order-id { font-variant-numeric:tabular-nums; margin-block:16px; }
.notice { display:grid; gap:8px; }.notice span { font-size:.875rem; }
.order-facts { display:grid; grid-template-columns:140px minmax(0,1fr); gap:14px 22px; margin:24px 0; }
dt,small { color:var(--muted); }dd { margin:0; }small { display:block; }
.order-inspection > .button { margin-top:20px; }
@media(max-width:600px) { .order-facts { grid-template-columns:minmax(0,1fr); gap:6px; }dd { margin-bottom:12px; } }
</style>
