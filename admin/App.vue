<script setup lang="ts">
import AuroraMark from '../shared/AuroraMark.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { SessionInfo, User } from '../shared/contracts'
import { api, message, SESSION_EXPIRED } from './api'
import DramaManager from './components/DramaManager.vue'
import MediaWorkspace from './components/MediaWorkspace.vue'
import OperationsPanel from './components/OperationsPanel.vue'
import PreviewCatalog from './components/PreviewCatalog.vue'
import AnalyticsDashboard from './components/AnalyticsDashboard.vue'
import Feedback from './components/Feedback.vue'
import DisplaySettings from './components/DisplaySettings.vue'
import AdminIcon from './components/AdminIcon.vue'
import { allowAdminNavigation } from './draft-navigation'
import AnalysisEvidence from './components/AnalysisEvidence.vue'
import { newAnalysisState, type AnalysisAction, type AnalysisEvidence as Evidence } from './operations-context'
import { newContentFilters, clearContentFilters } from './content-workspace'

const pages = [
  { id: 'dramas', label: '内容管理', icon: '01', description: '整理作品，继续上传，查看审核与上架结果' },
  { id: 'home', label: '首页编排', icon: '02', description: '为每种语言安排作品和栏目' },
  { id: 'media', label: '上传素材', icon: '03', description: '选择剧目，添加视频，核对后上传' },
  { id: 'analytics', label: '运营数据', icon: '04', description: '看懂用户表现，再到具体作品或栏目采取行动' },
  { id: 'orders', label: '订单', icon: '03', description: '核对订单和用户，管理 Sandbox 测试退款。' },
  { id: 'users', label: '用户', icon: '04', description: '查看用户基本资料与账户角色。' },
  { id: 'audit', label: '操作日志', icon: '05', description: '追溯后台操作，只展示安全摘要。' },
  { id: 'integrations', label: '接入状态', icon: '06', description: '真实配置状态，不将本地发布当作平台过审。' },
  { id: 'preview', label: '官方预览内容', icon: '07', description: '只分发审核就绪的内容到独立官方测试片库，不复制用户或订单。' },
  { id: 'settings', label: '显示设置', icon: '08', description: '调整后台的文字和外观；内容、发行和收费设置仍在各自任务里。' },
] as const
const dailyPages = pages.filter(page => ['dramas', 'home', 'analytics'].includes(page.id))
const supportPages = pages.filter(page => ['media', 'orders', 'users'].includes(page.id))
const advancedPages = pages.filter(page => ['audit', 'integrations', 'preview'].includes(page.id))
type PageId = typeof pages[number]['id']
function pageFromLocation(): PageId {
  const id = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  return pages.some(page => page.id === id) ? id as PageId : 'dramas'
}
const current = ref<PageId>(pageFromLocation())
const activePage = computed(() => pages.find(page => page.id === current.value)!)
const user = ref<User | null>(null)
const checking = ref(true)
const busy = ref(false)
const error = ref('')
const email = ref('')
const password = ref('')
const visitedMedia = ref(current.value === 'media')
const mediaDrama = ref<number | null>(null)
const returnDrama = ref<number | null>(null)
const returnStep = ref<'basic' | 'episodes' | 'publish'>('basic')
const uploadActive = ref(false)
const uploadPending = ref(false)
const creatingFromUpload = ref(false)
const workspaceRevision = ref(0)
const revision = ref(0)
const listFilters = ref(newContentFilters(true))
const dramaManager = ref<InstanceType<typeof DramaManager>>()
const analysisState = ref(newAnalysisState())
const analyticsDashboard = ref<InstanceType<typeof AnalyticsDashboard>>()
const analysisEvidence = ref<Evidence | null>(null)
const analysisHome = ref<{ region: string; locale: string } | null>(null)
const analysisOrderId = ref<string | null>(null)
function clearAnalysis() {
  analysisState.value = newAnalysisState(); clearActionEvidence()
}
function clearActionEvidence() {
  analysisEvidence.value = null; analysisHome.value = null; analysisOrderId.value = null
}
const mobileNavOpen = ref(false)
const heading = ref<HTMLElement>()
const adminAllowed = computed(() => user.value?.role === 'admin')
let sessionGeneration = 0
const theme = ref<'light' | 'dark'>('light')
const fontSize = ref<'standard' | 'large'>('standard')
const displayStorageAvailable = ref(true)
try {
  theme.value = localStorage.getItem('aurora:admin:theme') === 'dark' ? 'dark' : 'light'
  fontSize.value = localStorage.getItem('aurora:admin:font') === 'large' ? 'large' : 'standard'
} catch { displayStorageAvailable.value = false }
function applyDisplay(value = { theme: theme.value, font: fontSize.value }, persist = false) {
  theme.value = value.theme; fontSize.value = value.font
  document.documentElement.dataset.adminTheme = value.theme
  document.documentElement.dataset.adminFont = value.font
  if (persist) {
    try {
      localStorage.setItem('aurora:admin:theme', value.theme)
      localStorage.setItem('aurora:admin:font', value.font)
      displayStorageAvailable.value = true
    } catch { displayStorageAvailable.value = false }
  }
}
applyDisplay()
function expire() {
  sessionGeneration++
  user.value = null
  visitedMedia.value = false
  mediaDrama.value = null
  returnDrama.value = null
  uploadActive.value = false; uploadPending.value = false
  creatingFromUpload.value = false
  listFilters.value = clearContentFilters()
  clearAnalysis()
  mobileNavOpen.value = false
  // 401 后不要在重新登录时立即挂载刚刚拒绝访问的页面，避免“登录→401→登录”循环。
  current.value = 'dramas'
  history.replaceState(null, '', '#/dramas')
  password.value = ''
  error.value = '登录已过期，请重新登录。已上传文件仍保留在服务器，可登录后在资产列表核对。'
}
async function checkSession() {
  checking.value = true
  error.value = ''
  const generation = sessionGeneration
  try {
    const data = await api<SessionInfo>('/auth/me', { notify401: false })
    if (generation === sessionGeneration) user.value = data.user
  } catch (cause) {
    user.value = null
    error.value = message(cause)
  } finally { checking.value = false }
}
async function login() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api<SessionInfo>('/auth/login', { method: 'POST', body: { email: email.value.trim(), password: password.value }, notify401: false })
    // 以 /me 再校验角色，普通用户从不挂载管理组件。
    const data = await api<SessionInfo>('/auth/me', { notify401: false })
    user.value = data.user
    if (!data.user) error.value = '登录未建立有效会话，请重试。'
    current.value = pageFromLocation()
    if (current.value === 'media') visitedMedia.value = true
    returnDrama.value = null
    listFilters.value = clearContentFilters()
    clearAnalysis()
  } catch (cause) { error.value = message(cause) }
  finally { busy.value = false; password.value = '' }
}
async function logout() {
  if (busy.value) return
  if (!allowAdminNavigation()) return
  if ((uploadActive.value || uploadPending.value) && !window.confirm('当前有正在处理或尚未上传的文件。退出会丢失未完成队列，已完成资产不会删除。仍要退出吗？')) return
  busy.value = true
  error.value = ''
  try {
    await api('/auth/logout', { method: 'POST', body: {} })
    sessionGeneration++
    user.value = null
    visitedMedia.value = false
    mediaDrama.value = null
    returnDrama.value = null
    uploadActive.value = false; uploadPending.value = false
    listFilters.value = clearContentFilters()
    clearAnalysis()
    mobileNavOpen.value = false
  } catch (cause) { error.value = message(cause) }
  finally { busy.value = false }
}
async function navigate(id: PageId, keepDrama = false, fromHistory = false, prepare?: () => void) {
  if ((id !== current.value || (id === 'dramas' && !keepDrama)) && !allowAdminNavigation()) {
    if (fromHistory) history.replaceState(null, '', `#/${current.value}`)
    return false
  }
  if (current.value === 'dramas' || current.value === 'home') dramaManager.value?.remember()
  if (id === 'dramas' && !keepDrama) {
    returnDrama.value = null; creatingFromUpload.value = false; workspaceRevision.value++
  }
  if (current.value === 'analytics' && id !== current.value) analyticsDashboard.value?.remember()
  // 普通导航不携带上一部作品的分析依据；有意的同作品接续由 prepare 明确保留。
  if (!prepare) clearActionEvidence()
  prepare?.()
  current.value = id
  mobileNavOpen.value = false
  if (!fromHistory && window.location.hash !== `#/${id}`) history.pushState(null, '', `#/${id}`)
  if (id === 'media') visitedMedia.value = true
  await nextTick()
  heading.value?.focus()
  window.scrollTo({ top: 0 })
  return true
}
async function analysisAction(action: AnalysisAction) {
  const target = action.target === 'home' ? 'home' : action.target === 'orders' ? 'orders' : 'dramas'
  await navigate(target, true, false, () => {
    analysisEvidence.value = action.evidence
    analysisHome.value = action.region && action.locale ? { region: action.region, locale: action.locale } : null
    analysisOrderId.value = action.target === 'orders' ? action.orderId ?? null : null
    returnDrama.value = action.evidence.dramaId
    returnStep.value = action.target === 'review' ? 'publish' : action.target === 'episodes' ? 'episodes' : 'basic'
    creatingFromUpload.value = false; workspaceRevision.value++
  })
}
async function openMedia(id: number) {
  // 草稿保存的 finally 先结束，自动返回上传不会被“保存中”状态误拦。
  await nextTick()
  if (await navigate('media', false, false, () => {
    if (analysisEvidence.value?.dramaId !== id) clearActionEvidence()
  })) {
    mediaDrama.value = id
    creatingFromUpload.value = false
  }
}
function createFromMedia() {
  if (!allowAdminNavigation()) return
  returnDrama.value = null; creatingFromUpload.value = true; workspaceRevision.value++
  void navigate('dramas', true)
}
function backToDrama(id: number) {
  returnDrama.value = id; returnStep.value = 'episodes'
  void navigate('dramas', true)
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (uploadActive.value || uploadPending.value) { event.preventDefault(); event.returnValue = '' }
}
function locationChanged() {
  if (!pages.some(page => window.location.hash === `#/${page.id}`)) return
  const next = pageFromLocation()
  if (next !== current.value) void navigate(next, false, true)
}
onMounted(() => {
  window.addEventListener(SESSION_EXPIRED, expire)
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('popstate', locationChanged)
  window.addEventListener('hashchange', locationChanged)
  void checkSession()
})
onBeforeUnmount(() => {
  window.removeEventListener(SESSION_EXPIRED, expire)
  window.removeEventListener('beforeunload', beforeUnload)
  window.removeEventListener('popstate', locationChanged)
  window.removeEventListener('hashchange', locationChanged)
})
</script>

<template>
  <div v-if="checking" class="auth-shell">
    <div class="auth-card"><p class="eyebrow">aurora / ADMIN</p><h1>正在验证管理员会话</h1><p role="status">请稍候…</p></div>
  </div>
  <div v-else-if="!adminAllowed" class="auth-shell">
    <div class="auth-card">
      <AuroraMark class="brand-mark" :size="44" />
      <p class="eyebrow">aurora / ADMIN</p>
      <template v-if="user">
        <h1>此账户没有管理权限</h1>
        <p class="muted">你已登录普通用户账户。后台仅允许管理员访问，不会展示任何运营数据。</p>
        <Feedback :error="error" />
        <button class="button primary" :disabled="busy" @click="logout">{{ busy ? '退出中…' : '退出并切换管理员账户' }}</button>
      </template>
      <form v-else @submit.prevent="login">
        <h1>登录管理后台</h1>
        <p class="muted">使用已分配的管理员账户。普通观众账户不能进入管理后台。</p>
        <Feedback :error="error" />
        <label class="field"><span>邮箱</span><input v-model="email" type="email" autocomplete="username" required :disabled="busy" /></label>
        <label class="field"><span>密码</span><input v-model="password" type="password" autocomplete="current-password" required :disabled="busy" /></label>
        <button class="button primary full" type="submit" :disabled="busy">{{ busy ? '登录中…' : '登录管理后台' }}</button>
        <button v-if="error" class="button quiet full" type="button" :disabled="busy" @click="checkSession">重新检查会话</button>
      </form>
      <p class="auth-footnote">aurora 运营工作台 · 按语言管理内容</p>
    </div>
  </div>
  <div v-else class="admin-shell">
    <a href="#main-content" class="skip-link" @click.prevent="heading?.focus()">跳到主内容</a>
    <div class="mobile-topbar">
      <div class="brand"><AuroraMark class="brand-mark" :size="28" /><strong>aurora</strong></div>
      <button type="button" class="button" :aria-expanded="mobileNavOpen" aria-controls="admin-sidebar" :aria-label="mobileNavOpen ? '收起管理导航' : '展开管理导航'" @click="mobileNavOpen = !mobileNavOpen">{{ mobileNavOpen ? '收起菜单' : '管理菜单' }}</button>
    </div>
    <aside id="admin-sidebar" class="sidebar" :class="{ 'mobile-open': mobileNavOpen }">
      <div class="brand"><AuroraMark class="brand-mark" :size="34" /><div><strong>aurora</strong><small>运营后台</small></div></div>
      <p class="sidebar-caption">工作空间</p>
      <nav aria-label="管理导航">
        <button v-for="page in dailyPages" :key="page.id" :class="['nav-item', { active: current === page.id }]" :aria-current="current === page.id ? 'page' : undefined" @click="navigate(page.id)">
          <AdminIcon :name="page.id" /><span>{{ page.label }}</span>
          <span v-if="page.id === 'media' && uploadActive" class="activity-dot" aria-label="正在上传"></span>
        </button>
        <details class="nav-advanced" :open="supportPages.some(page => page.id === current)">
          <summary>上传与账户</summary>
          <button v-for="page in supportPages" :key="page.id" :class="['nav-item', { active: current === page.id }]" :aria-current="current === page.id ? 'page' : undefined" @click="navigate(page.id)"><AdminIcon :name="page.id" /><span>{{ page.label }}</span><span v-if="page.id === 'media' && uploadActive" class="activity-dot" aria-label="正在上传"></span></button>
        </details>
        <details class="nav-advanced" :open="advancedPages.some(page => page.id === current)">
          <summary>平台与维护</summary>
          <button v-for="page in advancedPages" :key="page.id" :class="['nav-item', { active: current === page.id }]" :aria-current="current === page.id ? 'page' : undefined" @click="navigate(page.id)"><AdminIcon :name="page.id" /><span>{{ page.label }}</span></button>
        </details>
      </nav>
      <div class="sidebar-bottom">
        <button class="nav-item" :class="{ active: current === 'settings' }" :aria-current="current === 'settings' ? 'page' : undefined" @click="navigate('settings')"><AdminIcon name="settings" />显示设置</button>
        <div class="account"><strong>{{ user?.nickname || '管理员' }}</strong><span class="badge">管理员</span></div>
        <button class="button full" :disabled="busy" @click="logout">{{ busy ? '退出中…' : '退出登录' }}</button>
      </div>
    </aside>
    <main id="main-content" class="main-content">
      <header class="page-header">
        <div class="page-heading"><h1 ref="heading" tabindex="-1">{{ activePage.label }}</h1><p class="muted">{{ activePage.description }}</p></div>
        <button v-if="current === 'dramas'" type="button" class="button" @click="navigate('media')"><AdminIcon name="media" />上传素材</button>
      </header>
      <Feedback :error="error" />
      <AnalysisEvidence v-if="analysisEvidence && current !== 'analytics'" :evidence="analysisEvidence" @back="navigate('analytics', true)" />
      <DramaManager v-if="current === 'dramas' || current === 'home'" ref="dramaManager" :key="`${current}:${workspaceRevision}`" :filters="listFilters" :analysis="analysisEvidence" :analysis-home="current === 'home' ? analysisHome : null" :initial-view="current === 'home' ? 'home' : 'list'" :initial-creating="creatingFromUpload" :upload-after-create="creatingFromUpload" :initial-drama-id="current === 'dramas' ? returnDrama : null" :initial-editor-step="returnStep" :revision="revision" @filter-change="listFilters = $event" @view="navigate($event === 'home' ? 'home' : 'dramas')" @cancel-create="creatingFromUpload = false" @editing="id => { if (analysisEvidence?.dramaId !== id) clearActionEvidence() }" @media="openMedia" @changed="revision++" />
      <!-- 上传页切换导航时不卸载，上传和成功记录保持；退出时彻底卸载。 -->
      <MediaWorkspace v-if="visitedMedia" v-show="current === 'media'" :initial-drama-id="mediaDrama" :revision="revision" @create="createFromMedia" @pending="uploadPending = $event" @target-change="mediaDrama = $event" @edit="backToDrama" @busy="uploadActive = $event" @changed="revision++" />
      <PreviewCatalog v-if="current === 'preview'" />
      <AnalyticsDashboard v-if="current === 'analytics'" ref="analyticsDashboard" :state="analysisState" @state="analysisState = $event" @action="analysisAction" />
      <DisplaySettings v-if="current === 'settings'" :theme="theme" :font="fontSize" :storage-available="displayStorageAvailable" @change="applyDisplay($event, true)" @navigate="navigate($event)" />
      <OperationsPanel v-if="!['dramas', 'home', 'media', 'preview', 'analytics', 'settings'].includes(current)" :key="`${current}:${analysisOrderId ?? ''}`" :order-id="analysisOrderId" :section="current as 'orders' | 'users' | 'audit' | 'integrations'" />
    </main>
  </div>
</template>
