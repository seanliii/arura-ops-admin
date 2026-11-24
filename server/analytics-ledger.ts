import { createHash } from 'node:crypto'
import type { AnalyticsContext, AnalyticsEventRecord, AnalyticsServerEventName } from '../shared/analytics.js'
import { analyticsEnvironment, ANALYTICS_DEVICE_SYSTEMS, ANALYTICS_NETWORK_TYPES, ANALYTICS_NETWORK_QUALITIES } from '../shared/analytics.js'
import { DRAMA_TEXT_LOCALES } from '../shared/drama-localizations.js'
import { audienceLanguage } from '../shared/content-delivery.js'
import { readDelivery } from './content-delivery.js'
import { analyticsKey, stable } from './analytics-identity.js'
import { ApiError, type AppContext } from './types.js'
import { importSubscriptionAnalyticsPage } from './analytics-subscriptions.js'

type Row = Record<string, any>
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
interface Attribution { visitId: string; journeyId: string; pageId: string; accountId?: string | null; dramaId?: number; context: AnalyticsContext }
function attribution(value: unknown): Attribution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['visitId','journeyId','pageId','accountId','dramaId','context'].includes(key)) ||
      !['visitId','journeyId','pageId'].every(key => typeof raw[key] === 'string' && uuid.test(raw[key] as string))) return null
  if (raw.accountId !== undefined && raw.accountId !== null && (typeof raw.accountId !== 'string' || raw.accountId.length > 128)) return null
  if (raw.dramaId !== undefined && (!Number.isSafeInteger(raw.dramaId) || Number(raw.dramaId) < 1)) return null
  if (raw.context && (typeof raw.context !== 'object' || Array.isArray(raw.context))) return null
  const c = (raw.context ?? {}) as Record<string, unknown>, clean: AnalyticsContext = {}
  const allowed = ['uiLanguage','contentLanguage','channelLanguage','sectionId','position','channelVersion','contentVersion','buildId','source','deviceOS','playerType','networkType','networkQuality','networkSource','experimentId','variant']
  if (Object.keys(c).some(key => !allowed.includes(key))) return null
  for (const key of ['uiLanguage','contentLanguage','channelLanguage'] as const) {
    if (c[key] !== undefined && !DRAMA_TEXT_LOCALES.includes(c[key] as never)) return null
    if (typeof c[key] === 'string') clean[key] = c[key]
  }
  for (const key of ['sectionId','buildId','experimentId'] as const) {
    if (c[key] !== undefined && (typeof c[key] !== 'string' || !/^[\p{L}\p{N}_.:-]{1,100}$/u.test(c[key] as string))) return null
    if (typeof c[key] === 'string') clean[key] = c[key]
  }
  for (const key of ['position','channelVersion','contentVersion'] as const) {
    if (c[key] !== undefined && (!Number.isSafeInteger(c[key]) || Number(c[key]) < 0 || Number(c[key]) > 2147483647)) return null
    if (typeof c[key] === 'number') clean[key] = c[key]
  }
  for (const [key, values] of [
    ['source',['catalog','search','history','favorite','direct','next_episode','resume','unknown']],
    ['deviceOS',ANALYTICS_DEVICE_SYSTEMS], ['playerType',['local','tiktok']],
    ['networkType',ANALYTICS_NETWORK_TYPES], ['networkQuality',ANALYTICS_NETWORK_QUALITIES], ['networkSource',['browser','unavailable']], ['variant',['a','b']],
  ] as const) {
    if (c[key] !== undefined && !(values as readonly unknown[]).includes(c[key])) return null
    if (c[key] !== undefined) (clean as Record<string, unknown>)[key] = c[key]
  }
  return { visitId: raw.visitId as string, journeyId: raw.journeyId as string, pageId: raw.pageId as string,
    accountId: raw.accountId as string | null | undefined, dramaId: raw.dramaId as number | undefined, context: clean }
}
function initial(ctx: AppContext, order: Row, raw: unknown): AnalyticsEventRecord {
  let a = attribution(raw)
  const now = Date.now()
  const d = order.kind === 'episode' ? ctx.db.prepare('SELECT d.* FROM dramas d JOIN episodes e ON e.drama_id=d.id WHERE e.id=?').get(order.target_id)
    : order.kind === 'drama' ? ctx.db.prepare('SELECT * FROM dramas WHERE id=?').get(order.target_id) : undefined
  const delivery = d ? readDelivery(d.delivery_profile, String(d.language)) : undefined
  const media = d ? ctx.db.prepare('SELECT platform_version FROM platform_media_bindings WHERE drama_id=?').get(d.id) : undefined
  if ((a?.accountId && a.accountId !== order.user_id) || (a?.dramaId && a.dramaId !== Number(d?.id))) a = null
  const c = a?.context ?? {}
  return {
    id: '', inputHash: '', name: 'order_created', source: 'server', environment: analyticsEnvironment(ctx.config.mode),
    occurredAt: Number(order.created_at), receivedAt: now,
    visitorKey: analyticsKey(ctx, a ? 'visit:' + a.visitId : 'order-visit:' + order.id),
    accountKey: analyticsKey(ctx, 'account:' + order.user_id),
    journeyKey: analyticsKey(ctx, a ? 'journey:' + a.visitId + ':' + a.journeyId : 'order-journey:' + order.id),
    pageKey: analyticsKey(ctx, a ? 'page:' + a.visitId + ':' + a.pageId : 'order-page:' + order.id),
    playbackKey: null, page: 'checkout', market: ctx.config.catalogRegion ?? 'JP', country: null,
    uiLanguage: c.uiLanguage ?? null, contentLanguage: d ? audienceLanguage({ language: String(d.language), delivery }) : null,
    channelLanguage: c.channelLanguage ?? null,
    audioLanguage: d ? String(d.language) : null, subtitleLanguage: delivery?.subtitleLanguage ?? null,
    subtitleMode: delivery?.subtitleMode ?? null, dramaId: d ? Number(d.id) : null, workId: d ? Number(d.work_id ?? d.id) : null,
    episodeId: order.kind === 'episode' ? Number(order.target_id) : null,
    mediaVersion: media?.platform_version ? Number(media.platform_version) : null,
    contentVersion: c.contentVersion ?? (d ? Number(d.version) : null), channelVersion: c.channelVersion ?? null,
    sectionId: c.sectionId ?? null, position: c.position ?? null, entrySource: c.source ?? 'unknown',
    deviceOS: c.deviceOS ?? 'other', playerType: c.playerType ?? null, networkType: c.networkType ?? 'unknown',
    networkQuality: c.networkQuality ?? 'unknown', networkSource: c.networkSource ?? 'unrecorded',
    buildId: c.buildId ?? null, orderId: String(order.id), amount: Number(order.amount), currency: String(order.currency),
    sample: Boolean(d?.is_sample), experimentId: c.experimentId ?? null, variant: c.variant ?? null,
    qualityFlags: a ? [] : ['attribution_unavailable'], properties: {},
  }
}
/** Only call after the corresponding business state has been written, in its transaction. */
export function recordAnalyticsOrder(ctx: AppContext, order: Row, name: AnalyticsServerEventName, raw?: unknown, occurredAt = Date.now(), flags: string[] = []) {
  if (!ctx.analytics) return
  const key = `order:${order.id}:${name}`
  if (ctx.db.prepare('SELECT 1 FROM analytics_outbox WHERE event_id=?').get(key)) return
  const prior = ctx.db.prepare('SELECT payload FROM analytics_outbox WHERE event_id=?').get(`order:${order.id}:order_created`)
  const base: AnalyticsEventRecord = prior ? JSON.parse(String(prior.payload)) : initial(ctx, order, raw)
  const value = { ...base, id: key, name, occurredAt, receivedAt: Date.now(), qualityFlags:[...new Set([...base.qualityFlags,...flags])] }
  value.inputHash = createHash('sha256').update(stable({ ...value, inputHash: undefined })).digest('hex')
  ctx.db.prepare('INSERT OR IGNORE INTO analytics_outbox(event_id,payload,created_at) VALUES(?,?,?)')
    .run(key, JSON.stringify(value), Date.now())
}
function importLedgerPage(ctx: AppContext) {
  const rows=ctx.db.prepare(`SELECT o.* FROM orders o WHERE NOT EXISTS(
    SELECT 1 FROM analytics_outbox a WHERE a.event_id='order:'||o.id||':order_created')
    ORDER BY o.created_at,o.id LIMIT 25`).all() as Row[]
  if(!rows.length)return
  ctx.db.exec('BEGIN IMMEDIATE')
  try{
    for(const row of rows){
      const flags=['legacy_ledger_import']
      recordAnalyticsOrder(ctx,row,'order_created',undefined,Number(row.created_at),flags)
      const payments=ctx.db.prepare('SELECT event_type,received_at FROM payment_events WHERE order_id=? ORDER BY received_at,id').all(row.id)
      for(const receipt of payments){
        const name=receipt.event_type==='paid'?'payment_confirmed':receipt.event_type==='refunded'?'refund_confirmed':receipt.event_type==='failed'?'order_failed':null
        if(name)recordAnalyticsOrder(ctx,row,name,undefined,Number(receipt.received_at),flags)
      }
      const entitlement=ctx.db.prepare('SELECT starts_at,revoked_at FROM entitlements WHERE order_id=?').get(row.id)
      if(entitlement){
        recordAnalyticsOrder(ctx,row,'entitlement_granted',undefined,Number(entitlement.starts_at),flags)
        if(entitlement.revoked_at!==null)recordAnalyticsOrder(ctx,row,'entitlement_revoked',undefined,Number(entitlement.revoked_at),flags)
      }
      const cancellation=ctx.db.prepare("SELECT min(created_at) at FROM audit_log WHERE action='order.cancelled' AND target_type='order' AND target_id=?").get(row.id)
      if(cancellation?.at)recordAnalyticsOrder(ctx,row,'order_cancelled',undefined,Number(cancellation.at),flags)
    }
    ctx.db.exec('COMMIT')
  }catch(error){ctx.db.exec('ROLLBACK');throw error}
}
const active = new WeakMap<AppContext, Promise<void>>()
export function drainAnalyticsOutbox(ctx: AppContext): Promise<void> {
  if (!ctx.analytics) return Promise.resolve()
  const previous = active.get(ctx)
  if (previous) return previous
  const run = (async () => {
    const status = await ctx.analytics!.status()
    importLedgerPage(ctx)
    importSubscriptionAnalyticsPage(ctx)
    const latest = Number(ctx.db.prepare('SELECT coalesce(max(seq),0) n FROM analytics_outbox').get()!.n)
    if (status.businessCursor > latest) throw new ApiError(409, 'ANALYTICS_CHECKPOINT_AHEAD', '统计快照晚于业务备份；请恢复匹配快照，未改动订单')
    const rows = ctx.db.prepare('SELECT seq,payload FROM analytics_outbox WHERE seq>? ORDER BY seq LIMIT 200').all(status.businessCursor)
    if (!rows.length) return
    await ctx.analytics!.ingest(rows.map(row => JSON.parse(String(row.payload))), Number(rows.at(-1)!.seq))
  })()
  active.set(ctx, run)
  void run.finally(() => { if (active.get(ctx) === run) active.delete(ctx) }).catch(() => {})
  return run
}
export function startAnalyticsPump(ctx: AppContext) {
  let stopped = false, running: Promise<void> | undefined
  let refreshed=0
  const tick = () => {
    if (stopped || running) return
    running = drainAnalyticsOutbox(ctx).then(async()=>{
      if(ctx.analytics && Date.now()-refreshed>=15000){await ctx.analytics.refreshCatalog();refreshed=Date.now()}
    }).catch(() => {
      // Durable facts stay in the business outbox. A statistics outage never replays commerce.
    }).finally(() => { running = undefined })
  }
  const timer = setInterval(tick, 2000); timer.unref(); tick()
  return { async stop() { stopped = true; clearInterval(timer); await running } }
}
