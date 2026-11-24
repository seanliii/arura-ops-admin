import { createHash } from 'node:crypto'
import type { Router, Request } from 'express'
import { ANALYTICS_CLIENT_EVENTS, ANALYTICS_PAGES, ANALYTICS_DEVICE_SYSTEMS, ANALYTICS_NETWORK_TYPES,
  ANALYTICS_NETWORK_QUALITIES, ANALYTICS_NETWORK_SOURCES,
  analyticsEnvironment, type AnalyticsClientEvent, type AnalyticsEventRecord } from '../shared/analytics.js'
import { DRAMA_TEXT_LOCALES } from '../shared/drama-localizations.js'
import { readDelivery } from './content-delivery.js'
import { audienceLanguage } from '../shared/content-delivery.js'
import { publicDramaCondition } from './catalog-policy.js'
import { hasEpisodeAccess } from './commerce.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { analyticsKey, stable } from './analytics-identity.js'
import { drainAnalyticsOutbox } from './analytics-ledger.js'
import { registerAnalyticsOperations } from './analytics-operations.js'
import { observeAnalyticsSupply } from './analytics-supply.js'
import { inspectAnalyticsOrders, registerAnalyticsOrderInspection } from './analytics-order-inspection.js'
import { parseAnalyticsFilters } from './analytics-filters.js'
import { isPlayerDiagnostic } from '../shared/player-diagnostics.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const token = /^[\p{L}\p{N}_.:-]{1,100}$/u
const invalid = () => new ApiError(400, 'INVALID_ANALYTICS_EVENT', '统计事件版本、字段或内容格式不正确')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid() }
function number(value: unknown, max: number, min = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid()
  return value
}
function identifier(value: unknown) { if (typeof value !== 'string' || !uuid.test(value)) throw invalid(); return value }
function validate(input: unknown): AnalyticsClientEvent {
  const e = object(input)
  keys(e, ['id','name','occurredAt','visitId','journeyId','pageId','page','dramaId','episodeId','playbackId','orderId','context','properties'])
  for (const key of ['id','visitId','journeyId','pageId']) identifier(e[key])
  if (!ANALYTICS_CLIENT_EVENTS.includes(e.name as never) || !ANALYTICS_PAGES.includes(e.page as never)) throw invalid()
  number(e.occurredAt, Date.now() + 5 * 60000, Date.now() - 7 * 86400000)
  for (const key of ['dramaId','episodeId']) if (e[key] !== undefined) {
    if (!Number.isSafeInteger(e[key]) || Number(e[key]) < 1) throw invalid()
  }
  if (e.playbackId !== undefined) identifier(e.playbackId)
  if (e.orderId !== undefined) identifier(e.orderId)
  const c = object(e.context ?? {})
  keys(c, ['uiLanguage','contentLanguage','channelLanguage','sectionId','position','channelVersion','contentVersion','buildId','source','deviceOS','playerType','networkType','networkQuality','networkSource','experimentId','variant'])
  for (const key of ['uiLanguage','contentLanguage','channelLanguage']) if (c[key] !== undefined && !DRAMA_TEXT_LOCALES.includes(c[key] as never)) throw invalid()
  for (const key of ['sectionId','buildId','experimentId']) if (c[key] !== undefined && (typeof c[key] !== 'string' || !token.test(c[key] as string))) throw invalid()
  for (const key of ['position','channelVersion','contentVersion']) if (c[key] !== undefined && (!Number.isSafeInteger(c[key]) || Number(c[key]) < 0 || Number(c[key]) > 2147483647)) throw invalid()
  for (const [key, options] of [
    ['source',['catalog','search','history','favorite','direct','next_episode','resume','unknown']],
    ['deviceOS',ANALYTICS_DEVICE_SYSTEMS],
    ['playerType',['local','tiktok']], ['networkType',ANALYTICS_NETWORK_TYPES],
    ['networkQuality',ANALYTICS_NETWORK_QUALITIES], ['networkSource',['browser','unavailable']],
    ['variant',['a','b']],
  ] as const) if (c[key] !== undefined && !(options as readonly unknown[]).includes(c[key])) throw invalid()
  const p = object(e.properties ?? {})
  if (e.name === 'autoplay_change') {
    keys(p, ['autoNext'])
    if (e.page !== 'player' || !e.episodeId || typeof p.autoNext !== 'boolean' || e.orderId !== undefined) throw invalid()
    return e as unknown as AnalyticsClientEvent
  }
  keys(p, ['watchedMs','wallMs','stallMs','watchDeltaMs','wallDeltaMs','stallDeltaMs','durationMs','firstFrameMs','mediaTimeMs','fromMs','toMs','resultCount','queryLength','errorCode','playerDiagnostic','ended','replay','hasFrameSignal','hasRebufferSignal','timingVersion','segments'])
  for (const [key, value] of Object.entries(p)) {
    if (key === 'playerDiagnostic') {
      if (e.name !== 'play_error' || e.page !== 'player' || c.playerType !== 'tiktok' || !isPlayerDiagnostic(value)) throw invalid()
    }
    else if (key === 'errorCode') { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value)) throw invalid() }
    else if (key === 'ended' || key === 'replay' || key === 'hasFrameSignal' || key === 'hasRebufferSignal') { if (typeof value !== 'boolean') throw invalid() }
    else if (key === 'timingVersion') { if (value !== 2) throw invalid() }
    else if (key === 'segments') {
      if (!Array.isArray(value) || value.length > 200) throw invalid()
      for (const interval of value) {
        if (!Array.isArray(interval) || interval.length !== 2 || number(interval[0], 86400000) > number(interval[1], 86400000)) throw invalid()
      }
    } else number(value, key === 'queryLength' ? 200 : key === 'resultCount' ? 100000 : 86400000)
  }
  return e as unknown as AnalyticsClientEvent
}
export function analyticsRecord(ctx: AppContext, req: Request, e: AnalyticsClientEvent, expectedAccount?: string | null): AnalyticsEventRecord {
  const user = ctx.user(req), c = e.context ?? {}, p = e.properties ?? {}, now = Date.now()
  if (ctx.config.mode === 'production' && p.playerDiagnostic) throw invalid()
  const d = e.dramaId ? ctx.db.prepare(`SELECT * FROM dramas WHERE id=? AND ${publicDramaCondition(ctx)}`).get(e.dramaId) : undefined
  if (e.dramaId && !d) throw new ApiError(404, 'NOT_FOUND', '统计内容不可用')
  const episode = e.episodeId ? ctx.db.prepare('SELECT * FROM episodes WHERE id=? AND drama_id=?').get(e.episodeId, e.dramaId ?? 0) : undefined
  if (e.episodeId && !episode) throw new ApiError(404, 'NOT_FOUND', '统计单集不属于该剧')
  const playbackEvents = ['play_request','first_frame','qualified_play','play_segment','play_pause','play_seek','play_end','play_error','stall_start','stall_end','play_after_purchase']
  if (playbackEvents.includes(e.name) && (!episode || !e.playbackId)) throw invalid()
  if (['first_frame','qualified_play','play_segment','play_end','play_after_purchase'].includes(e.name) &&
      !hasEpisodeAccess(ctx, user?.id ?? null, e.episodeId!)) throw new ApiError(403, 'ANALYTICS_PLAY_REJECTED', '不能将无权播放的单集上报为成功播放')
  if (e.orderId && (!user || !ctx.db.prepare('SELECT id FROM orders WHERE id=? AND user_id=?').get(e.orderId, user.id))) {
    throw new ApiError(403, 'ANALYTICS_ORDER_REJECTED', '订单不属于当前账户')
  }
  const delivery = d ? readDelivery(d.delivery_profile, String(d.language)) : undefined
  const media = d ? ctx.db.prepare('SELECT platform_version FROM platform_media_bindings WHERE drama_id=?').get(d.id) : undefined
  const visit = analyticsKey(ctx, 'visit:' + e.visitId)
  const flags: string[] = []
  if (d && c.contentVersion !== undefined && c.contentVersion !== Number(d.version)) flags.push('content_changed_since_render')
  return {
    id: e.id, inputHash: createHash('sha256').update(stable(e)).digest('hex'), name: e.name, source: 'client',
    environment: analyticsEnvironment(ctx.config.mode), occurredAt: e.occurredAt, receivedAt: now,
    visitorKey: visit, accountKey: user && expectedAccount === user.id ? analyticsKey(ctx, 'account:' + user.id) : null,
    journeyKey: analyticsKey(ctx, 'journey:' + e.visitId + ':' + e.journeyId),
    pageKey: analyticsKey(ctx, 'page:' + e.visitId + ':' + e.pageId),
    playbackKey: e.playbackId ? analyticsKey(ctx, 'playback:' + e.visitId + ':' + e.playbackId) : null,
    page: e.page, market: ctx.config.catalogRegion ?? 'JP', country: null,
    uiLanguage: c.uiLanguage ?? null, contentLanguage: d ? audienceLanguage({ language: String(d.language), delivery }) ?? null : c.contentLanguage ?? null,
    channelLanguage: c.channelLanguage ?? null,
    audioLanguage: d ? String(d.language) : null, subtitleLanguage: delivery?.subtitleLanguage ?? null,
    subtitleMode: delivery?.subtitleMode ?? null, dramaId: e.dramaId ?? null, workId: d ? Number(d.work_id ?? d.id) : null,
    episodeId: e.episodeId ?? null, mediaVersion: media?.platform_version ? Number(media.platform_version) : null,
    contentVersion: c.contentVersion ?? (d ? Number(d.version) : null), channelVersion: c.channelVersion ?? null,
    sectionId: c.sectionId ?? null, position: c.position ?? null, entrySource: c.source ?? 'unknown',
    deviceOS: c.deviceOS ?? 'other', playerType: c.playerType ?? null, networkType: c.networkType ?? 'unknown',
    networkQuality: c.networkQuality ?? 'unknown', networkSource: c.networkSource ?? 'unrecorded',
    buildId: c.buildId ?? null, orderId: e.orderId ?? null, amount: null, currency: null,
    sample: Boolean(d?.is_sample), experimentId: c.experimentId ?? null, variant: c.variant ?? null,
    qualityFlags: flags, properties: p,
    supplyObservation: observeAnalyticsSupply(ctx, e, d, episode, media?.platform_version ? Number(media.platform_version) : null, now),
  }
}
export function registerAnalytics(router: Router, ctx: AppContext) {
  registerAnalyticsOperations(router,ctx)
  registerAnalyticsOrderInspection(router,ctx)
  router.post('/api/analytics/events', asyncRoute(async (req, res) => {
    if (ctx.user(req)?.role === 'admin') { res.status(202).json({ accepted: 0, duplicates: 0, ignored: 'administrator' }); return }
    if (!ctx.analytics) { res.status(202).json({ accepted: 0, duplicates: 0, ignored: 'disabled' }); return }
    const batch = object(req.body)
    keys(batch, ['version','events','accountId'])
    if (batch.version !== 2 || !Array.isArray(batch.events) || batch.events.length < 1 || batch.events.length > 32) throw invalid()
    if (batch.accountId !== undefined && batch.accountId !== null && (typeof batch.accountId !== 'string' || batch.accountId.length > 128)) throw invalid()
    if (typeof batch.accountId === 'string' && batch.accountId !== ctx.user(req)?.id) {
      throw new ApiError(409, 'ANALYTICS_IDENTITY_CHANGED', '访问账户已变化，旧账户统计未写入新账户')
    }
    const events = batch.events.map(validate).map(e => analyticsRecord(ctx, req, e, batch.accountId as string | null | undefined))
    res.status(202).json(await ctx.analytics.ingest(events))
  }))
  router.get('/api/admin/analytics/status', asyncRoute(async (req, res) => {
    ctx.requireAdmin(req)
    if (!ctx.analytics) { res.json({ available: false, reason: 'disabled', events: null }); return }
    res.json(await ctx.analytics.status())
  }))
  router.post('/api/admin/analytics/refresh', asyncRoute(async (req, res) => {
    ctx.requireAdmin(req)
    if (Object.keys(object(req.body ?? {})).length) throw invalid()
    if (!ctx.analytics) { res.json({ available: false, reason: 'disabled', events: null }); return }
    await drainAnalyticsOutbox(ctx)
    await ctx.analytics.refreshCatalog()
    res.json(await ctx.analytics.status())
  }))
  router.get('/api/admin/analytics/report', asyncRoute(async (req, res) => {
    ctx.requireAdmin(req)
    if (!ctx.analytics) { res.json({ available: false, dataState: 'disabled', reason: '统计功能已停用，不表示没有观看或成交' }); return }
    const filters = parseAnalyticsFilters(req.query, ctx)
    const result = await ctx.analytics.call<Record<string, unknown>>('report', filters)
    // Identity keys are only for the main-thread join; never return them to the browser.
    const observations = result.__orderObservations
    delete result.__orderObservations
    const fulfillment = inspectAnalyticsOrders(ctx, Array.isArray(observations) ? observations : [])
    const content = ctx.db.prepare('SELECT id,title,language,status,regions,version,delivery_profile FROM dramas ORDER BY id').all()
      .map(row => ({ id: row.id, title: row.title, language: row.language, status: row.status, version: row.version,
        regions: JSON.parse(String(row.regions)),
        contentLanguage: audienceLanguage({ language: String(row.language), delivery: readDelivery(row.delivery_profile, String(row.language)) }) ?? null }))
    const jobs = ctx.db.prepare(`SELECT j.id,j.drama_id,j.status,j.phase,j.created_at,j.updated_at,j.auto_publish,j.expected_episodes,
      j.album_id,j.platform_version,j.message,
      (SELECT min(o.created_at) FROM platform_media_operations o WHERE o.drama_id=j.drama_id AND o.action='submit_review'
        AND o.platform_version=j.platform_version AND o.status IN ('succeeded','reconciled')) review_started_at
      FROM media_delivery_jobs j ORDER BY j.updated_at DESC LIMIT 100`).all()
    const status = await ctx.analytics.status()
    const latest = Number(ctx.db.prepare('SELECT coalesce(max(seq),0) n FROM analytics_outbox').get()!.n)
    const pendingHistory=Number(ctx.db.prepare("SELECT count(*) n FROM orders o WHERE NOT EXISTS(SELECT 1 FROM analytics_outbox a WHERE a.event_id='order:'||o.id||':order_created')").get()!.n)
    const pendingSince=ctx.db.prepare('SELECT min(created_at) at FROM analytics_outbox WHERE seq>?').get(status.businessCursor)?.at
    if(pendingSince&&Date.now()-Number(pendingSince)>60000&&Array.isArray(result.alerts)){
      result.alerts.push({id:'statistics-outbox-lag',level:'warning',message:'交易事实已有超过一分钟未同步到统计库；原订单与权益不受影响，先核对统计处理状态。'})
    }
    const episodeTitles=ctx.db.prepare('SELECT id,drama_id,seq,title FROM episodes ORDER BY drama_id,seq').all()
    res.json({ ...result, fulfillment, contentTitles: content,episodeTitles, delivery: jobs, pipeline: { ...status, pendingBusinessFacts: Math.max(0,latest-status.businessCursor), pendingHistory },
      currentOrderStates: ctx.db.prepare('SELECT status,currency,provider,count(*) count FROM orders GROUP BY status,currency,provider').all(),
      pendingRefundReviews: Number(ctx.db.prepare("SELECT count(*) n FROM payment_review_deliveries r JOIN orders o ON o.id=r.order_id WHERE o.status<>'refunded'").get()!.n),
      subscriptionLedger: { configured:Boolean(ctx.config.tiktokClientKey && ctx.config.mode!=='local'),
        ...ctx.db.prepare(`SELECT count(*) transactions,coalesce(sum(payment_receipt_id IS NOT NULL),0) confirmed,
          coalesce(sum(refund_receipt_id IS NOT NULL),0) refunded,coalesce(sum(receipt_conflict),0) conflicts
          FROM subscription_transactions WHERE client_key=? AND environment=?`).get(ctx.config.tiktokClientKey??'',ctx.config.mode==='production'?'production':'sandbox') } })
  }))
}
