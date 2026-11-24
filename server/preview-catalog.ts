import type { Request, Router } from 'express'
import type { PreviewCatalogState, PreviewManifest, PreviewReceipt, PreviewSource } from '../shared/preview-catalog.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { body, integer } from './validation.js'
import { fileReady, platformMediaReady } from './catalog-policy.js'
import { readPreviewCover } from './media-export.js'
import { readDramaLocalizations } from './drama-localizations.js'
import { readDelivery } from './content-delivery.js'
import { readRegistrationMetadata } from './registration-metadata.js'
import { transaction } from './db.js'
import {
  deliverPreview, previewConfig, previewError, previewHash, previewOffer,
  PREVIEW_SIGNATURE, validateManifest, validatePacket, type PreviewBridgeConfig,
} from './preview-catalog-wire.js'
import {
  importPreviewCatalog, initialPreviewReceipt, initializePreviewCatalog, inspectPreviewReceipt, readPreviewReceipt, savePreviewReceipt,
} from './preview-catalog-import.js'

type Row = Record<string, unknown>
function sourceStatus(ctx: AppContext, row: Row): PreviewSource {
  const episodes = ctx.db.prepare('SELECT id,seq,platform_episode_id,byteplus_vid,subtitle_asset_id FROM episodes WHERE drama_id=? ORDER BY seq').all(Number(row.id))
  const reasons: string[] = []
  if (!row.rights_confirmed || row.is_sample) reasons.push('需要真实版权确认，不能分发内部样例内容')
  if (row.status === 'archived') reasons.push('源作品已下架，不能作为新测试发行')
  if (!fileReady(ctx, row.cover_asset_id, 'cover')) reasons.push('缺少已验证封面')
  if (!episodes.length || episodes.some((e, i) => e.seq !== i + 1)) reasons.push('需要从第1集起连续排列的单集')
  if (!row.platform_album_id) {
    const metadata = readRegistrationMetadata(row.registration_metadata)
    if (!metadata.year) reasons.push('原剧还需确认计划首发年份，再进行平台剧目登记')
    if (!metadata.tagList.length) reasons.push('原剧还缺真实平台题材编号，不能用示例编号替代')
  }
  if (episodes.some(e => !e.platform_episode_id || !e.byteplus_vid)) reasons.push('仍缺平台单集ID或已关联视频ID')
  if (episodes.some(e => e.subtitle_asset_id)) reasons.push('本期测试分发仅使用视频自带字幕；外挂字幕需先接入平台字幕后再发行')
  if (!platformMediaReady(ctx, Number(row.id))) reasons.push('尚未确认当前版本的官方审核、在线版本、上架状态及当前App授权')
  return {
    id: Number(row.id), version: Number(row.version), title: String(row.title), language: String(row.language),
    regions: JSON.parse(String(row.regions)), episodeCount: episodes.length, ready: reasons.length === 0, reasons,
  }
}
async function sourceManifest(ctx: AppContext, input: Record<string, unknown>): Promise<PreviewManifest> {
  if (Object.keys(input).some(k => !['dramaId', 'version', 'freeEpisodes', 'episodePrice', 'bundlePrice'].includes(k))) {
    throw previewError(400, 'PREVIEW_INVALID_FIELDS', '只能选择源剧、版本和目标测试价格，不接受地址、凭据或批准状态')
  }
  const id = integer(input.dramaId, 'dramaId', 1), version = integer(input.version, 'version', 1)
  const row = ctx.db.prepare('SELECT * FROM dramas WHERE id=?').get(id)
  if (!row) throw previewError(404, 'NOT_FOUND', '源作品不存在')
  if (row.version !== version) throw previewError(409, 'VERSION_CONFLICT', '源作品已修改，请刷新后核对发行版本')
  const state = sourceStatus(ctx, row)
  if (!state.ready) throw previewError(409, 'PREVIEW_SOURCE_NOT_READY', state.reasons.join('；'))
  const episodes = ctx.db.prepare('SELECT * FROM episodes WHERE drama_id=? ORDER BY seq').all(id)
  const offer = previewOffer({ freeEpisodes: input.freeEpisodes, episodePrice: input.episodePrice, bundlePrice: input.bundlePrice }, episodes.length)
  const asset = ctx.db.prepare("SELECT * FROM assets WHERE id=? AND kind='cover'").get(String(row.cover_asset_id))!
  if (Number(asset.bytes) > 600_000) throw previewError(400, 'PREVIEW_COVER_TOO_LARGE', '用于测试发行的封面不能超过600KB，请另存压缩封面')
  const cover = await readPreviewCover(ctx, asset)
  // The asynchronous disk read must not package metadata whose source edition just changed.
  const latest = ctx.db.prepare('SELECT version FROM dramas WHERE id=?').get(id)
  if (latest?.version !== version || !platformMediaReady(ctx, id)) throw previewError(409, 'VERSION_CONFLICT', '源作品在打包期间已变化，请重新核对')
  const binding = ctx.db.prepare('SELECT * FROM platform_media_bindings WHERE drama_id=?').get(id)!
  const result: PreviewManifest = {
    v: 1, clientKey: ctx.config.tiktokClientKey!, authorizedClientKey: String(binding.authorized_client_key),
    sourceDramaId: id, sourceVersion: version, albumId: String(binding.album_id), platformVersion: Number(binding.platform_version),
    drama: { title: String(row.title), desc: String(row.description), category: String(row.category), language: String(row.language),
      regions: JSON.parse(String(row.regions)), tags: JSON.parse(String(row.tags)), localizations: readDramaLocalizations(row.localizations),
      delivery: readDelivery(row.delivery_profile, String(row.language)) },
    cover: { base64: cover.toString('base64'), sha256: String(asset.sha256), mime: String(asset.mime) },
    episodes: episodes.map(e => ({
      sourceId: Number(e.id), seq: Number(e.seq), title: String(e.title), durationSeconds: Number(e.duration_seconds),
      episodeId: String(e.platform_episode_id), vid: String(e.byteplus_vid),
    })), offer,
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 950_000) throw previewError(400, 'PREVIEW_TOO_LARGE', '发行文案与封面超过单次限制，未发送')
  return result
}
const loopback = (req: Request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
function requireSender(ctx: AppContext, bridge: PreviewBridgeConfig): void {
  if (ctx.config.mode !== 'production' || !bridge.secret || !bridge.target) {
    throw previewError(503, 'PREVIEW_UNCONFIGURED', '仅已配置专用内容通道的运营后台能发行到官方测试片库')
  }
}
async function sendManifest(ctx: AppContext, bridge: PreviewBridgeConfig, manifest: PreviewManifest, adminId: string, retry = false) {
  const releaseId = previewHash(manifest), receipt = initialPreviewReceipt(releaseId, manifest)
  const previous = transaction(ctx.db, () => {
    const old = readPreviewReceipt(ctx, releaseId)
    if (old && (!retry || old.state !== 'failed')) return old
    savePreviewReceipt(ctx, receipt)
    return null
  })
  if (previous) return previous
  ctx.audit(adminId, retry ? 'preview_catalog.retry' : 'preview_catalog.send', 'drama', String(manifest.sourceDramaId), {
    releaseId, sourceVersion: manifest.sourceVersion, episodeCount: manifest.episodes.length, offer: manifest.offer,
  })
  let confirmed: PreviewReceipt
  try {
    const result = await deliverPreview(bridge, { kind: 'publish', issuedAt: Date.now(), releaseId, manifest })
    if (!result || result.sourceDramaId !== manifest.sourceDramaId || result.sourceVersion !== manifest.sourceVersion ||
        result.episodeCount !== manifest.episodes.length || result.freeEpisodes !== manifest.offer.freeEpisodes ||
        result.episodePrice !== manifest.offer.episodePrice || result.bundlePrice !== manifest.offer.bundlePrice) throw Error('Mismatched receipt')
    confirmed = result
  } catch {
    confirmed = { ...receipt, state: 'unknown', updatedAt: Date.now(), errorCode: 'PREVIEW_RESULT_UNKNOWN',
      message: '目标结果尚未确认；请查询原发行记录，不要重传内容或重新建剧' }
  }
  savePreviewReceipt(ctx, confirmed)
  return confirmed
}
export function registerPreviewCatalog(router: Router, ctx: AppContext): void {
  const bridge = previewConfig(ctx.config.mode)
  initializePreviewCatalog(ctx)
  router.get('/api/admin/preview-catalog', (req, res) => {
    ctx.requireAdmin(req)
    const configured = ctx.config.mode === 'production' && Boolean(bridge.secret && bridge.target)
    const state: PreviewCatalogState = {
      configured, mode: ctx.config.mode,
      reason: configured ? null : '本环境未配置官方测试内容通道；不会复制数据库或启用模拟付款',
      dramas: ctx.db.prepare('SELECT * FROM dramas ORDER BY id DESC').all().map(row => sourceStatus(ctx, row)),
      receipts: ctx.db.prepare('SELECT receipt_json FROM preview_catalog_receipts ORDER BY updated_at DESC LIMIT 50')
        .all().map(row => JSON.parse(String(row.receipt_json))),
    }
    res.json(state)
  })
  router.post('/api/admin/preview-catalog/publish', asyncRoute(async (req, res) => {
    const admin = ctx.requireAdmin(req)
    requireSender(ctx, bridge)
    const manifest = await sourceManifest(ctx, body(req.body))
    res.json({ receipt: await sendManifest(ctx, bridge, manifest, admin.id) })
  }))
  router.post('/api/admin/preview-catalog/:releaseId/retry', asyncRoute(async (req, res) => {
    const admin = ctx.requireAdmin(req)
    requireSender(ctx, bridge)
    if (Object.keys(body(req.body)).length) throw previewError(400, 'PREVIEW_INVALID_FIELDS', '重试只使用原发行记录')
    const old = readPreviewReceipt(ctx, String(req.params.releaseId))
    if (!old || old.state !== 'failed') throw previewError(409, 'PREVIEW_RETRY_NOT_ALLOWED', '只能重试明确失败的发行；未知结果必须先查询')
    const manifest = await sourceManifest(ctx, {
      dramaId: old.sourceDramaId, version: old.sourceVersion,
      freeEpisodes: old.freeEpisodes, episodePrice: old.episodePrice, bundlePrice: old.bundlePrice,
    })
    if (previewHash(manifest) !== old.releaseId) throw previewError(409, 'VERSION_CONFLICT', '源内容已不同于原发行记录，请重新核对')
    res.json({ receipt: await sendManifest(ctx, bridge, manifest, admin.id, true) })
  }))
  router.post('/api/admin/preview-catalog/:releaseId/reconcile', asyncRoute(async (req, res) => {
    ctx.requireAdmin(req); requireSender(ctx, bridge)
    if (Object.keys(body(req.body)).length) throw previewError(400, 'PREVIEW_INVALID_FIELDS', '查询原记录不接受其他字段')
    const releaseId = String(req.params.releaseId)
    if (!/^[a-f0-9]{64}$/.test(releaseId)) throw previewError(400, 'PREVIEW_INVALID_ID', '发行记录编号无效')
    const current = readPreviewReceipt(ctx, releaseId)
    if (!current) throw previewError(404, 'NOT_FOUND', '未找到本次发行记录')
    try {
      const receipt = await deliverPreview(bridge, { kind: 'status', issuedAt: Date.now(), releaseId })
      if (!receipt) {
        const absent: PreviewReceipt = { ...current, state: 'failed', updatedAt: Date.now(), errorCode: 'PREVIEW_NOT_RECEIVED',
          message: '目标已确认尚未接收此发行；没有自动重发，可以明确重试原记录' }
        savePreviewReceipt(ctx, absent)
        return res.json({ receipt: absent })
      }
      if (receipt.sourceDramaId !== current.sourceDramaId || receipt.sourceVersion !== current.sourceVersion) throw Error()
      savePreviewReceipt(ctx, receipt)
      res.json({ receipt })
    } catch { throw previewError(503, 'PREVIEW_QUERY_FAILED', '无法查询目标记录，保留原状态，没有重发内容') }
  }))
  router.post('/api/admin/preview-catalog/receive', asyncRoute(async (req, res) => {
    if (ctx.config.mode !== 'staging' || !bridge.secret || !ctx.config.tiktokClientKey || !ctx.config.tiktokClientSecret) {
      throw previewError(404, 'NOT_FOUND', '接口不存在')
    }
    if (!loopback(req)) throw previewError(401, 'PREVIEW_AUTH_REQUIRED', '内部内容通道仅接受本机连接')
    const packet = validatePacket(req.body, req.get(PREVIEW_SIGNATURE), bridge.secret)
    if (packet.kind === 'status') return res.json({ receipt: inspectPreviewReceipt(ctx, packet.releaseId) })
    const region = (ctx.config as typeof ctx.config & { catalogRegion?: string }).catalogRegion ?? 'JP'
    const manifest = validateManifest(packet.manifest, ctx.config.tiktokClientKey, region)
    const receipt = await importPreviewCatalog(ctx, packet.releaseId, manifest)
    res.json({ receipt })
  }))
}
