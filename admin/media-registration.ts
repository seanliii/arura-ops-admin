import type { Drama } from '../shared/contracts'
import type { MediaRegistrationJob, MediaRegistrationState } from '../shared/media-registration'
import { api, ApiError, message, SESSION_EXPIRED } from './api'

export interface RegistrationForm { year: string; dramaType: string; albumStatus: string; tagIds: string }
export interface RegistrationView {
  registration: MediaRegistrationState | null
  form: RegistrationForm
  busy: boolean
  action: 'load' | 'prepare' | 'run' | 'reconcile' | 'recover' | null
  error: string
  needsLocalRead: boolean
  expired: boolean
}
type Target = Pick<Drama, 'id' | 'version' | 'registrationMetadata'>
type Registered = { albumId: string; platformVersion: number }
interface Options {
  onChange?: (view: RegistrationView) => void
  onBusy?: (busy: boolean) => void
  onChanged?: () => void
  onRegistered?: (value: Registered) => void
  isDisabled?: () => boolean
}
const phases = ['cover', 'create', 'update', 'verify', 'done']
const statuses = ['ready', 'running', 'failed', 'unknown', 'stale', 'registered', 'superseded']
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const blankForm = (): RegistrationForm => ({ year: '', dramaType: '', albumStatus: '', tagIds: '' })
const savedForm = (target: Target): RegistrationForm => {
  const saved = target.registrationMetadata
  return saved ? {
    year: saved.year === null ? '' : String(saved.year),
    dramaType: saved.dramaType === null ? '' : String(saved.dramaType),
    albumStatus: saved.albumStatus === null ? '' : String(saved.albumStatus),
    tagIds: sortedTags(saved.tagList).join(', '),
  } : blankForm()
}
const integer = (value: unknown, min = 1): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.trim() === value
const MAX_TAG_IDS = 20
const MAX_TAG_ID = 2147483647
const validTagList = (value: unknown): value is number[] => Array.isArray(value) &&
  value.length > 0 && value.length <= MAX_TAG_IDS &&
  Array.from(value).every(item => integer(item) && item <= MAX_TAG_ID) && new Set(value).size === value.length
const sortedTags = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b)
function parseTagIds(value: string): number[] {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请明确填写平台标签 ID，不会使用测试样例或默认分类。')
  const parts = value.split(/[,，]/).map(part => part.trim())
  if (parts.some(part => !/^[1-9]\d*$/.test(part))) {
    throw new Error('平台标签 ID 只能填写正整数，以逗号分隔；不能填写分类名称、空项或小数。')
  }
  const values = [...new Set(parts.map(Number))]
  if (!validTagList(values)) throw new Error('平台标签 ID 须在 1–2147483647 之间，最多填写 20 个不同 ID。')
  return sortedTags(values)
}
// 不转 Number：平台长 ID 可超过 JavaScript 的精确整数范围。
const albumId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) &&
  (value.length < 19 || value <= '9223372036854775807')
function check(ok: unknown, detail: string): asserts ok {
  if (!ok) throw new Error(`服务器登记记录${detail}，未采用该响应，请刷新本地记录核对。`)
}
function metadata(form: RegistrationForm) {
  if (!/^\d{4}$/.test(form.year) || Number(form.year) < 1900 || Number(form.year) > 2200) {
    throw new Error('请填写真实发行年份（1900–2200 的整数），不能留空或使用小数。')
  }
  if (!['1', '2', '3', '4'].includes(form.dramaType)) throw new Error('请选择内容类型：AIGC、漫剧、真人配音或真人本地化。')
  if (!['2', '3'].includes(form.albumStatus)) throw new Error('请选择连载中或已完结。')
  return {
    year: Number(form.year), dramaType: Number(form.dramaType) as MediaRegistrationJob['dramaType'],
    albumStatus: Number(form.albumStatus) as MediaRegistrationJob['albumStatus'],
    tagList: parseTagIds(form.tagIds),
  }
}
const jobForm = (job: MediaRegistrationJob): RegistrationForm => ({
  year: String(job.year), dramaType: String(job.dramaType), albumStatus: String(job.albumStatus),
  tagIds: sortedTags(job.tagList).join(', '),
})
function sameMetadata(form: RegistrationForm, job: MediaRegistrationJob): boolean {
  if (form.year !== String(job.year) || form.dramaType !== String(job.dramaType) || form.albumStatus !== String(job.albumStatus)) return false
  try {
    const chosen = parseTagIds(form.tagIds), saved = sortedTags(job.tagList)
    return chosen.length === saved.length && chosen.every((value, index) => value === saved[index])
  } catch { return false }
}

/** 边界只接受 shared 协议；不把服务器附带的其他字段带入页面。 */
function validate(raw: unknown, target: Target, ownerId?: string): MediaRegistrationState {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), '格式无效')
  const value = raw as MediaRegistrationState
  if (!text(value.ownerId) || (ownerId !== undefined && value.ownerId !== ownerId)) {
    throw new ApiError(401, 'SESSION_CHANGED', '当前管理员已变化，请重新登录。')
  }
  check(value.dramaId === target.id, '目标剧目不一致')
  check(integer(value.localVersion) && value.localVersion >= target.version, '本地版本无效或过旧')
  check(typeof value.configured === 'boolean' && typeof value.ready === 'boolean', '配置状态无效')
  check(Array.isArray(value.reasons) && value.reasons.every(reason => typeof reason === 'string'), '原因字段无效')
  check(integer(value.episodeCount, 0), '集数无效')
  check(value.japaneseLanguageCode === null || value.japaneseLanguageCode === 'ja', '日语配置无效')
  check(!value.configured || value.japaneseLanguageCode === 'ja', '缺少正式日语配置')
  check(value.recoveryAvailable === undefined || typeof value.recoveryAvailable === 'boolean', '回执恢复可用状态无效')
  const recovery = value.recovery
  check(recovery == null || (typeof recovery === 'object' && !Array.isArray(recovery)), '恢复回执格式无效')
  if (recovery != null) {
    check(albumId(recovery.albumId), '恢复回执 Album ID 无效')
    check(integer(recovery.localVersion) && recovery.localVersion <= value.localVersion, '恢复回执本地版本无效')
    check(typeof recovery.coverReady === 'boolean' && integer(recovery.recoveredAt), '恢复回执封面或时间无效')
  }
  const job = value.job
  check(job === null || (typeof job === 'object' && !Array.isArray(job)), '任务格式无效')
  if (job !== null) {
    check(text(job.id) && uuid.test(job.id), '任务 ID 无效')
    check(job.dramaId === target.id && integer(job.localVersion) && job.localVersion <= value.localVersion, '任务目标或快照版本不一致')
    check(statuses.includes(job.status) && phases.includes(job.phase), '任务状态或步骤无效')
    check(job.albumId === null || albumId(job.albumId), 'Album ID 无效')
    check(job.platformVersion === null || integer(job.platformVersion), '平台版本无效')
    check(integer(job.episodeCount) && integer(job.year, 1900) && job.year <= 2200 &&
      [1, 2, 3, 4].includes(job.dramaType) && [2, 3].includes(job.albumStatus), '任务资料无效')
    check(validTagList(job.tagList), '任务标签无效，须为不重复的 1–20 个正整数 ID，且不超过 2147483647')
    check((job.errorCode === null || typeof job.errorCode === 'string') && typeof job.message === 'string', '任务说明无效')
    check(integer(job.createdAt, 0) && integer(job.updatedAt, 0) && job.updatedAt >= job.createdAt, '任务时间无效')
    check(!['update', 'verify', 'done'].includes(job.phase) || albumId(job.albumId), '缺少已保存的平台 ID')
    // update可以是“创建ID已落库、尚无初始版本”；更新后的verify/done不能缺版本。
    check(!['verify', 'done'].includes(job.phase) || integer(job.platformVersion), '缺少已保存的平台版本')
    check(job.status !== 'registered' || job.phase === 'done', '尚未完成草稿核对')
    check(job.phase !== 'done' || ['registered', 'stale', 'superseded'].includes(job.status), '完成步骤与任务状态不一致')
  }
  return {
    ownerId: value.ownerId, dramaId: value.dramaId, localVersion: value.localVersion,
    configured: value.configured, ready: value.ready, reasons: [...value.reasons],
    japaneseLanguageCode: value.japaneseLanguageCode, episodeCount: value.episodeCount,
    ...(value.recoveryAvailable === undefined ? {} : { recoveryAvailable: value.recoveryAvailable }),
    ...(recovery === undefined ? {} : { recovery: recovery === null ? null : {
      albumId: recovery.albumId, localVersion: recovery.localVersion, coverReady: recovery.coverReady, recoveredAt: recovery.recoveredAt,
    } }),
    job: job === null ? null : {
      id: job.id, dramaId: job.dramaId, localVersion: job.localVersion, phase: job.phase, status: job.status,
      albumId: job.albumId, platformVersion: job.platformVersion, episodeCount: job.episodeCount,
      year: job.year, dramaType: job.dramaType, albumStatus: job.albumStatus, tagList: sortedTags(job.tagList),
      errorCode: job.errorCode, message: job.message, createdAt: job.createdAt, updatedAt: job.updatedAt,
    },
  }
}

/** 页面内的一次登记会话：不缓存凭据，不自动重试任何写请求。 */
export function createMediaRegistrationController(options: Options = {}) {
  let view: RegistrationView = {
    registration: null, form: blankForm(), busy: false, action: null, error: '', needsLocalRead: true, expired: false,
  }
  let target: Target | undefined, ownerId: string | undefined
  let generation = 0, disposed = false, dirty = false, notifiedVersion: number | undefined
  let controller: AbortController | undefined
  let preparation: { fingerprint: string; requestId: string } | undefined
  const update = (patch: Partial<RegistrationView>) => {
    const busy = view.busy
    view = { ...view, ...patch }
    options.onChange?.(view)
    if (busy !== view.busy) options.onBusy?.(view.busy)
  }
  const available = () => !disposed && !view.expired && !!target
  const idle = () => available() && !view.busy && !options.isDisabled?.()
  const current = () => available() && !view.needsLocalRead && view.registration?.dramaId === target!.id &&
    view.registration.localVersion === target!.version
  const formLocked = () => !!view.registration?.job && ['ready', 'running', 'failed', 'unknown', 'superseded'].includes(view.registration.job.status)
  const runnable = () => {
    const state = view.registration, job = state?.job
    return !!(current() && state?.configured && job && ['ready', 'failed'].includes(job.status) &&
      job.localVersion === target!.version && sameMetadata(view.form, job) && (job.phase === 'verify' || state.ready))
  }
  const preparable = () => {
    const state = view.registration, job = state?.job
    return !!(current() && state?.configured && state.ready && (!job || job.status === 'stale' ||
      (job.status === 'registered' && (job.localVersion !== target!.version || !sameMetadata(view.form, job)))))
  }
  const reconcilable = () => {
    const state = view.registration, job = state?.job
    // 只读核对原快照允许本地资料已改；run 仍要求当前版本与快照一致。
    return !!(available() && !view.needsLocalRead && state?.configured && job && albumId(job.albumId) &&
      ((job.status === 'unknown' && ['update', 'verify'].includes(job.phase)) ||
        (job.phase === 'verify' && ['failed', 'stale'].includes(job.status))))
  }
  const selectable = () => {
    const job = view.registration?.job
    return !!(current() && job?.status === 'registered' && job.localVersion === target!.version &&
      sameMetadata(view.form, job) && albumId(job.albumId) && integer(job.platformVersion))
  }
  const recoverable = () => current() && view.registration?.recoveryAvailable === true &&
    !view.registration.job && !view.registration.recovery
  function invalidate() {
    generation++
    controller?.abort(); controller = undefined
    update({ busy: false, action: null })
  }
  function expire() {
    if (disposed || view.expired) return
    preparation = undefined; dirty = false
    update({ registration: null, form: blankForm(), error: '', needsLocalRead: true, expired: true })
    invalidate()
  }
  window.addEventListener(SESSION_EXPIRED, expire)
  function authentication(cause: unknown) {
    if (!(cause instanceof ApiError) || ![401, 403].includes(cause.status)) return false
    expire()
    window.dispatchEvent(new Event(SESSION_EXPIRED))
    return true
  }
  type Operation = { signal: AbortSignal; target: Target; live: () => boolean }
  function adopt(raw: unknown, op: Operation, expected?: MediaRegistrationJob) {
    if (!op.live()) return
    const next = validate(raw, op.target, ownerId)
    const previous = view.registration
    check(!previous || next.localVersion >= previous.localVersion, '本地版本倒退')
    if (previous?.recovery) {
      check(next.recovery && next.recovery.albumId === previous.recovery.albumId, '已恢复的 Album ID 被替换或丢失')
      check(next.recovery.localVersion === previous.recovery.localVersion &&
        next.recovery.recoveredAt === previous.recovery.recoveredAt, '已恢复的原回执被改写')
    }
    if (expected) {
      check(next.job?.id === expected.id && next.job.localVersion === expected.localVersion, '任务或快照版本被替换')
    }
    const before = previous?.job, after = next.job
    if (before && after?.id === before.id) {
      check(after.localVersion === before.localVersion && sameMetadata(jobForm(before), after), '已保存的任务资料被替换')
      check(after.updatedAt >= before.updatedAt && phases.indexOf(after.phase) >= phases.indexOf(before.phase), '任务进度倒退')
      check(before.albumId === null || after.albumId === before.albumId, '已保存的 Album ID 被替换')
      check(before.platformVersion === null || (after.platformVersion !== null && after.platformVersion >= before.platformVersion), '平台版本倒退')
      check(before.status !== 'registered' || ['registered', 'stale', 'superseded'].includes(after.status), '已完成任务被恢复为待执行')
    }
    ownerId = next.ownerId
    update({
      registration: next, needsLocalRead: false,
      ...(!dirty ? { form: next.job ? jobForm(next.job) : savedForm(op.target) } : {}),
    })
    if (next.localVersion !== op.target.version && notifiedVersion !== next.localVersion) {
      notifiedVersion = next.localVersion
      options.onChanged?.()
    }
  }
  const endpoint = (op: Operation) => `/admin/dramas/${op.target.id}/platform-registration`
  async function read(op: Operation) {
    if (!op.live()) return
    // 由当前操作处理 401，避免已取消请求的迟到 401 清掉另一个新页面。
    const result = await api<unknown>(endpoint(op), { signal: op.signal, notify401: false })
    if (op.live()) adopt(result, op)
  }
  async function transaction(action: NonNullable<RegistrationView['action']>, work: (op: Operation) => Promise<void>) {
    if (!available() || view.busy || (action !== 'load' && options.isDisabled?.())) return
    const epoch = ++generation, selected = { ...target! }, abort = controller = new AbortController()
    const op: Operation = {
      signal: abort.signal, target: selected,
      live: () => available() && generation === epoch && controller === abort && !abort.signal.aborted &&
        target!.id === selected.id && target!.version === selected.version,
    }
    update({ busy: true, action, ...(action !== 'load' ? { error: '' } : {}) })
    try {
      if (op.live()) await work(op)
    } catch (cause) {
      if (!op.live() || authentication(cause)) return
      update({ error: message(cause), needsLocalRead: true })
      if (cause instanceof ApiError && cause.status === 409) options.onChanged?.()
      // 回执失败不代表没执行。只读一次本地记录，不自动接着 run 或换 requestId。
      if (action !== 'load' && op.live()) {
        update({ action: 'load' })
        try { await read(op) } catch (readError) {
          if (!op.live() || authentication(readError)) return
          update({ error: `${view.error}\n本地记录读取失败：${message(readError)}`, needsLocalRead: true })
        }
      }
    } finally {
      if (op.live()) { controller = undefined; update({ busy: false, action: null }) }
    }
  }
  async function execute(op: Operation, job: MediaRegistrationJob, action: 'run' | 'reconcile') {
    if (!op.live()) return
    update({ action })
    const result = await api<unknown>(`${endpoint(op)}/${encodeURIComponent(job.id)}/${action}`, {
      method: 'POST', body: action === 'run' ? { confirmed: true } : {}, signal: op.signal, notify401: false,
    })
    if (!op.live()) return
    adopt(result, op, job)
    if (op.live()) options.onChanged?.()
  }
  return {
    get view() { return view },
    get formLocked() { return formLocked() },
    get canPrepare() { return idle() && preparable() },
    get canRun() { return idle() && runnable() },
    get canReconcile() { return idle() && reconcilable() },
    get canUseRegistered() { return idle() && selectable() },
    get canRecover() { return idle() && recoverable() },
    async select(next: Target) {
      if (disposed || view.expired) return
      if (target?.id === next.id && target.version === next.version) return
      const sameDrama = target?.id === next.id
      // 新保存的发行资料是新的执行输入；旧任务仍在 adopt 中优先采用 jobForm。
      // 只有版本变动而发行资料没变时，保留用户正在填写的执行表单。
      if (sameDrama && JSON.stringify(target?.registrationMetadata) !== JSON.stringify(next.registrationMetadata)) dirty = false
      invalidate()
      target = { id: next.id, version: next.version, ...(next.registrationMetadata ? {
        registrationMetadata: { ...next.registrationMetadata, tagList: [...next.registrationMetadata.tagList] },
      } : {}) }
      preparation = undefined; notifiedVersion = undefined
      if (!sameDrama) {
        dirty = false
        update({ registration: null, form: blankForm(), error: '' })
      }
      update({ needsLocalRead: true })
      await transaction('load', read)
    },
    async load() { await transaction('load', read) },
    async recoverReceipts(knownAlbumId: string, coverPicId: string) {
      if (!idle() || !recoverable()) return
      if (!albumId(knownAlbumId) || !text(coverPicId) || !/^[A-Za-z0-9_-]{1,256}$/.test(coverPicId)) {
        update({ error: '请填写真实的 Album ID 和封面回执 ID，不接受文件地址、空值或非法 ID。' })
        return
      }
      await transaction('recover', async op => {
        const result = await api<unknown>(`${endpoint(op)}/recover-receipts`, {
          method: 'POST', body: { version: op.target.version, albumId: knownAlbumId, coverPicId, confirmed: true },
          signal: op.signal, notify401: false,
        })
        if (!op.live()) return
        const recovered = validate(result, op.target, ownerId)
        check(!recovered.job && recovered.recovery?.albumId === knownAlbumId &&
          recovered.recovery.localVersion === op.target.version, '恢复回执与当前 Album 或本地版本不一致')
        adopt(recovered, op)
        if (op.live()) options.onChanged?.()
        // 不接着准备/执行剧目；恢复回执也不是registered任务或可用的平台版本。
      })
    },
    edit(field: keyof RegistrationForm, value: string) {
      if (!idle() || formLocked() || view.form[field] === value) return
      dirty = true; preparation = undefined
      update({ form: { ...view.form, [field]: value } })
    },
    async saveAndRun() {
      if (!idle()) return
      if (runnable()) {
        const job = view.registration!.job!
        await transaction('run', op => execute(op, job, 'run'))
        return
      }
      if (!preparable()) return
      let fields: ReturnType<typeof metadata>
      try { fields = metadata(view.form) } catch (cause) { update({ error: message(cause) }); return }
      const version = target!.version
      const fingerprint = JSON.stringify([target!.id, version, fields])
      if (preparation?.fingerprint !== fingerprint) preparation = { fingerprint, requestId: crypto.randomUUID() }
      const requestId = preparation.requestId
      await transaction('prepare', async op => {
        const result = await api<unknown>(endpoint(op), {
          method: 'POST', body: { requestId, version, ...fields, confirmed: true }, signal: op.signal, notify401: false,
        })
        if (!op.live()) return
        const prepared = validate(result, op.target, ownerId)
        check(prepared.job && prepared.job.localVersion === version && sameMetadata(view.form, prepared.job), '准备快照与本次填写资料不一致')
        adopt(prepared, op)
        if (!op.live()) return
        dirty = false; preparation = undefined
        // 同一次确认可以继续；不读取父级因 busy 回传的 disabled，避免自己把自己锁住。
        if (runnable()) await execute(op, prepared.job, 'run')
      })
    },
    async reconcile() {
      if (!idle() || !reconcilable()) return
      const job = view.registration!.job!
      await transaction('reconcile', op => execute(op, job, 'reconcile'))
    },
    useRegistered() {
      if (!idle() || !selectable()) return
      const job = view.registration!.job!
      options.onRegistered?.({ albumId: job.albumId!, platformVersion: job.platformVersion! })
    },
    dispose() {
      if (disposed) return
      disposed = true; preparation = undefined
      window.removeEventListener(SESSION_EXPIRED, expire)
      invalidate()
      update({ registration: null, form: blankForm(), error: '', needsLocalRead: true })
    },
  }
}
