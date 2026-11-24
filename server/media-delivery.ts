import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Router } from 'express'
import type { MediaDeliveryJob, MediaDeliveryState } from '../shared/media-delivery.js'
import { ApiError, type AppContext } from './types.js'
import type { MediaActor } from './media-actor.js'
import { body, id, integer } from './validation.js'
import { transaction } from './db.js'
import { cloudUploadFingerprint } from './cloud-upload-config.js'
import { importCloudEpisode, registerCloudVideo } from './cloud-upload.js'
import { prepareMediaRegistration, runMediaRegistration, reusableMediaRegistration } from './media-registration.js'
import { syncPlatformMedia, writePlatformMedia, type MediaServiceResult } from './platform-media.js'
import { publishCatalogDrama } from './content.js'
import { fileReady, platformMediaReady } from './catalog-policy.js'
import { readRegistrationMetadata, registrationMetadataProblems } from './registration-metadata.js'
import { isContentLanguage } from '../shared/content-language.js'

type Row = Record<string, any>
const terminal = new Set(['complete', 'cancelled'])
const stopped = new Set(['complete', 'cancelled', 'paused', 'needs_input', 'needs_attention', 'rejected', 'ready_to_publish'])
/** 只读排程。过去的安排仍保留，调用方不能把它描述为已经执行或平台承诺时间。 */
export function scheduledMediaDeliveryAt(row: Row | undefined): number | null {
  return row?.active === 1 && !stopped.has(row.status) && Number.isSafeInteger(row.next_run_at) && row.next_run_at > 0
    ? row.next_run_at : null
}
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code: string, message: string, status = 409) => new ApiError(status, code, message)
const rowFor = (ctx: AppContext, jobId: string) => ctx.db.prepare('SELECT * FROM media_delivery_jobs WHERE id=?').get(jobId) as Row | undefined
function drama(ctx: AppContext, dramaId: number): Row {
  const row = ctx.db.prepare('SELECT * FROM dramas WHERE id=?').get(dramaId)
  if (!row) throw fail('NOT_FOUND', '剧目不存在', 404)
  return row
}
function metadata(ctx: AppContext, d: Row) {
  const cover = d.cover_asset_id ? ctx.db.prepare('SELECT id,sha256,bytes,mime FROM assets WHERE id=?').get(d.cover_asset_id) : null
  return {
    title: d.title, description: d.description, category: d.category, language: d.language, regions: d.regions,
    tags: d.tags, cover, rights: d.rights_confirmed, sample: d.is_sample, registration: d.registration_metadata,
    localizations: d.localizations, delivery: d.delivery_profile, free: d.free_episodes,
    episodePrice: d.episode_price, bundlePrice: d.bundle_price,
  }
}
function episodes(ctx: AppContext, dramaId: number): Row[] {
  // Platform IDs and timestamps are observations updated by sync, not changes to the approved source.
  return ctx.db.prepare(`SELECT id,seq,title,duration_seconds,asset_id,subtitle_asset_id,byteplus_vid
    FROM episodes WHERE drama_id=? ORDER BY seq`).all(dramaId).map(row => ({ ...row })) as Row[]
}
function sourceHash(ctx: AppContext, d: Row): string { return sha([metadata(ctx, d), episodes(ctx, d.id)]) }
function targetHash(ctx: AppContext): string {
  const c = ctx.config
  return sha([c.mode, c.tiktokClientKey, c.catalogRegion ?? 'JP', c.byteplusUpload ? cloudUploadFingerprint(c, c.byteplusUpload) : null, c.mediaRegistration])
}
export function configProblems(ctx: AppContext): string[] {
  const c = ctx.config, reasons: string[] = []
  if (c.mode === 'local') reasons.push('当前为内部演练；未配置真实平台，不会向TikTok提审或上架')
  if (!c.tiktokClientKey || !c.tiktokClientSecret) reasons.push('TikTok应用凭据尚未配置')
  if (!c.byteplusUpload || !c.mediaRegistration) reasons.push('视频云或临时封面交付来源尚未配置')
  return reasons
}
export function contentProblems(ctx: AppContext, d: Row, expected: number): string[] {
  const reasons = registrationMetadataProblems(readRegistrationMetadata(d.registration_metadata), expected)
  if (!d.rights_confirmed) reasons.push('请先确认本次内容的版权和发行权限')
  if (d.is_sample) reasons.push('已标记为样例；不能将内部样例自动送审成正式剧目')
  if (!fileReady(ctx, d.cover_asset_id, 'cover')) reasons.push('请先保存有效封面')
  if (!isContentLanguage(d.language)) reasons.push('请确认实际音轨语言')
  if (!JSON.parse(d.regions).includes(ctx.config.catalogRegion ?? 'JP')) reasons.push('发行地区未包含当前服务市场')
  if (d.free_episodes > expected) reasons.push('免费集数超过本批交付集数')
  return reasons
}
function dto(row: Row, ownerId: string): MediaDeliveryJob {
  return {
    id: row.id, dramaId: row.drama_id, expectedEpisodes: row.expected_episodes, autoPublish: !!row.auto_publish,
    status: row.status, phase: row.phase, message: row.message, errorCode: row.error_code,
    albumId: row.album_id, platformVersion: row.platform_version, registrationJobId: row.registration_job_id,
    nextRunAt: row.next_run_at > Date.now() && !stopped.has(row.status) ? row.next_run_at : null,
    canPause: row.active === 1 && !stopped.has(row.status), canResume: row.active === 1 && stopped.has(row.status),
    owner: row.owner_id === ownerId, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}
export function readMediaDelivery(ctx: AppContext, dramaId: number, ownerId: string, requestedJob?: string): MediaDeliveryState {
  const d = drama(ctx, dramaId)
  const current = (requestedJob
    ? ctx.db.prepare('SELECT * FROM media_delivery_jobs WHERE id=? AND drama_id=?').get(requestedJob, dramaId)
    : ctx.db.prepare('SELECT * FROM media_delivery_jobs WHERE drama_id=? ORDER BY active DESC,created_at DESC,rowid DESC LIMIT 1').get(dramaId)) as Row | undefined
  const slots = ctx.db.prepare("SELECT seq FROM cloud_upload_tasks WHERE drama_id=? AND status<>'cancelled'").all(dramaId).map(r => Number(r.seq))
  return { dramaId, localVersion: d.version, configured: !configProblems(ctx).length, reasons: configProblems(ctx),
    uploadedEpisodes: episodes(ctx, dramaId).length, knownUploadSlots: [...new Set(slots)].sort((a, b) => a - b),
    job: current ? dto(current, ownerId) : null }
}

export function registerMediaDelivery(router: Router, ctx: AppContext) {
  const route = '/api/admin/dramas/:id/delivery'
  router.get(route, (req, res) => {
    const actor = ctx.requireAdmin(req)
    res.json(readMediaDelivery(ctx, id(req.params.id), actor.id))
  })
  router.post(route, (req, res) => {
    const actor = ctx.requireAdmin(req), dramaId = id(req.params.id), v = body(req.body)
    if (Object.keys(v).some(k => !['version', 'requestId', 'expectedEpisodes', 'autoPublish', 'confirmed'].includes(k)) ||
      v.confirmed !== true || typeof v.autoPublish !== 'boolean' ||
      typeof v.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(v.requestId)) {
      throw fail('DELIVERY_CONFIRMATION_REQUIRED', '请明确确认本批集数、自动提审及是否自动上架', 400)
    }
    const expected = integer(v.expectedEpisodes, 'expectedEpisodes', 1, 10000), version = integer(v.version, 'version', 1)
    const intent = sha([dramaId, version, expected, v.autoPublish]), now = Date.now()
    let created = false, acceptedId: string | undefined
    transaction(ctx.db, () => {
      const old = ctx.db.prepare('SELECT * FROM media_delivery_jobs WHERE owner_id=? AND request_key=?').get(actor.id, String(v.requestId)) as Row | undefined
      if (old) {
        if (old.intent_hash !== intent) throw fail('DELIVERY_REQUEST_CONFLICT', '该请求编号已经用于另一份交付，不能改写')
        acceptedId = old.id
        return
      }
      const d = drama(ctx, dramaId), reasons = configProblems(ctx)
      if (reasons.length) throw fail('DELIVERY_UNCONFIGURED', reasons.join('；'), 503)
      if (d.version !== version) throw fail('VERSION_CONFLICT', '资料已变化，请刷新后确认')
      if (d.status !== 'draft') throw fail('UNPUBLISH_FIRST', '请先准备要交付的草稿，不自动下架或替换正在播放的作品')
      if (expected < episodes(ctx, dramaId).length) throw fail('DELIVERY_EPISODES_MISMATCH', '本批不能少于已有集数', 400)
      if (ctx.db.prepare('SELECT 1 FROM media_delivery_jobs WHERE drama_id=? AND active=1').get(dramaId)) {
        throw fail('DELIVERY_ALREADY_ACTIVE', '已有交付任务，请查看原任务，不重复开始')
      }
      const jobId = randomUUID()
      ctx.db.prepare(`INSERT INTO media_delivery_jobs(id,drama_id,owner_id,request_key,intent_hash,expected_episodes,
        auto_publish,metadata_hash,target_hash,initial_episodes_json,registration_request_id,message,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(jobId, dramaId, actor.id, String(v.requestId), intent, expected, Number(v.autoPublish),
          sha([targetHash(ctx), metadata(ctx, d)]), targetHash(ctx), JSON.stringify(episodes(ctx, dramaId)), randomUUID(),
          '已保存本批授权。上传完成后由服务器自动继续；不会创建订单或改变定价。', now, now)
      observeTransition(ctx, jobId, undefined, now)
      ctx.audit(actor.id, 'media.delivery.authorized', 'drama', String(dramaId),
        { jobId, expectedEpisodes: expected, autoPublish: v.autoPublish, version })
      created = true
      acceptedId = jobId
    })
    res.status(created ? 202 : 200).json(readMediaDelivery(ctx, dramaId, actor.id, acceptedId))
  })
  router.post(`${route}/:jobId/:action`, (req, res) => {
    const admin = ctx.requireAdmin(req), dramaId = id(req.params.id), v = body(req.body ?? {})
    const action = String(req.params.action), jobId = String(req.params.jobId)
    if (!['pause', 'resume', 'cancel', 'publish'].includes(action)) throw fail('NOT_FOUND', '操作不存在', 404)
    if (Object.keys(v).some(k => !['version', 'confirmed'].includes(k))) throw fail('INVALID_INPUT', '操作包含未知字段', 400)
    transaction(ctx.db, () => {
      const row = rowFor(ctx, jobId)
      if (!row || row.drama_id !== dramaId || row.owner_id !== admin.id) throw fail('NOT_FOUND', '未找到当前管理员的原交付任务', 404)
      if (terminal.has(row.status)) return
      const now = Date.now(), d = drama(ctx, dramaId)
      if (action === 'pause' || action === 'cancel') {
        ctx.db.prepare('UPDATE media_delivery_jobs SET status=?,active=?,message=?,updated_at=? WHERE id=?')
          .run(action === 'pause' ? 'paused' : 'cancelled', action === 'cancel' ? 0 : 1,
            '后续自动操作已停止；已经提交的平台请求无法撤回，已收到回执会保留。', now, jobId)
      } else {
        if (v.confirmed !== true || integer(v.version, 'version', 1) !== d.version) throw fail('VERSION_CONFLICT', '请确认服务器当前资料版本')
        if (row.target_hash !== targetHash(ctx)) throw fail('DELIVERY_TARGET_CHANGED', '原任务对应的应用、市场或云目标已改变，不能用“继续”迁移原授权')
        if (row.lease_id && row.lease_until > now) throw fail('DELIVERY_BUSY', '原步骤仍在结束，请稍后刷新再继续')
        if (action === 'publish' && row.status !== 'ready_to_publish') throw fail('DELIVERY_NOT_READY', '尚未核实审核通过')
        if (action === 'resume' && !stopped.has(row.status)) throw fail('DELIVERY_BUSY', '任务正在推进，不需重复继续')
        const changed = row.metadata_hash !== sha([targetHash(ctx), metadata(ctx, d)]) ||
          (row.source_hash && row.source_hash !== sourceHash(ctx, d))
        if (row.status === 'rejected' && !changed) throw fail('DELIVERY_REVIEW_REJECTED', '请先根据退回原因修改内容，再确认新版本')
        if (changed && d.status !== 'draft') throw fail('UNPUBLISH_FIRST', '当前不是草稿，不能自动替换已发布内容')
        const previousOperation = row.operation_id
          ? ctx.db.prepare('SELECT status,acknowledged,error_code FROM platform_media_operations WHERE request_id=?').get(row.operation_id) as Row | undefined
          : undefined
        const retryRejected = action === 'resume' && previousOperation?.status === 'failed' && previousOperation.acknowledged === 0 &&
          ['MEDIA_INVALID_INPUT', 'MEDIA_RUNTIME_UNSUPPORTED', 'MEDIA_TOKEN_UNAVAILABLE', 'MEDIA_REJECTED'].includes(previousOperation.error_code)
        ctx.db.prepare(`UPDATE media_delivery_jobs SET status='queued',phase=?,auto_publish=?,metadata_hash=?,
          initial_episodes_json=?,source_hash=?,registration_request_id=?,registration_job_id=?,operation_id=?,operation_action=?,
          failure_count=0,error_code=NULL,next_run_at=0,message='已确认继续处理；结果未知的原请求仍先查询，不会重放',updated_at=? WHERE id=?`)
          .run(changed ? 'uploads' : row.phase, action === 'publish' ? 1 : row.auto_publish,
            sha([targetHash(ctx), metadata(ctx, d)]), JSON.stringify(episodes(ctx, dramaId)),
            changed ? null : row.source_hash, changed ? randomUUID() : row.registration_request_id,
            changed ? null : row.registration_job_id, changed || retryRejected ? null : row.operation_id,
            changed || retryRejected ? null : row.operation_action, now, jobId)
      }
      observeTransition(ctx, jobId, row, now)
      ctx.audit(admin.id, `media.delivery.${action}`, 'drama', String(dramaId), { jobId })
    })
    res.json(readMediaDelivery(ctx, dramaId, admin.id))
  })
}

function observeTransition(ctx: AppContext, jobId: string, before: Row | undefined, now: number) {
  const current = rowFor(ctx, jobId)
  if (current && (!before || before.status !== current.status || before.phase !== current.phase)) {
    ctx.db.prepare('INSERT INTO media_delivery_observations(job_id,status,phase,observed_at) VALUES(?,?,?,?)')
      .run(jobId, current.status, current.phase, now)
  }
}
function save(ctx: AppContext, row: Row, values: Row) {
  transaction(ctx.db, () => {
    const now = Date.now(), before = rowFor(ctx, String(row.id))
    const entries = Object.entries({
      ...(values.failure_count === 0 && values.error_code === undefined ? { error_code: null } : {}),
      ...values, updated_at: now,
    })
    ctx.db.prepare(`UPDATE media_delivery_jobs SET ${entries.map(([k]) => `${k}=?`).join(',')} WHERE id=?`)
      .run(...entries.map(([, value]) => value ?? null), row.id)
    observeTransition(ctx, String(row.id), before, now)
  })
}
function workflowActor(ctx: AppContext, initial: Row, leaseId: string): MediaActor {
  return {
    id: initial.owner_id, dramaId: initial.drama_id, identity: `delivery:${initial.id}:${leaseId}`, kind: 'delivery',
    assertCurrent() {
      const row = rowFor(ctx, initial.id), d = drama(ctx, initial.drama_id)
      if (!row || !row.active || stopped.has(row.status) || row.lease_id !== leaseId || row.lease_until <= Date.now()) {
        throw fail('DELIVERY_STOPPED', '任务已暂停、取消或执行权已变化，不再发送后续请求')
      }
      if (!ctx.db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND disabled=0").get(row.owner_id)) {
        throw fail('DELIVERY_OWNER_DISABLED', '原授权管理员已停用，停止自动交付')
      }
      if (row.target_hash !== targetHash(ctx)) throw fail('DELIVERY_TARGET_CHANGED', '原任务的平台目标已变化，不使用新配置继续旧授权')
      if (row.metadata_hash !== sha([targetHash(ctx), metadata(ctx, d)]) ||
        (row.source_hash && row.source_hash !== sourceHash(ctx, d))) {
        throw fail('DELIVERY_SOURCE_CHANGED', '内容或平台目标已改变，请重新确认本次要交付的版本')
      }
      if (!row.source_hash) {
        const current = episodes(ctx, d.id)
        for (const original of JSON.parse(row.initial_episodes_json)) {
          if (!isDeepStrictEqual(current.find(e => e.id === original.id), original)) throw fail('DELIVERY_SOURCE_CHANGED', '本批原有单集已改变，请重新确认')
        }
      }
      // 只在当前执行仍有效且确实推进到检查点时续租；暂停/取消/抢占后不能续租。
      ctx.db.prepare('UPDATE media_delivery_jobs SET lease_until=? WHERE id=? AND lease_id=?')
        .run(Date.now() + 120_000, initial.id, leaseId)
    },
  }
}
function ensureResult(result: MediaServiceResult) {
  if (result.status >= 400 || result.value.error) throw new ApiError(result.status,
    result.value.error?.code ?? 'DELIVERY_PLATFORM_FAILURE', result.value.error?.message ?? '平台操作未确认')
  return result.value
}
async function sync(ctx: AppContext, actor: MediaActor, row: Row, verifyAccess = false) {
  const result = ensureResult(await syncPlatformMedia(ctx, actor, {
    version: drama(ctx, row.drama_id).version, requestId: randomUUID(),
    albumId: row.album_id, platformVersion: row.platform_version, verifyAccess,
  }))
  return result.media!
}
async function write(ctx: AppContext, actor: MediaActor, row: Row, action: string) {
  const requestId = row.operation_id && row.operation_action === action ? row.operation_id : randomUUID()
  const version = row.operation_id && row.operation_action === action ? row.operation_version : drama(ctx, row.drama_id).version
  // Persist the action ID before sending, so a lost process cannot submit it twice.
  save(ctx, row, { operation_id: requestId, operation_action: action, operation_version: version })
  const result = await writePlatformMedia(ctx, actor, {
    requestId, action, version, platformVersion: row.platform_version, confirmed: true,
  })
  const value = ensureResult(result)
  if (value.operation?.status === 'failed') {
    throw fail(value.operation.errorCode ?? 'DELIVERY_PLATFORM_FAILURE',
      value.operation.message || '原平台步骤已明确失败，未当作成功继续', 502)
  }
  // The platform acknowledgement is already recorded. A pause/revocation during
  // that request must stop this workflow rather than overwrite "paused" afterward.
  actor.assertCurrent()
}
async function step(ctx: AppContext, actor: MediaActor, row: Row): Promise<void> {
  actor.assertCurrent()
  const d = drama(ctx, row.drama_id)
  if (row.phase === 'uploads') {
    const problems = contentProblems(ctx, d, row.expected_episodes)
    if (problems.length) { save(ctx, row, { status: 'needs_input', message: problems.join('；'), error_code: 'DELIVERY_METADATA_REQUIRED' }); return }
    const local = episodes(ctx, d.id)
    if (local.length > row.expected_episodes) throw fail('DELIVERY_SOURCE_CHANGED', '实际集数多于本次授权，请重新确认本批范围')
    const tasks = ctx.db.prepare(`SELECT t.*,i.episode_id FROM cloud_upload_tasks t
      LEFT JOIN cloud_upload_imports i ON i.task_id=t.id WHERE t.drama_id=? AND t.status<>'cancelled' ORDER BY t.seq`).all(d.id) as Row[]
    const pending = tasks.find(t => t.seq <= row.expected_episodes && t.episode_id == null)
    if (pending) {
      if (pending.owner_id !== actor.id) throw fail('DELIVERY_OTHER_OWNER', '本批存在其他管理员上传任务，需原管理员核对')
      if (pending.status !== 'verified') {
        save(ctx, row, { status: 'waiting_uploads', message: `正在等待第${pending.seq}集完成云端核验，不会提前提审半批内容。`, next_run_at: Date.now() + 5000 })
        return
      }
      await registerCloudVideo(ctx, actor, pending.id)
      actor.assertCurrent()
      importCloudEpisode(ctx, actor, pending.id, drama(ctx, d.id).version)
      save(ctx, row, { status: 'registering_videos', message: `第${pending.seq}集已登记并导入，继续处理本批。`, next_run_at: 0, failure_count: 0 })
      return
    }
    if (local.length !== row.expected_episodes || local.some((e, i) => e.seq !== i + 1)) {
      save(ctx, row, { status: 'waiting_uploads', message: `已导入${local.length}/${row.expected_episodes}集，等待本批全部上传。`, next_run_at: Date.now() + 5000 })
      return
    }
    for (const episode of local) {
      const t = tasks.find(t => t.episode_id === episode.id)
      if (!t || t.owner_id !== actor.id) throw fail('DELIVERY_CLOUD_SOURCE_REQUIRED', '自动交付仅使用本管理员已核实云上传的单集，不把本地示例或手填VID送审')
      const registered = ctx.db.prepare("SELECT 1 FROM cloud_video_registrations WHERE task_id=? AND status='registered' AND vid=?").get(t.id, episode.byteplus_vid)
      if (!registered) { await registerCloudVideo(ctx, actor, t.id); return }
    }
    save(ctx, row, { source_hash: sourceHash(ctx, d), phase: 'registration', status: 'registering_drama', next_run_at: 0, message: '本批集数完整，正在使用现有资料登记TikTok剧目。' })
    return
  }
  if (row.phase === 'registration') {
    let jobId = row.registration_job_id
    if (!jobId) {
      const existing = reusableMediaRegistration(ctx, row.drama_id, row.owner_id)
      if (existing) jobId = existing
      else {
        const m = readRegistrationMetadata(d.registration_metadata)
        const prepared = prepareMediaRegistration(ctx, actor, {
          requestId: row.registration_request_id, version: d.version, year: m.year,
          dramaType: m.dramaType, albumStatus: m.albumStatus, tagList: m.tagList, confirmed: true,
        })
        jobId = prepared.value.job!.id
      }
      save(ctx, row, { registration_job_id: jobId })
    }
    const raw = ctx.db.prepare('SELECT * FROM media_registration_jobs WHERE id=?').get(jobId) as Row
    if (raw.status !== 'registered') {
      await runMediaRegistration(ctx, actor, jobId, raw.status === 'unknown' || raw.unresolved_write === 1)
    }
    const done = ctx.db.prepare('SELECT * FROM media_registration_jobs WHERE id=?').get(jobId) as Row
    if (done.status !== 'registered' || !done.album_id || !done.result_platform_version) throw fail('DELIVERY_REGISTRATION_PENDING', '剧目登记结果仍待查询核对')
    save(ctx, row, { album_id: done.album_id, platform_version: done.result_platform_version, phase: 'review',
      status: 'syncing', next_run_at: 0, failure_count: 0, message: '剧目和单集已登记，正在核对对应平台版本。' })
    return
  }
  if (row.phase === 'review' || row.phase === 'listing') {
    const media = await sync(ctx, actor, row)
    actor.assertCurrent()
    if ([3, 4, 7].includes(Number(media.reviewStatus))) {
      save(ctx, row, { status: 'rejected', message: 'TikTok未批准本次版本或已撤回。请在下方平台详情核对原因、修改内容后重新确认；不会自动重复提审。', next_run_at: 0 })
      return
    }
    if (media.needsSync) {
      const attempts = row.failure_count + 1
      save(ctx, row, { status: attempts >= 5 ? 'needs_attention' : 'retrying', failure_count: attempts,
        message: attempts >= 5 ? '已多次查询原操作，平台仍未确认结果。保留原请求编号，暂停写入；请核对平台回执后继续。'
          : '已查询原操作，但平台尚未给出一致结果；稍后继续查询，不重复写入。', next_run_at: Date.now() + 30_000 })
      return
    }
    if (media.reviewStatus === 0) {
      await write(ctx, actor, row, 'submit_review')
      save(ctx, row, { status: 'awaiting_review', message: '已提交TikTok审核。可关闭后台；服务器会继续查询，不把受理回执当作通过。', next_run_at: Date.now() + 30_000, failure_count: 0 })
      return
    }
    if (media.reviewStatus === 1 || media.reviewStatus === 5) {
      save(ctx, row, { status: 'awaiting_review', message: 'TikTok审核中。服务器定期查询，不需要重复点击，也不会跳过审核。', next_run_at: Date.now() + 60_000, failure_count: 0 })
      return
    }
    if (![2, 6].includes(Number(media.reviewStatus))) throw fail('DELIVERY_REVIEW_UNCONFIRMED', '未取得可识别的审核结果')
    if (!row.auto_publish) {
      save(ctx, row, { status: 'ready_to_publish', message: '审核已通过。本任务只授权自动提审，尚未上架；可明确确认“上架并发布片库”。', phase: 'listing', next_run_at: 0 })
      return
    }
    save(ctx, row, { phase: 'listing', status: 'publishing', message: '审核已通过，按本批授权设置在线、上架并逐集核验当前App播放许可。' })
    if (media.onlineVersion !== row.platform_version) {
      await write(ctx, actor, row, 'set_online')
    } else if (media.publishStatus !== 1) {
      await write(ctx, actor, row, 'list')
    } else if (media.authorization !== 'authorized') {
      await sync(ctx, actor, row, true)
    } else {
      if (!platformMediaReady(ctx, row.drama_id)) throw fail('DELIVERY_PLAYBACK_NOT_READY', '上架状态已返回，但本地映射或授权证据还未一致')
      actor.assertCurrent()
      const latest = drama(ctx, row.drama_id)
      if (latest.status !== 'published') publishCatalogDrama(ctx, actor.id, row.drama_id, latest.version)
      save(ctx, row, { status: 'complete', active: 0, phase: 'done', message: 'TikTok已确认本版本审核、在线和上架，已发布到本应用片库。真实手机音画与付款仍单独验收。', next_run_at: 0, failure_count: 0 })
      ctx.audit(actor.id, 'media.delivery.complete', 'drama', String(row.drama_id), { jobId: row.id, albumId: row.album_id, platformVersion: row.platform_version })
      return
    }
    save(ctx, row, { next_run_at: 0, failure_count: 0 })
    return
  }
  throw fail('DELIVERY_PHASE_INVALID', '交付步骤不正确，请核对原任务')
}

export async function runMediaDeliveryBatch(ctx: AppContext): Promise<void> {
  if (configProblems(ctx).length) return
  const row: Row | undefined = transaction(ctx.db, () => {
    const due = ctx.db.prepare(`SELECT * FROM media_delivery_jobs WHERE active=1
      AND status NOT IN ('complete','cancelled','paused','needs_input','needs_attention','rejected','ready_to_publish')
      AND next_run_at<=? AND (lease_id IS NULL OR lease_until<=?) ORDER BY next_run_at,created_at LIMIT 1`)
      .get(Date.now(), Date.now()) as Row | undefined
    if (!due) return
    const lease = randomUUID()
    ctx.db.prepare('UPDATE media_delivery_jobs SET lease_id=?,lease_until=? WHERE id=?').run(lease, Date.now() + 120_000, due.id)
    return { ...due, lease_id: lease, lease_until: Date.now() + 120_000 }
  })
  if (!row) return
  const actor = workflowActor(ctx, row, row.lease_id)
  try { await step(ctx, actor, row) }
  catch (cause) {
    const current = rowFor(ctx, row.id)
    if (!current || current.lease_id !== row.lease_id || stopped.has(current.status)) return
    const error = cause instanceof ApiError ? cause : fail('DELIVERY_STEP_FAILED', '当前步骤未完成；保留原记录稍后核对，不输出凭据或原始平台响应', 502)
    const input = ['DELIVERY_SOURCE_CHANGED', 'DELIVERY_TARGET_CHANGED', 'DELIVERY_OWNER_DISABLED', 'DELIVERY_OTHER_OWNER', 'DELIVERY_CLOUD_SOURCE_REQUIRED',
      'REGISTRATION_STALE', 'REGISTRATION_METADATA_INCOMPLETE', 'REGISTRATION_METADATA_MISMATCH', 'UNPUBLISH_FIRST'].includes(error.code)
    const attention = ['REGISTRATION_NEEDS_PLATFORM_CHECK', 'REGISTRATION_UNKNOWN', 'REGISTRATION_EXISTING_ALBUM'].includes(error.code)
    const retries = current.failure_count + 1
    save(ctx, current, { status: input ? 'needs_input' : attention || retries >= 5 ? 'needs_attention' : 'retrying',
      error_code: error.code, message: error.message, failure_count: retries,
      next_run_at: Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(retries, 6)) })
  } finally {
    ctx.db.prepare('UPDATE media_delivery_jobs SET lease_id=NULL,lease_until=0 WHERE id=? AND lease_id=?').run(row.id, row.lease_id)
  }
}
