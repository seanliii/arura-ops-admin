import { createHash, randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { PreviewManifest, PreviewReceipt } from '../shared/preview-catalog.js'
import type { AppContext } from './types.js'
import { ApiError } from './types.js'
import { transaction } from './db.js'
import { getMediaClient, verifyEpisodePlaybackAccess } from './platform-media.js'
import { previewCoverMime, readPreviewCover } from './media-export.js'
import { previewError } from './preview-catalog-wire.js'
import { platformMediaReady } from './catalog-policy.js'

type Row = Record<string, unknown>
export function initializePreviewCatalog(ctx: AppContext): void {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS preview_catalog_receipts(
      release_id TEXT PRIMARY KEY, source_drama_id INTEGER NOT NULL, source_version INTEGER NOT NULL,
      state TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, receipt_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS preview_catalog_targets(
      source_client_key TEXT NOT NULL, source_drama_id INTEGER NOT NULL, source_version INTEGER NOT NULL,
      target_drama_id INTEGER NOT NULL REFERENCES dramas(id), target_version INTEGER NOT NULL,
      release_id TEXT NOT NULL, episode_map TEXT NOT NULL,
      PRIMARY KEY(source_client_key,source_drama_id));
  `)
}
export function readPreviewReceipt(ctx: AppContext, releaseId: string): PreviewReceipt | null {
  const row = ctx.db.prepare('SELECT receipt_json FROM preview_catalog_receipts WHERE release_id=?').get(releaseId)
  return row ? JSON.parse(String(row.receipt_json)) : null
}
export function inspectPreviewReceipt(ctx: AppContext, releaseId: string): PreviewReceipt | null {
  return transaction(ctx.db, () => {
    const receipt = readPreviewReceipt(ctx, releaseId)
    const row = ctx.db.prepare('SELECT lease_until FROM preview_catalog_receipts WHERE release_id=?').get(releaseId)
    if (receipt?.state === 'checking' && Number(row?.lease_until) > 0 && Number(row?.lease_until) <= Date.now()) {
      receipt.state = 'failed'; receipt.errorCode = 'PREVIEW_CHECK_INTERRUPTED'; receipt.updatedAt = Date.now()
      receipt.message = '目标内容检查已中断且租约到期，未提交本次内容；可以明确重试原发行'
      savePreviewReceipt(ctx, receipt)
    }
    return receipt
  })
}
export function savePreviewReceipt(ctx: AppContext, receipt: PreviewReceipt, leaseUntil = 0): void {
  ctx.db.prepare(`INSERT INTO preview_catalog_receipts
    (release_id,source_drama_id,source_version,state,lease_until,receipt_json,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(release_id) DO UPDATE SET state=excluded.state,lease_until=excluded.lease_until,
    receipt_json=excluded.receipt_json,updated_at=excluded.updated_at`)
    .run(receipt.releaseId, receipt.sourceDramaId, receipt.sourceVersion, receipt.state, leaseUntil, JSON.stringify(receipt), receipt.updatedAt)
}
export const initialPreviewReceipt = (releaseId: string, manifest: PreviewManifest): PreviewReceipt => ({
  releaseId, sourceDramaId: manifest.sourceDramaId, sourceVersion: manifest.sourceVersion,
  state: 'checking', targetDramaId: null, episodeCount: manifest.episodes.length, ...manifest.offer,
  errorCode: null, message: '正在核对官方测试内容；未确认前不表示已可播放', updatedAt: Date.now(),
})
function existingTarget(ctx: AppContext, m: PreviewManifest): Row | undefined {
  return ctx.db.prepare('SELECT * FROM preview_catalog_targets WHERE source_client_key=? AND source_drama_id=?')
    .get(m.clientKey, m.sourceDramaId)
}
function assertEditableTarget(ctx: AppContext, target: Row | undefined, m: PreviewManifest): void {
  if (!target) return
  const current = ctx.db.prepare('SELECT version FROM dramas WHERE id=?').get(Number(target.target_drama_id))
  if (!current || current.version !== target.target_version || m.sourceVersion <= Number(target.source_version)) {
    throw previewError(409, 'PREVIEW_TARGET_CHANGED', '目标已修改或不是更新的源版本；请先核对现有发行，不覆盖')
  }
  if (ctx.db.prepare(`SELECT 1 FROM orders WHERE
    (kind='drama' AND target_id=?) OR (kind='episode' AND target_id IN(SELECT id FROM episodes WHERE drama_id=?)) LIMIT 1`)
    .get(Number(target.target_drama_id), Number(target.target_drama_id))) {
    throw previewError(409, 'PREVIEW_TARGET_HAS_ORDERS', '目标已有交易，不能覆盖价格、单集和既有权益；请另建测试发行')
  }
  const map = JSON.parse(String(target.episode_map)) as Record<string, number>
  if (Object.keys(map).length !== m.episodes.length || m.episodes.some(e => !map[e.sourceId])) {
    throw previewError(409, 'PREVIEW_TOPOLOGY_CHANGED', '目标已有单集记录，不能通过同步删除或替换集数')
  }
}
async function checkedPlatform(ctx: AppContext, m: PreviewManifest, assertCurrent: () => void) {
  assertCurrent()
  const result = await getMediaClient(ctx).queryAlbum(m.albumId, m.platformVersion)
  assertCurrent()
  const versions = new Set<number>()
  for (const row of result.album_version_list) {
    if (row.album_id !== m.albumId || versions.has(row.version)) throw previewError(409, 'PREVIEW_PLATFORM_MISMATCH', '平台返回了不一致的剧目版本')
    versions.add(row.version)
  }
  const row = result.album_version_list.find(v => v.version === m.platformVersion)
  if (!row || ![2, 6].includes(row.review_status ?? -1) || row.publish_status !== 1 ||
      row.online_version !== m.platformVersion || !Number.isSafeInteger(row.current_version) ||
      row.current_version! < m.platformVersion) {
    throw previewError(409, 'PREVIEW_PLATFORM_NOT_READY', '目标独立查询尚未确认该版本审核通过、已上架且在线')
  }
  const remote = row.episode_info_list
  if (!remote || remote.length !== m.episodes.length ||
      new Set(remote.map(e => e.episode_id)).size !== remote.length ||
      new Set(remote.map(e => e.seq)).size !== remote.length ||
      m.episodes.some(e => !remote.some(r => r.seq === e.seq && r.episode_id === e.episodeId && r.byteplus_vid === e.vid))) {
    throw previewError(409, 'PREVIEW_PLATFORM_MISMATCH', '目标查询的单集、顺序或视频与源发行快照不一致')
  }
  await verifyEpisodePlaybackAccess(getMediaClient(ctx), m.episodes.map(e => e.episodeId), assertCurrent)
  return row
}
/**
 * The signed manifest proves the source CMS accepted a same-app release.
 * It does NOT waive target-side platform queries, file checks or existing-order protection.
 */
export async function importPreviewCatalog(ctx: AppContext, releaseId: string, m: PreviewManifest): Promise<PreviewReceipt> {
  const receipt = initialPreviewReceipt(releaseId, m)
  let leaseUntil = Date.now() + 90_000
  const previous = transaction(ctx.db, () => {
    const existing = readPreviewReceipt(ctx, releaseId)
    const lease = ctx.db.prepare('SELECT lease_until FROM preview_catalog_receipts WHERE release_id=?').get(releaseId)
    if (existing && (existing.state === 'published' || existing.state === 'unknown' ||
        (existing.state === 'checking' && Number(lease?.lease_until) > Date.now()))) return existing
    savePreviewReceipt(ctx, receipt, leaseUntil)
    return null
  })
  if (previous) return previous
  let newFile: string | undefined
  try {
    const oldTarget = existingTarget(ctx, m)
    assertEditableTarget(ctx, oldTarget, m)
    const content = Buffer.from(m.cover.base64, 'base64')
    if (content.length > 600_000 || content.toString('base64') !== m.cover.base64 ||
        createHash('sha256').update(content).digest('hex') !== m.cover.sha256 ||
        previewCoverMime(content) !== m.cover.mime) throw previewError(400, 'PREVIEW_COVER_INVALID', '封面字节和已验证摘要不一致')
    const secret = ctx.config.tiktokClientSecret
    const currentCheck = (renew = true) => {
      const lease = ctx.db.prepare('SELECT state,lease_until FROM preview_catalog_receipts WHERE release_id=?').get(releaseId)
      if (ctx.config.tiktokClientKey !== m.clientKey || secret !== ctx.config.tiktokClientSecret ||
          lease?.state !== 'checking' || lease.lease_until !== leaseUntil || leaseUntil <= Date.now()) {
        throw previewError(409, 'PREVIEW_CHECK_INTERRUPTED', '目标核验已过期或应用配置改变，不采用旧结果')
      }
      if (!renew) return
      const nextLease = Math.max(leaseUntil + 1, Date.now() + 90_000)
      ctx.db.prepare('UPDATE preview_catalog_receipts SET lease_until=? WHERE release_id=? AND state=? AND lease_until=?')
        .run(nextLease, releaseId, 'checking', leaseUntil)
      leaseUntil = nextLease
    }
    const platform = await checkedPlatform(ctx, m, currentCheck)
    const admin = ctx.db.prepare("SELECT id FROM users WHERE role='admin' AND disabled=0 ORDER BY created_at LIMIT 1").get()
    if (!admin) throw previewError(409, 'PREVIEW_ADMIN_MISSING', '目标服务尚未初始化管理员，未导入内容')
    const asset = ctx.db.prepare("SELECT * FROM assets WHERE kind='cover' AND sha256=? AND bytes=? AND mime=?")
      .get(m.cover.sha256, content.length, m.cover.mime)
    const assetId = asset ? String(asset.id) : randomUUID()
    if (asset) await readPreviewCover(ctx, asset)
    if (!asset) {
      newFile = join(ctx.config.dataDir, 'uploads', `preview-${assetId}`)
      await writeFile(newFile, content, { flag: 'wx', mode: 0o600 })
    }
    transaction(ctx.db, () => {
      // 同步事务无需续租；回滚时不能让内存租约领先于数据库。
      currentCheck(false)
      const lease = ctx.db.prepare('SELECT state,lease_until FROM preview_catalog_receipts WHERE release_id=?').get(releaseId)
      if (lease?.state !== 'checking' || lease.lease_until !== leaseUntil || leaseUntil <= Date.now()) {
        throw previewError(409, 'PREVIEW_CHECK_INTERRUPTED', '本次内容检查已过期或被后续查询作废，不提交迟到结果')
      }
      const latest = existingTarget(ctx, m)
      if (latest?.release_id !== oldTarget?.release_id) throw previewError(409, 'PREVIEW_TARGET_CHANGED', '另一份发行已更新目标，请重新核对')
      assertEditableTarget(ctx, latest, m)
      const now = Date.now(), d = m.drama
      if (!asset) ctx.db.prepare(`INSERT INTO assets(id,owner_id,kind,original_name,storage_path,mime,bytes,sha256,created_at)
        VALUES(?,?,'cover',?,?,?,?,?,?)`).run(assetId, String(admin.id), 'preview-cover', newFile!, m.cover.mime, content.length, m.cover.sha256, now)
      const id = latest ? Number(latest.target_drama_id) : Number(ctx.db.prepare(`INSERT INTO dramas
        (title,created_at,updated_at) VALUES(?,?,?)`).run(d.title, now, now).lastInsertRowid)
      const version = latest ? Number(latest.target_version) + 1 : 1
      ctx.db.prepare(`UPDATE dramas SET title=?,description=?,category=?,language=?,regions=?,tags=?,localizations=?,
        cover_asset_id=?,rights_confirmed=1,is_sample=0,free_episodes=?,episode_price=?,bundle_price=?,
        status='draft',platform_album_id=?,platform_review_status='approved',version=?,updated_at=? WHERE id=?`)
        .run(d.title, d.desc, d.category, d.language, JSON.stringify(d.regions), JSON.stringify(d.tags),
          JSON.stringify(d.localizations), assetId, m.offer.freeEpisodes, m.offer.episodePrice, m.offer.bundlePrice,
          m.albumId, version, now, id)
      if (d.delivery !== undefined) ctx.db.prepare('UPDATE dramas SET delivery_profile=? WHERE id=?')
        .run(JSON.stringify(d.delivery), id)
      const map: Record<string, number> = latest ? JSON.parse(String(latest.episode_map)) : {}
      for (const e of m.episodes) {
        if (!map[e.sourceId]) map[e.sourceId] = Number(ctx.db.prepare(`INSERT INTO episodes
          (drama_id,seq,title,created_at,updated_at) VALUES(?,?,?,?,?)`).run(id, e.seq, e.title, now, now).lastInsertRowid)
        ctx.db.prepare(`UPDATE episodes SET seq=?,title=?,duration_seconds=?,platform_episode_id=?,byteplus_vid=?,updated_at=? WHERE id=? AND drama_id=?`)
          .run(e.seq, e.title, e.durationSeconds, e.episodeId, e.vid, now, map[e.sourceId], id)
      }
      const operationId = randomUUID()
      ctx.db.prepare(`INSERT INTO platform_media_operations
        (request_id,drama_id,action,album_id,platform_version,client_key,local_version,status,acknowledged,result_version,message,created_at,updated_at,lease_until)
        VALUES(?,?,'sync',?,?,?,?,'succeeded',1,?,'目标独立查询官方版本并逐集核验当前App播放许可；未保存凭证',?,?,?)`)
        .run(operationId, id, m.albumId, m.platformVersion, m.clientKey, version, version, now, now, now)
      ctx.db.prepare(`INSERT INTO platform_media_bindings
        (drama_id,album_id,client_key,platform_version,current_version,online_version,review_status,publish_status,
         synced_local_version,synced_at,authorized_client_key,authorized_at,needs_sync,operation_id,synced_operation_id,versions_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)
        ON CONFLICT(drama_id) DO UPDATE SET album_id=excluded.album_id,client_key=excluded.client_key,
        platform_version=excluded.platform_version,current_version=excluded.current_version,online_version=excluded.online_version,
        review_status=excluded.review_status,publish_status=excluded.publish_status,synced_local_version=excluded.synced_local_version,
        synced_at=excluded.synced_at,authorized_client_key=excluded.authorized_client_key,authorized_at=excluded.authorized_at,
        needs_sync=0,operation_id=excluded.operation_id,synced_operation_id=excluded.synced_operation_id,versions_json=excluded.versions_json`)
        .run(id, m.albumId, m.clientKey, m.platformVersion, platform.current_version!, platform.online_version!,
          platform.review_status!, platform.publish_status!, version, now, m.authorizedClientKey, now, operationId, operationId,
          JSON.stringify([{ version: m.platformVersion, reviewStatus: platform.review_status, episodeCount: m.episodes.length }]))
      ctx.db.prepare('DELETE FROM platform_media_episodes WHERE drama_id=?').run(id)
      for (const e of m.episodes) ctx.db.prepare(`INSERT INTO platform_media_episodes(drama_id,local_episode_id,seq,episode_id,vid) VALUES(?,?,?,?,?)`)
        .run(id, map[e.sourceId], e.seq, e.episodeId, e.vid)
      if (!platformMediaReady(ctx, id)) throw previewError(409, 'PREVIEW_POLICY_REJECTED', '目标未通过现有平台交付校验，全部内容写入已回滚')
      ctx.db.prepare("UPDATE dramas SET status='published' WHERE id=?").run(id)
      ctx.db.prepare(`INSERT INTO preview_catalog_targets(source_client_key,source_drama_id,source_version,target_drama_id,target_version,release_id,episode_map)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_client_key,source_drama_id) DO UPDATE SET
        source_version=excluded.source_version,target_version=excluded.target_version,release_id=excluded.release_id,episode_map=excluded.episode_map`)
        .run(m.clientKey, m.sourceDramaId, m.sourceVersion, id, version, releaseId, JSON.stringify(map))
      Object.assign(receipt, { state: 'published', targetDramaId: id, updatedAt: now, message: '内容已进入官方测试片库；尚不代表手机播放或官方付款验收通过' })
      savePreviewReceipt(ctx, receipt)
      ctx.audit(null, 'preview_catalog.publish', 'drama', String(id), { releaseId, sourceDramaId: m.sourceDramaId, sourceVersion: m.sourceVersion, platformVersion: m.platformVersion })
    })
    newFile = undefined
  } catch (error) {
    if (newFile) await unlink(newFile).catch(() => {})
    receipt.state = 'failed'; receipt.updatedAt = Date.now()
    receipt.errorCode = error instanceof ApiError ? error.code : 'PREVIEW_PLATFORM_CHECK_FAILED'
    receipt.message = error instanceof ApiError ? error.message : '目标平台查询或内容核对失败，未发布；请核对后新建发行'
    const live = ctx.db.prepare('SELECT state,lease_until FROM preview_catalog_receipts WHERE release_id=?').get(releaseId)
    if (live?.state === 'checking' && live.lease_until === leaseUntil) savePreviewReceipt(ctx, receipt)
    else return readPreviewReceipt(ctx, releaseId) ?? receipt
  }
  return receipt
}
