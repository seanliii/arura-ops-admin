import { createHash } from 'node:crypto'
import type { Router } from 'express'
import type { AppContext } from './types.js'
import { ApiError } from './types.js'
import { body, id, integer, text } from './validation.js'
import { transaction } from './db.js'
import { bump, dramaDto } from './content.js'
import { publishIssues } from './content-readiness.js'
import { configProblems, contentProblems, scheduledMediaDeliveryAt } from './media-delivery.js'
import { readRegistrationSource } from './media-registration.js'
import { channelLocale, channelRegion } from './catalog-channels.js'
import { readDelivery } from './content-delivery.js'
import { audienceLanguage } from '../shared/content-delivery.js'
import { DELIVERY_STATUS_LABELS, type MediaDeliveryStatus } from '../shared/media-delivery.js'
import type { ContentOperationSummary, ContentReadiness, DeliveryHistoryRow, EpisodeTitleReceipt, PageInfo, ReadinessIssue } from '../shared/content-operations.js'

type Row = Record<string, any>
const terminal = new Set(['complete', 'cancelled'])
function drama(ctx: AppContext, dramaId: number): Row {
  const row = ctx.db.prepare('SELECT * FROM dramas WHERE id=?').get(dramaId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', '作品不存在')
  return row
}
function pageInfo(q: Row, total: number): PageInfo {
  const page = integer(Number(q.page ?? 1), 'page', 1, 1000000)
  const pageSize = integer(Number(q.pageSize ?? 25), 'pageSize', 1, 100)
  return { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) }
}
function slicePage<T>(rows: T[], p: PageInfo) { return rows.slice((p.page - 1) * p.pageSize, p.page * p.pageSize) }
export function scopeRows(ctx: AppContext, q: Row) {
  const region = q.region ? channelRegion(q.region) : '', language = q.language ? channelLocale(q.language) : ''
  const dramaId = q.dramaId ? (typeof q.dramaId === 'number' ? integer(q.dramaId, 'dramaId', 1) : id(q.dramaId)) : null
  const query = q.q == null ? '' : text(q.q, 'q', 200, true).toLocaleLowerCase()
  if (q.status && !['draft','published','archived'].includes(q.status)) throw new ApiError(400, 'INVALID_INPUT', '发布状态不支持')
  return ctx.db.prepare('SELECT * FROM dramas ORDER BY updated_at DESC,id DESC').all().filter(d =>
    (!region || JSON.parse(String(d.regions)).includes(region)) &&
    (!language || audienceLanguage({ language: String(d.language), delivery: readDelivery(d.delivery_profile, String(d.language)) }) === language) &&
    (!dramaId || d.id === dramaId) && (!q.status || d.status === q.status) &&
    (!query || `${d.id} ${d.title} ${d.category} ${String(d.localizations)}`.toLocaleLowerCase().includes(query))) as Row[]
}
export function operationSummary(ctx: AppContext, d: Row): ContentOperationSummary {
  const job = ctx.db.prepare('SELECT id,status,phase FROM media_delivery_jobs WHERE drama_id=? ORDER BY active DESC,created_at DESC,rowid DESC LIMIT 1').get(d.id)
  const pending = ctx.db.prepare(`SELECT action FROM platform_media_operations WHERE drama_id=? AND action<>'sync'
    AND status IN ('unknown','submitting','awaiting_sync') ORDER BY created_at DESC LIMIT 1`).get(d.id)
  const binding = ctx.db.prepare('SELECT review_status FROM platform_media_bindings WHERE drama_id=?').get(d.id)
  const state = pending ? 'needs_attention' : job?.status ? String(job.status) : binding?.review_status === 1 ? 'awaiting_review' : d.status
  const waiting = ['queued','waiting_uploads','registering_videos','registering_drama','syncing','awaiting_review','publishing','retrying'].includes(state)
  const labels: Record<string, string> = { draft:'待整理草稿', archived:'已下架', published:'本应用已上架' }
  const action = state === 'needs_attention' ? { label:'核对原请求',step:'publish' as const }
    : state === 'ready_to_publish' ? { label:'查看结果并确认上架',step:'publish' as const }
    : ['awaiting_review','rejected','paused','retrying'].includes(state) ? { label:'查看审核进度',step:'publish' as const }
    : ['waiting_uploads','registering_videos'].includes(state) ? { label:'继续原上传任务',step:'episodes' as const }
    : { label:d.status === 'published' ? '查看作品' : '补充资料',step:'basic' as const }
  return { dramaId:Number(d.id),status:state,label:DELIVERY_STATUS_LABELS[state as MediaDeliveryStatus] ?? labels[state] ?? '状态待核对',
    needsAction:d.status !== 'published' && !waiting && state !== 'complete',
    hasReview:!!job || !!pending || binding?.review_status != null, nextAction:action,latestJobId:job ? String(job.id) : null }
}
function readiness(ctx: AppContext, d: Row): ContentReadiness {
  const count = Number(ctx.db.prepare('SELECT count(*) n FROM episodes WHERE drama_id=?').get(d.id)!.n)
  const job = ctx.db.prepare('SELECT expected_episodes FROM media_delivery_jobs WHERE drama_id=? AND active=1').get(d.id)
  const expected = Number(job?.expected_episodes ?? count)
  const review: ReadinessIssue[] = []
  const target = (label: string): Pick<ReadinessIssue, 'field'|'step'> => {
    if (label.includes('封面')) return { field:'cover',step:'basic' }
    if (label.includes('音轨')) return { field:'language',step:'basic' }
    if (label.includes('版权') || label.includes('权限')) return { field:'rightsConfirmed',step:'publish' }
    if (label.includes('免费')) return { field:'freeEpisodes',step:'publish' }
    if (label.includes('发行地区')) return { field:'regions',step:'publish' }
    return { field:'registration',step:'publish' }
  }
  for (const label of contentProblems(ctx, d, expected)) review.push({ ...target(label),label,code:'DELIVERY_METADATA_REQUIRED',status:422 })
  if (!count || count !== expected) review.push({field:'episodes',step:'episodes',label:`本批单集未齐：已保存${count}集，需要${expected || '确认本批'}集`,code:'DELIVERY_EPISODES_REQUIRED',status:422})
  try { readRegistrationSource(ctx, Number(d.id)) } catch (error) {
    if (!(error instanceof ApiError)) throw error
    const field = /VIDEO|EPISODES/.test(error.code) ? {field:'episodes',step:'episodes' as const} : target(error.message)
    review.push({...field,label:error.message,code:error.code,status:error.status})
  }
  for (const label of configProblems(ctx)) review.push({field:'platform',step:'publish',label,code:'DELIVERY_UNCONFIGURED',status:503})
  const publish = publishIssues(ctx, d)
  return { draft:{ready:!!d.title,issues:[]},review:{ready:!review.length,issues:review},publish:{ready:!publish.length,issues:publish} }
}
export function deliveryHistory(ctx: AppContext, q: Row = {}, now = Date.now()) {
  const allowed = new Set(scopeRows(ctx, q).map(d=>d.id))
  const rows = ctx.db.prepare(`SELECT j.*,d.title,
    (SELECT min(o.observed_at) FROM media_delivery_observations o WHERE o.job_id=j.id AND o.status='complete') completed_at
    FROM media_delivery_jobs j JOIN dramas d ON d.id=j.drama_id ORDER BY j.created_at DESC,j.id DESC`).all()
    .filter(row=>allowed.has(row.drama_id))
  const pagination = pageInfo(q, rows.length)
  const jobs: DeliveryHistoryRow[] = slicePage(rows, pagination).map(j => {
    const validStart = Number.isSafeInteger(j.created_at) && Number(j.created_at) >= 0
    const validEnd = validStart && j.status === 'complete' && Number.isSafeInteger(j.completed_at) &&
      Number(j.completed_at) >= Number(j.created_at) && Number(j.completed_at) <= now
    return {
      id:String(j.id), dramaId:Number(j.drama_id), title:String(j.title),status:String(j.status),phase:String(j.phase),message:String(j.message),
      expectedEpisodes:Number(j.expected_episodes),autoPublish:!!j.auto_publish,createdAt:Number(j.created_at),updatedAt:Number(j.updated_at),
      completedAt:validEnd ? Number(j.completed_at) : null,
      completedDurationMs:validEnd ? Number(j.completed_at)-Number(j.created_at) : null,
      ongoingAgeMs:!terminal.has(String(j.status)) && validStart && Number(j.created_at) <= now ? now-Number(j.created_at) : null,
      platformVersion:j.platform_version == null ? null : Number(j.platform_version),
      nextRunAt:scheduledMediaDeliveryAt(j),
    }
  })
  return { jobs,pagination,observedAt:now,scope:{region:q.region || null,contentLanguage:q.language || null,dramaId:q.dramaId || null,
    basis:'按当前作品发行地区/实际语言和原交付任务读取，不是观众行为日期、设备或实际观众国家筛选'} }
}
export function readContentOperations(ctx: AppContext, dramaId: number) {
  const d = drama(ctx, dramaId)
  // 不调用 readPlatformMedia：它会使过期请求转态。浏览页面不能驱动平台操作。
  const binding = ctx.db.prepare('SELECT * FROM platform_media_bindings WHERE drama_id=?').get(dramaId) as Row | undefined
  const operations = ctx.db.prepare(`SELECT request_id,action,album_id,client_key,platform_version,local_version,status,acknowledged,review_id,error_code,message,created_at,updated_at
    FROM platform_media_operations WHERE drama_id=? ORDER BY created_at,request_id`).all(dramaId) as Row[]
  const observations = ctx.db.prepare(`SELECT o.request_id,o.platform_version,o.local_version,o.review_status,o.publish_status,o.observed_at,
    p.album_id,p.client_key FROM platform_media_observations o JOIN platform_media_operations p ON p.request_id=o.request_id
    WHERE o.drama_id=? ORDER BY o.observed_at,o.id`).all(dramaId) as Row[]
  const submits = operations.filter(o=>o.action==='submit_review')
  const sameVersion = (a: Row,b: Row) => a.album_id===b.album_id && a.client_key===b.client_key && a.platform_version===b.platform_version
  const rounds = submits.map((op, i) => {
    const next = submits.slice(i+1).find(x=>sameVersion(x,op))
    return { requestId:op.request_id, round:submits.slice(0,i+1).filter(x=>sameVersion(x,op)).length,
      albumId:op.album_id,platformVersion:op.platform_version,localVersion:op.local_version,
      status:op.status,acknowledged:!!op.acknowledged,reviewId:op.review_id,submittedAt:op.created_at,message:op.message,
      observations:observations.filter(o=>sameVersion(o,op) && o.observed_at>=op.created_at &&
        (!next || o.observed_at<next.created_at)) }
  })
  const lastQuery = operations.filter(o=>o.action==='sync').at(-1)
  const uploads = ctx.db.prepare(`SELECT u.id,u.seq,u.title,u.status,u.claimed_vid,u.candidate_vid,u.error_code,u.message,
    v.status registration_status,e.id episode_id FROM cloud_upload_tasks u
    LEFT JOIN cloud_video_registrations v ON v.task_id=u.id
    LEFT JOIN cloud_upload_imports imported ON imported.task_id=u.id
    LEFT JOIN episodes e ON e.id=imported.episode_id AND e.drama_id=u.drama_id
    WHERE u.drama_id=? ORDER BY u.seq,u.created_at`).all(dramaId) as Row[]
  const groups: Record<'success'|'failed'|'unknown'|'pending'|'cancelled', Row[]> = {success:[],failed:[],unknown:[],pending:[],cancelled:[]}
  for (const u of uploads) {
    const group = u.status==='cancelled' ? 'cancelled' : u.episode_id ? 'success'
      : u.registration_status==='unknown' || ['awaiting_verification','verifying'].includes(u.status) ? 'unknown'
      : u.registration_status==='failed' || u.error_code ? 'failed' : 'pending'
    groups[group].push({id:u.id,seq:u.seq,title:u.title,status:u.status,registrationStatus:u.registration_status,
      hasKnownVideo:!!(u.claimed_vid || u.candidate_vid),episodeId:u.episode_id ?? null,message:u.message})
  }
  const summary = operationSummary(ctx,d)
  const latestJob = summary.latestJobId ? ctx.db.prepare('SELECT * FROM media_delivery_jobs WHERE id=?').get(summary.latestJobId) as Row : undefined
  return { dramaId,version:d.version,generatedAt:Date.now(),summary,readiness:readiness(ctx,d),
    platform:{ platformVersion:binding?.platform_version ?? null,localVersion:binding?.synced_local_version ?? null,
      reviewStatus:binding?.review_status ?? null,publishStatus:binding?.publish_status ?? null,
      syncedAt:binding?.synced_at ?? null,needsSync:binding?.needs_sync !== 0,
      nextQueryAt:latestJob && ['awaiting_review','syncing','retrying'].includes(latestJob.status) && ['review','listing'].includes(latestJob.phase)
        ? scheduledMediaDeliveryAt(latestJob) : null,
      queryIssue:lastQuery && ['failed','unknown','submitting'].includes(lastQuery.status)
        ? {status:lastQuery.status,at:lastQuery.updated_at,message:lastQuery.message} : null,
      rounds,observations,
      resultReason:'退回具体原因仅显示官方实际返回的信息；未提供时不推断哪一集违规。' },
    delivery:deliveryHistory(ctx,{dramaId,pageSize:100}),uploads:{groups,
      counts:Object.fromEntries(Object.entries(groups).map(([key,items])=>[key,items.length])),
      scope:'本作品保存的原上传任务；历史任务不按时间猜测归属某一批。成功项不重传，有VID或结果未知先查原任务。'} }
}

export function registerContentOperations(router: Router, ctx: AppContext) {
  router.get('/api/admin/content-operations', (req,res) => {
    ctx.requireAdmin(req)
    const q = req.query as Row, view = q.view ?? 'all'
    if (!['all','action','review','published'].includes(view)) throw new ApiError(400,'INVALID_INPUT','内容工作视图不支持')
    const rows = scopeRows(ctx,q), summaries = new Map(rows.map(d=>[d.id,operationSummary(ctx,d)]))
    const counts = { all:rows.length,action:rows.filter(d=>summaries.get(d.id)!.needsAction).length,
      review:rows.filter(d=>summaries.get(d.id)!.hasReview).length,published:rows.filter(d=>d.status==='published').length }
    const filtered = rows.filter(d=>view==='all' || (view==='action' ? summaries.get(d.id)!.needsAction : view==='review' ? summaries.get(d.id)!.hasReview : d.status==='published'))
    const pagination = pageInfo(q,filtered.length), chosen = slicePage(filtered,pagination)
    res.json({dramas:chosen.map(d=>dramaDto(ctx,d,req,true)),operations:Object.fromEntries(chosen.map(d=>[d.id,summaries.get(d.id)])),
      pagination,counts,catalogRegion:ctx.config.catalogRegion ?? 'JP'})
  })
  router.get('/api/admin/dramas/:id', (req,res) => {
    ctx.requireAdmin(req); res.json({drama:dramaDto(ctx,drama(ctx,id(req.params.id)),req,true)})
  })
  router.get('/api/admin/dramas/:id/operations', (req,res) => {
    ctx.requireAdmin(req); res.json(readContentOperations(ctx,id(req.params.id)))
  })
  router.get('/api/admin/delivery-history', (req,res) => {
    ctx.requireAdmin(req); res.json(deliveryHistory(ctx,req.query))
  })
  const titleRoute = '/api/admin/dramas/:id/episode-titles'
  router.get(`${titleRoute}/:requestId`, (req,res) => {
    const actor = ctx.requireAdmin(req)
    const row = ctx.db.prepare('SELECT receipt_json FROM episode_title_batches WHERE owner_id=? AND request_id=? AND drama_id=?')
      .get(actor.id,String(req.params.requestId),id(req.params.id))
    if (!row) throw new ApiError(404,'BATCH_NOT_FOUND','没有找到该原批次；可用同一请求编号重试，不能改用新编号')
    res.json(JSON.parse(String(row.receipt_json)))
  })
  router.post(titleRoute,(req,res)=>{
    const actor = ctx.requireAdmin(req), dramaId = id(req.params.id), input = body(req.body)
    if (Object.keys(input).some(k=>!['requestId','version','confirmed','changes'].includes(k)) || input.confirmed!==true ||
      typeof input.requestId!=='string' || !/^[0-9a-f-]{36}$/.test(input.requestId) || !Array.isArray(input.changes) ||
      input.changes.length<1 || input.changes.length>100) throw new ApiError(400,'INVALID_BATCH','请预览并确认同一作品的1至100条标题修改')
    const version = integer(input.version,'version',1), seen = new Set<number>()
    const changes = input.changes.map((value:unknown)=>{
      const row = body(value), episodeId = integer(row.episodeId,'episodeId',1)
      if (seen.has(episodeId) || Object.keys(row).some(k=>!['episodeId','title'].includes(k)) || typeof row.title!=='string' || row.title.length>1000) {
        throw new ApiError(400,'INVALID_BATCH','每集只能选择一次，且只能修改标题')
      }
      seen.add(episodeId); return {episodeId,title:row.title.trim()}
    })
    const fingerprint = createHash('sha256').update(JSON.stringify({dramaId,version,changes})).digest('hex')
    const receipt = transaction(ctx.db,()=>{
      const old = ctx.db.prepare('SELECT * FROM episode_title_batches WHERE owner_id=? AND request_id=?').get(actor.id,input.requestId as string)
      if(old) {
        if(old.fingerprint!==fingerprint) throw new ApiError(409,'BATCH_REQUEST_CONFLICT','原请求编号属于另一份修改，不能覆盖')
        return JSON.parse(String(old.receipt_json)) as EpisodeTitleReceipt
      }
      const d = drama(ctx,dramaId)
      if(d.status!=='draft') throw new ApiError(409,'DRAFT_REQUIRED','标题批改只用于私有草稿，不自动下架或修改已发布作品')
      if(d.version!==version) throw new ApiError(409,'VERSION_CONFLICT','作品版本已变化，请重新读取后核对差异')
      const rows: EpisodeTitleReceipt['rows'] = changes.map(change=>{
        const e = ctx.db.prepare('SELECT id,seq,title FROM episodes WHERE id=? AND drama_id=?').get(change.episodeId,dramaId)
        const valid = !!e && change.title.length>0 && change.title.length<=200
        return { ...change,seq:e ? Number(e.seq) : null,oldTitle:e ? String(e.title) : null,
          status:!valid?'failed':change.title===e!.title?'unchanged':'saved',
          message:!e?'此集不属于本作品或已被移除':!valid?'标题需为1至200字':change.title===e.title?'未改变':'已保存' }
      })
      const saved = rows.filter(r=>r.status==='saved')
      for(const row of saved) ctx.db.prepare('UPDATE episodes SET title=? WHERE id=? AND drama_id=?').run(row.title,row.episodeId,dramaId)
      if(saved.length) {
        bump(ctx,dramaId)
        if(d.platform_review_status==='approved') ctx.db.prepare("UPDATE dramas SET platform_review_status='needs_sync' WHERE id=?").run(dramaId)
      }
      const result: EpisodeTitleReceipt = { requestId:input.requestId as string,dramaId,beforeVersion:version,
        afterVersion:version+(saved.length?1:0),savedAt:Date.now(),rows,
        counts:{saved:saved.length,failed:rows.filter(r=>r.status==='failed').length,unchanged:rows.filter(r=>r.status==='unchanged').length} }
      ctx.db.prepare('INSERT INTO episode_title_batches(owner_id,request_id,drama_id,fingerprint,receipt_json,created_at) VALUES(?,?,?,?,?,?)')
        .run(actor.id,result.requestId,dramaId,fingerprint,JSON.stringify(result),result.savedAt)
      ctx.audit(actor.id,'episode.titles.batch','drama',String(dramaId),{requestId:result.requestId,beforeVersion:version,afterVersion:result.afterVersion,counts:result.counts})
      return result
    })
    res.json(receipt)
  })
}
