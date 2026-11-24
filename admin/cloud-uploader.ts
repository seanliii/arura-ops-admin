import { api, ApiError, SESSION_EXPIRED } from './api'
import type { Drama } from '../shared/contracts'
import type { CloudUploadAvailability, CloudUploadCredentials, CloudUploadImportResult, CloudUploadTask, CloudUploadTicket, CloudVideoRegistration } from '../shared/cloud-upload'

// @byteplus/uploader@1.1.3的声明遗漏region/缓存选项，且Action大小写与正式参数表不同。
// 已读分发源码：addFile.processAction原样进入Commit的Functions；不使用其宽泛any。
export interface UploadSdkOptions {
  userId: string
  appId: number
  region: CloudUploadTicket['vodRegion']
  videoConfig: { spaceName: string }
  useLocalStorage: false
  noLog: true
  enableDebugLog: false
}
export interface UploadFileOptions {
  file: File
  stsToken: CloudUploadCredentials
  type: 'media'
  fileExtension: '.mp4'
  processAction: { Name: 'AddOptionInfo'; Input: { Title: string; RecordType: 1 } }[]
}
type SdkEvent = 'progress' | 'complete' | 'error'
type Listener = (info: unknown) => void
export interface UploadSdk {
  on(event: SdkEvent, listener: Listener): void
  removeListener(event: SdkEvent, listener: Listener): void
  addFile(input: UploadFileOptions): string | null
  start(key: string): void
  pause(key: string): void
  cancel(key: string): void
  removeFile(key: string): void
  refreshStsToken(credentials: CloudUploadCredentials): void
}
export type UploadSdkConstructor = new (options: UploadSdkOptions) => UploadSdk
export type CloudUploadApi = typeof api
export type CloudUploadPhase = 'queued' | 'creating' | 'credentials' | 'uploading' | 'paused' | 'refreshing' |
  'awaiting_verification' | 'verifying' | 'verified' | 'cancelling' | 'cancelled' | 'interrupted' | 'error'
export interface CloudUploadState {
  id: string
  dramaId: number
  seq: number
  title: string
  fileName: string
  fileBytes: number
  phase: CloudUploadPhase
  percent: number
  error: string
  task: CloudUploadTask | null
  candidateVid: string | null
  hasFile: boolean
  locked: boolean
  busy: boolean
  registeringVideo: boolean
}
export interface CloudUploadSession {
  readonly state: CloudUploadState
  edit(input: { seq?: number; title?: string }): void
  start(): Promise<void>
  pause(): void
  resume(): Promise<void>
  verify(): Promise<void>
  registerVideo(): Promise<void>
  cancel(): Promise<void>
  dispose(): void
}
interface Dependencies {
  request?: CloudUploadApi
  loadUploader?: () => Promise<UploadSdkConstructor>
  onChange?: (state: CloudUploadState) => void
  onChanged?: () => void
  /** A durable delivery job may own registration after verification. Manual uploads retain their current behavior. */
  autoRegisterVideo?: () => boolean
}
interface NewUpload { dramaId: number; seq: number; title: string; file: File; maxBytes: number }
export interface CloudUploadContext {
  ownerId: string
  availability: CloudUploadAvailability
  drama: { id: number; title: string; status: Drama['status']; version: number; episodeSeqs: number[] } | null
  tasks: CloudUploadTask[]
}

const REFRESH_EARLY_MS = 60_000
class UploadProblem extends Error {}
const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
function safeError(error: unknown): string {
  return error instanceof ApiError || error instanceof UploadProblem ? error.message : '请求未完成，请刷新任务核对后重试。'
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}
function validVid(value: unknown): value is string {
  return nonempty(value) && value.trim() === value && !/\s|:\/\//.test(value)
}
function publicVideoRegistration(value: unknown): CloudVideoRegistration | null {
  if (value === null) return null
  const registration = object(value)
  if (!value || Array.isArray(value) || typeof registration.status !== 'string' ||
    !['checking', 'sending', 'registered', 'failed', 'unknown'].includes(registration.status) ||
    !positiveInteger(registration.updatedAt) || typeof registration.message !== 'string' ||
    !(registration.errorCode === null || nonempty(registration.errorCode)) ||
    !(registration.confirmedAt === null || (positiveInteger(registration.confirmedAt) && registration.confirmedAt <= registration.updatedAt)) ||
    (registration.status === 'registered' && (registration.confirmedAt === null || registration.errorCode !== null))) {
    throw new UploadProblem('TikTok视频登记状态格式无效，未采用结果，请核对原任务。')
  }
  return {
    status: registration.status as CloudVideoRegistration['status'], confirmedAt: registration.confirmedAt as number | null,
    errorCode: registration.errorCode as string | null, message: registration.message, updatedAt: registration.updatedAt,
  }
}
function registrationWarning(registration?: CloudVideoRegistration | null): string {
  return registration && ['failed', 'unknown'].includes(registration.status)
    ? `TikTok视频登记未完成；BytePlus核验仍有效，可导入本地草稿。${registration.message}` : ''
}
/** 仅挑选公开任务字段，绝不把整个credentials响应或SDK事件放进页面状态。 */
function publicTask(task: CloudUploadTask): CloudUploadTask {
  return {
    id: task.id, dramaId: task.dramaId, seq: task.seq, title: task.title, fileName: task.fileName, fileBytes: task.fileBytes,
    status: task.status, candidateVid: task.candidateVid, verifiedAt: task.verifiedAt, durationSeconds: task.durationSeconds,
    importedEpisodeId: task.importedEpisodeId, importedAt: task.importedAt,
    createdAt: task.createdAt, updatedAt: task.updatedAt, errorCode: task.errorCode, message: task.message,
    ...(task.videoRegistration === undefined ? {} : { videoRegistration: publicVideoRegistration(task.videoRegistration) }),
  }
}
export function validateCloudFile(file: File, maxBytes: number): string | null {
  if (!/\.mp4$/i.test(file.name) || (file.type && !['video/mp4', 'application/mp4', 'application/octet-stream'].includes(file.type))) return '仅支持 MP4 视频文件。'
  if (!file.size) return '空文件不能上传。'
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || file.size > maxBytes) return '文件大小超过服务器允许的上限，或大小配置不可用。'
  return null
}
export function sortCloudFiles(files: readonly File[]): File[] {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }))
}
export function nextCloudSequence(episodeSeqs: readonly number[], tasks: readonly CloudUploadTask[], queuedSeqs: readonly number[] = []): number {
  return [...episodeSeqs, ...tasks.filter(task => task.status !== 'cancelled' && task.importedAt === null).map(task => task.seq), ...queuedSeqs]
    .reduce((maximum, seq) => Math.max(maximum, seq), 0) + 1
}
export async function loadCloudUploadContext(
  dramaId: number | null,
  options: { request?: CloudUploadApi; signal?: AbortSignal; expectedOwnerId?: string } = {},
): Promise<CloudUploadContext> {
  const request = options.request ?? api
  const checkAbort = () => { if (options.signal?.aborted) throw new DOMException('任务读取已取消', 'AbortError') }
  const changedOwner = (): never => {
    window.dispatchEvent(new Event(SESSION_EXPIRED))
    throw new ApiError(401, 'ADMIN_SESSION_CHANGED', '管理员登录已变化或身份无法确认，旧资料已清空，请重新登录。')
  }
  checkAbort()
  // 先确认账号，再读取目录和任务；不能等其他请求成功后才发现另一标签页已切号。
  const availability = await request<CloudUploadAvailability & { ownerId: string }>('/admin/cloud-uploads/config', { signal: options.signal })
  checkAbort()
  const ownerId = object(availability).ownerId
  if (!nonempty(ownerId) || ownerId.trim() !== ownerId || (options.expectedOwnerId !== undefined && ownerId !== options.expectedOwnerId)) changedOwner()
  const owner = ownerId as string
  async function readTasks(): Promise<CloudUploadTask[]> {
    if (dramaId === null) return []
    const tasks: CloudUploadTask[] = [], seenTasks = new Set<string>(), seenCursors = new Set<string>()
    const cursorPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    const base = `/admin/cloud-uploads?dramaId=${encodeURIComponent(dramaId)}&expectedOwnerId=${encodeURIComponent(owner)}`
    let cursor: string | null = null
    // 异常服务不得让页面无限请求；超限只报错，不把未读完的列表当完整结果。
    for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
      checkAbort()
      const page = object(await request<unknown>(`${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal: options.signal }))
      checkAbort()
      if (page.ownerId !== owner) changedOwner()
      if (!Array.isArray(page.tasks) || page.tasks.length > 100) throw new UploadProblem('任务分页格式无效，未采用不完整列表，请重新刷新。')
      for (const value of page.tasks) {
        const task = object(value)
        if (!nonempty(task.id) || task.id.trim() !== task.id || task.dramaId !== dramaId) {
          throw new UploadProblem('分页任务身份或目标剧目不一致，未采用列表。')
        }
        if (seenTasks.has(task.id)) throw new UploadProblem('分页出现重复任务，已停止读取，请重新刷新。')
        seenTasks.add(task.id)
        tasks.push(publicTask(value as CloudUploadTask))
      }
      if (page.nextCursor === null) return tasks
      if (typeof page.nextCursor !== 'string' || !cursorPattern.test(page.nextCursor) || page.tasks.length !== 100 ||
        page.nextCursor !== tasks.at(-1)?.id || seenCursors.has(page.nextCursor)) {
        throw new UploadProblem('任务分页游标无效或重复，已停止读取，请重新刷新。')
      }
      seenCursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
    throw new UploadProblem('任务分页超过本次读取上限，未采用不完整列表，请联系管理员核对。')
  }
  const [catalogue, tasks] = await Promise.all([
    request<{ dramas: Drama[] }>('/admin/dramas', { signal: options.signal }),
    readTasks(),
  ])
  checkAbort()
  const drama = catalogue.dramas.find(drama => drama.id === dramaId)
  return {
    ownerId: owner,
    availability: {
      configured: availability.configured, reasons: [...availability.reasons], maxBytes: availability.maxBytes,
      spaceName: availability.spaceName, region: availability.region,
    },
    drama: drama ? { id: drama.id, title: drama.title, status: drama.status, version: drama.version, episodeSeqs: drama.episodes.map(episode => episode.seq) } : null,
    tasks,
  }
}
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const positiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
function verifiedImportTask(value: unknown): value is CloudUploadTask {
  const task = object(value)
  return nonempty(task.id) && task.id.trim() === task.id && positiveInteger(task.dramaId) && positiveInteger(task.seq) &&
    nonempty(task.title) && nonempty(task.fileName) && positiveInteger(task.fileBytes) && task.status === 'verified' &&
    validVid(task.candidateVid) && positiveNumber(task.verifiedAt) && positiveNumber(task.durationSeconds) &&
    positiveNumber(task.createdAt) && positiveNumber(task.updatedAt) && task.updatedAt >= task.createdAt &&
    task.updatedAt >= task.verifiedAt && (task.errorCode === null || nonempty(task.errorCode)) && typeof task.message === 'string' &&
    (task.importedEpisodeId === null || positiveInteger(task.importedEpisodeId)) &&
    (task.importedAt === null || (positiveNumber(task.importedAt) && task.importedAt <= task.updatedAt)) &&
    (task.importedEpisodeId === null || task.importedAt !== null)
}
/** 点击导入即确认；只提交原任务ID和本地版本，视频内容由服务端已核验记录决定。 */
export async function importCloudUploadEpisode(
  task: CloudUploadTask,
  drama: Pick<Drama, 'id' | 'status' | 'version'>,
  options: { request?: CloudUploadApi; signal?: AbortSignal } = {},
): Promise<CloudUploadImportResult> {
  const { signal } = options
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('导入请求已取消', 'AbortError') }
  checkAbort()
  if (!drama || !positiveInteger(drama.id) || !positiveInteger(drama.version) || drama.status !== 'draft' ||
    !verifiedImportTask(task) || task.dramaId !== drama.id) {
    throw new UploadProblem('导入需要当前草稿版本和完整的已核验任务，请刷新后核对。')
  }
  if (task.importedAt !== null && task.importedEpisodeId === null) {
    throw new UploadProblem('此任务导入的本地单集已删除，不能重复建集；请取消旧记录后重新上传。')
  }
  const original = publicTask(task), version = drama.version
  try {
    const result = object(await (options.request ?? api)<unknown>(
      `/admin/cloud-uploads/${encodeURIComponent(original.id)}/import-episode`,
      { method: 'POST', body: { version, confirmed: true }, signal },
    ))
    checkAbort()
    if (!verifiedImportTask(result.task) || !positiveInteger(result.episodeId) ||
      result.task.importedEpisodeId !== result.episodeId || result.task.importedAt === null ||
      !positiveInteger(result.dramaVersion) || result.dramaVersion < version) {
      throw new UploadProblem('导入响应缺少有效单集或本地版本，未确认成功；请刷新任务核对。')
    }
    const imported = result.task
    const identity = ['id', 'dramaId', 'seq', 'title', 'fileName', 'fileBytes', 'candidateVid', 'durationSeconds', 'verifiedAt', 'createdAt'] as const
    if (identity.some(field => imported[field] !== original[field]) || imported.updatedAt < original.updatedAt ||
      (original.importedAt !== null && (imported.importedAt !== original.importedAt || result.episodeId !== original.importedEpisodeId))) {
      throw new UploadProblem('服务器返回的导入任务与当前文件或目标不一致，未采用结果。')
    }
    return { task: publicTask(imported), episodeId: result.episodeId, dramaVersion: result.dramaVersion }
  } catch (error) {
    checkAbort()
    if (error instanceof ApiError || error instanceof UploadProblem) throw error
    throw new UploadProblem(safeError(error))
  }
}
async function officialUploader(): Promise<UploadSdkConstructor> {
  const module = await import('@byteplus/uploader')
  if (typeof module.default !== 'function') throw new UploadProblem('官方云上传组件不可用，未开始上传。')
  return module.default as unknown as UploadSdkConstructor
}

export function createCloudUploadSession(input: NewUpload, dependencies: Dependencies = {}): CloudUploadSession {
  const invalid = validateCloudFile(input.file, input.maxBytes)
  if (invalid) throw new UploadProblem(invalid)
  return session({
    id: crypto.randomUUID(), dramaId: input.dramaId, seq: input.seq, title: input.title.trim(),
    fileName: input.file.name, fileBytes: input.file.size, phase: 'queued', percent: 0, error: '',
    task: null, candidateVid: null, locked: false,
  }, input.file, dependencies)
}
export function restoreCloudUploadSession(task: CloudUploadTask, dependencies: Dependencies = {}): CloudUploadSession {
  const saved = publicTask(task)
  return session({
    id: `saved-${task.id}`, dramaId: task.dramaId, seq: task.seq, title: task.title, fileName: task.fileName,
    fileBytes: task.fileBytes, phase: task.status === 'verified' ? 'verified' : task.status === 'cancelled' ? 'cancelled' :
      task.candidateVid ? 'awaiting_verification' : 'interrupted',
    percent: task.candidateVid ? 100 : 0, task: saved, candidateVid: task.candidateVid, locked: true,
    error: task.candidateVid || ['verified', 'cancelled'].includes(task.status)
      ? (task.errorCode ? task.message : task.status === 'verified' ? registrationWarning(saved.videoRegistration) : '')
      : '此页没有原文件及分片会话，不能跨页续传；可核对或取消持久任务。',
  }, undefined, dependencies)
}

function session(initial: Omit<CloudUploadState, 'hasFile' | 'busy' | 'registeringVideo'>, initialFile: File | undefined, dependencies: Dependencies): CloudUploadSession {
  const request = dependencies.request ?? api, loadUploader = dependencies.loadUploader ?? officialUploader
  let view = initial, file = initialFile
  let disposed = false, cancelled = false, generation = 0, activity = 0
  let sdk: UploadSdk | undefined, key: string | undefined, sdkPaused = false, wantsRunning = true
  let expiry = 0, target = '', needsCredentials = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let flow: Promise<void> | undefined, finish: (() => void) | undefined
  let creating: Promise<void> | undefined, refreshing: Promise<void> | undefined
  let verifying: Promise<void> | undefined, cancelling: Promise<void> | undefined
  let registering: Promise<void> | undefined
  let createBody: object | undefined
  const requests = new Map<AbortController, string>()
  const state = (): CloudUploadState => ({
    ...view, task: view.task ? publicTask(view.task) : null, hasFile: Boolean(file), busy: !disposed && (activity > 0 || Boolean(sdk)),
    registeringVideo: !disposed && Boolean(registering),
  })
  const emit = () => { if (!disposed) dependencies.onChange?.(state()) }
  const update = (patch: Partial<typeof view>) => { view = { ...view, ...patch }; emit() }
  const live = (epoch: number) => !disposed && !cancelled && epoch === generation
  const changed = () => { if (!disposed) dependencies.onChanged?.() }
  function settle() { const done = finish; finish = undefined; flow = undefined; done?.() }
  function clearTimer() { clearTimeout(timer); timer = undefined }
  async function call<T>(path: string, body: object | undefined, kind: string): Promise<T> {
    const controller = new AbortController()
    requests.set(controller, kind)
    try { return await request<T>(path, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body }), signal: controller.signal }) }
    finally { requests.delete(controller) }
  }
  const path = (action?: string) => `/admin/cloud-uploads/${encodeURIComponent(view.task!.id)}${action ? `/${action}` : ''}`
  function adopt(task: CloudUploadTask) {
    if (!task || !nonempty(task.id) || (view.task && task.id !== view.task.id) || task.dramaId !== view.dramaId ||
      task.seq !== view.seq || task.title !== view.title || task.fileName !== view.fileName || task.fileBytes !== view.fileBytes ||
      !['created', 'uploading', 'awaiting_verification', 'verifying', 'verified', 'cancelled'].includes(task.status)) {
      throw new UploadProblem('服务器返回的任务与当前文件/目标不一致，未采用结果。')
    }
    if (task.candidateVid !== null && (!validVid(task.candidateVid) || (view.candidateVid && task.candidateVid !== view.candidateVid))) {
      throw new UploadProblem('服务器返回的候选VID不一致，未采用结果。')
    }
    if (task.status === 'verified' && (!task.candidateVid || !Number.isFinite(task.verifiedAt) || Number(task.verifiedAt) <= 0)) {
      throw new UploadProblem('核验响应不完整，不能判为已核验。')
    }
    view = { ...view, task: publicTask(task), candidateVid: task.candidateVid ?? view.candidateVid }
  }
  function stopSdk() {
    clearTimer()
    const old = sdk, oldKey = key
    sdk = undefined; key = undefined; sdkPaused = false
    if (!old) return
    for (const [event, handler] of listeners) { try { old.removeListener(event, handler) } catch { /* 不记录SDK原始异常 */ } }
    // complete/error仍可能位于官方事件栈内；等该栈结束再移除任务，避免破坏其内部收尾。
    queueMicrotask(() => {
      if (oldKey) {
        try { old.cancel(oldKey) } catch { /* 仅清理 */ }
        try { old.removeFile(oldKey) } catch { /* 仅清理 */ }
      }
    })
  }
  function interrupt(message: string) {
    generation++; stopSdk(); file = undefined
    update({ phase: 'interrupted', error: message }); settle()
  }
  function failure(error: unknown, phase: CloudUploadPhase) {
    if (error instanceof ApiError && error.status === 401) {
      // api已派发全局SESSION_EXPIRED；即使调用方尚未卸载也立即清除内存与SDK。
      view = { ...view, error: error.message }; dispose(); return
    }
    if (error instanceof ApiError && [403, 409].includes(error.status) && sdk) { interrupt(error.message); return }
    update({ phase, error: safeError(error) })
  }
  async function credentialsTicket(epoch: number): Promise<CloudUploadTicket | undefined> {
    const requestedAt = Date.now()
    const ticket = await call<CloudUploadTicket>(path('credentials'), {}, 'credentials')
    if (!live(epoch)) return
    adopt(ticket.task)
    if (!['created', 'uploading'].includes(ticket.task.status) || ticket.task.candidateVid) throw new UploadProblem('任务状态已变化，请刷新任务，不能重新上传。')
    if (!nonempty(ticket.mediaMarker)) throw new UploadProblem('上传票据缺少mediaMarker，未开始上传。')
    if (!nonempty(ticket.uploaderUserId) || !nonempty(ticket.spaceName) || !Number.isSafeInteger(ticket.vodAppId) || ticket.vodAppId <= 0 ||
      !['ap-singapore-1', 'ap-southeast-1'].includes(ticket.vodRegion)) throw new UploadProblem('上传票据的目标配置不完整，未开始上传。')
    const identity = JSON.stringify([ticket.uploaderUserId, ticket.vodAppId, ticket.vodRegion, ticket.spaceName, ticket.mediaMarker])
    if (target && identity !== target) throw new UploadProblem('上传目标或任务标记已变化，已停止原任务，请刷新核对。')
    const c = ticket.credentials
    if (!c || ![c.AccessKeyId, c.SecretAccessKey, c.SessionToken, c.CurrentTime, c.ExpiredTime].every(nonempty)) throw new UploadProblem('临时上传凭据不完整，未开始上传。')
    const issued = Date.parse(c.CurrentTime), expires = Date.parse(c.ExpiredTime)
    // 从请求发起时算剩余租期，并取绝对期限较早者；不因响应延迟或客户端时钟慢而延长凭据。
    const validUntil = Math.min(expires, requestedAt + expires - issued)
    if (!Number.isFinite(validUntil) || validUntil - Date.now() <= REFRESH_EARLY_MS) throw new UploadProblem('临时上传凭据已过期或即将过期，请重试获取新凭据。')
    target = identity; expiry = validUntil; needsCredentials = false
    changed()
    return ticket
  }
  function armRefresh() {
    clearTimer()
    if (sdk && wantsRunning && !cancelled && !disposed) timer = setTimeout(() => { timer = undefined; void refresh(true) }, Math.max(0, expiry - Date.now() - REFRESH_EARLY_MS))
  }
  async function begin(epoch: number) {
    activity++; emit()
    try {
      if (!view.task) {
        if (!Number.isSafeInteger(view.dramaId) || view.dramaId <= 0 || !Number.isSafeInteger(view.seq) || view.seq <= 0 || !view.title.trim()) throw new UploadProblem('请核对草稿剧目、正整数集号和标题。')
        createBody ??= { requestId: view.id, dramaId: view.dramaId, seq: view.seq, title: view.title.trim(), fileName: view.fileName, fileBytes: view.fileBytes, confirmed: true }
        update({ phase: 'creating', locked: true, error: '' })
        creating = call<{ task: CloudUploadTask }>('/admin/cloud-uploads', createBody, 'create').then(result => {
          // 显式取消可以等待原创建响应，再取消已知ID；卸载/401绝不继续操作。
          if (!disposed) { adopt(result.task); emit(); changed() }
        })
        try { await creating } finally { creating = undefined }
      }
      if (!live(epoch)) return
      if (view.task?.status === 'verified' || view.task?.status === 'cancelled') {
        file = undefined; update({ phase: view.task.status, percent: view.task.status === 'verified' ? 100 : view.percent }); settle(); return
      }
      if (view.candidateVid) { file = undefined; await verify(); return }
      update({ phase: 'credentials', error: '' })
      let ticket = await credentialsTicket(epoch)
      if (!ticket || !live(epoch)) return
      let Constructor: UploadSdkConstructor
      try { Constructor = await loadUploader() } catch { throw new UploadProblem('官方云上传组件加载失败，未开始上传，请重试。') }
      if (!live(epoch)) return
      if (expiry - Date.now() <= REFRESH_EARLY_MS) ticket = await credentialsTicket(epoch)
      if (!ticket || !live(epoch) || !file) return
      try {
        sdk = new Constructor({
          userId: ticket.uploaderUserId, appId: ticket.vodAppId, region: ticket.vodRegion,
          videoConfig: { spaceName: ticket.spaceName }, useLocalStorage: false, noLog: true, enableDebugLog: false,
        })
        for (const [event, handler] of listeners) sdk.on(event, handler)
        key = sdk.addFile({
          file, stsToken: ticket.credentials, type: 'media', fileExtension: '.mp4',
          processAction: [{ Name: 'AddOptionInfo', Input: { Title: ticket.mediaMarker, RecordType: 1 } }],
        }) ?? undefined
        if (!nonempty(key)) throw new Error()
        wantsRunning = true; sdkPaused = false
        update({ phase: 'uploading', error: '' })
        sdk.start(key)
        armRefresh()
      } catch { stopSdk(); throw new UploadProblem('官方SDK未能启动此文件，未判为上传成功，请核对后重试。') }
    } catch (error) {
      if (live(epoch)) { failure(error, 'error'); settle() }
    } finally { activity--; emit() }
  }
  function ownEvent(value: unknown) {
    const info = object(value)
    return !disposed && !cancelled && sdk && key && info.key === key ? info : null
  }
  const progress: Listener = value => {
    const info = ownEvent(value)
    if (!info || sdkPaused || !wantsRunning || typeof info.percent !== 'number' || !Number.isFinite(info.percent)) return
    const percent = Math.max(view.percent, Math.min(100, Math.max(0, Math.round(info.percent))))
    update({ percent, phase: percent === 100 ? 'awaiting_verification' : 'uploading' })
  }
  const complete: Listener = value => {
    const info = ownEvent(value)
    if (!info) return
    const vid = object(info.uploadResult).Vid
    if (!validVid(vid)) { interrupt('SDK未返回可核验的Vid，提交结果待核对；不能盲目重新上传。'); return }
    if (view.candidateVid) return
    generation++; stopSdk(); file = undefined
    update({ candidateVid: vid, percent: 100, phase: 'awaiting_verification', error: '' })
    void verify()
  }
  const sdkError: Listener = value => {
    const info = ownEvent(value)
    if (!info) return
    if (info.stage === 'complete' || view.percent === 100) {
      interrupt('云端提交结果未知，未取得可信Vid；请核对持久任务，不能盲目重传。'); return
    }
    pause()
    update({ error: 'SDK上传已中断并暂停。原始错误可能含凭据，未展示；可在本页继续或取消。' })
  }
  const listeners: [SdkEvent, Listener][] = [['progress', progress], ['complete', complete], ['error', sdkError]]

  function start(): Promise<void> {
    if (disposed || cancelled || view.phase === 'verified') return Promise.resolve()
    if (flow) return flow
    if (view.candidateVid) return verify()
    if (!file) { update({ phase: 'interrupted', error: '此页没有原文件及分片会话，不能跨页续传；请核对服务器任务。' }); return Promise.resolve() }
    flow = new Promise<void>(resolve => { finish = resolve })
    const result = flow
    void begin(generation)
    return result
  }
  function pause() {
    if (!sdk || !key || disposed || cancelled || view.percent >= 100) return
    wantsRunning = false; clearTimer()
    if (!sdkPaused) {
      try { sdk.pause(key); sdkPaused = true } catch { interrupt('SDK暂停未确认，本页已停止处理，请核对任务。'); return }
    }
    update({ phase: 'paused' })
  }
  function refresh(force: boolean): Promise<void> {
    if (refreshing) return refreshing
    if (!sdk || !key || disposed || cancelled) return Promise.resolve()
    const epoch = generation, original = sdk
    const work = async () => {
      if (!live(epoch) || sdk !== original) { refreshing = undefined; return }
      activity++; clearTimer(); emit()
      try {
        // 100%后可能正在Commit；官方pause不保证中止该阶段，不能在这里重启Commit。
        if (view.percent < 100 && !sdkPaused) { original.pause(key!); sdkPaused = true }
        update({ phase: 'refreshing', error: '' })
        if (force || needsCredentials || expiry - Date.now() <= REFRESH_EARLY_MS) {
          const fresh = await credentialsTicket(epoch)
          if (!fresh || !live(epoch) || sdk !== original) return
          original.refreshStsToken(fresh.credentials)
        }
        if (!live(epoch) || sdk !== original) return
        if (wantsRunning) {
          if (sdkPaused) { original.start(key!); sdkPaused = false }
          update({ phase: view.percent >= 100 ? 'awaiting_verification' : 'uploading' })
          armRefresh()
        } else update({ phase: 'paused' })
      } catch (error) {
        if (!live(epoch)) return
        needsCredentials = true; wantsRunning = false
        if (error instanceof UploadProblem && error.message.includes('目标')) { interrupt(error.message); return }
        failure(error, 'paused')
      } finally { activity--; refreshing = undefined; emit() }
    }
    // 未过期的继续路径可能不经过await；先登记promise，防止finally清空后又被旧promise覆盖。
    refreshing = Promise.resolve().then(work)
    return refreshing
  }
  function resume(): Promise<void> {
    if (!sdk || !file || disposed || cancelled) return Promise.resolve()
    wantsRunning = true
    return refresh(false)
  }
  function verify(): Promise<void> {
    if (verifying) return verifying
    if (disposed || cancelled || !view.task || view.phase === 'verified') return Promise.resolve()
    if (!validVid(view.candidateVid)) { update({ phase: 'interrupted', error: '没有可核验的候选VID；此页也没有可跨页恢复的上传会话。' }); return Promise.resolve() }
    const epoch = generation, vid = view.candidateVid
    const work = async () => {
      activity++; update({ phase: 'verifying', error: '' })
      try {
        const result = await call<{ task: CloudUploadTask }>(path('verify'), { vid }, 'verify')
        if (!live(epoch)) return
        adopt(result.task)
        update({
          phase: result.task.status === 'verified' ? 'verified' : result.task.status === 'cancelled' ? 'cancelled' : 'awaiting_verification',
          percent: 100, error: result.task.errorCode ? result.task.message : '',
        })
        changed()
        if (view.task?.status === 'verified' && dependencies.autoRegisterVideo?.() !== false) await registerVideo()
      } catch (error) { if (live(epoch)) failure(error, 'awaiting_verification') }
      finally { activity--; verifying = undefined; if (live(epoch)) settle(); emit() }
    }
    verifying = work()
    return verifying
  }
  function registerVideo(): Promise<void> {
    if (registering) return registering
    if (disposed || cancelled || view.phase !== 'verified' || view.task?.status !== 'verified' ||
      !validVid(view.candidateVid) || view.task.videoRegistration?.status === 'registered') return Promise.resolve()
    const epoch = generation, original = publicTask(view.task)
    const work = async () => {
      if (!live(epoch)) return
      activity++; update({ error: '' })
      try {
        // 每次明确操作只调用一次。unknown如何只查不写由服务端决定，前端不轮询POST。
        const result = await call<{ task: CloudUploadTask }>(path('register-video'), { confirmed: true }, 'register-video')
        if (!live(epoch)) return
        const task = result.task
        const identity = ['id', 'dramaId', 'seq', 'title', 'fileName', 'fileBytes', 'candidateVid',
          'verifiedAt', 'durationSeconds', 'createdAt', 'importedEpisodeId', 'importedAt'] as const
        if (!task || task.status !== 'verified' || identity.some(field => task[field] !== original[field]) ||
          !positiveInteger(task.updatedAt) || task.updatedAt < original.updatedAt || !task.videoRegistration) {
          throw new UploadProblem('TikTok视频登记回执与原任务、文件或导入记录不一致，请核对原任务。')
        }
        const registration = publicVideoRegistration(task.videoRegistration)!
        if (original.videoRegistration && registration.updatedAt < original.videoRegistration.updatedAt) {
          throw new UploadProblem('TikTok视频登记回执已过时，未覆盖原状态，请核对原任务。')
        }
        adopt(task)
        update({ phase: 'verified', error: registrationWarning(registration) })
        changed()
      } catch (error) {
        if (!live(epoch)) return
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          window.dispatchEvent(new Event(SESSION_EXPIRED)); dispose(); return
        }
        // 登记失败不撤销BytePlus文件核验，也不重新取票据或上传文件。
        update({ phase: 'verified', error: `TikTok视频登记未确认；BytePlus核验仍有效，可导入本地草稿。${safeError(error)}` })
      } finally { activity--; registering = undefined; emit() }
    }
    registering = Promise.resolve().then(work)
    return registering
  }
  function cancel(): Promise<void> {
    if (cancelling) return cancelling
    const removedImport = view.task?.importedAt != null && view.task.importedEpisodeId === null
    if (disposed || view.phase === 'cancelled' || (view.phase === 'verified' && !removedImport)) return Promise.resolve()
    cancelled = true; generation++; wantsRunning = false; stopSdk(); file = undefined
    for (const [controller, kind] of requests) if (kind !== 'create') controller.abort()
    const creation = creating
    const work = async () => {
      activity++; update({ phase: 'cancelling', error: '' })
      try {
        if (creation) await creation
        if (disposed) return
        if (!view.task) {
          if (view.locked) throw new UploadProblem('创建响应未确认，无法确定远端取消结果；本页已停止，请刷新任务核对。')
          update({ phase: 'cancelled' }); return
        }
        const result = await call<{ task: CloudUploadTask }>(path('cancel'), {}, 'cancel')
        if (disposed) return
        adopt(result.task)
        update({
          phase: result.task.status === 'cancelled' ? 'cancelled' : result.task.status === 'verified' ? 'verified' : 'interrupted',
          error: result.task.errorCode ? result.task.message : '',
        })
        changed()
      } catch (error) { if (!disposed) failure(error, 'interrupted') }
      finally { activity--; cancelling = undefined; settle(); emit() }
    }
    cancelling = work()
    return cancelling
  }
  function dispose() {
    if (disposed) return
    disposed = true; generation++; wantsRunning = false; stopSdk(); file = undefined
    window.removeEventListener(SESSION_EXPIRED, dispose)
    for (const controller of requests.keys()) controller.abort()
    requests.clear()
    view = { ...view, phase: ['verified', 'cancelled'].includes(view.phase) ? view.phase : 'interrupted' }
    settle()
  }
  window.addEventListener(SESSION_EXPIRED, dispose)
  return {
    get state() { return state() }, start, pause, resume, verify, registerVideo, cancel, dispose,
    edit(input) {
      if (disposed || view.locked) return
      update({ ...(input.seq === undefined ? {} : { seq: input.seq }), ...(input.title === undefined ? {} : { title: input.title.trim() }), error: '' })
    },
  }
}
