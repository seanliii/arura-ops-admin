import { lstatSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { AppContext } from './types.js'
import { CONTENT_LANGUAGES } from '../shared/content-language.js'

type CatalogContext = Pick<AppContext, 'db' | 'config'>

/** 无论发布、片库、播放还是新购买，都使用同一份已查询证据。 */
export function platformMediaCondition(ctx: Pick<AppContext, 'config'>, alias: 'dramas' | 'd' = 'dramas'): string {
  // 目录证据与运行时凭据分开：Secret缺失由发布/播放/支付各自明确拒绝，
  // 不把已验证的内容伪装成不存在，也不破坏支付原有“未提交失败”的持久记录。
  if (!ctx.config.tiktokClientKey) return '0'
  const clientKey = `'${ctx.config.tiktokClientKey.replaceAll("'", "''")}'`
  return `${alias}.is_sample=0 AND ${alias}.platform_review_status='approved'
    AND EXISTS (SELECT 1 FROM platform_media_bindings pm
      JOIN platform_media_operations po ON po.request_id=pm.synced_operation_id
      WHERE pm.drama_id=${alias}.id AND pm.album_id=${alias}.platform_album_id
        AND pm.client_key=${clientKey} AND pm.authorized_client_key=${clientKey}
        AND pm.needs_sync=0 AND pm.synced_local_version=${alias}.version
        AND pm.review_status IN (2,6) AND pm.publish_status=1
        AND pm.platform_version=pm.online_version
        AND po.action='sync' AND po.status='succeeded'
        AND po.album_id=pm.album_id AND po.platform_version=pm.platform_version AND po.client_key=pm.client_key)
    AND (SELECT COUNT(*) FROM episodes pe WHERE pe.drama_id=${alias}.id)>0
    AND (SELECT MIN(seq) FROM episodes pe WHERE pe.drama_id=${alias}.id)=1
    AND (SELECT MAX(seq) FROM episodes pe WHERE pe.drama_id=${alias}.id)
        =(SELECT COUNT(*) FROM episodes pe WHERE pe.drama_id=${alias}.id)
    AND (SELECT COUNT(*) FROM platform_media_episodes me WHERE me.drama_id=${alias}.id)
        =(SELECT COUNT(*) FROM episodes pe WHERE pe.drama_id=${alias}.id)
    AND NOT EXISTS (SELECT 1 FROM episodes pe WHERE pe.drama_id=${alias}.id
      AND NOT EXISTS (SELECT 1 FROM platform_media_episodes me WHERE me.drama_id=${alias}.id
        AND me.local_episode_id=pe.id AND me.seq=pe.seq
        AND me.episode_id=pe.platform_episode_id AND me.vid=pe.byteplus_vid
        AND LENGTH(TRIM(me.episode_id))>0 AND LENGTH(TRIM(me.vid))>0))`
}

/** 只判断平台交付条件；不修改、撤销已有订单或权益。 */
export function platformMediaReady(ctx: CatalogContext, dramaId: number): boolean {
  return Boolean(ctx.db.prepare(`SELECT id FROM dramas WHERE id=? AND ${platformMediaCondition(ctx)}`).get(dramaId))
}

/** Shared by catalog, details, playback, library, assets and new purchases. */
export function publicDramaCondition(ctx: Pick<AppContext, 'config'>, alias: 'dramas' | 'd' = 'dramas'): string {
  const languages = CONTENT_LANGUAGES.map(language => `'${language}'`).join(',')
  const region = ctx.config.catalogRegion ?? 'JP'
  if (!/^[A-Z]{2}$/.test(region)) return '0'
  const local = `${alias}.status='published' AND ${alias}.language IN (${languages}) AND EXISTS (SELECT 1 FROM json_each(${alias}.regions) WHERE value='${region}')`
  if (ctx.config.mode === 'local') return local
  return `${local} AND ${platformMediaCondition(ctx, alias)}`
}

/** The same private-file check used when publishing and issuing local playback. */
export function fileReady(ctx: CatalogContext, value: unknown, kind: string): boolean {
  if (!value) return false
  const row = ctx.db.prepare('SELECT * FROM assets WHERE id=? AND kind=?').get(String(value), kind)
  if (!row) return false
  const root = resolve(ctx.config.dataDir, 'uploads') + sep, path = resolve(String(row.storage_path))
  if (!path.startsWith(root) || path.slice(root.length).includes(sep)) return false
  try { const info = lstatSync(path); return info.isFile() && !info.isSymbolicLink() && info.size === Number(row.bytes) } catch { return false }
}

/** Checks delivery, not ownership or price; never use to reject a verified receipt. */
export function canPurchaseContent(ctx: CatalogContext, kind: 'episode' | 'drama', targetId: number | null): boolean {
  const episodes = ctx.db.prepare(`SELECT e.asset_id FROM episodes e JOIN dramas d ON d.id=e.drama_id
    WHERE ${kind === 'episode' ? 'e.id' : 'd.id'}=? AND ${publicDramaCondition(ctx, 'd')}`).all(targetId)
  return episodes.length > 0 && (ctx.config.mode !== 'local' ||
    episodes.every(episode => fileReady(ctx, episode.asset_id, 'video')))
}
