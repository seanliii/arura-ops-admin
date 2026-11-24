import type { Router } from 'express'
import type {
  PlatformMediaAction, PlatformMediaEpisode, PlatformMediaOperation, PlatformMediaOperationStatus,
  PlatformMediaPublishStatus, PlatformMediaResponse, PlatformMediaReviewStatus, PlatformMediaState, PlatformMediaVersion,
} from '../shared/contracts.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { body, id, integer, text } from './validation.js'
import { transaction } from './db.js'
import { platformMediaReady } from './catalog-policy.js'
import { cloudUploadFingerprint } from './cloud-upload-config.js'
import { createMediaClient, MediaClientError, type MediaAlbumQueryResult, type MediaClient } from './tiktok-media-client.js'
import { assertMediaActor, requestMediaActor, type MediaActor } from './media-actor.js'

type Row = Record<string, unknown>
type WriteAction = Exclude<PlatformMediaAction, 'sync'>
const writes: WriteAction[] = ['submit_review', 'set_online', 'authorize_app', 'list', 'delist']
const unresolved = "('submitting','unknown','awaiting_sync')"
// SDK 的 token/业务请求各自限时15秒；过期只标记未知，绝不重新执行。
const LEASE_MS = 60_000
const reviewNames = ['unsubmitted', 'pending', 'approved', 'rejected', 'withdrawn', 'appealing', 'approved', 'rejected']
const approved = (value: unknown) => value === 2 || value === 6
const nullableNumber = (value: unknown): number | null => value === undefined || value === null ? null : Number(value)
const nullableString = (value: unknown): string | null => value === undefined || value === null ? null : String(value)

const clients = new WeakMap<AppContext, { key: string; secret: string; client: MediaClient }>()
/** 同一ctx的运营与播放共享client_credentials缓存；不缓存任何临时播放凭证。 */
export function getMediaClient(ctx: AppContext): MediaClient {
  const key = ctx.config.tiktokClientKey ?? '', secret = ctx.config.tiktokClientSecret ?? ''
  let cached = clients.get(ctx)
  if (!cached || cached.key !== key || cached.secret !== secret) {
    cached = { key, secret, client: createMediaClient({ clientKey: key, clientSecret: secret }) }
    clients.set(ctx, cached)
  }
  return cached.client
}

/** 运营核验只保存成功事实，临时播放凭证不返回后台、不入库，也不产生观众权益。 */
export async function verifyEpisodePlaybackAccess(client: MediaClient, episodeIds: string[], assertCurrent: () => void): Promise<void> {
  for (const episodeId of episodeIds) {
    assertCurrent()
    const result = await client.getPlayToken(episodeId)
    assertCurrent()
    if (!result.playAuthToken?.trim()) throw new ApiError(502, 'MEDIA_ACCESS_UNCONFIRMED', '平台未返回有效播放许可，未确认当前App访问权限')
  }
}

interface Claim {
  requestId: string
  dramaId: number
  action: PlatformMediaAction
  albumId: string
  platformVersion: number
  localVersion: number
  clientKey: string
  actorId: string
  priorNeedsSync: number
}
interface Snapshot {
  currentVersion: number
  onlineVersion: number | null
  reviewStatus: PlatformMediaReviewStatus
  publishStatus: PlatformMediaPublishStatus
  versions: PlatformMediaVersion[]
  episodes: PlatformMediaEpisode[]
}
class SnapshotError extends ApiError {
  constructor(code: string, message: string, readonly invalidate = false) { super(422, code, message) }
}
function dramaRow(ctx: AppContext, dramaId: number): Row {
  const row = ctx.db.prepare('SELECT * FROM dramas WHERE id=?').get(dramaId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', '作品不存在')
  return row
}
function binding(ctx: AppContext, dramaId: number): Row | undefined {
  return ctx.db.prepare('SELECT * FROM platform_media_bindings WHERE drama_id=?').get(dramaId)
}
export function expirePlatformMediaOperations(ctx: AppContext): void {
  ctx.db.prepare(`UPDATE platform_media_operations SET
    status=CASE WHEN action='sync' THEN 'failed' ELSE 'unknown' END,
    error_code=CASE WHEN action='sync' THEN 'MEDIA_QUERY_INTERRUPTED' ELSE 'MEDIA_MUTATION_UNKNOWN' END,
    message=CASE WHEN action='sync' THEN '只读查询中断，可以重新查询' ELSE '操作中断或服务重启，结果未知；只允许查询核对，不自动重发' END,
    updated_at=? WHERE status='submitting' AND lease_until<=?`).run(Date.now(), Date.now())
}
function pendingWrites(ctx: AppContext, dramaId: number): Row[] {
  return ctx.db.prepare(`SELECT * FROM platform_media_operations WHERE drama_id=? AND action<>'sync' AND status IN ${unresolved}`).all(dramaId)
}
function operationDto(row: Row): PlatformMediaOperation {
  return {
    requestId: String(row.request_id), action: row.action as PlatformMediaAction, status: row.status as PlatformMediaOperationStatus,
    albumId: String(row.album_id), platformVersion: Number(row.platform_version), localVersion: Number(row.local_version),
    resultVersion: nullableNumber(row.result_version), reviewId: nullableString(row.review_id),
    errorCode: nullableString(row.error_code), message: String(row.message), reconciledBy: nullableString(row.reconciled_by),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}
function state(ctx: AppContext, dramaId: number): PlatformMediaState {
  expirePlatformMediaOperations(ctx)
  const drama = dramaRow(ctx, dramaId), media = binding(ctx, dramaId)
  const configured = Boolean(ctx.config.tiktokClientKey && ctx.config.tiktokClientSecret)
  const authorization = configured && media?.authorized_client_key === ctx.config.tiktokClientKey ? 'authorized' : 'unconfirmed'
  const needsSync = !media?.album_id || Boolean(media.needs_sync) || media.synced_local_version !== drama.version ||
    media.client_key !== ctx.config.tiktokClientKey || pendingWrites(ctx, dramaId).length > 0
  const readyToPublish = configured && platformMediaReady(ctx, dramaId)
  const reasons: string[] = []
  if (!configured) reasons.push('服务器尚未配置平台应用凭据')
  if (!media?.album_id) reasons.push('尚未关联并查询已有平台album')
  if (needsSync) reasons.push('需要查询同步当前本地版本，或仍有未知/待核对操作')
  if (!approved(media?.review_status)) reasons.push('对应平台版本尚未审核批准')
  if (!media?.platform_version || media.online_version !== media.platform_version) reasons.push('在线版本与本地关联的平台版本不同')
  if (media?.publish_status !== 1) reasons.push('平台尚未确认已上架（publish_status=1）')
  if (authorization !== 'authorized') reasons.push('尚未确认当前App授权')
  if (drama.is_sample) reasons.push('样例内容不能在生产片库发布')
  if (!readyToPublish && !reasons.length) reasons.push('本地集号、剧集映射或同步证据不一致，需要重新查询')
  const operations = ctx.db.prepare(`SELECT * FROM platform_media_operations WHERE drama_id=?
    ORDER BY CASE WHEN status IN ${unresolved} THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 30`).all(dramaId).map(operationDto)
  return {
    dramaId, localVersion: Number(drama.version), mode: ctx.config.mode, configured,
    albumId: nullableString(media?.album_id), platformVersion: nullableNumber(media?.platform_version),
    currentVersion: nullableNumber(media?.current_version), onlineVersion: nullableNumber(media?.online_version),
    reviewStatus: nullableNumber(media?.review_status) as PlatformMediaReviewStatus | null,
    publishStatus: nullableNumber(media?.publish_status) as PlatformMediaPublishStatus | null,
    syncedLocalVersion: nullableNumber(media?.synced_local_version), syncedAt: nullableNumber(media?.synced_at),
    authorization, authorizedAt: authorization === 'authorized' ? nullableNumber(media?.authorized_at) : null,
    needsSync, readyToPublish, reasons, versions: JSON.parse(String(media?.versions_json ?? '[]')) as PlatformMediaVersion[],
    episodes: ctx.db.prepare('SELECT * FROM platform_media_episodes WHERE drama_id=? ORDER BY seq').all(dramaId).map(row => ({
      localEpisodeId: Number(row.local_episode_id), seq: Number(row.seq), episodeId: String(row.episode_id), vid: String(row.vid),
    })),
    operations,
  }
}
function response(ctx: AppContext, dramaId: number, requestId?: string): PlatformMediaResponse {
  return {
    media: state(ctx, dramaId),
    ...(requestId ? { operation: operationDto(ctx.db.prepare('SELECT * FROM platform_media_operations WHERE request_id=?').get(requestId)!) } : {}),
  }
}
function albumId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new ApiError(400, 'INVALID_INPUT', 'albumId必须是无损的正int64字符串，不能使用JavaScript数字或非平台ID')
  }
  return value
}
function requestId(value: unknown): string {
  const result = text(value, 'requestId', 100)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/.test(result)) throw new ApiError(400, 'INVALID_INPUT', 'requestId必须为8到100位字母、数字、短横线或下划线')
  return result
}
function localEpisodes(ctx: AppContext, dramaId: number): Row[] {
  const episodes = ctx.db.prepare(`SELECT e.*,t.claimed_vid AS imported_vid,t.config_fingerprint AS imported_fingerprint,
    i.task_id AS import_task_id FROM episodes e
    LEFT JOIN cloud_upload_imports i ON i.episode_id=e.id
    LEFT JOIN cloud_upload_tasks t ON t.id=i.task_id WHERE e.drama_id=? ORDER BY e.seq`).all(dramaId)
  if (!episodes.length || episodes.some((episode, i) => episode.seq !== i + 1)) {
    throw new ApiError(422, 'MEDIA_EPISODE_COVERAGE', '本地剧集seq必须从第1集开始连续排列，且至少有一集；请先完善本地剧集')
  }
  for (const episode of episodes) if (episode.import_task_id != null) {
    if (!ctx.config.byteplusUpload || episode.imported_fingerprint !== cloudUploadFingerprint(ctx.config, ctx.config.byteplusUpload)) {
      throw new ApiError(409, 'MEDIA_IMPORTED_CONTEXT_CHANGED', '已导入视频属于另一套应用或云空间配置，请先核对原上传目标，不能直接同步到当前配置')
    }
  }
  return episodes
}
function checkWrite(media: Row | undefined, drama: Row, action: WriteAction, platformVersion: number, clientKey: string): void {
  if (!media?.album_id || media.platform_version !== platformVersion || media.client_key !== clientKey) {
    throw new ApiError(409, 'MEDIA_VERSION_MISMATCH', 'platformVersion与已同步的album、版本或当前App不匹配，请先查询关联')
  }
  // 下架是明确的停止服务操作，不要求剧目已经获批；仍须绑定正确的album。
  if (action !== 'delist' && (media.synced_local_version !== drama.version || media.needs_sync)) {
    throw new ApiError(409, 'MEDIA_SYNC_REQUIRED', '本地内容已改变或平台结果待核对，请先查询同步')
  }
  if (action === 'submit_review' && ![0, 3, 4, 7].includes(Number(media.review_status))) {
    throw new ApiError(409, 'MEDIA_REVIEW_NOT_ALLOWED', '此版本正在审核、申诉或已批准，不能重复提审')
  }
  if ((action === 'set_online' || action === 'list') && !approved(media.review_status)) {
    throw new ApiError(409, 'MEDIA_REVIEW_REQUIRED', '只有已审核批准的对应版本才能设为在线或上架')
  }
  if (action === 'list' && media.online_version !== platformVersion) {
    throw new ApiError(409, 'MEDIA_ONLINE_REQUIRED', '上架前必须确认同一在线版本；片库发布前另需核验当前App播放权限')
  }
}

function begin(ctx: AppContext, dramaId: number, actorId: string, input: Row, action: PlatformMediaAction) {
  const allowed = action === 'sync'
    ? ['version', 'requestId', 'albumId', 'platformVersion', 'verifyAccess']
    : ['version', 'requestId', 'platformVersion', 'action', 'confirmed']
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ApiError(400, 'INVALID_INPUT', '媒资请求含不支持的字段；不能指定其他App、伪造状态或传入凭据')
  if (input.verifyAccess !== undefined && typeof input.verifyAccess !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'verifyAccess必须是布尔值')
  const key = requestId(input.requestId), localVersion = integer(input.version, 'version', 1)
  const platformVersion = integer(input.platformVersion, 'platformVersion', 1)
  const requestedAlbum = action === 'sync' ? albumId(input.albumId) : undefined
  if (action !== 'sync' && input.confirmed !== true) throw new ApiError(400, 'MEDIA_CONFIRMATION_REQUIRED', '平台写操作必须在页面明确确认（confirmed=true）')
  return transaction(ctx.db, () => {
    expirePlatformMediaOperations(ctx)
    const drama = dramaRow(ctx, dramaId), media = binding(ctx, dramaId)
    const existing = ctx.db.prepare('SELECT * FROM platform_media_operations WHERE request_id=?').get(key)
    const targetAlbum = requestedAlbum ?? nullableString(existing?.album_id ?? media?.album_id) ?? ''
    const clientKey = ctx.config.tiktokClientKey ?? ''
    const claim: Claim = { requestId: key, dramaId, action, albumId: targetAlbum, platformVersion, localVersion, clientKey, actorId, priorNeedsSync: Number(media?.needs_sync ?? 1) }
    // 幂等读取早于本地version校验，重试只能取回原存根，不能重新执行。
    if (existing) {
      if (existing.drama_id !== dramaId || existing.action !== action || existing.album_id !== targetAlbum ||
        existing.platform_version !== platformVersion || existing.local_version !== localVersion || existing.client_key !== clientKey ||
        existing.verify_access !== Number(input.verifyAccess === true)) {
        throw new ApiError(409, 'MEDIA_REQUEST_CONFLICT', 'requestId已用于另一份媒资请求，不能更换剧目、操作或版本')
      }
      return { claim, duplicate: true }
    }
    if (ctx.db.prepare(`SELECT 1 FROM media_registration_jobs WHERE drama_id=?
      AND status IN ('running','unknown') LIMIT 1`).get(dramaId)) {
      throw new ApiError(409, 'MEDIA_REGISTRATION_PENDING', '云端登记仍在处理中或结果未知，请先在登记面板核对原任务，再关联版本或提交审核')
    }
    if (!clientKey || !ctx.config.tiktokClientSecret) throw new ApiError(503, 'MEDIA_NOT_CONFIGURED', '服务器未配置平台应用凭据，未发起外部请求')
    if (drama.version !== localVersion) throw new ApiError(409, 'VERSION_CONFLICT', '本地version已变化，请刷新剧目后重试')
    const pending = pendingWrites(ctx, dramaId)
    if (action === 'sync') {
      if (pending.some(op => op.status === 'submitting')) throw new ApiError(409, 'MEDIA_OPERATION_IN_PROGRESS', '平台写操作仍在处理中；先刷新记录，不要同时查询或重发')
      if (pending.some(op => op.album_id !== targetAlbum || op.platform_version !== platformVersion)) {
        throw new ApiError(409, 'MEDIA_OPERATION_UNRESOLVED', '旧album或版本仍有未知操作，必须先查询原操作对象，不能换关联绕过')
      }
      if (drama.status === 'published' && (media?.album_id !== targetAlbum || media?.platform_version !== platformVersion)) {
        throw new ApiError(409, 'UNPUBLISH_FIRST', '已发布剧目更换album或关联版本前，请先从本应用下架')
      }
      localEpisodes(ctx, dramaId)
      ctx.db.prepare(`UPDATE platform_media_operations SET status='superseded',message='已由更新的只读查询取代',updated_at=?
        WHERE drama_id=? AND action='sync' AND status='submitting'`).run(Date.now(), dramaId)
    } else {
      if (pending.length) throw new ApiError(409, 'MEDIA_OPERATION_UNRESOLVED', '仍有处理中、未知或待查询确认的平台写操作；不能换请求ID再次执行')
      if (ctx.db.prepare("SELECT 1 FROM platform_media_operations WHERE drama_id=? AND status='submitting' LIMIT 1").get(dramaId)) {
        throw new ApiError(409, 'MEDIA_OPERATION_IN_PROGRESS', '查询仍在处理中，请等本次查询结果返回')
      }
      checkWrite(media, drama, action, platformVersion, clientKey)
    }
    const now = Date.now()
    ctx.db.prepare(`INSERT INTO platform_media_operations
      (request_id,drama_id,action,album_id,platform_version,client_key,local_version,verify_access,status,prior_review_status,prior_needs_sync,message,created_at,updated_at,lease_until)
      VALUES(?,?,?,?,?,?,?,?,'submitting',?,?,'请求已记录，正在处理',?,?,?)`)
      .run(key, dramaId, action, targetAlbum, platformVersion, clientKey, localVersion, Number(input.verifyAccess === true), nullableNumber(media?.review_status), claim.priorNeedsSync, now, now, now + LEASE_MS)
    ctx.db.prepare(`INSERT INTO platform_media_bindings(drama_id,operation_id) VALUES(?,?)
      ON CONFLICT(drama_id) DO UPDATE SET operation_id=excluded.operation_id`).run(dramaId, key)
    if (action !== 'sync') ctx.db.prepare('UPDATE platform_media_bindings SET needs_sync=1 WHERE drama_id=?').run(dramaId)
    ctx.audit(actorId, 'media.request', 'drama', String(dramaId), { requestId: key, action, albumId: targetAlbum, platformVersion, localVersion })
    return { claim, duplicate: false }
  })
}
function isCurrent(ctx: AppContext, claim: Claim): boolean {
  return ctx.config.tiktokClientKey === claim.clientKey &&
    dramaRow(ctx, claim.dramaId).version === claim.localVersion && binding(ctx, claim.dramaId)?.operation_id === claim.requestId
}
function assertCurrent(ctx: AppContext, claim: Claim): void {
  if (!isCurrent(ctx, claim)) throw new ApiError(409, 'MEDIA_STALE_RESULT', '本地version或操作ID已变化，旧平台结果未覆盖本地内容；请查询核对')
}
function explicitlyUnavailable(selected: MediaAlbumQueryResult['album_version_list'][number], version: number): boolean {
  return [0, 1, 3, 4, 5, 7].includes(selected.review_status ?? -1) ||
    selected.publish_status === 0 || selected.publish_status === 2 || selected.online_version === null ||
    (typeof selected.online_version === 'number' && selected.online_version !== version)
}
function snapshot(result: MediaAlbumQueryResult, claim: Claim, episodes: Row[]): Snapshot {
  const rows = result.album_version_list
  const seen = new Set<number>()
  for (const row of rows) {
    if (row.album_id !== claim.albumId || seen.has(row.version)) throw new SnapshotError('MEDIA_SNAPSHOT_INVALID', '平台album_id或version列表重复、不匹配，未采用本次响应')
    seen.add(row.version)
  }
  const selected = rows.find(row => row.version === claim.platformVersion)
  if (!selected) throw new SnapshotError('MEDIA_VERSION_MISSING', `平台没有返回指定version=${claim.platformVersion}，不能使用其他版本代替`, true)
  // SDK已验证album/version身份。明确的不可播放信号不能因其他字段缺失而被忽略；
  // 仍不采用半套状态，只让原完整快照停止交付，等待完整查询。
  const unavailable = explicitlyUnavailable(selected, claim.platformVersion)
  const numeric = (value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new SnapshotError('MEDIA_SNAPSHOT_INVALID', `指定平台版本的${field}缺失或无效，未采用本次响应`, unavailable)
    }
    return value
  }
  const currentVersion = numeric(selected.current_version, 'current_version', 1)
  const onlineVersion = selected.online_version === null || selected.online_version === undefined ? null : numeric(selected.online_version, 'online_version', 1)
  const reviewStatus = numeric(selected.review_status, 'review_status', 0, 7) as PlatformMediaReviewStatus
  const publishStatus = numeric(selected.publish_status, 'publish_status', 0, 2) as PlatformMediaPublishStatus
  for (const row of rows) for (const field of ['current_version', 'online_version', 'publish_status'] as const) {
    if (row[field] !== undefined && row[field] !== selected[field]) throw new SnapshotError('MEDIA_SNAPSHOT_INVALID', `平台不同版本返回的${field}互相矛盾，未采用本次响应`, unavailable)
  }
  if (!selected.episode_info_list?.length) throw new SnapshotError('MEDIA_EPISODE_COVERAGE', '指定版本缺少episode_info_list，无法覆盖本地全部剧集', true)
  const bySequence = new Map<number, typeof selected.episode_info_list[number]>()
  const episodeIds = new Set<string>()
  for (const episode of selected.episode_info_list) {
    if (bySequence.has(episode.seq)) throw new SnapshotError('MEDIA_EPISODE_COVERAGE', '平台episode_info_list的seq重复，不能采用不明确的剧集映射', true)
    if (episodeIds.has(episode.episode_id)) throw new SnapshotError('MEDIA_EPISODE_COVERAGE', '平台episode_info_list的episode_id重复', true)
    if (!episode.byteplus_vid.trim() || episode.byteplus_vid.length > 200 || /[\s/?#]/.test(episode.byteplus_vid)) {
      throw new SnapshotError('MEDIA_EPISODE_COVERAGE', '平台byteplus_vid必须是视频ID，不能是原始播放URL', true)
    }
    bySequence.set(episode.seq, episode); episodeIds.add(episode.episode_id)
  }
  return {
    currentVersion, onlineVersion, reviewStatus, publishStatus,
    versions: rows.map(row => ({
      version: row.version,
      reviewStatus: typeof row.review_status === 'number' && Number.isInteger(row.review_status) && row.review_status >= 0 && row.review_status <= 7 ? row.review_status as PlatformMediaReviewStatus : null,
      episodeCount: row.episode_info_list?.length ?? null,
    })).sort((a, b) => b.version - a.version),
    episodes: episodes.map(local => {
      const remote = bySequence.get(Number(local.seq))
      if (!remote) throw new SnapshotError('MEDIA_EPISODE_COVERAGE', `平台版本缺少本地第${local.seq}集（seq=${local.seq}），必须覆盖本地全部连续集数`, true)
      if (local.import_task_id != null && remote.byteplus_vid !== local.imported_vid) {
        throw new SnapshotError('MEDIA_IMPORTED_VIDEO_MISMATCH', `平台第${local.seq}集与已核验导入的视频不一致，未覆盖本地视频，请核对云端剧集映射`, true)
      }
      return { localEpisodeId: Number(local.id), seq: Number(local.seq), episodeId: remote.episode_id, vid: remote.byteplus_vid }
    }),
  }
}
function observed(op: Row, value: Snapshot): boolean {
  switch (op.action) {
    case 'authorize_app': return op.acknowledged === 1 // 只接受该请求已验证的授权回执，查询本身不提供授权状态。
    case 'submit_review': return value.reviewStatus !== 0 &&
      (value.reviewStatus !== op.prior_review_status || [1, 2, 6].includes(value.reviewStatus))
    case 'set_online': return value.onlineVersion === op.platform_version && approved(value.reviewStatus)
    case 'list': return value.publishStatus === 1 && value.onlineVersion === op.platform_version && approved(value.reviewStatus)
    case 'delist': return value.publishStatus === 2
    default: return false
  }
}
function applySnapshot(ctx: AppContext, claim: Claim, result: MediaAlbumQueryResult, accessVerified = false): void {
  transaction(ctx.db, () => {
    assertCurrent(ctx, claim)
    const value = snapshot(result, claim, localEpisodes(ctx, claim.dramaId)), previous = binding(ctx, claim.dramaId)!
    const now = Date.now()
    const expectedEpisodes = JSON.stringify(value.episodes.map(e => [e.localEpisodeId, e.seq, e.episodeId, e.vid]))
    const savedEpisodes = JSON.stringify(ctx.db.prepare(`SELECT local_episode_id,seq,episode_id,vid
      FROM platform_media_episodes WHERE drama_id=? ORDER BY seq`).all(claim.dramaId)
      .map(e => [e.local_episode_id, e.seq, e.episode_id, e.vid]))
    // 单集许可不是对未来新版本/新片源的永久授权；映射变化必须重新核验。
    let authorized = accessVerified || (previous.album_id === claim.albumId &&
      previous.platform_version === claim.platformVersion && expectedEpisodes === savedEpisodes &&
      previous.authorized_client_key === claim.clientKey)
    let authorizedAt = authorized ? nullableNumber(previous.authorized_at) : null
    if (accessVerified) authorizedAt = now
    for (const op of pendingWrites(ctx, claim.dramaId)) {
      if (op.album_id !== claim.albumId || op.platform_version !== claim.platformVersion || op.client_key !== claim.clientKey || !observed(op, value)) continue
      ctx.db.prepare(`UPDATE platform_media_operations SET status='reconciled',reconciled_by=?,error_code=NULL,
        message='后续查询已确认目标状态；未重发原请求',updated_at=? WHERE request_id=?`).run(claim.requestId, now, String(op.request_id))
      if (op.action === 'authorize_app') { authorized = true; authorizedAt = now }
    }
    const needsSync = Number(pendingWrites(ctx, claim.dramaId).length > 0)
    const local = dramaRow(ctx, claim.dramaId)
    const localMappings = JSON.stringify(ctx.db.prepare(`SELECT id,seq,platform_episode_id,byteplus_vid
      FROM episodes WHERE drama_id=? ORDER BY seq`).all(claim.dramaId)
      .map(e => [e.id, e.seq, e.platform_episode_id, e.byteplus_vid]))
    // 查询时间和查询回执不是内容修改。稳定的审核轮询不应每分钟使运营表单过期。
    // 状态、授权、版本或任一映射变化时，仍按原流程推进版本、失效旧观察并修复数据。
    const unchanged = previous.synced_local_version === claim.localVersion && previous.synced_operation_id != null &&
      // 两段式查询可能临时置needs_sync；只采用发起前的标记，不忽略原有待核对状态。
      claim.priorNeedsSync === 0 && needsSync === 0 &&
      previous.album_id === claim.albumId && previous.client_key === claim.clientKey &&
      previous.platform_version === claim.platformVersion && previous.current_version === value.currentVersion &&
      previous.online_version === value.onlineVersion && previous.review_status === value.reviewStatus &&
      previous.publish_status === value.publishStatus &&
      nullableString(previous.authorized_client_key) === (authorized ? claim.clientKey : null) &&
      nullableNumber(previous.authorized_at) === authorizedAt &&
      local.platform_album_id === claim.albumId && local.platform_review_status === reviewNames[value.reviewStatus] &&
      String(previous.versions_json) === JSON.stringify(value.versions) &&
      savedEpisodes === expectedEpisodes && localMappings === expectedEpisodes
    const newVersion = claim.localVersion + (unchanged ? 0 : 1)
    ctx.db.prepare(`UPDATE platform_media_bindings SET album_id=?,client_key=?,platform_version=?,
      current_version=?,online_version=?,review_status=?,publish_status=?,synced_local_version=?,synced_at=?,
      authorized_client_key=?,authorized_at=?,needs_sync=?,synced_operation_id=?,versions_json=? WHERE drama_id=?`)
      .run(claim.albumId, claim.clientKey, claim.platformVersion, value.currentVersion, value.onlineVersion, value.reviewStatus, value.publishStatus,
        newVersion, now, authorized ? claim.clientKey : null, authorizedAt, needsSync, claim.requestId, JSON.stringify(value.versions), claim.dramaId)
    if (!unchanged) {
      ctx.db.prepare('DELETE FROM platform_media_episodes WHERE drama_id=?').run(claim.dramaId)
      for (const episode of value.episodes) {
        ctx.db.prepare('INSERT INTO platform_media_episodes(drama_id,local_episode_id,seq,episode_id,vid) VALUES(?,?,?,?,?)')
          .run(claim.dramaId, episode.localEpisodeId, episode.seq, episode.episodeId, episode.vid)
        ctx.db.prepare('UPDATE episodes SET platform_episode_id=?,byteplus_vid=?,updated_at=? WHERE id=? AND drama_id=?')
          .run(episode.episodeId, episode.vid, now, episode.localEpisodeId, claim.dramaId)
      }
      ctx.db.prepare('UPDATE dramas SET platform_album_id=?,platform_review_status=?,version=version+1,updated_at=? WHERE id=?')
        .run(claim.albumId, reviewNames[value.reviewStatus], now, claim.dramaId)
    }
    ctx.db.prepare(`UPDATE platform_media_operations SET status='succeeded',acknowledged=1,result_version=?,
      message=?,updated_at=? WHERE request_id=?`).run(newVersion,
        accessVerified ? `已查询指定版本并逐集取得${value.episodes.length}集播放许可；未保存凭证，未购买或公开源草稿`
          : '已按指定版本查询同步；审核通过不等于已上线', now, claim.requestId)
    ctx.db.prepare(`INSERT INTO platform_media_observations
      (request_id,drama_id,platform_version,local_version,review_status,publish_status,observed_at)
      VALUES(?,?,?,?,?,?,?)`).run(claim.requestId,claim.dramaId,claim.platformVersion,newVersion,value.reviewStatus,value.publishStatus,now)
    ctx.audit(claim.actorId, 'media.sync', 'drama', String(claim.dramaId), {
      requestId: claim.requestId, albumId: claim.albumId, platformVersion: claim.platformVersion,
      reviewStatus: value.reviewStatus, onlineVersion: value.onlineVersion, publishStatus: value.publishStatus,
      ...(accessVerified ? { accessVerified: true, verifiedEpisodeIds: value.episodes.map(e => e.episodeId) } : {}),
    })
  })
}
async function sendWrite(client: MediaClient, claim: Claim): Promise<{ reviewId?: string }> {
  switch (claim.action) {
    case 'submit_review': return client.submitReview(claim.albumId, claim.platformVersion)
    case 'set_online': await client.setOnlineVersion(claim.albumId, claim.platformVersion); break
    case 'authorize_app': await client.authorizeAlbum(claim.albumId); break
    case 'list': await client.setAlbumStatus(claim.albumId, 1); break
    case 'delist': await client.setAlbumStatus(claim.albumId, 2); break
  }
  return {}
}
function acceptWrite(ctx: AppContext, claim: Claim, receipt: { reviewId?: string }): void {
  transaction(ctx.db, () => {
    assertCurrent(ctx, claim)
    const now = Date.now(), newVersion = claim.localVersion + 1, authorization = claim.action === 'authorize_app'
    // 不把提交回执当成审核/上市查询。除授权回执外，写成功也必须再查询确认。
    if (authorization) ctx.db.prepare('UPDATE platform_media_bindings SET authorized_client_key=?,authorized_at=?,needs_sync=? WHERE drama_id=?')
      .run(claim.clientKey, now, claim.priorNeedsSync, claim.dramaId)
    ctx.db.prepare('UPDATE platform_media_bindings SET synced_local_version=? WHERE drama_id=? AND synced_local_version=?')
      .run(newVersion, claim.dramaId, claim.localVersion)
    ctx.db.prepare('UPDATE dramas SET version=version+1,updated_at=? WHERE id=?').run(now, claim.dramaId)
    ctx.db.prepare(`UPDATE platform_media_operations SET status=?,acknowledged=1,review_id=?,result_version=?,message=?,updated_at=? WHERE request_id=?`)
      .run(authorization ? 'succeeded' : 'awaiting_sync', receipt.reviewId ?? null, newVersion,
        authorization ? '平台已确认当前App授权' : '平台已受理此请求；请查询确认目标状态，不要重复提交', now, claim.requestId)
    ctx.audit(claim.actorId, 'media.accepted', 'drama', String(claim.dramaId), { requestId: claim.requestId, action: claim.action, reviewId: receipt.reviewId })
  })
}
function failOperation(ctx: AppContext, claim: Claim, cause: unknown, receipt?: { reviewId?: string }): ApiError {
  return transaction(ctx.db, () => {
    const current = isCurrent(ctx, claim)
    const error = !current ? new ApiError(409, 'MEDIA_STALE_RESULT', '本地version或操作ID已变化，旧结果未覆盖内容；平台写操作仍需查询核对') :
      cause instanceof ApiError ? cause :
      cause instanceof MediaClientError ? new ApiError(cause.status, cause.code, cause.message) :
      new ApiError(502, claim.action === 'sync' ? 'MEDIA_REQUEST_FAILED' : 'MEDIA_MUTATION_UNKNOWN',
        claim.action === 'sync' ? '平台查询失败，保留上次已验证状态' : '平台写操作结果未知，请先查询核对，不要重发')
    const stored = ctx.db.prepare('SELECT status FROM platform_media_operations WHERE request_id=?').get(claim.requestId)
    if (!current && (stored?.status === 'reconciled' || stored?.status === 'succeeded')) {
      // 新查询已经确认了目标状态；迟到回执既不能覆盖内容，也不能倒写旧存根的结论。
      ctx.audit(claim.actorId, 'media.stale_response', 'drama', String(claim.dramaId), { requestId: claim.requestId, code: error.code })
      return error
    }
    const uncertain = !current || Boolean(receipt) || !['MEDIA_INVALID_INPUT', 'MEDIA_RUNTIME_UNSUPPORTED', 'MEDIA_TOKEN_UNAVAILABLE', 'MEDIA_REJECTED'].includes(error.code)
    const status = claim.action === 'sync' ? (current ? 'failed' : 'superseded') : uncertain ? 'unknown' : 'failed'
    const now = Date.now()
    ctx.db.prepare(`UPDATE platform_media_operations SET status=?,error_code=?,message=?,acknowledged=?,review_id=?,updated_at=? WHERE request_id=?`)
      .run(status, error.code, error.message, Number(Boolean(receipt)), receipt?.reviewId ?? null, now, claim.requestId)
    if (current && claim.action !== 'sync' && !uncertain) {
      ctx.db.prepare('UPDATE platform_media_bindings SET needs_sync=? WHERE drama_id=?').run(claim.priorNeedsSync, claim.dramaId)
    }
    const previous = binding(ctx, claim.dramaId)
    if (current && claim.action === 'sync' && cause instanceof SnapshotError && cause.invalidate &&
      previous?.album_id === claim.albumId && previous.platform_version === claim.platformVersion) {
      // 明确版本丢失或覆盖失效时停止展示，不谎称平台已下架；网络失败不走这里。
      ctx.db.prepare('UPDATE platform_media_bindings SET needs_sync=1 WHERE drama_id=?').run(claim.dramaId)
      ctx.db.prepare("UPDATE dramas SET platform_review_status='needs_sync',version=version+1,updated_at=? WHERE id=?").run(now, claim.dramaId)
    }
    ctx.audit(claim.actorId, 'media.failure', 'drama', String(claim.dramaId), { requestId: claim.requestId, action: claim.action, code: error.code, status })
    return error
  })
}

export interface MediaServiceResult {
  status: number
  value: Partial<PlatformMediaResponse> & { error?: { code: string; message: string } }
}
export function readPlatformMedia(ctx: AppContext, dramaId: number): PlatformMediaState { return state(ctx, dramaId) }

export async function syncPlatformMedia(ctx: AppContext, actor: MediaActor, input: Row): Promise<MediaServiceResult> {
    const dramaId = actor.dramaId
    assertMediaActor(actor, dramaId)
    const { claim, duplicate } = begin(ctx, dramaId, actor.id, input, 'sync')
    if (duplicate) return { status: 200, value: response(ctx, dramaId, claim.requestId) }
    const verifying = input.verifyAccess === true
    const secret = ctx.config.tiktokClientSecret
    // 重新核验时先撤销旧访问证据，失败/中断不能继续使用旧标记放行。
    if (verifying) ctx.db.prepare('UPDATE platform_media_bindings SET authorized_client_key=NULL,authorized_at=NULL,needs_sync=1 WHERE drama_id=?').run(dramaId)
    const context = () => JSON.stringify({ episodes: localEpisodes(ctx, dramaId), binding: binding(ctx, dramaId) })
    const initialContext = verifying ? context() : ''
    const currentSession = () => {
      assertMediaActor(actor, dramaId); assertCurrent(ctx, claim)
      if (verifying && (secret !== ctx.config.tiktokClientSecret || context() !== initialContext)) {
        throw new ApiError(409, 'MEDIA_STALE_RESULT', '核验期间应用配置或单集映射改变，未采用旧播放许可')
      }
      if (verifying) {
        const op = ctx.db.prepare('SELECT status,lease_until FROM platform_media_operations WHERE request_id=?').get(claim.requestId)!
        if (op.status !== 'submitting' || Number(op.lease_until) <= Date.now()) throw new ApiError(409, 'MEDIA_STALE_RESULT', '播放权限核验已中断或过期，请重新查询')
      }
    }
    try {
      let result = await getMediaClient(ctx).queryAlbum(claim.albumId)
      currentSession()
      const selected = result.album_version_list.find(row => row.version === claim.platformVersion)
      // 真实接口不带version时是版本索引，单集列表可能为空；保留索引供版本选择，
      // 仅为已选中的确切版本读取详情，不能拿其他版本的剧集顶替。
      if (selected && (!selected.episode_info_list || selected.episode_info_list.length === 0)) {
        const unavailable = explicitlyUnavailable(selected, claim.platformVersion)
        if (unavailable && !verifying) {
          // 索引已明确拒播：先暂停旧绑定交付，不能在等待详情时继续使用旧批准状态。
          // 不伪造新审核结果；完整详情回查成功后仍由applySnapshot统一写入。
          ctx.db.prepare(`UPDATE platform_media_bindings SET needs_sync=1
            WHERE drama_id=? AND album_id=? AND platform_version=? AND client_key=?`)
            .run(dramaId, claim.albumId, claim.platformVersion, claim.clientKey)
        }
        const detail = await getMediaClient(ctx).queryAlbum(claim.albumId, claim.platformVersion)
        currentSession()
        if (detail.album_version_list.length !== 1 || detail.album_version_list[0].version !== claim.platformVersion) {
          throw new SnapshotError('MEDIA_SNAPSHOT_INVALID', '指定版本详情不唯一或不匹配，未采用', unavailable)
        }
        const detailed = detail.album_version_list[0]
        for (const key of ['review_status', 'publish_status', 'current_version', 'online_version'] as const) {
          if (selected[key] !== undefined && detailed[key] !== undefined && selected[key] !== detailed[key]) {
            throw new SnapshotError('MEDIA_SNAPSHOT_INVALID', '版本索引与详情状态矛盾，请重新查询；不覆盖已有拒播信号',
              unavailable || explicitlyUnavailable(detailed, claim.platformVersion))
          }
        }
        result = { album_version_list: result.album_version_list.map(row =>
          row.version === claim.platformVersion ? detailed : row) }
      }
      currentSession()
      if (verifying) {
        const value = snapshot(result, claim, localEpisodes(ctx, dramaId))
        if (!approved(value.reviewStatus) || value.onlineVersion !== claim.platformVersion || value.publishStatus !== 1) {
          throw new ApiError(409, 'MEDIA_ACCESS_NOT_READY', '须先确认对应版本审核批准、在线且已上架，再核验当前App播放权限')
        }
        await verifyEpisodePlaybackAccess(getMediaClient(ctx), value.episodes.map(e => e.episodeId), () => {
          currentSession()
          ctx.db.prepare('UPDATE platform_media_operations SET lease_until=? WHERE request_id=?').run(Date.now() + LEASE_MS, claim.requestId)
        })
        currentSession()
      }
      applySnapshot(ctx, claim, result, verifying)
      return { status: 200, value: response(ctx, dramaId, claim.requestId) }
    } catch (cause) {
      // SDK拒绝/超时时同样复核会话；否则不会经过成功回包分支的检查。
      // 操作同时过期不能把身份错误降为409后又向旧会话返回media。
      let revoked: ApiError | undefined
      try { currentSession() }
      catch (error) { if (error instanceof ApiError && [401, 403].includes(error.status)) revoked = error }
      const recorded = failOperation(ctx, claim, revoked ?? cause)
      const error = revoked ?? recorded
      if ([401, 403].includes(error.status)) {
        return { status: error.status, value: { error: { code: error.code, message: error.message } } }
      }
      return { status: error.status, value: { error: { code: error.code, message: error.message }, ...response(ctx, dramaId, claim.requestId) } }
    }
}

export async function writePlatformMedia(ctx: AppContext, actor: MediaActor, input: Row): Promise<MediaServiceResult> {
    const dramaId = actor.dramaId
    assertMediaActor(actor, dramaId)
    if (!writes.includes(input.action as WriteAction)) throw new ApiError(400, 'INVALID_INPUT', 'action必须为提审、设在线、当前App授权或平台上/下架')
    const { claim, duplicate } = begin(ctx, dramaId, actor.id, input, input.action as WriteAction)
    if (duplicate) return { status: 200, value: response(ctx, dramaId, claim.requestId) }
    let receipt: { reviewId?: string } | undefined
    try {
      receipt = await sendWrite(getMediaClient(ctx), claim)
      acceptWrite(ctx, claim, receipt)
      return { status: 200, value: response(ctx, dramaId, claim.requestId) }
    } catch (cause) {
      const error = failOperation(ctx, claim, cause, receipt)
      return { status: error.status, value: { error: { code: error.code, message: error.message }, ...response(ctx, dramaId, claim.requestId) } }
    }
}

export function registerPlatformMedia(router: Router, ctx: AppContext): void {
  const route = '/api/admin/dramas/:id/platform-media'
  router.get(route, (req, res) => { ctx.requireAdmin(req); res.json(response(ctx, id(req.params.id))) })
  router.post(`${route}/sync`, asyncRoute(async (req, res) => {
    const result = await syncPlatformMedia(ctx, requestMediaActor(ctx, req, id(req.params.id)), body(req.body))
    res.status(result.status).json(result.value)
  }))
  router.post(`${route}/operations`, asyncRoute(async (req, res) => {
    const result = await writePlatformMedia(ctx, requestMediaActor(ctx, req, id(req.params.id)), body(req.body))
    res.status(result.status).json(result.value)
  }))
}
