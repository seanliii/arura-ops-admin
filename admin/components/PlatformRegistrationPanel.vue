<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { Drama } from '../../shared/contracts'
import type { MediaRegistrationPhase, MediaRegistrationStatus } from '../../shared/media-registration'
import { formatDate } from '../api'
import { createMediaRegistrationController, type RegistrationForm, type RegistrationView } from '../media-registration'

const props = defineProps<{ drama: Drama; disabled?: boolean }>()
const emit = defineEmits<{
  busy: [value: boolean]
  changed: []
  registered: [value: { albumId: string; platformVersion: number }]
}>()
const session = createMediaRegistrationController({
  onChange: value => { view.value = value },
  onBusy: value => emit('busy', value),
  onChanged: () => emit('changed'),
  onRegistered: value => emit('registered', value),
  isDisabled: () => props.disabled === true,
})
const view = shallowRef<RegistrationView>(session.view)
const state = computed(() => view.value.registration)
const job = computed(() => state.value?.job)
const yearLabel = computed(() => !job.value && props.drama.registrationMetadata?.releaseStatus === 'unreleased'
  ? '计划首发年份' : '首次发行年份')
const contentLanguage = computed(() => {
  const language = props.drama.language
  if (language === 'ja') return '日语 ja'
  if (language === 'en') return '英语 en'
  if (language === 'und') return '未确定 und'
  return language ? `视频版本 ${language}` : '未填写'
})
const resultNotice = ref<HTMLElement>()
const recoveryAlbum = ref(''), recoveryCover = ref('')
const blocked = computed(() => view.value.busy || props.disabled || view.value.expired)
const phaseLabels: Record<MediaRegistrationPhase, string> = {
  cover: '上传封面', create: '创建平台草稿', update: '更新封面与剧集资料', verify: '查询并核对草稿', done: '草稿登记已核对',
}
const statusLabels: Record<MediaRegistrationStatus, string> = {
  ready: '快照已保存 · 待执行', running: '正在执行', failed: '失败 · 需核对后继续',
  unknown: '结果未知 · 禁止重放', stale: '资料已过期', registered: '草稿登记已核对',
  superseded: '旧快照已被替换',
}
const typeLabels = { 1: 'AIGC', 2: '漫剧', 3: '真人配音', 4: '真人本地化' }
const submitLabel = computed(() => {
  if (job.value && ['ready', 'failed'].includes(job.value.status)) {
    if (job.value.phase === 'verify') return '重新查询此任务结果'
    return job.value.phase === 'update' && state.value?.recovery?.albumId === job.value.albumId
      ? '核对并继续已恢复草稿' : '继续执行已保存草稿'
  }
  return '保存快照并执行'
})
const reading = computed(() => ({
  load: '正在读取本地登记记录…', prepare: '正在保存本次资料快照…',
  run: '服务器正在核对或执行已确认的草稿登记，请勿重复操作…', reconcile: '正在查询已知 Album，不会重放写请求…',
  recover: '正在查询原 Album 并保存已有回执，不会创建、更新或发布…',
})[view.value.action ?? 'load'])
function edit(field: keyof RegistrationForm, event: Event) {
  session.edit(field, (event.target as HTMLInputElement | HTMLSelectElement).value)
}
async function perform(action: 'run' | 'reconcile') {
  const dramaId = props.drama.id
  if (action === 'run') await session.saveAndRun()
  else await session.reconcile()
  if (props.drama.id === dramaId && !view.value.expired && job.value?.status === 'registered') {
    await nextTick()
    // 完成后按钮可能变为disabled；将键盘焦点放到可读结果，不滚动打断当前阅读位置。
    resultNotice.value?.focus?.({ preventScroll: true })
  }
}
watch(() => state.value?.recovery, recovery => {
  if (recovery) { recoveryAlbum.value = recovery.albumId; recoveryCover.value = '' }
})
watch(() => view.value.expired, expired => {
  if (expired) { recoveryAlbum.value = ''; recoveryCover.value = '' }
})
watch(() => [props.drama.id, props.drama.version], () => {
  recoveryAlbum.value = ''; recoveryCover.value = ''
  void session.select(props.drama)
}, { immediate: true })
onBeforeUnmount(() => { recoveryAlbum.value = ''; recoveryCover.value = ''; session.dispose() })
</script>

<template>
  <section class="panel platform-registration" data-testid="platform-registration" aria-label="新建／更新平台草稿" :aria-busy="view.busy">
    <div class="section-heading">
      <div><h3>新建／更新平台草稿</h3><p class="muted">保存资料快照 → 上传封面 → 新建或更新平台草稿 → 查询核对。</p></div>
      <button class="button" type="button" data-testid="registration-refresh" :disabled="blocked" @click="session.load()">刷新本地登记记录</button>
    </div>
    <p class="notice">打开或刷新本页只读取本地记录，不自动请求平台。常规剧目执行会提交封面和剧集信息；恢复已有回执仅查询并保存到本地。按钮点击即为对应操作的确认，都不会自动提审、授权或上架。</p>
    <p class="notice">“保存发行资料”只存后台，不代表平台登记成功。这里在没有旧任务时预填已保存资料；有旧任务时使用原快照。已有发行资料需要修改时，请先在上方保存，再核对本表单；本表单不会替你保存发行资料。资料未齐全也可先保存后台，补齐后再主动执行；执行会请求平台，不会自动提审。</p>
    <p v-if="view.busy" class="loading" role="status" data-testid="registration-loading">{{ reading }}</p>
    <p v-if="view.error" class="notice error registration-error" role="alert" data-testid="registration-error">{{ view.error }}</p>
    <p v-if="view.expired" class="notice warning" role="status">登录状态或管理员已变化，旧资料已清除，请重新登录。</p>
    <template v-if="state && !view.expired">
      <div class="registration-target">
        <span>目标：{{ drama.title }} · #{{ state.dramaId }}</span>
        <span>当前本地版本：{{ state.localVersion }} · 已核验素材集数：{{ state.episodeCount }}</span>
        <span data-testid="registration-language">内容语言：{{ contentLanguage }}</span>
        <span data-testid="registration-japanese-config">服务器日语配置（非内容语言）：{{ state.japaneseLanguageCode === 'ja' ? 'ja（日语）' : '未配置' }}</span>
      </div>
      <div v-if="!state.configured || state.reasons.length" class="notice warning" data-testid="registration-reasons">
        <strong v-if="!state.configured">剧目登记所需服务器配置未就绪，不能执行剧目；若下方允许，仍可单独恢复已有回执。</strong>
        <ul v-if="state.reasons.length"><li v-for="reason in state.reasons" :key="reason">{{ reason }}</li></ul>
      </div>
      <p v-if="state.localVersion !== drama.version" class="notice warning">剧目资料版本已变化，已通知上层刷新。核对新资料前不会提交旧版本。</p>
      <p v-if="view.needsLocalRead" class="notice warning">暂时无法确认最新记录，已保留已知资料。请先刷新本地记录，不要重复执行。</p>
      <details v-if="(!job && state.recoveryAvailable) || state.recovery" class="registration-recovery" data-testid="recovery-details">
        <summary>恢复已有平台回执（避免重复创建）</summary>
        <p class="notice">只填写同一应用、当前封面的真实平台回执。点击即确认：服务器只查询原 Album，确认版本列表为空后保存回执；不创建或更新剧目、不重传图片、不提审或发布。空版本结果不代表版权、授权或审核已通过。已有恢复记录不能被改写。</p>
        <form class="form-grid registration-form" data-testid="registration-recovery-form" novalidate
          @submit.prevent="session.recoverReceipts(recoveryAlbum, recoveryCover)">
          <label class="field">
            <span>已有 Album ID</span>
            <input :value="recoveryAlbum" type="text" inputmode="numeric" autocomplete="off" maxlength="19"
              aria-label="已有 Album ID" data-testid="recovery-album-id" :disabled="blocked || !session.canRecover"
              @input="recoveryAlbum = ($event.target as HTMLInputElement).value" />
          </label>
          <label class="field">
            <span>当前封面的回执 ID（open_pic_id）</span>
            <input :value="recoveryCover" type="text" autocomplete="off" maxlength="256"
              aria-label="当前封面回执 ID" data-testid="recovery-cover-pic-id" :disabled="blocked || !session.canRecover"
              @input="recoveryCover = ($event.target as HTMLInputElement).value" />
          </label>
          <div class="form-actions">
            <button class="button" type="submit" data-testid="recovery-submit"
              :disabled="blocked || !session.canRecover">确认查询并保存已有回执</button>
          </div>
        </form>
      </details>
      <section v-if="state.recovery" class="notice" data-testid="registration-recovery" aria-label="已恢复的平台回执">
        <strong>已恢复原回执，不是已完成的剧目登记任务</strong>
        <dl class="registration-details">
          <div><dt>保留的 Album ID</dt><dd data-testid="registration-recovery-album-id">{{ state.recovery.albumId }}</dd></div>
          <div><dt>恢复时本地版本</dt><dd>{{ state.recovery.localVersion }}</dd></div>
        </dl>
        <p v-if="state.recovery.coverReady">封面回执已对应当前封面，后续可复用。</p>
        <p v-else class="warning">当前封面已改变，后续登记需重传封面；原 Album ID 仍保留，不会重复创建。</p>
        <p>后续执行会复用此 Album；若已有完全匹配的版本，仅查询并采用，不会重复创建或更新。</p>
        <p>恢复时间：{{ formatDate(state.recovery.recoveredAt) }}。未创建或更新剧目、未提审；正式日语配置未就绪时仍不能执行剧目。</p>
      </section>
      <form class="form-grid registration-form" data-testid="registration-form" novalidate @submit.prevent="perform('run')">
        <label class="field">
          <span>{{ yearLabel }}</span>
          <input :value="view.form.year" data-testid="registration-year" :aria-label="yearLabel" inputmode="numeric"
            type="text" autocomplete="off" maxlength="4" :aria-describedby="`registration-year-help-${drama.id}`"
            :disabled="blocked || session.formLocked" @input="edit('year', $event)" />
          <small :id="`registration-year-help-${drama.id}`">执行登记需确认年份（1900–2200），不会默认填今年；不确定时可先仅保存后台发行资料。</small>
        </label>
        <label class="field">
          <span>内容类型</span>
          <select :value="view.form.dramaType" data-testid="registration-drama-type" aria-label="内容类型"
            :disabled="blocked || session.formLocked" @change="edit('dramaType', $event)">
            <option value="" disabled>请选择真实内容类型</option>
            <option value="1">1 · AIGC</option><option value="2">2 · 漫剧</option>
            <option value="3">3 · 真人配音</option><option value="4">4 · 真人本地化</option>
          </select>
        </label>
        <label class="field">
          <span>连载状态</span>
          <select :value="view.form.albumStatus" data-testid="registration-album-status" aria-label="连载状态"
            :disabled="blocked || session.formLocked" @change="edit('albumStatus', $event)">
            <option value="" disabled>请选择连载状态</option>
            <option value="2">2 · 连载中</option><option value="3">3 · 已完结</option>
          </select>
        </label>
        <label class="field">
          <span>平台标签 ID</span>
          <input :value="view.form.tagIds" type="text" autocomplete="off" required
            data-testid="registration-tag-ids" aria-label="平台标签 ID"
            placeholder="多个 ID 用逗号分隔" :aria-describedby="`registration-tags-help-${drama.id}`"
            :disabled="blocked || session.formLocked" @input="edit('tagIds', $event)" />
          <small :id="`registration-tags-help-${drama.id}`">请按平台给出的实际分类 ID 填写；测试样例不可当作上线分类。用中英文逗号分隔，最多 20 个不同 ID。</small>
        </label>
        <div class="form-actions">
          <button class="button primary" type="submit" data-testid="registration-submit"
            :disabled="blocked || (!session.canPrepare && !session.canRun)">{{ submitLabel }}</button>
        </div>
      </form>
      <p v-if="job && session.formLocked" class="muted">已保存的快照资料不可在继续时改写；继续只使用原任务 ID，不会重新准备另一份任务。</p>
      <section v-if="job" class="registration-job" data-testid="registration-job" aria-label="平台草稿登记任务">
        <div class="inline wrap">
          <h4>已保存任务</h4>
          <span class="badge" :class="['failed', 'unknown', 'stale'].includes(job.status) ? 'warning' : 'neutral'"
            data-testid="registration-job-status" :data-status="job.status">{{ statusLabels[job.status] }}</span>
        </div>
        <dl class="registration-details">
          <div><dt>任务 ID</dt><dd data-testid="registration-job-id">{{ job.id }}</dd></div>
          <div><dt>服务器记录的步骤</dt><dd data-testid="registration-phase" :data-phase="job.phase">{{ phaseLabels[job.phase] }}</dd></div>
          <div><dt>已保存 Album ID</dt><dd data-testid="registration-album-id">{{ job.albumId ?? '尚无已确认 ID' }}</dd></div>
          <div><dt>已保存平台版本</dt><dd data-testid="registration-platform-version">{{ job.platformVersion ?? '尚无已确认版本' }}</dd></div>
          <div><dt>快照本地版本 / 集数</dt><dd>{{ job.localVersion }} / {{ job.episodeCount }}</dd></div>
          <div><dt>快照资料</dt><dd>{{ job.year }} 年 · {{ typeLabels[job.dramaType] }} · {{ job.albumStatus === 2 ? '连载中' : '已完结' }}</dd></div>
          <div><dt>平台标签 ID</dt><dd data-testid="registration-job-tag-ids">{{ job.tagList.join(', ') }}</dd></div>
        </dl>
        <p data-testid="registration-job-message">{{ job.message }}<span v-if="job.errorCode">（{{ job.errorCode }}）</span></p>
        <p class="muted">最近记录：{{ formatDate(job.updatedAt) }}</p>
        <p v-if="job.status === 'running'" class="notice warning">服务器仍在执行，已禁止重复操作。刷新本地记录查看进度，不会自动再次执行。</p>
        <p v-if="job.status === 'unknown'" class="notice warning" data-testid="registration-unknown">
          <template v-if="['update', 'verify'].includes(job.phase) && job.albumId">已有 Album，允许仅查询原任务结果；不会再次上传、创建或更新。</template>
          <template v-else>封面上传或建剧结果未知，不能重传或重建，也不能靠新任务绕过。请向平台核对原操作。</template>
        </p>
        <p v-if="job.phase === 'verify' && ['failed', 'stale'].includes(job.status)" class="notice">平台版本已生成，单集映射尚待核对。可仅查询原版本；本地资料已修改时，先核对原快照映射，再准备新快照，不会重建或重复更新。</p>
        <p v-if="job.status === 'stale'" class="notice warning">快照资料已过期。请刷新剧目资料并核对后，主动保存新的快照；旧 Album 和版本保留用于核对，不会自动提交新资料。</p>
        <p v-if="job.status === 'superseded'" class="notice warning">此旧快照已被替换，不能执行；请刷新本地记录查看当前任务。</p>
        <p v-if="job.status === 'registered'" ref="resultNotice" tabindex="-1" class="notice" data-testid="registration-registered">
          平台草稿登记已核对，<strong>不代表审核通过、已授权、已上架或可售</strong>。下一步只将下方 ID 和版本交给已有媒体面板查询、配置审核。
        </p>
        <div class="inline wrap registration-actions">
          <button v-if="job.albumId && ((job.status === 'unknown' && ['update', 'verify'].includes(job.phase)) ||
            (job.phase === 'verify' && ['failed', 'stale'].includes(job.status)))"
            class="button" type="button" data-testid="registration-reconcile" :disabled="blocked || !session.canReconcile" @click="perform('reconcile')">仅查询已知 Album 核对结果</button>
          <button v-if="job.status === 'registered'" class="button primary" type="button" data-testid="registration-use-version"
            :disabled="blocked || !session.canUseRegistered" @click="session.useRegistered()">使用此版本继续审核配置</button>
        </div>
      </section>
      <p v-else-if="!view.busy" class="muted">尚未准备登记快照。填写并核对以上真实资料后，再点击执行。</p>
    </template>
  </section>
</template>

<style scoped>
.platform-registration { min-width: 0; overflow-wrap: anywhere; }
.platform-registration .notice { display: block; }
.registration-form select {
  appearance: none; min-height: 44px; padding-right: 34px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m4 6 4 4 4-4' fill='none' stroke='%23c9cada' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 12px center; background-size: 16px;
}
.registration-target { display: flex; flex-wrap: wrap; gap: .5rem 1rem; margin: 1rem 0; font-size: .875rem; }
.registration-form { margin: 1rem 0; }
.registration-recovery { margin: 1rem 0; }
.registration-recovery summary { cursor: pointer; padding: .75rem 0; font-weight: 600; }
.registration-job { margin-top: 1.25rem; border-top: 1px solid var(--border, #e4e7eb); padding-top: 1rem; }
.registration-job h4 { margin: 0; }
.registration-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .85rem 1rem; }
.registration-details div { min-width: 0; }
.registration-details dt { margin-bottom: .25rem; font-size: .875rem; color: var(--muted, #626b78); }
.registration-details dd { margin: 0; font-weight: 600; }
.registration-error { white-space: pre-line; }
.registration-actions { margin-top: 1rem; }
@media (max-width: 600px) {
  .registration-details { grid-template-columns: 1fr; }
  .registration-actions > button { width: 100%; }
}
</style>
