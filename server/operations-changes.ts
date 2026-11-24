import { randomUUID } from 'node:crypto'
import type { Router } from 'express'
import { analyticsEnvironment } from '../shared/analytics.js'
import { DRAMA_TEXT_LOCALES } from '../shared/drama-localizations.js'
import { audienceLanguage } from '../shared/content-delivery.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { publicDramaCondition, fileReady } from './catalog-policy.js'
import { readDelivery } from './content-delivery.js'
import { parseAnalyticsFilters } from './analytics-filters.js'

type Row = Record<string, any>
type Kind = 'drama' | 'catalog'
interface Snapshot { version: number; values: Row; supply: Row[] }
const guards = ['playback_errors','fulfillment_refunds','available_content','data_quality']
const editableText = ['title','desc','category','tags','coverAssetId']
const metricNames = ['viewingVisits','clickRate','continuation','d1']
const DAY = 86400000
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const bad = () => new ApiError(400, 'INVALID_OPERATION_CONTEXT', '改动记录的范围、原因或观察设置不正确')
const conflict = (message: string) => new ApiError(409, 'RESTORE_RECHECK_REQUIRED', message)
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad()
  return value as Row
}
function allowedKeys(value: Row, keys: string[]) { if (Object.keys(value).some(k => !keys.includes(k))) throw bad() }
function target(kind: unknown, key: unknown): { kind: Kind; key: string } {
  if (typeof key !== 'string' || (kind !== 'drama' && kind !== 'catalog')) throw bad()
  if (kind === 'drama' ? !/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(Number(key))
    : !/^[A-Z]{2}\/[^/]+$/.test(key) || !(DRAMA_TEXT_LOCALES as readonly string[]).includes(key.split('/')[1]!)) throw bad()
  return { kind, key }
}
function context(value: unknown, ctx: AppContext): Row {
  const raw = value === undefined ? {} : object(value)
  allowedKeys(raw, ['reason','primaryMetric','observationDays','evidence','restoredFrom'])
  const reason = raw.reason ?? '', primaryMetric = raw.primaryMetric ?? 'viewingVisits'
  const days = raw.observationDays ?? 7
  if (typeof reason !== 'string' || reason.length > 500 || !metricNames.includes(primaryMetric) ||
    !Number.isSafeInteger(days) || days < 1 || days > 30 ||
    (raw.restoredFrom !== undefined && (typeof raw.restoredFrom !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.restoredFrom)))) throw bad()
  let evidence: Row | null = null
  if (raw.evidence != null) {
    const e = object(raw.evidence)
    allowedKeys(e, ['filters','generatedAt','title','dramaId','contentLanguage'])
    if (!Number.isSafeInteger(e.generatedAt) || e.generatedAt < 0 || e.generatedAt > Date.now() + 300000 ||
      !Number.isSafeInteger(e.dramaId) || e.dramaId < 1 || typeof e.title !== 'string' || e.title.length > 200 ||
      typeof e.contentLanguage !== 'string' || (e.contentLanguage && !(DRAMA_TEXT_LOCALES as readonly string[]).includes(e.contentLanguage))) throw bad()
    const filters = object(e.filters), query: Record<string, string> = {}
    if (filters.environment != null && filters.environment !== analyticsEnvironment(ctx.config.mode)) throw bad()
    for (const [key, val] of Object.entries(filters)) {
      if (key === 'environment' || val == null || val === '') continue
      if (!['string','number','boolean'].includes(typeof val)) throw bad()
      query[key] = String(val)
    }
    evidence = { ...e, filters: parseAnalyticsFilters(query, ctx) }
  }
  return { reason: reason.trim(), primaryMetric, observationDays: days, evidence, guardrails: guards,
    ...(raw.restoredFrom ? { restoredFrom: raw.restoredFrom } : {}) }
}
function supply(ctx: AppContext, kind: Kind, key: string, values: Row): Row[] {
  const [region, locale] = key.split('/')
  const scope = { config: { ...ctx.config, ...(kind === 'catalog' ? { catalogRegion: region } : {}) } }
  const rows = ctx.db.prepare(`SELECT d.*,pm.platform_version,pm.synced_local_version,pm.needs_sync,
    pm.review_status AS media_review,pm.publish_status AS media_publish,pm.authorized_client_key,
    CASE WHEN ${publicDramaCondition(scope, 'd')} THEN 1 ELSE 0 END AS publicly_available
    FROM dramas d LEFT JOIN platform_media_bindings pm ON pm.drama_id=d.id ORDER BY d.id`).all() as Row[]
  return rows.filter(d => kind === 'drama' ? d.id === Number(key) : values.configured
    ? values.dramaIds.includes(d.id) : d.publicly_available === 1 && d.rights_confirmed === 1 &&
      JSON.parse(d.regions).includes(region) &&
      audienceLanguage({ language: d.language, delivery: readDelivery(d.delivery_profile, d.language) }) === locale)
    .map(d => ({ id: d.id, version: d.version, status: d.status, rights: d.rights_confirmed === 1,
      language: audienceLanguage({ language: d.language, delivery: readDelivery(d.delivery_profile, d.language) }) ?? null,
      regions: JSON.parse(d.regions), mediaVersion: d.platform_version ?? null,
      mediaSyncedVersion: d.synced_local_version ?? null, needsSync: d.needs_sync ?? null,
      available: d.publicly_available === 1 && d.rights_confirmed === 1,
      episodes: ctx.db.prepare('SELECT id,seq,asset_id,subtitle_asset_id,platform_episode_id,byteplus_vid FROM episodes WHERE drama_id=? ORDER BY seq').all(d.id)
        // IDs describe a supply version, not URLs, credentials or private file paths.
        .map(e => [e.id,e.seq,e.asset_id,e.subtitle_asset_id,e.platform_episode_id,e.byteplus_vid]) }))
}
export function operationsSnapshot(ctx: AppContext, kind: Kind, key: string): Snapshot {
  let version: number, values: Row
  if (kind === 'drama') {
    const d = ctx.db.prepare('SELECT * FROM dramas WHERE id=?').get(Number(key)) as Row | undefined
    if (!d) throw new ApiError(404, 'NOT_FOUND', '作品不存在')
    version = d.version
    values = { title: d.title, desc: d.description, category: d.category, tags: JSON.parse(d.tags),
      coverAssetId: d.cover_asset_id, language: d.language, regions: JSON.parse(d.regions),
      freeEpisodes: d.free_episodes, episodePrice: d.episode_price, bundlePrice: d.bundle_price,
      rightsConfirmed: d.rights_confirmed === 1, isSample: d.is_sample === 1,
      registrationMetadata: JSON.parse(d.registration_metadata), localizations: JSON.parse(d.localizations),
      delivery: JSON.parse(d.delivery_profile), productionSources: JSON.parse(d.production_sources) }
  } else {
    const [region, locale] = key.split('/')
    const c = ctx.db.prepare('SELECT * FROM catalog_channels WHERE region=? AND locale=?').get(region!, locale!) as Row | undefined
    version = c?.version ?? 0
    values = { configured: c?.enabled === 1, fallback: c?.enabled === 1 ? c.fallback : 'strict',
      dramaIds: c?.enabled === 1 ? JSON.parse(c.drama_ids) : [],
      sort: c?.enabled === 1 ? c.sort_mode : 'manual', sections: c?.enabled === 1 ? JSON.parse(c.sections_json) : [] }
  }
  return { version, values, supply: supply(ctx, kind, key, values) }
}
function row(ctx: AppContext, id: string): Row {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw bad()
  const found = ctx.db.prepare('SELECT * FROM operations_changes WHERE id=?').get(id)
  if (!found) throw new ApiError(404, 'CHANGE_NOT_FOUND', '没有找到这次改动')
  return found
}
function dto(r: Row) {
  const before = JSON.parse(r.before_json), after = JSON.parse(r.after_json)
  return { id: r.id, sequence: r.seq, kind: r.kind, key: r.target_key, createdAt: r.created_at,
    beforeVersion: r.before_version, afterVersion: r.after_version, context: JSON.parse(r.context_json),
    changes: Object.keys(after).filter(k => !same(before[k], after[k])).map(field => ({ field, before: before[field], after: after[field] })) }
}
function restore(ctx: AppContext, r: Row) {
  const kind = r.kind as Kind, key = String(r.target_key), current = operationsSnapshot(ctx, kind, key)
  const before = JSON.parse(r.before_json), blockers: string[] = []
  let draft: Row
  if (kind === 'catalog') {
    draft = before
    const [region, locale] = key.split('/')
    const observed = supply(ctx, kind, key, before)
    for (const id of before.configured ? before.dramaIds : observed.map(d => d.id)) {
      const d = observed.find(d => d.id === id)
      if (!d || !d.available || !d.rights || !d.regions.includes(region) ||
        (before.fallback === 'strict' && d.language !== locale)) blockers.push(`作品 #${id} 的当前权利、供给或语言不再满足回退条件`)
    }
  } else {
    const currentRow = ctx.db.prepare('SELECT status,rights_confirmed FROM dramas WHERE id=?').get(Number(key))!
    if (currentRow.rights_confirmed !== 1 || currentRow.status !== 'draft') blockers.push('先核对当前作品权利，并在未上架的可编辑草稿中回退')
    // Only the editorial fields actually touched by that change. Never roll back
    // prices, rights, territory, raw videos, approvals or unrelated newer fields.
    draft = Object.fromEntries(editableText.filter(k => !same(before[k], JSON.parse(r.after_json)[k])).map(k => [k, before[k]]))
    if (!Object.keys(draft).length) blockers.push('这次改动没有可直接回退的普通图文；价格、权利和交付需在原入口核对')
    if (draft.coverAssetId && !fileReady(ctx, draft.coverAssetId, 'cover')) blockers.push('原封面文件当前不可用')
  }
  return { readOnly: true, id: r.id, kind, key, currentVersion: current.version, allowed: !blockers.length,
    draft, blockers, note: '只载入草稿。再次保存才生成新版本，并重新核对当前权限和供给；不会恢复价格、版权声明、原视频或审核结论。' }
}
/** Called inside the original save transaction. Any failed validation rolls back the save and history together. */
export function recordOperationsChange(ctx: AppContext, actorId: string, kind: Kind, key: string, before: Snapshot, input?: unknown) {
  const c = context(input, ctx), after = operationsSnapshot(ctx, kind, key)
  if (c.restoredFrom) {
    const original = row(ctx, c.restoredFrom)
    if (original.kind !== kind || original.target_key !== key) throw conflict('历史改动不属于当前作品或片单')
    const proposal = restore(ctx, original)
    if (!proposal.allowed) throw conflict(proposal.blockers.join('；'))
    if (kind === 'catalog' ? !same(proposal.draft, after.values)
      : Object.keys(after.values).some(k => !same(before.values[k], after.values[k]) && !(k in proposal.draft)) ||
        Object.keys(proposal.draft).some(k => !same(proposal.draft[k], after.values[k]))) {
      throw conflict('回退内容与原记录不一致；请重新载入并核对，不能借回退改变价格或权利')
    }
  }
  if (same(before.values, after.values)) return
  ctx.db.prepare(`INSERT INTO operations_changes
    (id,kind,target_key,actor_id,created_at,before_version,after_version,before_json,after_json,context_json,supply_before,supply_after)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), kind, key, actorId, Date.now(), before.version, after.version,
      JSON.stringify(before.values), JSON.stringify(after.values), JSON.stringify(c), JSON.stringify(before.supply), JSON.stringify(after.supply))
}
function localDay(at: number, timezone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(at).map(p => [p.type, p.value]))
  return `${p.year}-${p.month}-${p.day}`
}
const shift = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10)
function measures(report: Row) {
  const cohorts = report.retention.filter((c: Row) => c.maturity?.d1 === 'mature')
  const size = cohorts.reduce((s: number, c: Row) => s + c.size, 0), count = cohorts.reduce((s: number, c: Row) => s + c.d1, 0)
  return { viewingVisits: report.overview.viewingVisits, qualifiedAttempts: report.timeline.reduce((s: number, d: Row) => s + (d.qualifiedAttempts ?? 0), 0),
    clickRate: report.rates.click, continuation: report.continuation,
    d1: { numerator: count, denominator: size, value: size ? count / size : null },
    exposures: report.overview.exposedVisits,
    playbackErrors: report.quality.errors.reduce((s: number, e: Row) => s + e.count, 0),
    refunds: report.money.map((m: Row) => ({ currency: m.currency, orders: m.refundedOrders, amount: m.refunds })),
    paidOrders: report.overview.paidOrders, resumeObservability: report.rates.resumed,
    dataState: report.dataState, processingBoundary: report.scope.processingBoundary,
    detailIncomplete: report.scope.detailMetricsIncomplete, unavailableFrameSignals: report.quality.firstFrame.unavailableRequests }
}
async function review(ctx: AppContext, r: Row) {
  const c = JSON.parse(r.context_json), evidence = c.evidence?.filters ?? {}
  const scope: Row = { ...evidence, environment: analyticsEnvironment(ctx.config.mode),
    timezone: evidence.timezone ?? 'Asia/Shanghai', includeSamples: evidence.includeSamples ?? ctx.config.mode === 'local' }
  const adjustments: string[] = [], versionField = r.kind === 'catalog' ? 'channelVersion' : 'contentVersion'
  if (r.kind === 'catalog') {
    const [market, channelLanguage] = String(r.target_key).split('/')
    for (const [key, val] of Object.entries({ market, channelLanguage })) {
      if (scope[key] !== val) adjustments.push(`复查${key === 'market' ? '发行市场' : '频道语言'}限定为 ${val}；原分析范围仍保留`)
      scope[key] = val
    }
  } else {
    if (scope.dramaId != null && Number(scope.dramaId) !== Number(r.target_key)) adjustments.push('复查仅限当前作品，原依据未覆盖的范围不混入')
    scope.dramaId = Number(r.target_key)
  }
  const changedDay = localDay(r.created_at, scope.timezone), today = localDay(Date.now(), scope.timezone)
  const windows = { before: { from: shift(changedDay, -c.observationDays), to: shift(changedDay, -1) },
    after: { from: shift(changedDay, 1), to: shift(changedDay, c.observationDays) }, excludedChangeDay: changedDay }
  const versionPair = { field: versionField, before: r.before_version, after: r.after_version }
  const base = { readOnly: true, causal: false, change: dto(r), scope, scopeAdjustments: adjustments, windows, versionPair,
    primaryMetric: c.primaryMetric, interpretation: '等长完整自然日的描述性前后观察，排除修改当天。版本分开统计；没有同期对照试验，不把变化说成由这次改动造成。100曝光/30有效观看只是首版观察门槛，不是统计显著性。' }
  if (!ctx.analytics) return { ...base, status: 'unavailable', reasons: ['统计功能已停用，原保存不受影响'], before: null, after: null }
  const current = operationsSnapshot(ctx, r.kind, r.target_key), reasons: string[] = []
  const expectedSupply = JSON.parse(r.supply_after)
  if (current.version !== r.after_version) reasons.push('对象已存在后续版本，不再是本次改动后的同一条件')
  if (!same(current.supply, expectedSupply)) reasons.push('同期内容或供给条件已变化，不能直接比较或归因')
  const reportFor = async (side: 'before' | 'after') => {
    const period = windows[side]
    return measures(await ctx.analytics!.call<Row>('report', { ...scope, ...period,
      [versionField]: side === 'before' ? r.before_version : r.after_version }))
  }
  const [before, after] = await Promise.all([reportFor('before'), reportFor('after')])
  let status = 'descriptive'
  if (reasons.length) status = 'not_comparable'
  else if (before.detailIncomplete || after.detailIncomplete) { status = 'incomplete'; reasons.push('原始详情已清理或覆盖不完整，不能给出精确变化') }
  else if (windows.after.to >= today) { status = 'observing'; reasons.push('改后观察期尚未结束') }
  else if (!after.processingBoundary || !before.processingBoundary) { status = 'processing_unknown'; reasons.push('处理水位未确认') }
  else if (localDay(after.processingBoundary.clientCompleteBefore, scope.timezone) <= windows.after.to) {
    status = 'late_window'; reasons.push('仍在允许迟到的7天窗口，补报可能改变结果')
  } else if (before.exposures < 100 || after.exposures < 100 || before.viewingVisits < 30 || after.viewingVisits < 30) {
    status = 'small_sample'; reasons.push('曝光或有效观看样本尚不足，只能继续观察')
  } else if (c.primaryMetric === 'continuation' &&
    [before, after].some(m => m.continuation.rate.value == null || m.continuation.observation.status !== 'mature')) {
    status = 'incomplete'; reasons.push('严格接续样本未齐或未成熟，不能判断改善')
  } else if (c.primaryMetric === 'd1' && [before, after].some(m => m.d1.value == null)) {
    status = 'observing'; reasons.push('成熟的D1账户组尚未齐备')
  }
  const guard = (m: Row, rows: Row[]) => ({ playbackErrors: m.playbackErrors, refunds: m.refunds,
    paidOrders: m.paidOrders, resumeObservability: m.resumeObservability,
    financialCoverage: { state: 'attributed_only', excludesUnattributed: true,
      note: '只包含能归属到所选版本及筛选范围的订单事件；未归属记录没有计入，不是全账本无异常的证明。' },
    availableContent: rows.filter(d => d.available).length,
    dataQuality: { state: m.dataState, detailIncomplete: m.detailIncomplete, unavailableFrameSignals: m.unavailableFrameSignals } })
  return { ...base, status, reasons, before, after, guardrails: {
    before: guard(before, JSON.parse(r.supply_before)), after: guard(after, expectedSupply),
    note: '可用内容是保存时点的供给，不是全天历史；未归属的订单未计入，履约与退款需回原订单核对。投放、外部流量及其他未观测因素尚不能排除。' } }
}
export function registerOperationsChanges(router: Router, ctx: AppContext) {
  router.get('/api/admin/operations/changes', (req, res) => {
    ctx.requireAdmin(req)
    allowedKeys(req.query, ['kind','key','before'])
    const t = target(req.query.kind, req.query.key)
    const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before)
    if (!Number.isSafeInteger(before) || before < 1) throw bad()
    const rows = ctx.db.prepare('SELECT * FROM operations_changes WHERE kind=? AND target_key=? AND seq<? ORDER BY seq DESC LIMIT 26')
      .all(t.kind, t.key, before)
    res.json({ changes: rows.slice(0, 25).map(dto), nextCursor: rows.length > 25 ? rows[24]!.seq : null })
  })
  router.get('/api/admin/operations/changes/:id/restore', (req, res) => {
    ctx.requireAdmin(req); allowedKeys(req.query, [])
    res.json(restore(ctx, row(ctx, String(req.params.id))))
  })
  router.get('/api/admin/operations/changes/:id/review', asyncRoute(async (req, res) => {
    ctx.requireAdmin(req); allowedKeys(req.query, [])
    res.json(await review(ctx, row(ctx, String(req.params.id))))
  }))
}
