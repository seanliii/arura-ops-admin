import { randomUUID } from 'node:crypto'
import type { Request, Router } from 'express'
import type {
  BytePlusUploadConfig, CloudMediaObservation, CloudUploadImportResult, CloudUploadStatus, CloudUploadTask, CloudUploadTicket,
} from '../shared/cloud-upload.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { body, id, integer, text } from './validation.js'
import { transaction } from './db.js'
import { cloudUploadAvailability, cloudUploadFingerprint, MAX_CLOUD_UPLOAD_BYTES } from './cloud-upload-config.js'
import { createBytePlusUploadClient } from './byteplus-upload-client.js'
import { getMediaClient } from './platform-media.js'
import { MediaClientError } from './tiktok-media-client.js'
import { assertMediaActor, requestMediaActor, type MediaActor } from './media-actor.js'

type Row = Record<string, unknown>
const prefix = '/api/admin/cloud-uploads'
const LEASE_MS = 60_000
const CREDENTIAL_COOLDOWN_MS = 30_000
const taskIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const taskSelect = `SELECT t.*,i.episode_id AS imported_episode_id,i.imported_at,
  r.status AS video_status,r.confirmed_at AS video_confirmed_at,r.error_code AS video_error_code,
  r.message AS video_message,r.updated_at AS video_updated_at
  FROM cloud_upload_tasks t LEFT JOIN cloud_upload_imports i ON i.task_id=t.id
  LEFT JOIN cloud_video_registrations r ON r.task_id=t.id`
const failure = (status: number, code: string, message: string) => new ApiError(status, code, message)
function onlyFields(input: Row, allowed: string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw failure(400, 'INVALID_CLOUD_FIELDS', '上传请求含不支持的字段')
}
function emptyBody(req: Request) { onlyFields(body(req.body ?? {}), []) }
function configuration(ctx: AppContext): BytePlusUploadConfig {
  if (!cloudUploadAvailability(ctx.config).configured) throw failure(503, 'CLOUD_UPLOAD_UNCONFIGURED', '云端上传未完成服务端配置，未签发凭据或开始上传')
  return ctx.config.byteplusUpload!
}
/** 可轮换密钥，但不能在任务途中改变云账号、空间、角色、App或环境。 */
function fingerprint(ctx: AppContext, config = configuration(ctx)) {
  return cloudUploadFingerprint(ctx.config, config)
}
function publicTask(row: Row): CloudUploadTask {
  return {
    id: String(row.id), dramaId: Number(row.drama_id), seq: Number(row.seq), title: String(row.title),
    fileName: String(row.file_name), fileBytes: Number(row.file_bytes), status: row.status as CloudUploadStatus,
    candidateVid: row.candidate_vid === null ? null : String(row.candidate_vid),
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    verifiedAt: row.verified_at === null ? null : Number(row.verified_at),
    importedEpisodeId: row.imported_episode_id == null ? null : Number(row.imported_episode_id),
    importedAt: row.imported_at == null ? null : Number(row.imported_at),
    createdAt: Number(row.created_at), updatedAt: Math.max(Number(row.updated_at), Number(row.video_updated_at ?? 0)),
    errorCode: row.error_code === null ? null : String(row.error_code), message: String(row.message),
    videoRegistration: row.video_status == null ? null : {
      status: row.video_status as NonNullable<CloudUploadTask['videoRegistration']>['status'],
      confirmedAt: row.video_confirmed_at == null ? null : Number(row.video_confirmed_at),
      errorCode: row.video_error_code == null ? null : String(row.video_error_code),
      message: String(row.video_message), updatedAt: Number(row.video_updated_at),
    },
  }
}
function taskById(ctx: AppContext, taskId: string): Row {
  return ctx.db.prepare(`${taskSelect} WHERE t.id=?`).get(taskId)!
}
function expireLeases(ctx: AppContext) {
  const now = Date.now()
  ctx.db.prepare(`UPDATE cloud_video_registrations SET
    status=CASE WHEN write_id IS NULL THEN 'failed' ELSE 'unknown' END,
    lease_id=NULL,lease_until=0,updated_at=?,error_code='CLOUD_VIDEO_INTERRUPTED',
    message='视频登记请求中断，请核对原任务；已发出写入的任务只查询，不重复登记。'
    WHERE lease_id IS NOT NULL AND lease_until<=? AND status<>'registered'`).run(now, now)
  ctx.db.prepare(`UPDATE cloud_upload_tasks SET
    status=CASE WHEN status='verifying' THEN 'awaiting_verification' ELSE status END,
    lease_id=NULL,lease_until=0,updated_at=?,error_code='CLOUD_REQUEST_INTERRUPTED',
    message='上一次请求中断。已收到VID的任务可重新核验；没有VID的上传需回到原页面核对。'
    WHERE lease_id IS NOT NULL AND lease_until<=?`).run(now, now)
}
function owned(ctx: AppContext, req: Request): Row {
  const admin = ctx.requireAdmin(req)
  const taskId = String(req.params.id)
  if (!taskIdPattern.test(taskId)) throw failure(400, 'INVALID_UPLOAD_ID', '上传任务编号无效')
  expireLeases(ctx)
  const row = ctx.db.prepare(`${taskSelect} WHERE t.id=? AND t.owner_id=?`).get(taskId, admin.id)
  if (!row) throw failure(404, 'CLOUD_UPLOAD_NOT_FOUND', '未找到当前管理员的上传任务')
  return row
}
function editableTarget(ctx: AppContext, dramaId: number, seq: number) {
  const drama = ctx.db.prepare('SELECT * FROM dramas WHERE id=?').get(dramaId)
  if (!drama) throw failure(404, 'NOT_FOUND', '目标剧目不存在')
  if (drama.status === 'published') throw failure(409, 'UNPUBLISH_FIRST', '请先下架目标剧目，再上传或核验新视频')
  if (!drama.rights_confirmed) throw failure(422, 'RIGHTS_REQUIRED', '请先在目标剧目中确认内容版权')
  if (ctx.db.prepare('SELECT id FROM episodes WHERE drama_id=? AND seq=?').get(dramaId, seq)) {
    throw failure(409, 'CLOUD_EPISODE_OCCUPIED', '该集数已经存在，不能让上传任务覆盖已有单集')
  }
}
function matchingContext(ctx: AppContext, row: Row) {
  if (row.status === 'cancelled') throw failure(409, 'CLOUD_UPLOAD_CANCELLED', '任务已取消；这不会删除云端视频或立即撤销已签发权限')
  if (row.config_fingerprint !== fingerprint(ctx)) throw failure(409, 'CLOUD_CONFIG_CHANGED', '任务对应的应用或云空间配置已变化，不能在新配置下继续原任务')
}
function compatible(ctx: AppContext, row: Row) {
  matchingContext(ctx, row)
  editableTarget(ctx, Number(row.drama_id), Number(row.seq))
}
interface Claim { taskId: string; ownerId: string; sessionHash: string; leaseId: string }
function begin(ctx: AppContext, req: Request, row: Row): Claim {
  compatible(ctx, row)
  if (row.lease_id && Number(row.lease_until) > Date.now()) throw failure(409, 'CLOUD_UPLOAD_BUSY', '这个上传任务的请求仍在处理中，请先等待或刷新记录')
  const sessionHash = ctx.sessionHash(req)
  if (!sessionHash) throw failure(401, 'UNAUTHENTICATED', '管理员登录已失效')
  const leaseId = randomUUID()
  ctx.db.prepare('UPDATE cloud_upload_tasks SET lease_id=?,lease_until=?,updated_at=? WHERE id=?')
    .run(leaseId, Date.now() + LEASE_MS, Date.now(), String(row.id))
  return { taskId: String(row.id), ownerId: String(row.owner_id), sessionHash, leaseId }
}
function stillCurrent(ctx: AppContext, req: Request, claim: Claim): Row {
  const admin = ctx.requireAdmin(req)
  if (admin.id !== claim.ownerId || ctx.sessionHash(req) !== claim.sessionHash) {
    throw failure(401, 'ADMIN_SESSION_CHANGED', '管理员登录已变化，未交付上一会话的上传结果')
  }
  const row = owned(ctx, req)
  compatible(ctx, row)
  if (row.lease_id !== claim.leaseId) throw failure(409, 'CLOUD_UPLOAD_CHANGED', '任务已经被后续操作更新，未采用迟到结果')
  return row
}
const ownErrorCodes = new Set([
  'UNAUTHENTICATED', 'FORBIDDEN', 'ADMIN_SESSION_CHANGED', 'CLOUD_UPLOAD_CHANGED', 'CLOUD_UPLOAD_CANCELLED',
  'CLOUD_CONFIG_CHANGED', 'CLOUD_UPLOAD_UNCONFIGURED', 'CLOUD_EPISODE_OCCUPIED', 'UNPUBLISH_FIRST',
  'RIGHTS_REQUIRED', 'CLOUD_MEDIA_MISMATCH', 'CLOUD_PROVIDER_VIDEO_FAILED', 'NOT_FOUND',
  'UPLOAD_VID_CLAIMED',
])
function safeError(error: unknown, phase: 'credentials' | 'verify'): ApiError {
  if (error instanceof ApiError && ownErrorCodes.has(error.code)) return error
  return phase === 'credentials'
    ? failure(502, 'CLOUD_CREDENTIALS_FAILED', '无法取得临时上传权限，未返回任何凭据。请核对服务器配置后重试')
    : failure(502, 'CLOUD_VERIFY_FAILED', '暂时无法核验云端视频。已有VID已保留，请重试核验，不要再次上传')
}
function saveError(ctx: AppContext, claim: Claim, error: ApiError, phase: 'credentials' | 'verify') {
  ctx.db.prepare(`UPDATE cloud_upload_tasks SET status=CASE WHEN ?='verify' THEN 'awaiting_verification' ELSE status END,
    lease_id=NULL,lease_until=0,error_code=?,message=?,updated_at=? WHERE id=? AND lease_id=? AND status<>'cancelled'`)
    .run(phase, error.code, error.message, Date.now(), claim.taskId, claim.leaseId)
}
function matches(row: Row, media: CloudMediaObservation, config: BytePlusUploadConfig) {
  return media.vid === row.candidate_vid && media.spaceName === config.spaceName && media.title === row.media_marker
    && Number.isSafeInteger(media.bytes) && media.bytes === row.file_bytes
    && Number.isFinite(media.durationSeconds) && media.durationSeconds > 0 && media.durationSeconds <= 86400
    && media.fileType === 'video' && typeof media.format === 'string' && media.format.toUpperCase() === 'MP4'
    && media.publishStatus === 'Unpublished'
}

function ownedTask(ctx: AppContext, actor: MediaActor, uploadId: string): Row {
  assertMediaActor(actor, actor.dramaId)
  if (!taskIdPattern.test(uploadId)) throw failure(400, 'INVALID_UPLOAD_ID', '上传任务编号无效')
  expireLeases(ctx)
  const row = ctx.db.prepare(`${taskSelect} WHERE t.id=? AND t.owner_id=? AND t.drama_id=?`).get(uploadId, actor.id, actor.dramaId)
  if (!row) throw failure(404, 'CLOUD_UPLOAD_NOT_FOUND', '未找到本次授权的原上传任务')
  return row
}

/** 只登记已经核验并认领的原VID；不依赖日语配置、不签发上传权限、不创建剧目或权益。 */
export async function registerCloudVideo(ctx: AppContext, actor: MediaActor, uploadId: string): Promise<Row> {
  const config = configuration(ctx), initial = ownedTask(ctx, actor, uploadId)
  function eligible(row: Row) {
    matchingContext(ctx, row)
    if (row.status !== 'verified' || !Number(row.verified_at) || !Number(row.issued_at) ||
      typeof row.claimed_vid !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(row.claimed_vid) ||
      row.claimed_vid !== row.candidate_vid) {
      throw failure(409, 'CLOUD_UPLOAD_NOT_VERIFIED', '只能登记已由服务器核验并认领的视频，不能手填或更换VID')
    }
    const drama = ctx.db.prepare('SELECT status,rights_confirmed FROM dramas WHERE id=?').get(Number(row.drama_id))
    if (drama?.status !== 'draft') throw failure(409, 'UNPUBLISH_FIRST', '只能为草稿登记视频，请先下架或恢复为草稿')
    if (!drama.rights_confirmed) throw failure(422, 'RIGHTS_REQUIRED', '请先确认内容版权')
    if (row.imported_at != null) {
      const episode = ctx.db.prepare('SELECT drama_id,byteplus_vid FROM episodes WHERE id=?').get(Number(row.imported_episode_id ?? 0))
      if (!episode || episode.drama_id !== row.drama_id || episode.byteplus_vid !== row.claimed_vid) {
        throw failure(409, 'CLOUD_IMPORTED_EPISODE_REMOVED', '原导入单集已删除或换片，不能用历史任务重新登记')
      }
    } else editableTarget(ctx, Number(row.drama_id), Number(row.seq))
    if (row.lease_id && Number(row.lease_until) > Date.now()) throw failure(409, 'CLOUD_UPLOAD_BUSY', '原上传任务仍在处理，请稍后核对')
    if (config.vodRegion !== 'ap-southeast-1') throw failure(503, 'CLOUD_VIDEO_REGION_UNCONFIRMED', '当前仅已验证柔佛空间的视频登记，请先确认此地域的接入契约')
  }
  eligible(initial)
  const taskId = String(initial.id), vid = String(initial.claimed_vid), ownerId = String(initial.owner_id)
  const sessionHash = actor.identity
  if (!sessionHash) throw failure(401, 'UNAUTHENTICATED', '管理员登录已失效')
  const leaseId = randomUUID()
  const registration = () => ctx.db.prepare('SELECT * FROM cloud_video_registrations WHERE task_id=?').get(taskId)
  const alreadyDone = transaction(ctx.db, () => {
    const previous = registration()
    if (previous && previous.vid !== vid) throw failure(409, 'UPLOAD_VID_CONFLICT', '历史视频登记与原任务不一致')
    if (previous?.status === 'registered') return true
    if (previous?.lease_id && Number(previous.lease_until) > Date.now()) throw failure(409, 'CLOUD_UPLOAD_BUSY', '视频登记仍在处理中，请等待原请求')
    const now = Date.now()
    ctx.db.prepare(`INSERT INTO cloud_video_registrations(task_id,vid,status,lease_id,lease_until,message,created_at,updated_at)
      VALUES(?,?,'checking',?,?,'正在核对TikTok中的原视频',?,?)
      ON CONFLICT(task_id) DO UPDATE SET status='checking',lease_id=excluded.lease_id,lease_until=excluded.lease_until,
      error_code=NULL,message=excluded.message,updated_at=excluded.updated_at`)
      .run(taskId, vid, leaseId, now + 90_000, now, now)
    return false
  })
  if (alreadyDone) return taskById(ctx, taskId)
  function current() {
    const row = ownedTask(ctx, actor, uploadId)
    if (actor.identity !== sessionHash || row.owner_id !== ownerId) throw failure(401, 'ADMIN_SESSION_CHANGED', '管理员会话已变化，未继续视频登记')
    eligible(row)
    if (row.claimed_vid !== vid || registration()?.lease_id !== leaseId) throw failure(409, 'CLOUD_UPLOAD_CHANGED', '原任务已变化或请求过期，请刷新核对')
    return row
  }
  let thisWrite: string | undefined
  let inWrite = false
  try {
    const client = getMediaClient(ctx)
    let found
    try { found = await client.queryVideo({ vid, byteplusAccountId: config.accountId }) }
    catch (error) {
      if (!(error instanceof MediaClientError) || error.code !== 'MEDIA_VIDEO_NOT_FOUND') throw error
    }
    current()
    if (!found) {
      if (registration()?.write_id) throw failure(409, 'CLOUD_VIDEO_REGISTRATION_UNKNOWN', '原登记可能已提交，平台尚未查到结果；只允许稍后查询，不重复登记')
      if (!client.registerExistingVideo) throw failure(503, 'CLOUD_VIDEO_CLIENT_UNAVAILABLE', '服务端尚未启用已有视频登记能力')
      thisWrite = randomUUID()
      transaction(ctx.db, () => {
        current()
        ctx.db.prepare(`UPDATE cloud_video_registrations SET status='sending',write_id=?,message='正在登记已有VID，不转传视频',updated_at=? WHERE task_id=? AND lease_id=?`)
          .run(thisWrite!, Date.now(), taskId, leaseId)
        ctx.audit(ownerId, 'cloud_video.registration_sent', 'cloud_upload', taskId)
      })
      inWrite = true
      const result = await client.registerExistingVideo({
        vid, title: String(initial.media_marker), spaceName: config.spaceName,
        byteplusAccountId: config.accountId, byteplusRegion: 'ap-southeast-1',
      })
      if (result.byteplusVid !== vid) throw failure(502, 'CLOUD_VIDEO_RECEIPT_INVALID', '平台返回的视频编号不一致，需要核对原登记')
      inWrite = false
      // 回执是已经发生的事实：即使用户退出/租约过期，也先保存且不覆盖后来回查的状态。
      ctx.db.prepare('UPDATE cloud_video_registrations SET acknowledged_vid=? WHERE task_id=? AND write_id=?')
        .run(vid, taskId, thisWrite)
      current()
      found = await client.queryVideo({ vid, byteplusAccountId: config.accountId })
      current()
    }
    if (found.vid !== vid || found.uploadStatus !== 2 || found.status !== 'succeeded') {
      throw failure(409, 'CLOUD_VIDEO_NOT_READY', '平台尚未确认同一视频登记完成，请稍后核对，不要重新上传')
    }
    transaction(ctx.db, () => {
      current()
      const now = Date.now()
      ctx.db.prepare(`UPDATE cloud_video_registrations SET status='registered',confirmed_at=?,lease_id=NULL,lease_until=0,
        error_code=NULL,message='TikTok视频登记已回查确认；仍需剧集登记、审核及上架',updated_at=? WHERE task_id=? AND lease_id=?`)
        .run(now, now, taskId, leaseId)
      ctx.db.prepare('UPDATE cloud_upload_tasks SET updated_at=? WHERE id=?').run(now, taskId)
      ctx.audit(ownerId, 'cloud_video.registered', 'cloud_upload', taskId)
    })
    return taskById(ctx, taskId)
  } catch (cause) {
    // 只有本次写入明确未发生/被拒绝时可以解除未知状态，不能拿后续GET的拒绝清除POST历史。
    if (inWrite && thisWrite && cause instanceof MediaClientError &&
      ['MEDIA_INVALID_INPUT', 'MEDIA_RUNTIME_UNSUPPORTED', 'MEDIA_TOKEN_UNAVAILABLE', 'MEDIA_REJECTED'].includes(cause.code)) {
      ctx.db.prepare('UPDATE cloud_video_registrations SET write_id=NULL WHERE task_id=? AND write_id=? AND acknowledged_vid IS NULL')
        .run(taskId, thisWrite)
    }
    const error = cause instanceof ApiError ? cause : failure(502, 'CLOUD_VIDEO_REGISTRATION_FAILED', 'TikTok视频登记或回查尚未完成。原VID和回执已保留，请核对同一任务，不要重复上传')
    ctx.db.prepare(`UPDATE cloud_video_registrations SET status=CASE WHEN write_id IS NULL THEN 'failed' ELSE 'unknown' END,
      lease_id=NULL,lease_until=0,error_code=?,message=?,updated_at=? WHERE task_id=? AND lease_id=? AND status<>'registered'`)
      .run(error.code, error.message, Date.now(), taskId, leaseId)
    throw error
  }
}

export function importCloudEpisode(ctx: AppContext, actor: MediaActor, uploadId: string, version: number) {
    assertMediaActor(actor, actor.dramaId)
    integer(version, 'version', 1)
    let created = false
    const result = transaction(ctx.db, (): CloudUploadImportResult => {
      const row = ownedTask(ctx, actor, uploadId)
      matchingContext(ctx, row)
      if (row.status !== 'verified' || !Number.isFinite(row.issued_at) || Number(row.issued_at) <= 0 ||
        !Number.isFinite(row.verified_at) || Number(row.verified_at) <= 0 ||
        typeof row.claimed_vid !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(row.claimed_vid) ||
        row.claimed_vid !== row.candidate_vid || !Number.isFinite(row.duration_seconds) ||
        Number(row.duration_seconds) <= 0 || Number(row.duration_seconds) > 86400) {
        throw failure(409, 'CLOUD_UPLOAD_NOT_VERIFIED', '只有服务器已核实BytePlus归属及文件信息的视频才能导入，不能使用候选VID或进度条结果')
      }
      const dramaId = Number(row.drama_id)
      const drama = ctx.db.prepare('SELECT * FROM dramas WHERE id=?').get(dramaId)!
      if (row.imported_at != null) {
        if (row.imported_episode_id == null) {
          throw failure(409, 'CLOUD_IMPORTED_EPISODE_REMOVED', '此任务已导入过，但单集后来被删除；不会因重试重新创建，请取消旧任务后按需重新上传')
        }
        // 丢失响应后的重试返回原单集；不覆盖后续编辑，也不再次增加版本。
        return { task: publicTask(row), episodeId: Number(row.imported_episode_id), dramaVersion: Number(drama.version) }
      }
      editableTarget(ctx, dramaId, Number(row.seq))
      if (drama.version !== version) throw failure(409, 'VERSION_CONFLICT', '剧目内容已变化，请刷新后核对集号再导入')
      if (row.lease_id && Number(row.lease_until) > Date.now()) throw failure(409, 'CLOUD_UPLOAD_BUSY', '上传任务仍有请求处理中，请稍后再导入')
      const now = Date.now()
      const inserted = ctx.db.prepare(`INSERT INTO episodes
        (drama_id,seq,title,duration_seconds,byteplus_vid,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(dramaId, Number(row.seq), String(row.title), Number(row.duration_seconds), row.claimed_vid, now, now)
      const episodeId = Number(inserted.lastInsertRowid)
      ctx.db.prepare('INSERT INTO cloud_upload_imports(task_id,episode_id,imported_at) VALUES(?,?,?)').run(String(row.id), episodeId, now)
      ctx.db.prepare(`UPDATE dramas SET version=version+1,updated_at=?,
        platform_review_status=CASE WHEN platform_review_status='approved' THEN 'needs_sync' ELSE platform_review_status END WHERE id=?`)
        .run(now, dramaId)
      ctx.db.prepare('UPDATE platform_media_bindings SET needs_sync=1 WHERE drama_id=?').run(dramaId)
      ctx.db.prepare(`UPDATE cloud_upload_tasks SET updated_at=?,error_code=NULL,reserved_seq=NULL,
        message='已导入本地草稿单集。仍需TikTok剧集登记、审核及上架；本次没有发布或发放观看权益。' WHERE id=?`)
        .run(now, String(row.id))
      ctx.audit(String(row.owner_id), 'cloud_upload.imported', 'cloud_upload', String(row.id), { dramaId, episodeId, seq: row.seq })
      created = true
      return { task: publicTask(taskById(ctx, String(row.id))), episodeId, dramaVersion: Number(drama.version) + 1 }
    })
    return { created, value: result }
}

export function registerCloudUploads(router: Router, ctx: AppContext) {
  router.get(`${prefix}/config`, (req, res) => {
    const admin = ctx.requireAdmin(req)
    res.json({ ...cloudUploadAvailability(ctx.config), ownerId: admin.id })
  })
  router.get(prefix, (req, res) => {
    const admin = ctx.requireAdmin(req)
    if (Object.keys(req.query).some(key => !['dramaId', 'cursor', 'expectedOwnerId'].includes(key))) {
      throw failure(400, 'INVALID_CLOUD_FIELDS', '仅支持目标剧目、分页游标和管理员身份校验')
    }
    if (req.query.expectedOwnerId !== undefined) {
      const expectedOwner = text(req.query.expectedOwnerId, 'expectedOwnerId', 256)
      if (expectedOwner !== admin.id) throw failure(401, 'ADMIN_SESSION_CHANGED', '其他标签页中的管理员会话已经变化，请重新登录确认，旧任务已停止显示')
    }
    const dramaId = req.query.dramaId === undefined ? null : id(req.query.dramaId)
    let before = Number.MAX_SAFE_INTEGER
    if (req.query.cursor !== undefined) {
      const cursor = text(req.query.cursor, 'cursor', 36)
      if (!taskIdPattern.test(cursor)) throw failure(400, 'INVALID_CLOUD_CURSOR', '分页游标无效，请重新刷新任务')
      const anchor = ctx.db.prepare(`SELECT rowid FROM cloud_upload_tasks
        WHERE id=? AND owner_id=? AND (? IS NULL OR drama_id=?)`).get(cursor, admin.id, dramaId, dramaId)
      if (!anchor) throw failure(400, 'INVALID_CLOUD_CURSOR', '分页游标不属于当前任务列表，请重新刷新')
      before = Number(anchor.rowid)
    }
    expireLeases(ctx)
    // 使用不可变插入顺序分页，导入/取消或核验状态变化不会把任务移动到另一页而漏掉。
    const rows = ctx.db.prepare(`${taskSelect} WHERE t.owner_id=? AND (? IS NULL OR t.drama_id=?) AND t.rowid<?
      ORDER BY t.rowid DESC LIMIT 101`).all(admin.id, dramaId, dramaId, before)
    const page = rows.slice(0, 100)
    res.json({ ownerId: admin.id, tasks: page.map(publicTask), nextCursor: rows.length > 100 ? String(page.at(-1)!.id) : null })
  })
  router.get(`${prefix}/:id`, (req, res) => { res.json({ task: publicTask(owned(ctx, req)) }) })
  router.post(`${prefix}/:id/register-video`, asyncRoute(async (req, res) => {
    ctx.requireAdmin(req)
    const value = body(req.body)
    onlyFields(value, ['confirmed'])
    if (value.confirmed !== true) throw failure(400, 'CLOUD_VIDEO_CONFIRMATION_REQUIRED', '请确认将已核验的原VID登记到TikTok；不会重复上传或发布')
    res.json({ task: publicTask(await registerCloudVideo(ctx, requestMediaActor(ctx, req, Number(owned(ctx, req).drama_id)), String(req.params.id))) })
  }))
  router.post(prefix, (req, res) => {
    const admin = ctx.requireAdmin(req), config = configuration(ctx), value = body(req.body)
    onlyFields(value, ['requestId', 'dramaId', 'seq', 'title', 'fileName', 'fileBytes', 'confirmed'])
    const requestKey = text(value.requestId, 'requestId', 36)
    if (!taskIdPattern.test(requestKey) || value.confirmed !== true) throw failure(400, 'UPLOAD_CONFIRMATION_REQUIRED', '请核对文件和集数后确认创建任务')
    const dramaId = integer(value.dramaId, 'dramaId', 1), seq = integer(value.seq, 'seq', 1, 10000)
    const title = text(value.title, 'title', 200), fileName = text(value.fileName, 'fileName', 255)
    const fileBytes = integer(value.fileBytes, 'fileBytes', 1, Math.min(ctx.config.cloudUploadMaxBytes!, MAX_CLOUD_UPLOAD_BYTES))
    if (!/\.mp4$/i.test(fileName) || /[/\\\u0000-\u001f\u007f]/.test(fileName)) throw failure(400, 'INVALID_VIDEO_FILE', '只能上传无路径信息的MP4文件名')
    let created = false
    const row = transaction(ctx.db, () => {
      const existing = ctx.db.prepare(`${taskSelect} WHERE t.owner_id=? AND t.request_key=?`).get(admin.id, requestKey)
      if (existing) {
        if (existing.drama_id !== dramaId || existing.seq !== seq || existing.title !== title ||
          existing.file_name !== fileName || existing.file_bytes !== fileBytes) throw failure(409, 'UPLOAD_REQUEST_CONFLICT', '同一请求编号不能改成另一个上传任务')
        return existing
      }
      editableTarget(ctx, dramaId, seq)
      if (ctx.db.prepare("SELECT id FROM cloud_upload_tasks WHERE drama_id=? AND reserved_seq=? AND status<>'cancelled'").get(dramaId, seq)) {
        throw failure(409, 'CLOUD_EPISODE_OCCUPIED', '该集数已有云上传任务，请先检查原任务而不是重复上传')
      }
      if (Number(ctx.db.prepare("SELECT COUNT(*) n FROM cloud_upload_tasks WHERE owner_id=? AND status NOT IN ('verified','cancelled')").get(admin.id)!.n) >= 100) {
        throw failure(429, 'CLOUD_UPLOAD_LIMIT', '未完成上传任务过多，请先核验或取消已有任务')
      }
      const taskId = randomUUID(), now = Date.now()
      ctx.db.prepare(`INSERT INTO cloud_upload_tasks
        (id,request_key,owner_id,drama_id,seq,reserved_seq,title,file_name,file_bytes,account_id,config_fingerprint,media_marker,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'created',?,?)`)
        .run(taskId, requestKey, admin.id, dramaId, seq, seq, title, fileName, fileBytes, config.accountId, fingerprint(ctx, config), `aurora-upload-${taskId}`, now, now)
      ctx.audit(admin.id, 'cloud_upload.created', 'cloud_upload', taskId, { dramaId, seq, fileBytes })
      created = true
      return taskById(ctx, taskId)
    })
    res.status(created ? 201 : 200).json({ task: publicTask(row) })
  })
  router.post(`${prefix}/:id/credentials`, asyncRoute(async (req, res) => {
    emptyBody(req)
    const row = owned(ctx, req), config = configuration(ctx)
    const claim = transaction(ctx.db, () => {
      compatible(ctx, row)
      if (!['created', 'uploading'].includes(String(row.status)) || row.candidate_vid) {
        throw failure(409, 'CLOUD_UPLOAD_ALREADY_TRANSFERRED', '该任务已有上传结果或已结束，请核验原视频，不要重新上传')
      }
      if (Number(row.credential_after) > Date.now()) throw failure(429, 'CLOUD_CREDENTIAL_COOLDOWN', '临时权限刚刚签发，请稍后再申请；不要重复启动上传')
      const result = begin(ctx, req, row)
      ctx.db.prepare("UPDATE cloud_upload_tasks SET status='uploading',credential_after=? WHERE id=?")
        .run(Date.now() + CREDENTIAL_COOLDOWN_MS, result.taskId)
      return result
    })
    try {
      const credentials = await createBytePlusUploadClient(config).issueCredentials(`aurora-${claim.taskId}`)
      const current = transaction(ctx.db, () => {
        stillCurrent(ctx, req, claim)
        ctx.db.prepare('UPDATE cloud_upload_tasks SET issued_at=?,lease_id=NULL,lease_until=0,error_code=NULL,message=?,updated_at=? WHERE id=?')
          .run(Date.now(), '临时上传权限已签发。文件直接传入视频云，进度完成后仍需服务器核验。', Date.now(), claim.taskId)
        ctx.audit(claim.ownerId, 'cloud_upload.credentials_issued', 'cloud_upload', claim.taskId)
        return taskById(ctx, claim.taskId)
      })
      res.json({
        task: publicTask(current), credentials, uploaderUserId: claim.ownerId, vodAppId: config.vodAppId,
        vodRegion: config.vodRegion, spaceName: config.spaceName, mediaMarker: String(current.media_marker),
      } satisfies CloudUploadTicket)
    } catch (cause) {
      const error = safeError(cause, 'credentials')
      saveError(ctx, claim, error, 'credentials')
      throw error
    }
  }))
  router.post(`${prefix}/:id/verify`, asyncRoute(async (req, res) => {
    const row = owned(ctx, req), value = body(req.body), config = configuration(ctx)
    onlyFields(value, ['vid'])
    const vid = text(value.vid, 'vid', 200)
    if (!/^[a-zA-Z0-9_-]+$/.test(vid)) throw failure(400, 'INVALID_MEDIA_ID', '云端视频编号格式无效')
    if (row.candidate_vid !== null && row.candidate_vid !== vid) throw failure(409, 'UPLOAD_VID_CONFLICT', '任务已收到另一个视频编号，不能用重试覆盖原结果')
    matchingContext(ctx, row)
    // 已核验记录的重放是只读；导入后同集号已存在，不应因此把历史结果说成失败。
    if (row.status === 'verified') { res.json({ task: publicTask(row) }); return }
    editableTarget(ctx, Number(row.drama_id), Number(row.seq))
    if (!row.issued_at) throw failure(409, 'UPLOAD_NOT_STARTED', '该任务尚未获得上传权限，不能认领外部视频')
    const claim = transaction(ctx.db, () => {
      if (ctx.db.prepare('SELECT id FROM cloud_upload_tasks WHERE account_id=? AND claimed_vid=? AND id<>?').get(config.accountId, vid, String(row.id))) {
        throw failure(409, 'UPLOAD_VID_CLAIMED', '这个视频已经属于另一个任务，不能关联到不同集数')
      }
      const result = begin(ctx, req, row)
      ctx.db.prepare("UPDATE cloud_upload_tasks SET status='verifying',candidate_vid=?,error_code=NULL,message='正在由服务器核验云端视频' WHERE id=?")
        .run(vid, result.taskId)
      return result
    })
    try {
      const media = await createBytePlusUploadClient(config).getMedia(vid)
      const result = transaction(ctx.db, () => {
        const current = stillCurrent(ctx, req, claim)
        if (!matches(current, media, config)) throw failure(422, 'CLOUD_MEDIA_MISMATCH', '云端视频的任务标记、空间、大小、格式或未发布状态不符合此任务，未通过核验')
        // 候选只是客户端提供的线索；只有已验证归属的VID才占用全局绑定。
        // 错误任务不能通过“提交别人的VID”阻止那个正确任务核验。
        if (ctx.db.prepare('SELECT id FROM cloud_upload_tasks WHERE account_id=? AND claimed_vid=? AND id<>?')
          .get(config.accountId, vid, claim.taskId)) {
          throw failure(409, 'UPLOAD_VID_CLAIMED', '这个视频已经属于另一个任务，不能关联到不同集数')
        }
        // SDK直传的本地文件核验不以TikTok上传状态查询为前置条件。
        // verified只允许导入本地草稿；平台登记仍核对Album/Episode，
        // 正式目录、播放及新购买继续使用catalog-policy的独立审核/上架/授权条件。
        const now = Date.now()
        ctx.db.prepare(`UPDATE cloud_upload_tasks SET status='verified',claimed_vid=?,duration_seconds=?,verified_at=?,lease_id=NULL,lease_until=0,
          error_code=NULL,message=?,updated_at=? WHERE id=?`)
          .run(vid, media.durationSeconds, now,
            'BytePlus文件已核验，可导入本地草稿。TikTok剧集登记、审核、授权和上架仍需完成；本次没有发布或发放权益。',
            now, claim.taskId)
        ctx.audit(claim.ownerId, 'cloud_upload.verified', 'cloud_upload', claim.taskId, {
          dramaId: row.drama_id, seq: row.seq, verificationScope: 'byteplus_file',
        })
        return taskById(ctx, claim.taskId)
      })
      res.json({ task: publicTask(result) })
    } catch (cause) {
      const error = safeError(cause, 'verify')
      saveError(ctx, claim, error, 'verify')
      throw error
    }
  }))
  router.post(`${prefix}/:id/import-episode`, (req, res) => {
    const source = owned(ctx, req), value = body(req.body)
    onlyFields(value, ['version', 'confirmed'])
    if (value.confirmed !== true) throw failure(400, 'CLOUD_IMPORT_CONFIRMATION_REQUIRED', '请确认将此已核验视频导入为本地草稿单集')
    const actor = requestMediaActor(ctx, req, Number(source.drama_id))
    const result = importCloudEpisode(ctx, actor, String(source.id), integer(value.version, 'version', 1))
    res.status(result.created ? 201 : 200).json(result.value)
  })
  router.post(`${prefix}/:id/cancel`, (req, res) => {
    emptyBody(req)
    const row = owned(ctx, req)
    transaction(ctx.db, () => {
      if (row.imported_episode_id != null) {
        throw failure(409, 'CLOUD_EPISODE_ALREADY_IMPORTED', '视频已导入为本地单集，请在剧集管理中处理；取消上传任务不能删除已导入内容')
      }
      if (row.status !== 'cancelled') {
        ctx.db.prepare(`UPDATE cloud_upload_tasks SET status='cancelled',reserved_seq=NULL,lease_id=NULL,lease_until=0,updated_at=?,
          message='任务已取消。已上传云端文件不会被删除，已签发权限会自然过期。' WHERE id=?`).run(Date.now(), String(row.id))
        ctx.audit(String(row.owner_id), 'cloud_upload.cancelled', 'cloud_upload', String(row.id))
      }
    })
    res.json({ task: publicTask(taskById(ctx, String(row.id))) })
  })
}
