<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Order, OrderStatus, User } from '../../shared/contracts'
import type { SubscriptionHistoryScope, SubscriptionLedgerLocation } from '../../shared/subscription-review'
import { api, formatDate, message, orderStatus, type AuditEvent, type Integrations } from '../api'
import Feedback from './Feedback.vue'
import PaymentReviews from './PaymentReviews.vue'
import SubscriptionEvents from './SubscriptionEvents.vue'
import SubscriptionInspector from './SubscriptionInspector.vue'
import OrderInspection from './OrderInspection.vue'

const props = defineProps<{ section: 'orders' | 'users' | 'audit' | 'integrations'; orderId?: string | null }>()
const orders = ref<Order[]>([])
const users = ref<User[]>([])
const events = ref<AuditEvent[]>([])
const integrations = ref<Integrations | null>(null)
const loading = ref(false)
const error = ref('')
const success = ref('')
const status = ref<OrderStatus | ''>('')
const query = ref('')
const refundTarget = ref<Order | null>(null)
const subscriptionTarget = ref<(Pick<User, 'id' | 'nickname'> & { historyOnly?: boolean; scope?: SubscriptionHistoryScope }) | null>(null)
let subscriptionOpener: HTMLElement | null = null
const reason = ref('')
const refundBusy = ref(false)
const refundError = ref('')
const refundDialog = ref<HTMLDialogElement>()
const checkingOrder = ref<string | null>(null)
const providerChecks = ref<Record<string, { status: 'PENDING' | 'SUCCESS' | 'UNCONFIRMED'; checkedAt: number; receiptConfirmed: boolean }>>({})
const providerLabels = { PENDING: '平台仍待确认', SUCCESS: '平台查询成功', UNCONFIRMED: '平台状态未确认' }
const controller = new AbortController()
const kinds = { episode: '单集', drama: '整剧', vip: '会员' }
const shownOrders = computed(() => orders.value.filter(order =>
  (!status.value || order.status === status.value)
  && `${order.id} ${order.title} ${order.userId ?? ''} ${order.userEmail ?? ''}`.toLowerCase().includes(query.value.toLowerCase()),
))
const shownUsers = computed(() => users.value.filter(user =>
  `${user.id} ${user.email ?? ''} ${user.nickname}`.toLowerCase().includes(query.value.toLowerCase()),
))
const shownEvents = computed(() => events.value.filter(event =>
  `${event.actorId ?? ''} ${event.action} ${event.targetType} ${event.targetId ?? ''}`.toLowerCase().includes(query.value.toLowerCase()),
))
const canRefund = (order: Order) => order.provider === 'sandbox' && order.status === 'paid'
  && integrations.value?.mode === 'local'
function openSubscription(user: User, historyOnly: boolean, event: Event) {
  subscriptionOpener = event.currentTarget as HTMLElement
  subscriptionTarget.value = { id: user.id, nickname: user.nickname, historyOnly }
}
function openLedger(location: SubscriptionLedgerLocation, opener: HTMLElement) {
  subscriptionOpener = opener
  subscriptionTarget.value = {
    id: location.userId, nickname: '通知关联用户', historyOnly: true,
    scope: { tradeOrderId: location.tradeOrderId, subscriptionId: location.subscriptionId },
  }
}
async function closeSubscription() {
  subscriptionTarget.value = null
  await nextTick()
  if (subscriptionOpener?.isConnected) subscriptionOpener.focus({ preventScroll: true })
  subscriptionOpener = null
}
async function checkOrder(order: Order) {
  if (checkingOrder.value || order.provider !== 'tiktok' || !order.tradeOrderId) return
  checkingOrder.value = order.id; error.value = ''; success.value = ''
  try {
    const result = await api<{
      order: Order; providerCheck: { status: 'PENDING' | 'SUCCESS' | 'UNCONFIRMED'; checkedAt: number; receiptConfirmed: boolean };
      notice?: { message: string };
    }>(`/admin/orders/${encodeURIComponent(order.id)}/reconcile`, { method: 'POST', signal: controller.signal })
    if (controller.signal.aborted) return
    orders.value = orders.value.map(item => item.id === result.order.id ? { ...item, ...result.order } : item)
    providerChecks.value[order.id] = result.providerCheck
    success.value = result.notice?.message || '平台状态已核对，订单和权益仍以服务器验签结果为准。'
  } catch (cause) { if (!controller.signal.aborted) error.value = message(cause) }
  finally { checkingOrder.value = null }
}
async function load() {
  if (loading.value || (props.section === 'orders' && props.orderId)) return
  loading.value = true; error.value = ''
  try {
    const options = { signal: controller.signal }
    if (props.section === 'orders') {
      const [list, state] = await Promise.all([
        api<{ orders: Order[] }>(`/admin/orders${status.value ? `?status=${encodeURIComponent(status.value)}` : ''}`, options),
        api<Integrations>('/admin/integrations', options),
      ])
      orders.value = list.orders; integrations.value = state
    } else if (props.section === 'users') users.value = (await api<{ users: User[] }>('/admin/users', options)).users
    else if (props.section === 'audit') events.value = (await api<{ events: AuditEvent[] }>('/admin/audit', options)).events
    else integrations.value = await api<Integrations>('/admin/integrations', options)
  } catch (cause) { if (!controller.signal.aborted) error.value = message(cause) }
  finally { loading.value = false }
}
async function openRefund(order: Order) {
  if (!canRefund(order) || refundBusy.value) return
  refundTarget.value = order; reason.value = ''; refundError.value = ''
  await nextTick()
  refundDialog.value?.showModal()
}
function closeRefund() {
  if (refundBusy.value) return
  refundDialog.value?.close()
  refundTarget.value = null
}
async function refund() {
  if (!refundTarget.value || refundBusy.value || !canRefund(refundTarget.value)) return
  if (!reason.value.trim()) { refundError.value = '请填写退款原因。'; return }
  refundBusy.value = true; refundError.value = ''; success.value = ''
  try {
    const result = await api<{ order: Order }>(`/admin/orders/${encodeURIComponent(refundTarget.value.id)}/refund`, {
      method: 'POST', body: { reason: reason.value.trim() },
    })
    // 写接口不一定重复返回列表专用的 userId / userEmail，保留已有安全关联。
    orders.value = orders.value.map(order => order.id === result.order.id ? { ...order, ...result.order } : order)
    success.value = 'Sandbox 测试订单退款完成，相关权益以服务器结果为准；没有发生真钱退款。'
    refundDialog.value?.close(); refundTarget.value = null
  } catch (cause) { refundError.value = message(cause) }
  finally { refundBusy.value = false }
}
onMounted(load)
onBeforeUnmount(() => controller.abort())
</script>

<template>
  <OrderInspection v-if="section === 'orders' && orderId" :key="orderId" :order-id="orderId" />
  <section v-else class="panel">
    <div class="section-heading"><h2>{{ { orders: '订单记录', users: '用户账户', audit: '操作记录', integrations: '服务接入检查' }[section] }}</h2><button class="button" :disabled="loading || refundBusy" @click="load">刷新数据</button></div>
    <p v-if="section === 'orders'" class="notice warning">Sandbox 为测试订单，不涉及真钱。只允许本地 Sandbox 已支付订单测试退款；真实 TikTok 订单不提供模拟退款按钮。</p>
    <div v-if="section !== 'integrations'" class="toolbar">
      <label class="field search-field"><span>{{ section === 'orders' ? '搜索订单或用户' : section === 'users' ? '搜索用户' : '搜索操作日志' }}</span><input v-model="query" type="search" placeholder="输入关键词" /></label>
      <label v-if="section === 'orders'" class="field"><span>订单状态</span><select v-model="status" :disabled="loading" @change="load"><option value="">全部状态</option><option v-for="(label, value) in orderStatus" :key="value" :value="value">{{ label }}</option></select></label>
    </div>
    <Feedback :loading="loading" :error="error" :success="success" retry @retry="load" />
    <template v-if="section === 'orders'">
      <div v-if="shownOrders.length" class="table-scroll" tabindex="0" role="region" aria-label="订单列表表格"><table><thead><tr><th>订单 / 内容</th><th>用户</th><th>金额 / 单位</th><th>支付渠道</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody><tr v-for="order in shownOrders" :key="order.id"><td><strong>{{ order.title }}</strong><small class="mono">{{ order.id }}</small><small>{{ kinds[order.kind] }} · {{ order.targetId ?? '—' }}</small></td><td>{{ order.userEmail || '未提供邮箱' }}<small class="mono">{{ order.userId || '未返回用户关联' }}</small></td><td>{{ order.amount }}<small>{{ order.currency }}</small></td><td>{{ order.provider === 'sandbox' ? 'Sandbox · 无真钱' : integrations?.mode === 'staging' ? 'TikTok · 预发布验证' : 'TikTok · 真实渠道' }}</td><td><span :class="['badge', order.status === 'paid' ? 'good' : 'neutral']">{{ orderStatus[order.status] }}</span><small v-if="providerChecks[order.id]">{{ providerLabels[providerChecks[order.id].status] }} · {{ providerChecks[order.id].receiptConfirmed ? '已收有效回执' : '未确认有效回执，不代表已发权' }}</small></td><td>{{ formatDate(order.createdAt) }}</td><td><button v-if="canRefund(order)" class="button small danger" @click="openRefund(order)">Sandbox 测试退款</button><span v-else class="muted">{{ order.provider === 'tiktok' ? '请在真实支付渠道处理' : '无可用操作' }}</span><button v-if="order.provider === 'tiktok'" class="button small" :disabled="!!checkingOrder || !order.tradeOrderId" @click="checkOrder(order)">{{ checkingOrder === order.id ? '正在核对…' : '核对平台状态' }}</button></td></tr></tbody>
      </table></div>
      <div v-else-if="!loading && !error" class="empty-state"><h3>没有匹配的订单</h3><p>更换筛选条件，或等待用户创建订单。</p></div>
    </template>
    <template v-else-if="section === 'users'">
      <div v-if="shownUsers.length" class="table-scroll" tabindex="0" role="region" aria-label="用户列表表格">
        <table class="users-table"><thead><tr><th>昵称</th><th>邮箱</th><th>用户 ID</th><th>角色</th><th>注册渠道</th><th>注册时间</th><th>订阅核对</th></tr></thead>
          <tbody><tr v-for="item in shownUsers" :key="item.id">
            <td data-label="昵称">{{ item.nickname }}</td><td data-label="邮箱">{{ item.email || '未提供' }}</td>
            <td data-label="用户 ID" class="mono">{{ item.id }}</td>
            <td data-label="角色"><span class="badge">{{ item.role === 'admin' ? '管理员' : '普通用户' }}</span></td>
            <td data-label="注册渠道">{{ item.provider === 'local' ? '本地账户' : 'TikTok' }}</td>
            <td data-label="注册时间">{{ formatDate(item.createdAt) }}</td>
            <td data-label="订阅"><div v-if="item.provider === 'tiktok'" class="subscription-actions">
              <button class="button small" :aria-label="`查看${item.nickname}的订阅记录`" @click="openSubscription(item, true, $event)">查看订阅记录</button>
              <button class="button small" :aria-label="`核对${item.nickname}的订阅`" @click="openSubscription(item, false, $event)">核对订阅</button>
            </div><span v-else class="muted">本地账户无平台订阅</span></td>
          </tr></tbody>
        </table>
      </div>
      <div v-else-if="!loading && !error" class="empty-state"><h3>没有匹配的用户</h3><p>这里只展示账户基本资料，不展示口令、会话或支付秘密。</p></div>
    </template>
    <template v-else-if="section === 'audit'">
      <p class="muted small-text">仅展示操作人、动作、目标和时间；不直接展开日志 detail 或任何未知字段。记录范围以服务器返回为准。</p>
      <div v-if="shownEvents.length" class="table-scroll" tabindex="0" role="region" aria-label="操作日志表格"><table><thead><tr><th>记录 ID</th><th>操作人</th><th>动作</th><th>目标类型 / ID</th><th>时间</th></tr></thead><tbody><tr v-for="event in shownEvents" :key="event.id"><td>{{ event.id }}</td><td class="mono">{{ event.actorId || '系统' }}</td><td>{{ event.action }}</td><td>{{ event.targetType }}<small class="mono">{{ event.targetId || '—' }}</small></td><td>{{ formatDate(event.createdAt) }}</td></tr></tbody></table></div>
      <div v-else-if="!loading && !error" class="empty-state"><h3>没有匹配的操作记录</h3><p>新增、上传、发布与退款等操作会由服务器记录。</p></div>
    </template>
    <template v-else-if="integrations">
      <div class="integration-grid">
        <article class="integration-card"><span class="eyebrow">RUNTIME</span><h3>运行环境</h3><strong>{{ integrations.mode === 'local' ? '本地模式' : integrations.mode === 'staging' ? '预发布环境' : '生产模式' }}</strong><p>此状态来自服务器，不依据页面地址推断。</p></article>
        <article class="integration-card"><span class="eyebrow">PAYMENT</span><h3>支付模式</h3><strong>{{ integrations.paymentMode === 'sandbox' ? 'Sandbox · 无真钱' : integrations.paymentMode === 'disabled' ? '支付已禁用' : 'TikTok 真实渠道' }}</strong><p>TEST_CREDITS / BEANS 必须按订单原单位核对。</p></article>
        <article class="integration-card"><span class="eyebrow">MEDIA</span><h3>媒体服务</h3><strong>{{ integrations.mediaMode === 'local' ? '本地私有存储' : 'TikTok 媒体服务' }}</strong><p>视频播放依赖服务端授权，不展示或猜造公开地址。</p></article>
        <article class="integration-card"><span class="eyebrow">TIKTOK</span><h3>平台凭据</h3><strong :class="integrations.tiktokConfigured ? 'accent' : 'warning-text'">{{ integrations.tiktokConfigured ? '已配置平台凭据' : '未配置真实 TikTok' }}</strong><p>配置凭据不等于完成同步、审核、回调或生产验收。</p></article>
      </div>
      <div v-if="integrations.mode === 'staging'" class="notice warning">预发布与正式共用平台业务流程，只接收已验签的测试回执。必须由平台实际启用测试权限；仅修改本服务配置不会自动停止平台扣款。</div>
      <div class="notice warning">本应用发布仅改变本地片库状态，不等于 TikTok 提审或审核通过。本页不提供“模拟过审”按钮。</div>
      <h3>服务器返回的接入要求</h3><ul v-if="integrations.requirements.length" class="requirements"><li v-for="(item, index) in integrations.requirements" :key="index">{{ item }}</li></ul><p v-else class="muted">服务器未列出额外要求；这不代表真实平台流程已验证。</p>
    </template>
    <dialog ref="refundDialog" class="confirm-dialog" aria-labelledby="refund-title" @cancel="refundBusy ? $event.preventDefault() : closeRefund()">
      <form v-if="refundTarget" @submit.prevent="refund">
        <p class="eyebrow">SANDBOX ONLY</p><h2 id="refund-title">确认测试退款</h2>
        <p class="notice warning">仅撤销 Sandbox 测试订单对应权益，没有真钱转入或退回。</p>
        <dl><dt>订单</dt><dd class="mono">{{ refundTarget.id }}</dd><dt>用户</dt><dd>{{ refundTarget.userEmail || refundTarget.userId || '未提供' }}</dd><dt>金额</dt><dd>{{ refundTarget.amount }} {{ refundTarget.currency }}</dd></dl>
        <label class="field"><span>退款原因</span><textarea v-model="reason" rows="3" required maxlength="500" :disabled="refundBusy" autofocus></textarea></label>
        <Feedback :error="refundError" />
        <div class="form-actions"><button class="button danger" type="submit" :disabled="refundBusy">{{ refundBusy ? '退款处理中…' : '确认 Sandbox 测试退款' }}</button><button class="button" type="button" :disabled="refundBusy" @click="closeRefund">取消</button></div>
      </form>
    </dialog>
  </section>
  <PaymentReviews v-if="section === 'orders' && !orderId" />
  <SubscriptionEvents v-if="section === 'orders' && !orderId" @open-ledger="openLedger" />
  <SubscriptionInspector v-if="subscriptionTarget" :key="`${subscriptionTarget.id}:${subscriptionTarget.historyOnly}:${subscriptionTarget.scope?.tradeOrderId ?? ''}`" :user-id="subscriptionTarget.id" :nickname="subscriptionTarget.nickname" :history-only="subscriptionTarget.historyOnly" :initial-scope="subscriptionTarget.scope" @close="closeSubscription" />
</template>

<style scoped>
.subscription-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.users-table td { overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .users-table, .users-table tbody, .users-table tr, .users-table td { display: block; width: 100%; min-width: 0; }
  .users-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .users-table tr { padding: .75rem; border-bottom: 1px solid var(--line); }
  .users-table td { border: 0; padding: .4rem 0; }
  .users-table td[data-label]::before { content: attr(data-label); display: block; color: var(--muted); margin-bottom: .2rem; }
}
</style>
