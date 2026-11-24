import { createHash } from 'node:crypto'
import type { Router } from 'express'
import type { CatalogMetrics } from '../shared/catalog-channel.js'
export { sortCatalog } from '../shared/catalog-channel.js'
import { hasEpisodeAccess } from './commerce.js'
import { publicDramaCondition } from './catalog-policy.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { body, integer } from './validation.js'
import { analyticsRecord } from './analytics.js'
import { drainAnalyticsOutbox } from './analytics-ledger.js'
import { DRAMA_TEXT_LOCALES } from '../shared/drama-localizations.js'

const day = 86_400_000
export const emptyMetrics = (): CatalogMetrics => ({ impressions: 0, plays: 0, engagedVisits: 0, viewers: 0, buyers: 0, playRate: null, paidRate: null })
const legacyCache=new WeakMap<AppContext,Map<string,{at:number;value:Record<string,CatalogMetrics>}>>()
export function cachedCatalogMetrics(ctx:AppContext,region:string,locale?:string):Record<string,CatalogMetrics>{
  const snapshot=ctx.analytics?.catalogSnapshot()
  if(locale)return snapshot?.channelMetrics?.[region]?.[locale]??{}
  if(snapshot?.metrics[region])return snapshot.metrics[region]
  const cached=legacyCache.get(ctx)?.get(region)
  return cached&&Date.now()-cached.at<120000?cached.value:{}
}
export function catalogMetrics(ctx: AppContext, region: string): Record<string, CatalogMetrics> {
  const since = Date.now() - 7 * day
  const result: Record<string, CatalogMetrics> = {}
  const rows = ctx.db.prepare(`SELECT e.drama_id,
    SUM(e.kind='impression') impressions,SUM(e.kind='play') plays,
    COUNT(DISTINCT CASE WHEN e.kind='play' THEN e.user_id END) viewers,
    COUNT(DISTINCT CASE WHEN e.kind='play' AND EXISTS (
      SELECT 1 FROM content_events i WHERE i.visitor_hash=e.visitor_hash AND i.drama_id=e.drama_id
        AND i.kind='impression' AND i.created_at>=? AND i.region=?
    ) THEN e.visitor_hash END) engaged
    FROM content_events e WHERE e.region=? AND e.created_at>=? GROUP BY e.drama_id`).all(since, region, region, since)
  for (const r of rows) {
    const m = result[String(r.drama_id)] = { ...emptyMetrics(), impressions: Number(r.impressions), plays: Number(r.plays),
      engagedVisits: Number(r.engaged), viewers: Number(r.viewers) }
    m.playRate = m.impressions ? m.engagedVisits / m.impressions : null
  }
  // Only actual paid orders, attributed to a logged-in account that played this exact deliverable.
  const buyers = ctx.db.prepare(`SELECT e.drama_id,COUNT(DISTINCT e.user_id) buyers FROM content_events e
    WHERE e.kind='play' AND e.user_id IS NOT NULL AND e.region=? AND e.created_at>=? AND EXISTS (
      SELECT 1 FROM orders o WHERE o.user_id=e.user_id AND o.status='paid' AND o.paid_at>=?
        AND ((o.kind='drama' AND o.target_id=e.drama_id) OR (o.kind='episode' AND o.target_id IN (
          SELECT id FROM episodes WHERE drama_id=e.drama_id)))
    ) GROUP BY e.drama_id`).all(region, since, since)
  for (const r of buyers) if (result[String(r.drama_id)]) result[String(r.drama_id)].buyers = Number(r.buyers)
  for (const m of Object.values(result)) m.paidRate = m.viewers ? m.buyers / m.viewers : null
  let cache=legacyCache.get(ctx);if(!cache){cache=new Map();legacyCache.set(ctx,cache)}
  cache.set(region,{at:Date.now(),value:result})
  return result
}
export function registerCatalogMetrics(router: Router, ctx: AppContext) {
  let lastCleanup = 0
  router.post('/api/catalog/events', asyncRoute(async (req, res) => {
    const user = ctx.user(req)
    if (user?.role === 'admin') { res.status(202).json({ accepted: false }); return }
    const v = body(req.body)
    if (Object.keys(v).some(k => !['eventId', 'visitorId', 'dramaId', 'kind', 'episodeId'].includes(k)) ||
      !['play', 'impression'].includes(String(v.kind)) ||
      ![v.eventId, v.visitorId].every(x => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x))) {
      throw new ApiError(400, 'INVALID_METRIC', '访问记录格式不正确')
    }
    const id = integer(v.dramaId, 'dramaId', 1)
    if (!ctx.db.prepare(`SELECT id FROM dramas WHERE id=? AND ${publicDramaCondition(ctx)}`).get(id)) throw new ApiError(404, 'NOT_FOUND', '内容不可用')
    const episodeId = v.kind === 'play' ? integer(v.episodeId, 'episodeId', 1) : 0
    if (v.kind === 'play' && (!ctx.db.prepare('SELECT id FROM episodes WHERE id=? AND drama_id=?').get(episodeId, id) ||
      !hasEpisodeAccess(ctx, user?.id ?? null, episodeId))) throw new ApiError(403, 'METRIC_PLAY_REJECTED', '不能上报无权播放的内容')
    const now = Date.now(), region = ctx.config.catalogRegion ?? 'JP'
    const visitor = createHash('sha256').update(`${region}:${v.visitorId}`).digest('hex')
    const inserted=ctx.db.prepare(`INSERT OR IGNORE INTO content_events(event_id,visitor_hash,user_id,region,drama_id,episode_id,kind,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(String(v.eventId), visitor, user?.id ?? null, region, id, episodeId, String(v.kind), now)
    if(ctx.analytics&&inserted.changes){
      try{
        const event=analyticsRecord(ctx,req,{id:String(v.eventId),name:v.kind==='play'?'qualified_play':'card_impression',
          occurredAt:now,visitId:String(v.visitorId),journeyId:String(v.visitorId),pageId:String(v.visitorId),
          page:'home',dramaId:id,...(episodeId?{episodeId,playbackId:String(v.visitorId)}:{}),
          properties:v.kind==='play'?{watchedMs:3000}:{},context:{}},user?.id??null)
        event.playbackKey=episodeId?createHash('sha256').update('legacy:'+v.visitorId+':'+episodeId).digest('hex'):null
        event.qualityFlags.push('legacy_threshold_only')
        await ctx.analytics.ingest([event])
        await ctx.analytics.refreshCatalog()
      }catch{/* The old record is durable; a statistics outage cannot break the old viewer. */}
    }
    if (now - lastCleanup > 3_600_000) {
      ctx.db.prepare('DELETE FROM content_events WHERE created_at<?').run(now - 30 * day); lastCleanup = now
    }
    res.status(202).json({ accepted: true })
  }))
  router.get('/api/admin/catalog-metrics/:region', asyncRoute(async(req, res) => {
    ctx.requireAdmin(req)
    if (!/^[A-Z]{2}$/.test(String(req.params.region))) throw new ApiError(400, 'INVALID_CATALOG_REGION', '地区格式错误')
    if(Object.keys(req.query).some(k=>k!=='locale')||(req.query.locale!==undefined&&
      (typeof req.query.locale!=='string'||!DRAMA_TEXT_LOCALES.includes(req.query.locale as never)))){
      throw new ApiError(400,'INVALID_CATALOG_LOCALE','请选择单个受支持的内容频道语言')
    }
    const locale=req.query.locale as string|undefined
    let value:Record<string,CatalogMetrics>|undefined
    if(ctx.analytics){
      await drainAnalyticsOutbox(ctx)
      const snapshot=await ctx.analytics.refreshCatalog(),region=String(req.params.region)
      value=locale?snapshot.channelMetrics[region]?.[locale]??{}:snapshot.metrics[region]
    }
    const selected=value??(locale?{}:catalogMetrics(ctx, String(req.params.region)))
    res.json({ metrics:selected, days:7, channelLanguage:locale??null,
      dataState:locale&&!ctx.analytics?'unavailable':Object.keys(selected).length?'ready':'empty',
      scope:(ctx.config.mode==='local'?'内部演练数据，不代表商业表现':'本应用上报与服务器订单，不是TikTok官方统计')+
        (locale?`；仅 ${req.params.region}/${locale} 内容频道`:'；地区内全部频道汇总'),
      definition:'播放：累计正常前进至少3秒的访问内单集首播；播放率：有曝光访问中的播放访问/曝光访问；付费率：本剧仍为paid买家/已登录播放账号。无分母为暂无数据；同分保留手排。'+
        (locale?' 未记录频道语言的旧数据不归入本频道，也不按界面语言或原声推测。':'') })
  }))
}
