import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Router } from 'express'
import type { MediaRegistrationJob, MediaRegistrationPhase, MediaRegistrationState } from '../shared/media-registration.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { body, id, integer } from './validation.js'
import { transaction } from './db.js'
import { fileReady } from './catalog-policy.js'
import { cloudUploadFingerprint } from './cloud-upload-config.js'
import { getMediaClient, expirePlatformMediaOperations } from './platform-media.js'
import { issueCoverExport } from './media-export.js'
import { MediaClientError, type MediaAlbumQueryResult, type MediaUpdateAlbumInput } from './tiktok-media-client.js'
import { isContentLanguage, type ContentLanguage } from '../shared/content-language.js'
import type { RegistrationMetadata } from '../shared/registration-metadata.js'
import { hasRegistrationMetadata, readRegistrationMetadata, registrationMetadataProblems } from './registration-metadata.js'
import { readDramaLocalizations } from './drama-localizations.js'
import type { DramaLocalizations } from '../shared/drama-localizations.js'
import { assertMediaActor, requestMediaActor, type MediaActor } from './media-actor.js'

type Row = Record<string, unknown>
interface Source {
  localizations?: DramaLocalizations
  registrationMetadata?: RegistrationMetadata
  dramaId: number
  version: number
  language: ContentLanguage
  title: string
  description: string
  coverAssetId: string
  coverSha256: string
  coverBytes: number
  episodes: { localId: number; seq: number; title: string; vid: string }[]
}
interface Snapshot extends Source {
  year: number
  dramaType: 1 | 2 | 3 | 4
  albumStatus: 2 | 3
  tagList: number[]
}
interface EpisodeMap { localId: number; vid: string; platformEpisodeId: string }
interface Lease { id: string; ownerId: string; sessionHash: string; leaseId: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LEASE_MS = 90_000
const message = {
  cover: '正在登记封面；只提供短期封面授权，不公开原片',
  create: '正在创建平台剧目；结果未知时不会重复创建',
  update: '正在向指定平台草稿写入已确认的剧目和单集信息',
  verify: '正在查询核对同一个平台剧目版本',
  done: '平台草稿登记已核对。仍需关联查询、审核、授权和上架；本次没有发布或收款。',
} satisfies Record<MediaRegistrationPhase, string>
const fail = (status: number, code: string, text: string) => new ApiError(status, code, text)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fields(value: Row, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw fail(400, 'REGISTRATION_INVALID_FIELDS', '登记请求包含不支持的字段')
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail(400, 'REGISTRATION_INVALID_ID', '登记请求编号必须为UUID')
  return value.toLowerCase()
}
function platformId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function tags(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 ||
    value.some(tag => !positive(tag) || tag > 2147483647) || new Set(value).size !== value.length) {
    throw fail(400, 'REGISTRATION_TAGS_REQUIRED', '请明确填写1至20个不重复的正整数平台标签ID；不能留空或把示例当作默认分类')
  }
  return [...value].sort((a, b) => a - b)
}
function current(ctx: AppContext, dramaId: number): Row | undefined {
  return ctx.db.prepare("SELECT * FROM media_registration_jobs WHERE drama_id=? AND status<>'superseded'").get(dramaId)
}
function jobRow(ctx: AppContext, jobId: string): Row {
  const row = ctx.db.prepare('SELECT * FROM media_registration_jobs WHERE id=?').get(jobId)
  if (!row) throw fail(404, 'REGISTRATION_NOT_FOUND', '未找到当前登记任务')
  return row
}
function drama(ctx: AppContext, dramaId: number): Row {
  const row = ctx.db.prepare('SELECT * FROM dramas WHERE id=?').get(dramaId)
  if (!row) throw fail(404, 'NOT_FOUND', '目标剧目不存在')
  return row
}
function configHash(ctx: AppContext): string {
  const config = ctx.config
  if (!config.mediaRegistration || !config.byteplusUpload || !config.tiktokClientKey || !config.tiktokClientSecret) {
    throw fail(503, 'REGISTRATION_UNCONFIGURED', '需配置真实视频云、TikTok应用、封面HTTPS来源及日语代码ja')
  }
  return hash([cloudUploadFingerprint(config, config.byteplusUpload), config.mediaRegistration])
}
function recoveryTarget(ctx: AppContext): string {
  if (!ctx.config.byteplusUpload || !ctx.config.tiktokClientKey || !ctx.config.tiktokClientSecret) {
    throw fail(503, 'REGISTRATION_RECOVERY_UNCONFIGURED', '恢复回执需要当前TikTok应用与BytePlus目标配置')
  }
  return cloudUploadFingerprint(ctx.config, ctx.config.byteplusUpload)
}
function recovered(ctx: AppContext, dramaId: number): Row | undefined {
  return ctx.db.prepare('SELECT * FROM media_registration_recoveries WHERE drama_id=?').get(dramaId)
}
function recoveryCoverMatches(value: Row, material: Source): boolean {
  return value.cover_asset_id === material.coverAssetId && value.cover_sha256 === material.coverSha256 &&
    value.cover_bytes === material.coverBytes
}
function source(ctx: AppContext, dramaId: number, inspectRegistered = false): Source {
  expirePlatformMediaOperations(ctx)
  return readRegistrationSource(ctx, dramaId, inspectRegistered)
}
/** 和实际登记共用的只读校验；仅查看准备情况不能把中断请求改成未知。 */
export function readRegistrationSource(ctx: AppContext, dramaId: number, inspectRegistered = false): Source {
  const row = drama(ctx, dramaId)
  if (!inspectRegistered && ctx.db.prepare(`SELECT 1 FROM platform_media_operations WHERE drama_id=?
    AND status IN ('unknown','awaiting_sync','submitting') LIMIT 1`).get(dramaId)) {
    throw fail(409, 'REGISTRATION_MEDIA_PENDING', '已有未核对的媒资查询、审核或上下架操作，请先完成原操作，再更新平台剧目')
  }
  if (row.status !== 'draft') throw fail(409, 'REGISTRATION_DRAFT_REQUIRED', '请先将剧目恢复为草稿，再登记或更新平台内容')
  if (!row.rights_confirmed || row.is_sample) throw fail(422, 'REGISTRATION_RIGHTS_REQUIRED', '平台登记需要版权确认，不能使用样例内容')
  if (!isContentLanguage(row.language) || !JSON.parse(String(row.regions)).includes(ctx.config.catalogRegion ?? 'JP')) {
    throw fail(422, 'REGISTRATION_MARKET', '内容语言须为已确认的视频版本，发行地区须包含当前服务市场；不能靠界面语言改写原声或授权')
  }
  if (!fileReady(ctx, row.cover_asset_id, 'cover')) throw fail(422, 'REGISTRATION_COVER_REQUIRED', '请先上传并保存有效的剧目封面')
  const cover = ctx.db.prepare("SELECT * FROM assets WHERE id=? AND kind='cover'").get(String(row.cover_asset_id))!
  if (Number(cover.bytes) > 5 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(String(cover.sha256))) {
    throw fail(422, 'REGISTRATION_COVER_REQUIRED', '平台登记封面不得超过5MiB，且须具备完整的源文件校验记录')
  }
  const episodes = ctx.db.prepare(`SELECT e.*,t.status AS upload_status,t.claimed_vid,t.candidate_vid,t.verified_at,
    t.config_fingerprint,t.issued_at,v.status AS video_registration_status,v.vid AS registered_vid,v.confirmed_at FROM episodes e
    LEFT JOIN cloud_upload_imports i ON i.episode_id=e.id
    LEFT JOIN cloud_upload_tasks t ON t.id=i.task_id
    LEFT JOIN cloud_video_registrations v ON v.task_id=t.id WHERE e.drama_id=? ORDER BY e.seq`).all(dramaId)
  if (!episodes.length || episodes.some((episode, index) => episode.seq !== index + 1)) {
    throw fail(422, 'REGISTRATION_EPISODES_REQUIRED', '至少需要一集从第1集起连续排列的已核验云视频')
  }
  const fingerprint = ctx.config.byteplusUpload ? cloudUploadFingerprint(ctx.config, ctx.config.byteplusUpload) : ''
  const seen = new Set<string>()
  for (const episode of episodes) {
    const vid = episode.byteplus_vid
    if (episode.upload_status !== 'verified' || !positive(episode.verified_at) || !positive(episode.issued_at) ||
      typeof vid !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(vid) || vid !== episode.claimed_vid ||
      vid !== episode.candidate_vid || episode.config_fingerprint !== fingerprint || seen.has(vid)) {
      throw fail(422, 'REGISTRATION_VIDEO_REQUIRED', '所有单集必须来自当前应用及空间的已核验云上传，不接受手填VID或重复视频')
    }
    if (episode.video_registration_status !== 'registered' || episode.registered_vid !== vid || !positive(episode.confirmed_at)) {
      throw fail(422, 'REGISTRATION_VIDEO_NOT_REGISTERED', '请先在上传素材中完成每个原VID的TikTok视频登记或核对，再登记剧目；无需重复上传')
    }
    seen.add(vid)
  }
  const result: Source = {
    dramaId, version: Number(row.version), language: row.language, title: String(row.title), description: String(row.description),
    coverAssetId: String(cover.id), coverSha256: String(cover.sha256), coverBytes: Number(cover.bytes),
    episodes: episodes.map(episode => ({ localId: Number(episode.id), seq: Number(episode.seq), title: String(episode.title), vid: String(episode.byteplus_vid) })),
    ...(hasRegistrationMetadata(row.registration_metadata) ? { registrationMetadata: readRegistrationMetadata(row.registration_metadata) } : {}),
    ...(Object.keys(readDramaLocalizations(row.localizations)).length ? { localizations: readDramaLocalizations(row.localizations) } : {}),
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 512_000) throw fail(422, 'REGISTRATION_TOO_LARGE', '本次登记信息超过业务服务512KB限制，请联系开发核对集数与文案')
  return result
}
function snapshot(row: Row): Snapshot { return JSON.parse(String(row.snapshot_json)) as Snapshot }
function matchesSourceHash(row: Row, material: Source): boolean {
  if (row.source_hash === hash(material)) return true
  // 旧版只允许日语，源哈希未包含语言。仅在双方仍为ja时兼容旧顺序，不回写或扩大到英语。
  if (material.language !== 'ja' || snapshot(row).language !== 'ja') return false
  const { language: _language, ...legacySource } = material
  return row.source_hash === hash(legacySource)
}
function sameSource(ctx: AppContext, row: Row): boolean {
  try {
    return row.config_fingerprint === configHash(ctx) && matchesSourceHash(row, source(ctx, Number(row.drama_id)))
  } catch { return false }
}
function expire(ctx: AppContext) {
  ctx.db.prepare(`UPDATE media_registration_attempts SET status='unknown',updated_at=? WHERE status='pending'
    AND id IN (SELECT pending_attempt_id FROM media_registration_jobs WHERE status='running' AND lease_until<=?)`)
    .run(Date.now(), Date.now())
  ctx.db.prepare(`UPDATE media_registration_jobs SET
    status=CASE WHEN unresolved_write=1 OR (write_started=1 AND phase<>'verify') THEN 'unknown' ELSE 'failed' END,
    unresolved_write=CASE WHEN unresolved_write=1 OR (write_started=1 AND phase<>'verify') THEN 1 ELSE 0 END,
    error_code='REGISTRATION_INTERRUPTED',message='上次执行已中断，请核对原任务；未知平台写入不能自动重放',
    lease_id=NULL,lease_until=0,updated_at=? WHERE status='running' AND lease_until<=?`).run(Date.now(), Date.now())
}
function dto(row: Row): MediaRegistrationJob {
  const saved = snapshot(row)
  return {
    id: String(row.id), dramaId: Number(row.drama_id), localVersion: Number(row.local_version),
    phase: row.phase as MediaRegistrationJob['phase'], status: row.status as MediaRegistrationJob['status'],
    albumId: row.album_id === null ? null : String(row.album_id),
    platformVersion: row.result_platform_version == null
      ? row.base_platform_version == null ? null : Number(row.base_platform_version) : Number(row.result_platform_version),
    episodeCount: saved.episodes.length, year: saved.year, dramaType: saved.dramaType, albumStatus: saved.albumStatus,
    tagList: [...(saved.tagList ?? [])],
    errorCode: row.error_code === null ? null : String(row.error_code), message: String(row.message),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  }
}
function state(ctx: AppContext, dramaId: number, ownerId: string, requested?: Row): MediaRegistrationState {
  expire(ctx)
  const local = drama(ctx, dramaId), reasons: string[] = []
  let configured = true, ready = true, episodeCount = 0
  try { configHash(ctx) } catch (error) { configured = ready = false; reasons.push((error as Error).message) }
  let material: Source | undefined
  try { material = source(ctx, dramaId); episodeCount = material.episodes.length } catch (error) { ready = false; reasons.push((error as Error).message) }
  if (material?.registrationMetadata) {
    const missing = registrationMetadataProblems(material.registrationMetadata, episodeCount)
    if (missing.length) { ready = false; reasons.push(...missing) }
  }
  const row = requested ?? current(ctx, dramaId)
  const receipt = recovered(ctx, dramaId)
  let recovery: MediaRegistrationState['recovery'] = null, recoveryAvailable = false
  try {
    const target = recoveryTarget(ctx)
    recoveryAvailable = !!material && !row && !receipt &&
      !ctx.db.prepare('SELECT 1 FROM platform_media_bindings WHERE drama_id=?').get(dramaId)
    if (receipt) {
      if (receipt.owner_id !== ownerId) {
        ready = false; reasons.push('已有其他管理员恢复的回执，请由原管理员核对，不能重新建剧')
      } else {
        recovery = {
          albumId: String(receipt.album_id), localVersion: Number(receipt.local_version),
          coverReady: !!material && recoveryCoverMatches(receipt, material), recoveredAt: Number(receipt.recovered_at),
        }
        if (receipt.target_fingerprint !== target) {
          ready = false; reasons.push('恢复的回执属于原应用或云目标，不能迁入当前配置')
        }
      }
    }
  } catch { /* 回执恢复不可用不改变原登记配置错误说明。 */ }
  let job: MediaRegistrationJob | null = null
  if (row) {
    if (row.owner_id !== ownerId) { ready = false; reasons.push('该剧目已有其他管理员的登记任务，请由原操作人核对后继续') }
    else {
      job = dto(row)
      if (!['running', 'unknown', 'superseded'].includes(job.status) && !sameSource(ctx, row)) {
        job = { ...job, status: 'stale', message: '本地内容或目标配置已变化；旧回执保留，请准备新的登记快照' }
      }
      if (['running', 'unknown'].includes(job.status)) { ready = false; reasons.push('已有处理中或结果未知的登记，只能核对原任务，不能重复创建') }
      if (row.phase === 'verify' && row.result_platform_version != null) {
        ready = false
        reasons.push('平台已生成版本，需先查询核对旧版本的单集映射，再准备新的登记')
      }
    }
  }
  return {
    ownerId, dramaId, localVersion: Number(local.version), configured, ready, reasons,
    japaneseLanguageCode: ctx.config.mediaRegistration?.japaneseLanguageCode ?? null, episodeCount, job, recovery, recoveryAvailable,
  }
}
function assertSource(ctx: AppContext, row: Row) {
  if (!sameSource(ctx, row)) throw fail(409, 'REGISTRATION_STALE', '本地内容或目标配置已变化，未使用旧快照继续请求平台')
}
function leaseRow(ctx: AppContext, lease: Lease): Row {
  const row = jobRow(ctx, lease.id)
  if (row.lease_id !== lease.leaseId || row.status !== 'running' || Number(row.lease_until) <= Date.now()) {
    throw fail(409, 'REGISTRATION_LEASE_CHANGED', '原执行租约已结束或被接管，已停止后续请求；收到的有效回执仍保留供核对')
  }
  return row
}
function live(ctx: AppContext, actor: MediaActor, lease: Lease, readOnly = false): Row {
  assertMediaActor(actor, Number(jobRow(ctx, lease.id).drama_id))
  if (actor.id !== lease.ownerId || actor.identity !== lease.sessionHash) {
    throw fail(401, 'ADMIN_SESSION_CHANGED', '管理员登录已变化，停止向上一会话交付结果')
  }
  const row = leaseRow(ctx, lease)
  if (readOnly) {
    if (row.config_fingerprint !== configHash(ctx)) throw fail(409, 'REGISTRATION_STALE', '平台目标配置已改变，不能用当前身份核对旧目标')
  } else assertSource(ctx, row)
  return row
}
function start(ctx: AppContext, actor: MediaActor, row: Row, reconciling: boolean): Lease {
  assertMediaActor(actor, Number(row.drama_id))
  expire(ctx)
  const fresh = jobRow(ctx, String(row.id))
  if (fresh.status === 'superseded' || fresh.status === 'running') throw fail(409, 'REGISTRATION_BUSY', '原登记已被替代或正在执行')
  if (reconciling) {
    if (!fresh.album_id || !['update', 'verify', 'done'].includes(String(fresh.phase))) {
      throw fail(409, 'REGISTRATION_NEEDS_PLATFORM_CHECK', '没有可查询的明确平台剧目，需由平台核对原创建结果，不会盲目重建')
    }
  } else if (fresh.status === 'unknown' || fresh.unresolved_write === 1) throw fail(409, 'REGISTRATION_UNKNOWN', '上次平台写入结果未知，必须先查询或联系平台，不会重发')
  if (reconciling) {
    if (fresh.config_fingerprint !== configHash(ctx)) throw fail(409, 'REGISTRATION_STALE', '请使用原平台目标配置核对旧任务')
  } else assertSource(ctx, fresh)
  const sessionHash = actor.identity
  if (!sessionHash) throw fail(401, 'UNAUTHENTICATED', '请重新登录管理员')
  const lease: Lease = { id: String(row.id), ownerId: String(row.owner_id), sessionHash, leaseId: randomUUID() }
  ctx.db.prepare(`UPDATE media_registration_jobs SET status='running',lease_id=?,lease_until=?,write_started=0,
    error_code=NULL,message=?,updated_at=? WHERE id=?`)
    .run(lease.leaseId, Date.now() + LEASE_MS, reconciling ? '只查询原平台剧目，不重放未知写入' : message[fresh.phase as MediaRegistrationPhase], Date.now(), lease.id)
  return lease
}
function sent(ctx: AppContext, actor: MediaActor, lease: Lease): string {
  return transaction(ctx.db, () => {
    const row = live(ctx, actor, lease), attemptId = randomUUID(), now = Date.now()
    ctx.db.prepare(`INSERT INTO media_registration_attempts(id,job_id,phase,source_hash,status,created_at,updated_at)
      VALUES(?,?,?,?,'pending',?,?)`).run(attemptId, lease.id, String(row.phase), String(row.source_hash), now, now)
    ctx.db.prepare('UPDATE media_registration_jobs SET write_started=1,unresolved_write=1,pending_attempt_id=?,lease_until=?,updated_at=? WHERE id=?')
      .run(attemptId, now + LEASE_MS, now, lease.id)
    return attemptId
  })
}
/** 先持久保存远端回执，再检查原登录。退出不应导致已知album回执丢失后又创建第二个。 */
function advance(ctx: AppContext, lease: Lease, attemptId: string, phase: MediaRegistrationPhase, values: Row = {}) {
  transaction(ctx.db, () => {
    const row = jobRow(ctx, lease.id)
    const attempt = ctx.db.prepare('SELECT * FROM media_registration_attempts WHERE id=? AND job_id=?').get(attemptId, lease.id)
    if (!attempt || row.pending_attempt_id !== attemptId || attempt.source_hash !== row.source_hash ||
      row.status === 'superseded' || attempt.status === 'rejected') {
      throw fail(409, 'REGISTRATION_LEASE_CHANGED', '原请求回执无法匹配当前任务，未推进后续操作')
    }
    // 查询已核实的版本不因旧执行者的迟到ACK而倒退；记录补充回执即可。
    if (attempt.status === 'reconciled') {
      ctx.db.prepare('UPDATE media_registration_attempts SET receipt_json=?,updated_at=? WHERE id=?')
        .run(JSON.stringify({ query: JSON.parse(String(attempt.receipt_json ?? '{}')), lateAcknowledgement: values }), Date.now(), attemptId)
      return
    }
    ctx.db.prepare("UPDATE media_registration_attempts SET status='confirmed',receipt_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(values), Date.now(), attemptId)
    const activeLease = row.lease_id != null && Number(row.lease_until) > Date.now()
    const ownLease = row.lease_id === lease.leaseId && activeLease
    const entries = Object.entries(values)
    ctx.db.prepare(`UPDATE media_registration_jobs SET phase=?,write_started=0,unresolved_write=0,status=?,
      message=?,updated_at=?,lease_until=?
      ${entries.map(([key]) => `,${key}=?`).join('')} WHERE id=?`)
      .run(phase, activeLease ? 'running' : 'failed',
        ownLease ? message[phase] : '已保存原请求的迟到回执。旧执行已停止，请刷新原任务后继续，不必重新创建。',
        Date.now(), ownLease ? Date.now() + LEASE_MS : Number(row.lease_until),
        ...entries.map(([, value]) => value as string | number | null), lease.id)
    ctx.audit(lease.ownerId, 'media.registration.step', 'media_registration', lease.id, { phase })
  })
}
function updateInput(row: Row): MediaUpdateAlbumInput {
  const saved = snapshot(row), mapping = JSON.parse(String(row.episode_map_json)) as EpisodeMap[]
  return {
    albumId: String(row.album_id), operationType: 1,
    // 新建空壳可能还没有版本；不能把SQL NULL转换成0或猜测成1。
    ...(row.base_platform_version === null ? {} : { version: Number(row.base_platform_version) }),
    albumInfo: {
      language: saved.language, title: saved.title, desp: saved.description, seqNum: saved.episodes.length,
      coverList: [String(row.cover_pic_id)], year: saved.year, dramaType: saved.dramaType, albumStatus: saved.albumStatus,
      tagList: saved.tagList,
    },
    episodeInfoList: saved.episodes.map(episode => {
      const known = mapping.find(entry => entry.localId === episode.localId && entry.vid === episode.vid)
      // 官方接口要求每集都有封面；未单独制作单集封面时复用本次已登记的整剧封面。
      return { seq: episode.seq, title: episode.title, byteplusVid: episode.vid,
        coverList: [String(row.cover_pic_id)], ...(known ? { episodeId: known.platformEpisodeId } : {}) }
    }),
  }
}
function matchesMetadata(row: Row, remote: MediaAlbumQueryResult['album_version_list'][number]): boolean {
  const saved = snapshot(row), info = remote.album_info
  if (remote.album_id !== row.album_id || !positive(remote.version) || !info ||
    info.language !== saved.language || info.title !== saved.title || info.desp !== saved.description ||
    info.seq_num !== saved.episodes.length || info.year !== saved.year || info.drama_type !== saved.dramaType || info.album_status !== saved.albumStatus ||
    !Array.isArray(info.cover_list) || info.cover_list.length !== 1 || info.cover_list[0] !== row.cover_pic_id ||
    !Array.isArray(info.tag_list) || !Array.isArray(saved.tagList) ||
    info.tag_list.length !== saved.tagList.length ||
    [...info.tag_list].sort((a, b) => Number(a) - Number(b)).some((tag, i) => tag !== saved.tagList[i])) return false
  return true
}
function matchesRemote(row: Row, remote: MediaAlbumQueryResult['album_version_list'][number]): boolean {
  const saved = snapshot(row)
  if (!matchesMetadata(row, remote) ||
    !Array.isArray(remote.episode_info_list) || remote.episode_info_list.length !== saved.episodes.length) return false
  const seenIds = new Set<string>(), seenSeqs = new Set<number>()
  return remote.episode_info_list.every(episode => {
    const expected = saved.episodes.find(local => local.seq === episode.seq)
    if (!expected || !platformId(episode.episode_id) || seenIds.has(episode.episode_id) || seenSeqs.has(episode.seq) ||
      episode.title !== expected.title || episode.byteplus_vid !== expected.vid) return false
    seenIds.add(episode.episode_id); seenSeqs.add(episode.seq); return true
  })
}
async function queryRegistration(
  ctx: AppContext, actor: MediaActor, lease: Lease, readOnly = false, index?: MediaAlbumQueryResult,
): Promise<MediaAlbumQueryResult> {
  const row = live(ctx, actor, lease, readOnly), client = getMediaClient(ctx)
  if (row.result_platform_version != null) {
    const details = await client.queryAlbum(String(row.album_id), Number(row.result_platform_version))
    live(ctx, actor, lease, readOnly)
    return details
  }
  const result = index ?? await client.queryAlbum(String(row.album_id))
  live(ctx, actor, lease, readOnly)
  const candidates = result.album_version_list.filter(remote => matchesMetadata(row, remote) &&
    (row.base_platform_version == null || remote.version > Number(row.base_platform_version)))
  // 只读取匹配快照的候选版本；不能因索引不含剧集而重发更新，也不穷举大量历史版本。
  if (candidates.length > 20 || new Set(candidates.map(v => v.version)).size !== candidates.length) {
    throw fail(422, 'REGISTRATION_QUERY_MISMATCH', '匹配的版本过多或重复，请核对原操作，不自动选择版本')
  }
  const detailed: MediaAlbumQueryResult['album_version_list'] = []
  for (const candidate of candidates) {
    if (candidate.episode_info_list?.length) { detailed.push(candidate); continue }
    live(ctx, actor, lease, readOnly)
    const detail = await client.queryAlbum(String(row.album_id), candidate.version)
    live(ctx, actor, lease, readOnly)
    if (detail.album_version_list.length !== 1 || detail.album_version_list[0].version !== candidate.version ||
      detail.album_version_list[0].album_id !== row.album_id) {
      throw fail(422, 'REGISTRATION_QUERY_MISMATCH', '指定版本详情不匹配，未采用原索引以外的结果')
    }
    detailed.push(detail.album_version_list[0])
  }
  return { album_version_list: detailed }
}
function confirmRemote(ctx: AppContext, actor: MediaActor, lease: Lease, result: MediaAlbumQueryResult, readOnly = false) {
  transaction(ctx.db, () => {
    const row = live(ctx, actor, lease, readOnly)
    if (!Array.isArray(result.album_version_list)) throw fail(422, 'REGISTRATION_QUERY_MISMATCH', '平台未返回可核对的剧目版本')
    const matches = result.album_version_list.filter(remote => matchesRemote(row, remote) &&
      (row.result_platform_version == null
        ? row.base_platform_version === null || remote.version > Number(row.base_platform_version)
        : remote.version === row.result_platform_version))
    if (matches.length !== 1) throw fail(422, 'REGISTRATION_QUERY_MISMATCH', '没有唯一、完整匹配本次登记的版本，保留原结果继续核对，不猜选版本')
    const selected = matches[0], saved = snapshot(row)
    const mapping: EpisodeMap[] = saved.episodes.map(local => ({
      localId: local.localId, vid: local.vid,
      platformEpisodeId: selected.episode_info_list!.find(episode => episode.seq === local.seq)!.episode_id,
    }))
    ctx.db.prepare(`UPDATE media_registration_jobs SET phase='done',status='registered',result_platform_version=?,
      episode_map_json=?,lease_id=NULL,lease_until=0,write_started=0,unresolved_write=0,error_code=NULL,message=?,updated_at=? WHERE id=?`)
      .run(selected.version, JSON.stringify(mapping), message.done, Date.now(), lease.id)
    if (row.pending_attempt_id && row.unresolved_write === 1) {
      ctx.db.prepare("UPDATE media_registration_attempts SET status='reconciled',receipt_json=?,updated_at=? WHERE id=?")
        .run(JSON.stringify({ albumId: row.album_id, version: selected.version, episodeMap: mapping }), Date.now(), String(row.pending_attempt_id))
    }
    ctx.audit(lease.ownerId, 'media.registration.confirmed', 'media_registration', lease.id, { albumId: row.album_id, platformVersion: selected.version })
  })
}
const rejectedBeforeMutation = new Set(['MEDIA_INVALID_INPUT', 'MEDIA_RUNTIME_UNSUPPORTED', 'MEDIA_TOKEN_UNAVAILABLE', 'MEDIA_REJECTED'])
/** 明确拒绝同样是原写请求的事实；不能因执行租约到期而丢失，也不能用于解除其他请求的未决状态。 */
function rejectedAttempt(ctx: AppContext, lease: Lease, attemptId: string | undefined, cause: unknown) {
  if (!attemptId || !(cause instanceof MediaClientError) || !rejectedBeforeMutation.has(cause.code)) return
  transaction(ctx.db, () => {
    const attempt = ctx.db.prepare('SELECT * FROM media_registration_attempts WHERE id=? AND job_id=?').get(attemptId, lease.id)
    if (!attempt || !['pending', 'unknown'].includes(String(attempt.status))) return
    const now = Date.now()
    ctx.db.prepare("UPDATE media_registration_attempts SET status='rejected',receipt_json=?,updated_at=? WHERE id=?")
      .run(JSON.stringify({ errorCode: cause.code, noMutation: true }), now, attemptId)
    const row = jobRow(ctx, lease.id)
    if (row.pending_attempt_id === attemptId && row.unresolved_write === 1 &&
      row.phase === attempt.phase && !['registered', 'superseded'].includes(String(row.status))) {
      const activeLease = row.lease_id != null && Number(row.lease_until) > now
      ctx.db.prepare(`UPDATE media_registration_jobs SET unresolved_write=0,write_started=0,status=?,
        error_code=?,message=?,updated_at=? WHERE id=?`)
        .run(activeLease ? 'running' : 'failed', cause.code,
          '已保存原请求的明确拒绝，未发生本次写入；旧执行不会继续，可刷新后明确重试原任务', now, lease.id)
    }
  })
}
function failed(ctx: AppContext, lease: Lease, cause: unknown, attemptId?: string): ApiError {
  rejectedAttempt(ctx, lease, attemptId, cause)
  const row = jobRow(ctx, lease.id)
  const local = cause instanceof ApiError ? cause : null
  const unknown = row.unresolved_write === 1 || (row.phase !== 'verify' && row.write_started === 1)
  const error = local ?? (cause instanceof MediaClientError
    ? fail(cause.status, cause.code, cause.message)
    : fail(502, unknown ? 'REGISTRATION_OUTCOME_UNKNOWN' : 'REGISTRATION_FAILED',
      unknown ? '平台写入结果未知，请核对原任务，不要重复创建' : '登记未完成，请核对原任务后继续；未泄露平台响应或密钥'))
  if (row.lease_id === lease.leaseId) {
    if (row.pending_attempt_id && row.write_started === 1) {
      ctx.db.prepare('UPDATE media_registration_attempts SET status=?,updated_at=? WHERE id=? AND status IN (\'pending\',\'unknown\')')
        .run(unknown ? 'unknown' : 'rejected', Date.now(), String(row.pending_attempt_id))
    }
    ctx.db.prepare(`UPDATE media_registration_jobs SET status=?,error_code=?,message=?,lease_id=NULL,lease_until=0,
      unresolved_write=?,updated_at=? WHERE id=? AND lease_id=?`).run(unknown ? 'unknown' : error.code === 'REGISTRATION_STALE' ? 'stale' : 'failed',
      error.code, error.message, Number(unknown), Date.now(), lease.id, lease.leaseId)
  }
  return error
}

export function readMediaRegistration(ctx: AppContext, dramaId: number, ownerId: string): MediaRegistrationState {
  return state(ctx, dramaId, ownerId)
}
/** Workflow-only adoption of an exact previous receipt; observation-only version bumps do not create a new drama. */
export function reusableMediaRegistration(ctx: AppContext, dramaId: number, ownerId: string): string | null {
  const row = current(ctx, dramaId)
  if (!row || row.owner_id !== ownerId || row.status === 'superseded') return null
  try {
    if (row.config_fingerprint !== configHash(ctx)) return null
    // Exact comparison only: an already registered version may have a pending
    // manual review acknowledgement. The workflow adopts it and queries; it does not update it.
    const { version: _now, ...material } = source(ctx, dramaId, row.status === 'registered')
    const { version: _then, year: _year, dramaType: _type, albumStatus: _status, tagList: _tags, ...saved } = snapshot(row)
    return isDeepStrictEqual(material, saved) ? String(row.id) : null
  } catch { return null }
}

export function prepareMediaRegistration(ctx: AppContext, actor: MediaActor, value: Row) {
    const dramaId = actor.dramaId
    assertMediaActor(actor, dramaId)
    fields(value, ['requestId', 'version', 'year', 'dramaType', 'albumStatus', 'tagList', 'confirmed'])
    if (value.confirmed !== true) throw fail(400, 'REGISTRATION_CONFIRMATION_REQUIRED', '请明确确认登记当前剧目和全部单集')
    const key = uuid(value.requestId), version = integer(value.version, 'version', 1), year = integer(value.year, 'year', 1900, 2200)
    const dramaType = integer(value.dramaType, 'dramaType', 1, 4) as Snapshot['dramaType']
    const albumStatus = integer(value.albumStatus, 'albumStatus', 2, 3) as Snapshot['albumStatus']
    const tagList = tags(value.tagList)
    const intentHash = hash([dramaId, version, year, dramaType, albumStatus, tagList])
    // 过期分类属于已观察到的事实，不应随后续输入/互斥校验失败而回滚。
    expirePlatformMediaOperations(ctx)
    expire(ctx)
    let created = false
    const row = transaction(ctx.db, () => {
      expire(ctx)
      const bound = ctx.db.prepare(`SELECT j.*,r.intent_hash AS accepted_intent FROM media_registration_requests r
        JOIN media_registration_jobs j ON j.id=r.job_id WHERE r.owner_id=? AND r.request_key=?`).get(actor.id, key)
      if (bound) {
        if (bound.accepted_intent !== intentHash) throw fail(409, 'REGISTRATION_REQUEST_CONFLICT', '已接受的请求编号不能改写另一份登记意图')
        return bound
      }
      const bindRequest = (jobId: string) => {
        ctx.db.prepare('INSERT INTO media_registration_requests(owner_id,request_key,job_id,intent_hash) VALUES(?,?,?,?)')
          .run(actor.id, key, jobId, intentHash)
      }
      const existing = ctx.db.prepare('SELECT * FROM media_registration_jobs WHERE owner_id=? AND request_key=?').get(actor.id, key)
      if (existing) {
        const saved = snapshot(existing)
        if (existing.drama_id !== dramaId || saved.version !== version || saved.year !== year ||
          saved.dramaType !== dramaType || saved.albumStatus !== albumStatus || JSON.stringify(saved.tagList) !== JSON.stringify(tagList)) {
          throw fail(409, 'REGISTRATION_REQUEST_CONFLICT', '同一登记请求编号不能改成另一份内容')
        }
        bindRequest(String(existing.id))
        return existing
      }
      const fingerprint = configHash(ctx), material = source(ctx, dramaId), previous = current(ctx, dramaId), receipt = recovered(ctx, dramaId)
      if (material.version !== version) throw fail(409, 'VERSION_CONFLICT', '剧目已修改，请刷新后确认本次登记资料')
      if (material.registrationMetadata) {
        const saved = material.registrationMetadata
        const missing = registrationMetadataProblems(saved, material.episodes.length)
        if (missing.length) throw fail(422, 'REGISTRATION_METADATA_INCOMPLETE', missing.join('；'))
        if (saved.year !== year || saved.dramaType !== dramaType || saved.albumStatus !== albumStatus || !isDeepStrictEqual(saved.tagList, tagList)) {
          throw fail(409, 'REGISTRATION_METADATA_MISMATCH', '本次提交与后台已保存的发行资料不同，请先保存并刷新资料，不会提交另一份内容')
        }
      }
      if (previous && (previous.unresolved_write === 1 || ['running', 'unknown'].includes(String(previous.status)) || previous.owner_id !== actor.id)) {
        throw fail(409, 'REGISTRATION_PENDING', '已有未核对的原登记任务，请先由原管理员处理；不能换请求编号重复建剧')
      }
      if (previous?.phase === 'verify' && previous.result_platform_version != null) {
        throw fail(409, 'REGISTRATION_MAPPING_PENDING', '平台已生成版本但单集映射尚未核对。请先仅查询原版本，不能携带空映射再次更新')
      }
      if (receipt && (receipt.owner_id !== actor.id || receipt.target_fingerprint !== recoveryTarget(ctx))) {
        throw fail(409, 'REGISTRATION_RECOVERY_CONFLICT', '已有回执属于另一管理员或原目标，不能创建新剧目绕过')
      }
      const saved: Snapshot = { ...material, year, dramaType, albumStatus, tagList }
      if (previous && matchesSourceHash(previous, material) && previous.config_fingerprint === fingerprint &&
        isDeepStrictEqual(snapshot(previous), saved)) {
        bindRequest(String(previous.id))
        return previous
      }
      const binding = ctx.db.prepare('SELECT * FROM platform_media_bindings WHERE drama_id=?').get(dramaId)
      if (binding?.album_id && previous?.album_id !== binding.album_id) {
        throw fail(409, 'REGISTRATION_EXISTING_ALBUM', '此剧目已关联其他平台Album，请先核对已有媒资，不能另建重复剧目')
      }
      if (previous?.album_id && previous.config_fingerprint !== fingerprint) {
        throw fail(409, 'REGISTRATION_TARGET_CHANGED', '已有平台剧目属于旧应用或云空间配置，不能直接迁入另一目标')
      }
      const useCover = !previous && receipt && recoveryCoverMatches(receipt, material)
      if (previous) ctx.db.prepare("UPDATE media_registration_jobs SET status='superseded' WHERE id=?").run(String(previous.id))
      const jobId = randomUUID(), now = Date.now()
      ctx.db.prepare(`INSERT INTO media_registration_jobs
        (id,drama_id,owner_id,request_key,local_version,source_hash,config_fingerprint,snapshot_json,phase,status,
         album_id,base_platform_version,episode_map_json,message,created_at,updated_at,cover_pic_id)
         VALUES(?,?,?,?,?,?,?,?,?,'ready',?,?,?,?,?,?,?)`)
        .run(jobId, dramaId, actor.id, key, version, hash(material), fingerprint, JSON.stringify(saved),
          useCover ? 'update' : 'cover',
          (previous?.album_id ?? receipt?.album_id ?? null) as string | null, (previous?.result_platform_version ?? previous?.base_platform_version ?? null) as number | null,
          String(previous?.episode_map_json ?? '[]'), '登记快照已保存，尚未向平台发送；执行后仍需审核与上架', now, now,
          useCover ? String(receipt.cover_pic_id) : null)
      ctx.audit(actor.id, 'media.registration.prepared', 'media_registration', jobId, { dramaId, version, episodeCount: saved.episodes.length })
      bindRequest(jobId)
      created = true
      return jobRow(ctx, jobId)
    })
    return { created, value: state(ctx, dramaId, actor.id, row) }
}

export async function runMediaRegistration(ctx: AppContext, actor: MediaActor, jobId: string, reconciling = false): Promise<MediaRegistrationState> {
    assertMediaActor(actor, actor.dramaId)
    expire(ctx)
    const ownedJob = jobRow(ctx, uuid(jobId))
    if (ownedJob.drama_id !== actor.dramaId || ownedJob.owner_id !== actor.id) throw fail(404, 'REGISTRATION_NOT_FOUND', '未找到本次授权的原登记任务')
    if (ownedJob.status === 'registered') return state(ctx, actor.dramaId, actor.id)
    const lease = transaction(ctx.db, () => start(ctx, actor, ownedJob, reconciling))
    if (reconciling) {
      try {
        live(ctx, actor, lease, true)
        const result = await queryRegistration(ctx, actor, lease, true)
        confirmRemote(ctx, actor, lease, result, true)
        return state(ctx, actor.dramaId, actor.id)
      } catch (cause) { throw failed(ctx, lease, cause) }
    }
    let attemptId: string | undefined
    try {
      while (true) {
        const row = live(ctx, actor, lease), saved = snapshot(row)
        if (row.phase === 'cover') {
          const grant = await issueCoverExport(ctx, {
            assetId: saved.coverAssetId, dramaId: saved.dramaId, localVersion: saved.version, ownerId: lease.ownerId,
          }, ctx.config.mediaRegistration!.publicOrigin, actor.kind === 'delivery' ? actor : undefined)
          try {
            const attempt = attemptId = sent(ctx, actor, lease)
            const cover = await getMediaClient(ctx).createImage(grant.url)
            if (typeof cover.openPicId !== 'string' || !cover.openPicId.trim() || cover.openPicId.length > 256) {
              throw fail(502, 'REGISTRATION_COVER_INVALID', '平台封面回执缺少有效ID，请核对原请求')
            }
            advance(ctx, lease, attempt, row.album_id ? 'update' : 'create', { cover_pic_id: cover.openPicId })
            attemptId = undefined
          } finally { grant.revoke() }
        } else if (row.phase === 'create') {
          const attempt = attemptId = sent(ctx, actor, lease)
          const created = await getMediaClient(ctx).createAlbum()
          if (!platformId(created.albumId) || (created.version !== null && !positive(created.version))) {
            throw fail(502, 'REGISTRATION_CREATE_INVALID', '平台建剧回执不完整，请核对原请求')
          }
          advance(ctx, lease, attempt, 'update', { album_id: created.albumId, base_platform_version: created.version })
          attemptId = undefined
        } else if (row.phase === 'update') {
          // 恢复的是空Album：保存回执后可能由外部新增了版本。首次无版本更新前再查，
          // 不能用省略version覆盖他人在等待期间写入的内容。
          const receipt = recovered(ctx, Number(row.drama_id))
          if (receipt?.album_id === row.album_id && row.base_platform_version === null && row.result_platform_version === null) {
            const latest = await getMediaClient(ctx).queryAlbum(String(row.album_id))
            live(ctx, actor, lease)
            if (!Array.isArray(latest.album_version_list) || latest.album_version_list.length) {
              if (Array.isArray(latest.album_version_list) && latest.album_version_list.some(remote => matchesMetadata(row, remote))) {
                const result = await queryRegistration(ctx, actor, lease, false, latest)
                confirmRemote(ctx, actor, lease, result)
                break
              }
              throw fail(409, 'REGISTRATION_RECOVERY_HAS_VERSIONS', '恢复的剧目已有不匹配的平台版本，请核对原资料和单集，不能直接覆盖')
            }
          }
          const attempt = attemptId = sent(ctx, actor, lease)
          const result = await getMediaClient(ctx).updateAlbum(updateInput(row))
          if (result.albumId !== row.album_id || !positive(result.version) ||
            (row.base_platform_version !== null && result.version <= Number(row.base_platform_version))) {
            throw fail(502, 'REGISTRATION_UPDATE_INVALID', '平台未返回本次新增的正确版本，需查询核对，不能重放')
          }
          advance(ctx, lease, attempt, 'verify', { result_platform_version: result.version })
          attemptId = undefined
        } else if (row.phase === 'verify') {
          const result = await queryRegistration(ctx, actor, lease)
          confirmRemote(ctx, actor, lease, result)
          break
        } else throw fail(409, 'REGISTRATION_PHASE_INVALID', '登记已完成或步骤不可执行，请刷新原记录')
      }
      actor.assertCurrent()
      return state(ctx, actor.dramaId, actor.id)
    } catch (cause) { throw failed(ctx, lease, cause, attemptId) }
}

export function registerMediaRegistration(router: Router, ctx: AppContext): void {
  const root = '/api/admin/dramas/:id/platform-registration'
  router.get(root, (req, res) => {
    const actor = ctx.requireAdmin(req)
    res.json(state(ctx, id(req.params.id), actor.id))
  })
  router.post(`${root}/recover-receipts`, asyncRoute(async (req, res) => {
    const actor = ctx.requireAdmin(req), dramaId = id(req.params.id), value = body(req.body)
    fields(value, ['version', 'albumId', 'coverPicId', 'confirmed'])
    if (value.confirmed !== true) throw fail(400, 'REGISTRATION_CONFIRMATION_REQUIRED', '请确认回执来自当前应用及当前封面；此操作只查询并保存，不创建或发布')
    const version = integer(value.version, 'version', 1)
    if (!platformId(value.albumId) || typeof value.coverPicId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.coverPicId)) {
      throw fail(400, 'REGISTRATION_RECOVERY_INVALID', '请提供原始Album ID字符串与封面回执ID，不接受网址或猜测版本号')
    }
    const albumId = value.albumId, coverPicId = value.coverPicId, target = recoveryTarget(ctx)
    const material = source(ctx, dramaId), sourceHash = hash(material)
    if (material.version !== version) throw fail(409, 'VERSION_CONFLICT', '当前资料已变化，请刷新核对回执对应的封面')
    const checkExisting = () => {
      const receipt = recovered(ctx, dramaId)
      if (receipt) {
        if (receipt.owner_id !== actor.id || receipt.album_id !== albumId || receipt.cover_pic_id !== coverPicId ||
          receipt.target_fingerprint !== target) {
          throw fail(409, 'REGISTRATION_RECOVERY_CONFLICT', '已有恢复回执不能被另一管理员、ID或目标覆盖')
        }
        return receipt
      }
      if (current(ctx, dramaId) || ctx.db.prepare('SELECT 1 FROM platform_media_bindings WHERE drama_id=?').get(dramaId)) {
        throw fail(409, 'REGISTRATION_PENDING', '已有登记任务或媒资关联，请核对原记录，不能另行恢复覆盖')
      }
      if (ctx.db.prepare('SELECT 1 FROM media_registration_recoveries WHERE album_id=?').get(albumId) ||
        ctx.db.prepare('SELECT 1 FROM media_registration_jobs WHERE album_id=?').get(albumId) ||
        ctx.db.prepare('SELECT 1 FROM platform_media_bindings WHERE album_id=?').get(albumId)) {
        throw fail(409, 'REGISTRATION_ALBUM_CLAIMED', '此平台剧目已在其他本地记录中使用，不能串联不同剧目')
      }
      return undefined
    }
    if (checkExisting()) { res.json(state(ctx, dramaId, actor.id)); return }
    const sessionHash = ctx.sessionHash(req)
    if (!sessionHash) throw fail(401, 'UNAUTHENTICATED', '请重新登录管理员')
    let result: MediaAlbumQueryResult
    try { result = await getMediaClient(ctx).queryAlbum(albumId) }
    catch (error) {
      throw error instanceof MediaClientError ? fail(error.status, error.code, error.message)
        : fail(502, 'REGISTRATION_RECOVERY_QUERY_FAILED', '无法核对原平台剧目，未保存或重建；请稍后重试查询')
    }
    // 只恢复没有任何版本的已有创建回执。有版本的Album必须完整核对映射，不能当空壳覆盖。
    if (!Array.isArray(result.album_version_list) || result.album_version_list.length !== 0) {
      throw fail(409, 'REGISTRATION_RECOVERY_HAS_VERSIONS', '原平台剧目已有版本，请先核对版本与单集映射；不能作为空剧目恢复')
    }
    transaction(ctx.db, () => {
      const active = ctx.requireAdmin(req)
      if (active.id !== actor.id || ctx.sessionHash(req) !== sessionHash) throw fail(401, 'ADMIN_SESSION_CHANGED', '管理员会话已变化，未保存旧会话回执')
      if (target !== recoveryTarget(ctx) || sourceHash !== hash(source(ctx, dramaId))) {
        throw fail(409, 'REGISTRATION_STALE', '查询期间资料或目标配置改变，未采用旧封面回执')
      }
      if (checkExisting()) return
      ctx.db.prepare(`INSERT INTO media_registration_recoveries
        (drama_id,owner_id,album_id,cover_pic_id,target_fingerprint,local_version,cover_asset_id,cover_sha256,cover_bytes,recovered_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(dramaId, actor.id, albumId, coverPicId, target, version,
          material.coverAssetId, material.coverSha256, material.coverBytes, Date.now())
      ctx.audit(actor.id, 'media.registration.receipts_recovered', 'drama', String(dramaId), { albumId, localVersion: version, emptyVersionsObserved: true })
    })
    res.json(state(ctx, dramaId, actor.id))
  }))
  router.post(root, (req, res) => {
    const actor = requestMediaActor(ctx, req, id(req.params.id))
    const result = prepareMediaRegistration(ctx, actor, body(req.body))
    res.status(result.created ? 201 : 200).json(result.value)
  })
  router.post(`${root}/:jobId/run`, asyncRoute(async (req, res) => {
    const value = body(req.body); fields(value, ['confirmed'])
    if (value.confirmed !== true) throw fail(400, 'REGISTRATION_CONFIRMATION_REQUIRED', '执行将向平台发送封面和剧集信息，请确认')
    const actor = requestMediaActor(ctx, req, id(req.params.id))
    res.json(await runMediaRegistration(ctx, actor, String(req.params.jobId)))
  }))
  router.post(`${root}/:jobId/reconcile`, asyncRoute(async (req, res) => {
    fields(body(req.body ?? {}), [])
    const actor = requestMediaActor(ctx, req, id(req.params.id))
    res.json(await runMediaRegistration(ctx, actor, String(req.params.jobId), true))
  }))
}
