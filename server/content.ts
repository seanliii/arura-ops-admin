import { createHash, randomBytes } from 'node:crypto'
import type { Router, Request } from 'express'
import type { Drama, Episode, Meta } from '../shared/contracts.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { hasEpisodeAccess } from './commerce.js'
import { body, text, integer, number, boolean, strings, id } from './validation.js'
import { tokenHash, publicUser } from './auth.js'
import { transaction } from './db.js'
import { publicDramaCondition, fileReady, platformMediaReady } from './catalog-policy.js'
import { getMediaClient } from './platform-media.js'
import { MediaClientError } from './tiktok-media-client.js'
import { readSubscriptionAccess, refreshSubscriptionAccess } from './subscription-access.js'
import { mergeRegistrationMetadata, readRegistrationMetadata } from './registration-metadata.js'
import { mergeDramaLocalizations, readDramaLocalizations } from './drama-localizations.js'
import { catalogResult, registerCatalogChannels, channelLocale, channelRegion } from './catalog-channels.js'
import { readDelivery, mergeDelivery, readProductionSources, mergeProductionSources } from './content-delivery.js'
import { audienceLanguage } from '../shared/content-delivery.js'
import { publishIssues } from './content-readiness.js'
import { operationsSnapshot, recordOperationsChange, registerOperationsChanges } from './operations-changes.js'
import { supportsModernMinisPlayback } from './host-version.js'

export { publicDramaCondition } from './catalog-policy.js'

type Row = Record<string, unknown>
/** 仅比较内容/授权证据；不包含播放凭证，不持久化，也不记录日志。 */
function platformPlaybackSnapshot(ctx: AppContext, dramaId: number, episodeId: number): string {
  const row = ctx.db.prepare(`SELECT d.id,d.version,d.status,d.language,d.regions,d.free_episodes,d.rights_confirmed,d.is_sample,
    d.platform_album_id,d.platform_review_status,e.id AS local_episode_id,e.drama_id,e.seq,e.platform_episode_id,e.byteplus_vid,
    pm.client_key,pm.platform_version,pm.current_version,pm.online_version,pm.review_status,pm.publish_status,
    pm.synced_local_version,pm.synced_operation_id,pm.authorized_client_key,pm.needs_sync
    FROM dramas d JOIN episodes e ON e.drama_id=d.id JOIN platform_media_bindings pm ON pm.drama_id=d.id
    WHERE d.id=? AND e.id=?`).get(dramaId, episodeId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', '剧集或平台关联已不存在')
  return JSON.stringify(row)
}
function dramaRow(ctx: AppContext, dramaId: number): Row {
  const row = ctx.db.prepare('SELECT * FROM dramas WHERE id=?').get(dramaId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', '作品不存在')
  return row
}
export function publishedRow(ctx: AppContext, dramaId: number): Row {
  const row = ctx.db.prepare(`SELECT * FROM dramas WHERE id=? AND ${publicDramaCondition(ctx)}`).get(dramaId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', '作品不存在或未发布')
  return row
}
function editable(row: Row): void { if (row.status === 'published') throw new ApiError(409, 'UNPUBLISH_FIRST', '请先下架，再修改内容') }
export function bump(ctx: AppContext, dramaId: number): void {
  ctx.db.prepare('UPDATE dramas SET version=version+1,updated_at=? WHERE id=?').run(Date.now(), dramaId)
  ctx.db.prepare('UPDATE platform_media_bindings SET needs_sync=1 WHERE drama_id=?').run(dramaId)
}
// 仅本地上/下架改变版本而不改内容；不得把这一例外用于剧目或单集编辑。
function carryMediaVersion(ctx: AppContext, dramaId: number, oldVersion: number): void {
  ctx.db.prepare('UPDATE platform_media_bindings SET synced_local_version=? WHERE drama_id=? AND synced_local_version=?')
    .run(oldVersion + 1, dramaId, oldVersion)
}
function asset(ctx: AppContext, value: unknown, kind: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined || value === '')) return null
  const assetId = text(value, `${kind}AssetId`, 100)
  if (!ctx.db.prepare('SELECT id FROM assets WHERE id=? AND kind=?').get(assetId, kind)) throw new ApiError(400, 'INVALID_ASSET', `未找到${kind}类型文件`)
  return assetId
}
function episodeDto(ctx: AppContext, row: Row, drama: Row, userId: string | null, admin = false): Episode {
  const seconds = Number(row.duration_seconds), isFree = Number(row.seq) <= Number(drama.free_episodes)
  const ready = ctx.config.mode !== 'local' ? Boolean(row.platform_episode_id && row.byteplus_vid) : fileReady(ctx, row.asset_id, 'video')
  return { id: Number(row.id), dramaId: Number(row.drama_id), seq: Number(row.seq), title: String(row.title), duration: `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`, durationSeconds: seconds, isFree,
    canPlay: drama.status === 'published' && ready && hasEpisodeAccess(ctx, userId, Number(row.id)), thumb: drama.cover_asset_id ? `/api/assets/${drama.cover_asset_id}` : '', price: Number(drama.episode_price), mediaReady: ready,
    ...(admin ? { assetId: row.asset_id as string | null, subtitleAssetId: row.subtitle_asset_id as string | null, platformEpisodeId: row.platform_episode_id as string | null, byteplusVid: row.byteplus_vid as string | null } : {}) }
}
export function dramaDto(ctx: AppContext, row: Row, req: Request, admin = false): Drama {
  const userId = ctx.user(req)?.id ?? null
  const episodes = ctx.db.prepare('SELECT * FROM episodes WHERE drama_id=? ORDER BY seq').all(Number(row.id)).map(e => episodeDto(ctx, e, row, userId, admin))
  const registration = readRegistrationMetadata(row.registration_metadata)
  const workId = Number(row.work_id ?? row.id)
  const editions = ctx.db.prepare(`SELECT id,title,language,delivery_profile FROM dramas
    WHERE COALESCE(work_id,id)=? ${admin ? '' : `AND ${publicDramaCondition(ctx)}`} ORDER BY id`).all(workId)
    .map(d => ({ id: Number(d.id), title: String(d.title), language: String(d.language), label: readDelivery(d.delivery_profile, String(d.language)).label }))
  return { workId, editions, metricsEnabled: !admin, delivery: readDelivery(row.delivery_profile, String(row.language)), localizations: readDramaLocalizations(row.localizations),
    seriesComplete: registration.albumStatus === 3 && episodes.length > 0 && registration.totalEpisodes === episodes.length,
    ...(admin ? { registrationMetadata: registration, productionSources: readProductionSources(row.production_sources) } : {}),
    id: Number(row.id), title: String(row.title), desc: String(row.description), category: String(row.category), cover: row.cover_asset_id ? `/api/assets/${row.cover_asset_id}` : '', episodes, totalEpisodes: episodes.length,
    freeEpisodes: Number(row.free_episodes), tags: JSON.parse(String(row.tags)), status: row.status as Drama['status'], version: Number(row.version), episodePrice: Number(row.episode_price), bundlePrice: Number(row.bundle_price), language: String(row.language), regions: JSON.parse(String(row.regions)), rightsConfirmed: Boolean(row.rights_confirmed), platformAlbumId: row.platform_album_id as string | null, platformReviewStatus: String(row.platform_review_status), isSample: Boolean(row.is_sample), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
}
function dramaFields(ctx: AppContext, input: Row, existing?: Row): Row {
  if (existing && ctx.config.mode !== 'local' && ['platformAlbumId', 'platformReviewStatus'].some(key => input[key] !== undefined)) {
    throw new ApiError(400, 'PLATFORM_FIELDS_READ_ONLY', 'platformAlbumId、platformReviewStatus只能通过服务器媒资同步更新')
  }
  const fields: Row = {}
  if (input.localizations !== undefined) fields.localizations = JSON.stringify(mergeDramaLocalizations(existing?.localizations, input.localizations))
  if (input.registrationMetadata !== undefined) {
    const uploaded = existing ? Number(ctx.db.prepare('SELECT COUNT(*) n FROM episodes WHERE drama_id=?').get(Number(existing.id))!.n) : 0
    fields.registration_metadata = JSON.stringify(mergeRegistrationMetadata(existing?.registration_metadata, input.registrationMetadata, uploaded))
  }
  if (!existing && input.regions === undefined) fields.regions = JSON.stringify([ctx.config.catalogRegion ?? 'JP'])
  const fieldText = (wire: string, column: string, max: number, empty = false) => { if (input[wire] !== undefined) fields[column] = text(input[wire], wire, max, empty) }
  fieldText('title', 'title', 200); fieldText('desc', 'description', 10000, true); fieldText('category', 'category', 100); fieldText('language', 'language', 20)
  if (input.delivery !== undefined) fields.delivery_profile = JSON.stringify(mergeDelivery(existing?.delivery_profile, input.delivery, String(fields.language ?? existing?.language ?? 'ja')))
  if (input.productionSources !== undefined) fields.production_sources = JSON.stringify(mergeProductionSources(existing?.production_sources, input.productionSources))
  if (existing && fields.language !== undefined && input.delivery === undefined && String(existing.delivery_profile) !== '{}') {
    // A saved caption declaration must still make sense after changing the audio tag.
    fields.delivery_profile = JSON.stringify(mergeDelivery(existing.delivery_profile, {}, String(fields.language)))
  }
  for (const [wire, column] of [['freeEpisodes', 'free_episodes'], ['episodePrice', 'episode_price'], ['bundlePrice', 'bundle_price']] as const) if (input[wire] !== undefined) fields[column] = integer(input[wire], wire, 0, 100000000)
  for (const field of ['regions', 'tags']) if (input[field] !== undefined) {
    const values = strings(input[field], field)
    fields[field] = JSON.stringify(field === 'regions' ? [...new Set(values.map(channelRegion))].sort() : values)
  }
  for (const [wire, column] of [['rightsConfirmed', 'rights_confirmed'], ['isSample', 'is_sample']] as const) if (input[wire] !== undefined) fields[column] = Number(boolean(input[wire], wire))
  if (input.coverAssetId !== undefined) fields.cover_asset_id = asset(ctx, input.coverAssetId, 'cover', true)
  if (!existing && !fields.title) throw new ApiError(400, 'TITLE_REQUIRED', '请输入作品标题')
  return fields
}
function updateColumns(ctx: AppContext, table: 'dramas' | 'episodes', rowId: number, fields: Row): void {
  const entries = Object.entries(fields)
  if (entries.length) ctx.db.prepare(`UPDATE ${table} SET ${entries.map(([k]) => `${k}=?`).join(',')} WHERE id=?`).run(...entries.map(([, v]) => v as string | number | null), rowId)
}
function episodeFields(ctx: AppContext, input: Row, existing?: Row): Row {
  if (existing && ctx.config.mode !== 'local' && ['platformEpisodeId', 'byteplusVid'].some(key => input[key] !== undefined)) {
    throw new ApiError(400, 'PLATFORM_FIELDS_READ_ONLY', 'platformEpisodeId、byteplusVid只能通过服务器媒资同步更新')
  }
  const fields: Row = {}
  if (!existing || input.seq !== undefined) fields.seq = integer(input.seq, 'seq', 1, 10000)
  if (!existing || input.title !== undefined) fields.title = text(input.title, 'title', 200)
  if (!existing || input.durationSeconds !== undefined) fields.duration_seconds = number(input.durationSeconds ?? 0, 'durationSeconds', 0, 86400)
  if (!existing || input.assetId !== undefined) fields.asset_id = asset(ctx, input.assetId, 'video', true)
  if (input.subtitleAssetId !== undefined) fields.subtitle_asset_id = asset(ctx, input.subtitleAssetId, 'subtitle', true)
  if (ctx.config.mode === 'local') for (const [wire, column] of [['platformEpisodeId', 'platform_episode_id'], ['byteplusVid', 'byteplus_vid']] as const) if (input[wire] !== undefined) fields[column] = input[wire] === null || input[wire] === '' ? null : text(input[wire], wire, 200)
  return fields
}
export function publishCatalogDrama(ctx: AppContext, actorId: string, dramaId: number, version: number): void {
    transaction(ctx.db, () => {
      const row = dramaRow(ctx, dramaId)
      if (integer(version, 'version', 1) !== row.version) throw new ApiError(409, 'VERSION_CONFLICT', '内容版本已变化')
      editable(row)
      const issue = publishIssues(ctx, row)[0]
      if (issue) throw new ApiError(issue.status, issue.code, issue.label)
      ctx.db.prepare("UPDATE dramas SET status='published',version=version+1,updated_at=? WHERE id=?").run(Date.now(), dramaId)
      carryMediaVersion(ctx, dramaId, Number(row.version))
      ctx.audit(actorId, 'drama.publish', 'drama', String(dramaId), { mode: ctx.config.mode, platformReviewStatus: row.platform_review_status })
    })
}

export function registerContent(router: Router, ctx: AppContext): void {
  registerCatalogChannels(router, ctx)
  registerOperationsChanges(router, ctx)
  router.get('/api/meta', (_req, res) => {
    const meta: Meta = { mode: ctx.config.mode, paymentMode: ctx.config.paymentMode, mediaMode: ctx.config.mode === 'local' ? 'local' : 'tiktok', registrationEnabled: ctx.config.mode === 'local', vipPrice: ctx.config.vipPrice, vipDays: ctx.config.vipDays,
      analytics: { enabled: Boolean(ctx.analytics), version: 2, autoplayPreference: true,
        playerDiagnostics: ctx.config.mode !== 'production' } }
    res.json(meta)
  })
  router.get('/api/catalog', (req, res) => res.json(catalogResult(ctx,
    ctx.db.prepare(`SELECT * FROM dramas WHERE ${publicDramaCondition(ctx)} ORDER BY updated_at DESC,id DESC`).all().map(d => dramaDto(ctx, d, req)), req)))
  router.get('/api/dramas/:id', (req, res) => res.json({ drama: dramaDto(ctx, publishedRow(ctx, id(req.params.id)), req) }))
  router.get('/api/admin/dramas', (req, res) => {
    ctx.requireAdmin(req)
    const region = req.query.region === undefined ? null : channelRegion(req.query.region)
    const language = req.query.language === undefined ? null : channelLocale(req.query.language)
    const rows = ctx.db.prepare('SELECT * FROM dramas ORDER BY updated_at DESC,id DESC').all()
      .filter(d => (!region || JSON.parse(String(d.regions)).includes(region)) &&
        (!language || audienceLanguage({ language: String(d.language), delivery: readDelivery(d.delivery_profile, String(d.language)) }) === language))
    res.json({ dramas: rows.map(d => dramaDto(ctx, d, req, true)), catalogRegion: ctx.config.catalogRegion ?? 'JP' })
  })
  router.post('/api/admin/dramas/:id/editions', (req, res) => {
    const user = ctx.requireAdmin(req), sourceId = id(req.params.id), input = body(req.body)
    if (Object.keys(input).some(k => !['version', 'requestId', 'language', 'regions', 'delivery'].includes(k))) {
      throw new ApiError(400, 'INVALID_EDITION_REQUEST', '新成片请求包含不允许复制的字段')
    }
    const language = channelLocale(input.language)
    const regions = [...new Set(strings(input.regions, 'regions').map(channelRegion))].sort()
    if (!regions.length || regions.length > 50) throw new ApiError(400, 'INVALID_CATALOG_REGION', '请选择发行地区')
    const requestId = text(input.requestId, 'requestId', 100)
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new ApiError(400, 'INVALID_EDITION_REQUEST', '请使用独立的版本创建请求编号')
    const delivery = mergeDelivery('{}', input.delivery ?? {}, language)
    const sourceVersion = integer(input.version, 'version', 1)
    const fingerprint = createHash('sha256').update(JSON.stringify({ sourceId, sourceVersion, language, regions, delivery })).digest('hex')
    const result = transaction(ctx.db, () => {
      const prior = ctx.db.prepare('SELECT * FROM drama_edition_requests WHERE user_id=? AND request_id=?').get(user.id, requestId)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ApiError(409, 'EDITION_REQUEST_CONFLICT', '该请求编号已用于另一份成片，不可覆盖')
        return { row: dramaRow(ctx, Number(prior.drama_id)), created: false }
      }
      const source = dramaRow(ctx, sourceId), workId = Number(source.work_id ?? source.id)
      if (sourceVersion !== source.version) throw new ApiError(409, 'VERSION_CONFLICT', '原作品已更新，请刷新')
      const now = Date.now()
      // Only copy editorial text and cover. Never copy episodes, approval, VID, rights or pricing.
      const r = ctx.db.prepare(`INSERT INTO dramas(work_id,title,description,category,language,regions,
        tags,cover_asset_id,localizations,delivery_profile,free_episodes,episode_price,bundle_price,is_sample,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,0,0,0,?,?,?)`).run(workId, String(source.title), String(source.description),
        String(source.category), language, JSON.stringify(regions), String(source.tags), source.cover_asset_id as string | null,
        String(source.localizations), JSON.stringify(delivery), Number(source.is_sample), now, now)
      const newId = Number(r.lastInsertRowid)
      ctx.db.prepare('INSERT INTO drama_edition_requests(user_id,request_id,fingerprint,drama_id,created_at) VALUES(?,?,?,?,?)')
        .run(user.id, requestId, fingerprint, newId, now)
      ctx.audit(user.id, 'drama.edition.create', 'drama', String(newId), { workId, language, regions })
      return { row: dramaRow(ctx, newId), created: true }
    })
    res.status(result.created ? 201 : 200).json({ drama: dramaDto(ctx, result.row, req, true), created: result.created })
  })
  router.post('/api/admin/dramas', (req, res) => {
    const user = ctx.requireAdmin(req), fields = dramaFields(ctx, body(req.body)), now = Date.now()
    const dramaId = transaction(ctx.db, () => {
      const result = ctx.db.prepare('INSERT INTO dramas(title,created_at,updated_at) VALUES(?,?,?)').run(String(fields.title), now, now)
      const newId = Number(result.lastInsertRowid)
      updateColumns(ctx, 'dramas', newId, fields); ctx.audit(user.id, 'drama.create', 'drama', String(newId))
      return newId
    })
    res.status(201).json({ drama: dramaDto(ctx, dramaRow(ctx, dramaId), req, true) })
  })
  router.patch('/api/admin/dramas/:id', (req, res) => {
    const user = ctx.requireAdmin(req), dramaId = id(req.params.id), input = body(req.body)
    transaction(ctx.db, () => {
      const row = dramaRow(ctx, dramaId); editable(row)
      if (integer(input.version, 'version', 1) !== row.version) throw new ApiError(409, 'VERSION_CONFLICT', '内容已被修改，请刷新后重试')
      const before = operationsSnapshot(ctx, 'drama', String(dramaId))
      const fields = dramaFields(ctx, input, row)
      updateColumns(ctx, 'dramas', dramaId, fields); bump(ctx, dramaId)
      // Changed metadata must be resynchronized; never carry a platform approval across edits.
      if (Object.keys(fields).length && row.platform_review_status === 'approved') ctx.db.prepare("UPDATE dramas SET platform_review_status='needs_sync' WHERE id=?").run(dramaId)
      ctx.audit(user.id, 'drama.update', 'drama', String(dramaId), { fields: Object.keys(fields) })
      recordOperationsChange(ctx, user.id, 'drama', String(dramaId), before, input.operationContext)
    })
    res.json({ drama: dramaDto(ctx, dramaRow(ctx, dramaId), req, true) })
  })
  router.post('/api/admin/dramas/:id/publish', (req, res) => {
    const user = ctx.requireAdmin(req), dramaId = id(req.params.id), input = body(req.body)
    publishCatalogDrama(ctx, user.id, dramaId, integer(input.version, 'version', 1))
    res.json({ drama: dramaDto(ctx, dramaRow(ctx, dramaId), req, true) })
  })
  router.post('/api/admin/dramas/:id/unpublish', (req, res) => {
    const user = ctx.requireAdmin(req), dramaId = id(req.params.id)
    transaction(ctx.db, () => {
      const row = dramaRow(ctx, dramaId)
      if (req.body?.version !== undefined && integer(req.body.version, 'version', 1) !== row.version) throw new ApiError(409, 'VERSION_CONFLICT', '内容版本已变化')
      ctx.db.prepare("UPDATE dramas SET status='draft',version=version+1,updated_at=? WHERE id=?").run(Date.now(), dramaId)
      ctx.db.prepare(`UPDATE media_delivery_jobs SET status='paused',next_run_at=0,
        message='运营已手动下架，自动交付已暂停，不会重新上架。已有平台回执保留。',updated_at=?
        WHERE drama_id=? AND active=1`).run(Date.now(), dramaId)
      carryMediaVersion(ctx, dramaId, Number(row.version))
      ctx.audit(user.id, 'drama.unpublish', 'drama', String(dramaId))
    })
    res.json({ drama: dramaDto(ctx, dramaRow(ctx, dramaId), req, true) })
  })
  router.post('/api/admin/dramas/:id/episodes', (req, res) => {
    const user = ctx.requireAdmin(req), dramaId = id(req.params.id), input = body(req.body)
    const episodeId = transaction(ctx.db, () => {
      const drama = dramaRow(ctx, dramaId); editable(drama)
      const fields = episodeFields(ctx, input), now = Date.now()
      if (ctx.db.prepare('SELECT id FROM episodes WHERE drama_id=? AND seq=?').get(dramaId, Number(fields.seq))) throw new ApiError(409, 'EPISODE_SEQUENCE_CONFLICT', '该集号已存在')
      const result = ctx.db.prepare('INSERT INTO episodes(drama_id,seq,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(dramaId, Number(fields.seq), String(fields.title), now, now)
      const newId = Number(result.lastInsertRowid)
      updateColumns(ctx, 'episodes', newId, fields); bump(ctx, dramaId)
      ctx.db.prepare("UPDATE dramas SET platform_review_status=CASE WHEN platform_review_status='approved' THEN 'needs_sync' ELSE platform_review_status END WHERE id=?").run(dramaId)
      ctx.audit(user.id, 'episode.create', 'episode', String(newId))
      return newId
    })
    res.status(201).json({ episode: episodeDto(ctx, ctx.db.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId)!, dramaRow(ctx, dramaId), user.id, true) })
  })
  router.patch('/api/admin/episodes/:id', (req, res) => {
    const user = ctx.requireAdmin(req), episodeId = id(req.params.id), input = body(req.body)
    transaction(ctx.db, () => {
      const row = ctx.db.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId)
      if (!row) throw new ApiError(404, 'NOT_FOUND', '剧集不存在')
      const dramaId = Number(row.drama_id); editable(dramaRow(ctx, dramaId))
      const fields = episodeFields(ctx, input, row)
      if (fields.seq !== undefined && ctx.db.prepare('SELECT id FROM episodes WHERE drama_id=? AND seq=? AND id<>?').get(dramaId, Number(fields.seq), episodeId)) throw new ApiError(409, 'EPISODE_SEQUENCE_CONFLICT', '该集号已存在')
      updateColumns(ctx, 'episodes', episodeId, { ...fields, updated_at: Date.now() }); bump(ctx, dramaId)
      ctx.db.prepare("UPDATE dramas SET platform_review_status=CASE WHEN platform_review_status='approved' THEN 'needs_sync' ELSE platform_review_status END WHERE id=?").run(dramaId)
      ctx.audit(user.id, 'episode.update', 'episode', String(episodeId))
    })
    const row = ctx.db.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId)!
    res.json({ episode: episodeDto(ctx, row, dramaRow(ctx, Number(row.drama_id)), user.id, true) })
  })
  router.delete('/api/admin/episodes/:id', (req, res) => {
    const user = ctx.requireAdmin(req), episodeId = id(req.params.id)
    transaction(ctx.db, () => {
      const row = ctx.db.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId)
      if (!row) throw new ApiError(404, 'NOT_FOUND', '剧集不存在')
      const dramaId = Number(row.drama_id); editable(dramaRow(ctx, dramaId))
      if (ctx.db.prepare("SELECT id FROM orders WHERE (kind='episode' AND target_id=?) OR (kind='drama' AND target_id=?) LIMIT 1").get(episodeId, dramaId)) throw new ApiError(409, 'CONTENT_HAS_ORDERS', '有关联订单的内容不可删除')
      ctx.db.prepare('DELETE FROM playback_grants WHERE episode_id=?').run(episodeId)
      ctx.db.prepare('DELETE FROM progress WHERE episode_id=?').run(episodeId)
      ctx.db.prepare('DELETE FROM episodes WHERE id=?').run(episodeId); bump(ctx, dramaId)
      ctx.db.prepare("UPDATE dramas SET platform_review_status=CASE WHEN platform_review_status='approved' THEN 'needs_sync' ELSE platform_review_status END WHERE id=?").run(dramaId)
      ctx.audit(user.id, 'episode.delete', 'episode', String(episodeId))
    })
    res.json({ ok: true })
  })
  router.post('/api/episodes/:id/playback', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const episodeId = id(req.params.id)
    let subscriptionUsed = false
    const initialUser = ctx.user(req)
    if (ctx.config.mode !== 'local' && initialUser && !hasEpisodeAccess(ctx, initialUser.id, episodeId, false)) {
      const initialEpisode = ctx.db.prepare('SELECT drama_id FROM episodes WHERE id=?').get(episodeId)
      if (!initialEpisode) throw new ApiError(404, 'NOT_FOUND', '剧集不存在')
      publishedRow(ctx, Number(initialEpisode.drama_id))
      const before = [ctx.config.mode, ctx.config.tiktokClientKey, ctx.sessionHash(req), initialUser.id, initialUser.provider, initialUser.role]
      const access = await refreshSubscriptionAccess(ctx, initialUser.id, true)
      const current = ctx.user(req)
      const after = [ctx.config.mode, ctx.config.tiktokClientKey, ctx.sessionHash(req), current?.id, current?.provider, current?.role]
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new ApiError(401, 'UNAUTHENTICATED', '播放期间登录状态已变化，请重新登录')
      if (access.status === 'unverified') throw new ApiError(access.reason === 'login_required' ? 401 : 503,
        'SUBSCRIPTION_ACCESS_UNVERIFIED', '会員の視聴権を確認できません。再購入せず、時間をおいて再確認してください。')
      subscriptionUsed = access.status === 'valid'
    }
    // 首次资格与映射也要来自同一份数据库快照，不能把旧ID与新版本拼在一起。
    const { episode, drama, user, isFree, platform } = transaction(ctx.db, () => {
      const episode = ctx.db.prepare('SELECT * FROM episodes WHERE id=?').get(episodeId)
      if (!episode) throw new ApiError(404, 'NOT_FOUND', '剧集不存在')
      const drama = publishedRow(ctx, Number(episode.drama_id)), user = ctx.user(req)
      const isFree = Number(episode.seq) <= Number(drama.free_episodes)
      if (!isFree && !user) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录')
      if (!hasEpisodeAccess(ctx, user?.id ?? null, episodeId)) throw new ApiError(402, 'PAYMENT_REQUIRED', '请先购买本集或会员')
      if (ctx.config.mode === 'local') return { episode, drama, user, isFree, platform: null }
      if (!ctx.config.tiktokClientKey || !ctx.config.tiktokClientSecret || !platformMediaReady(ctx, Number(drama.id))) throw new ApiError(503, 'PLATFORM_NOT_READY', '真实平台播放尚未就绪')
      const identity = { mode: ctx.config.mode, key: ctx.config.tiktokClientKey, secret: ctx.config.tiktokClientSecret, session: ctx.sessionHash(req) }
      const snapshot = platformPlaybackSnapshot(ctx, Number(drama.id), episodeId)
      if (typeof episode.platform_episode_id !== 'string') throw new ApiError(503, 'PLATFORM_NOT_READY', '平台episode_id必须为已同步的字符串ID')
      return { episode, drama, user, isFree, platform: { identity, snapshot, episodeId: episode.platform_episode_id } }
    })
    if (platform) {
      const { identity, snapshot } = platform
      let playAuthToken: string | undefined
      // 只按真实HTTP UA选择协议，不读取body版本；选路不替代前后两次授权检查。
      if (!supportsModernMinisPlayback(req.rawHeaders)) {
        try {
          playAuthToken = (await getMediaClient(ctx).getPlayToken(platform.episodeId)).playAuthToken
        } catch (error) {
          if (error instanceof MediaClientError) throw new ApiError(error.status, error.code, error.message)
          throw new ApiError(502, 'PLATFORM_PLAYBACK_FAILED', '平台播放凭证获取失败，请稍后重试')
        }
      }
      // A verified notification may have invalidated the observation while the
      // play token was being fetched. Recheck once, never infer a revocation.
      if (subscriptionUsed && user && readSubscriptionAccess(ctx, user.id).status !== 'valid') {
        if (ctx.sessionHash(req) !== identity.session || ctx.user(req)?.id !== user.id) {
          throw new ApiError(401, 'UNAUTHENTICATED', '播放期间登录状态已变化，请重新登录')
        }
        const access = await refreshSubscriptionAccess(ctx, user.id, true)
        if (access.status === 'unverified') throw new ApiError(access.reason === 'login_required' ? 401 : 503,
          'SUBSCRIPTION_ACCESS_UNVERIFIED', '会員の視聴権を再確認できませんでした。')
      }
      // HTTP已结束，才进入短事务做一致性检查；网络等待期间不占用SQLite事务。
      const playback = transaction(ctx.db, () => {
        if (ctx.config.mode !== identity.mode || ctx.config.tiktokClientKey !== identity.key || ctx.config.tiktokClientSecret !== identity.secret) {
          throw new ApiError(409, 'PLAYBACK_CONTEXT_CHANGED', '播放期间应用配置已变化，请重新请求播放')
        }
        const currentUser = ctx.user(req)
        if (ctx.sessionHash(req) !== identity.session || (currentUser?.id ?? null) !== (user?.id ?? null) ||
          currentUser?.provider !== user?.provider || currentUser?.role !== user?.role) {
          throw new ApiError(401, 'UNAUTHENTICATED', '播放期间登录状态已变化，请重新登录')
        }
        publishedRow(ctx, Number(drama.id))
        if (platformPlaybackSnapshot(ctx, Number(drama.id), episodeId) !== snapshot) {
          throw new ApiError(409, 'PLAYBACK_CONTEXT_CHANGED', '播放期间本地或平台版本、单集映射已变化，请重新请求播放')
        }
        if (!platformMediaReady(ctx, Number(drama.id))) throw new ApiError(503, 'PLATFORM_NOT_READY', '平台播放状态已变化')
        if (!hasEpisodeAccess(ctx, currentUser?.id ?? null, episodeId)) throw new ApiError(402, 'PAYMENT_REQUIRED', '播放权限已失效，请核对购买或退款状态')
        return { kind: 'tiktok', albumId: drama.platform_album_id, episodeId: episode.platform_episode_id, vid: episode.byteplus_vid, playAuthToken,
          ...(subscriptionUsed && currentUser ? { subscriptionAccess: readSubscriptionAccess(ctx, currentUser.id) } : {}) }
      })
      res.json(playback); return
    }
    if (!fileReady(ctx, episode.asset_id, 'video')) throw new ApiError(404, 'ASSET_UNAVAILABLE', '视频不可用')
    const token = randomBytes(32).toString('hex'), expiresAt = Date.now() + 5 * 60000
    ctx.db.prepare('DELETE FROM playback_grants WHERE expires_at<=?').run(Date.now())
    ctx.db.prepare('INSERT INTO playback_grants(token_hash,user_id,session_hash,episode_id,expires_at) VALUES(?,?,?,?,?)').run(tokenHash(token), isFree ? null : user!.id, isFree ? null : ctx.sessionHash(req), episodeId, expiresAt)
    res.json({ kind: 'local', url: `/api/media/stream/${token}`, expiresAt, ...(episode.subtitle_asset_id ? { subtitleUrl: `/api/assets/${episode.subtitle_asset_id}` } : {}) })
  }))
  router.get('/api/admin/users', (req, res) => { ctx.requireAdmin(req); res.json({ users: ctx.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map(publicUser) }) })
  router.get('/api/admin/audit', (req, res) => {
    ctx.requireAdmin(req)
    res.json({ events: ctx.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all().map(row => ({ id: row.id, actorId: row.actor_id, action: row.action, targetType: row.target_type, targetId: row.target_id, detail: JSON.parse(String(row.detail)), createdAt: row.created_at })) })
  })
  router.get('/api/admin/integrations', (req, res) => {
    ctx.requireAdmin(req)
    const tiktokConfigured = Boolean(ctx.config.tiktokClientKey && ctx.config.tiktokClientSecret)
    res.json({ mode: ctx.config.mode, paymentMode: ctx.config.paymentMode, mediaMode: ctx.config.mode === 'local' ? 'local' : 'tiktok', tiktokConfigured, requirements: [
      ...(!tiktokConfigured ? ['需要配置真实TikTok应用凭据'] : []),
      ...(ctx.config.mode === 'local' ? ['当前为本地服务，发布不代表平台审核通过', '沙盒订单不产生真实扣费'] : ['生产发布需要真实平台同步与审核状态', '生产支付需平台验签、回调及订单核对']),
      ...(ctx.config.mode === 'staging' ? ['预发布与正式使用相同平台业务路径，但只接受明确is_sandbox=true的已验签回执', '必须由平台实际启用测试权限；此配置不会让平台自动免扣费'] : []),
    ] })
  })
}
