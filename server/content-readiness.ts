import type { AppContext } from './types.js'
import type { ReadinessIssue } from '../shared/content-operations.js'
import { fileReady, platformMediaReady } from './catalog-policy.js'
import { readDelivery } from './content-delivery.js'

/** 展示和真正发布共用；只读当前事实，不同步平台、不补写历史。 */
export function publishIssues(ctx: AppContext, row: Record<string, any>): ReadinessIssue[] {
  const episodes = ctx.db.prepare('SELECT * FROM episodes WHERE drama_id=? ORDER BY seq').all(Number(row.id))
  const issues: ReadinessIssue[] = []
  function add(field: string, label: string, step: ReadinessIssue['step'], code = 'PUBLISH_INCOMPLETE', status = 422) {
    issues.push({ field, label, step, code, status })
  }
  if (!row.rights_confirmed) add('rightsConfirmed', '确认作品与素材的使用权', 'publish')
  if (!fileReady(ctx, row.cover_asset_id, 'cover')) add('cover', '补充有效的剧目封面', 'basic')
  if (!episodes.length || episodes.some((e, i) => Number(e.seq) !== i + 1)) add('episodes', '补齐从第1集开始的连续剧集', 'episodes')
  if (Number(row.free_episodes) > episodes.length) add('freeEpisodes', '免费集数不能超过总集数', 'publish')
  const delivery = readDelivery(row.delivery_profile, String(row.language))
  if (delivery.subtitleMode === 'external' && episodes.some(e => !e.subtitle_asset_id)) {
    add('subtitles', '已声明可切换字幕，每集必须关联实际字幕文件；烧录字幕请选择画面字幕', 'episodes')
  }
  if (ctx.config.mode !== 'local') {
    if (!ctx.config.tiktokClientKey || !ctx.config.tiktokClientSecret || !platformMediaReady(ctx, Number(row.id))) {
      add('platform', '发布需要平台凭据、同步本地当前版本、完整连续单集映射、平台审核批准、相同在线版本、平台已上架及当前App授权', 'publish', 'PLATFORM_NOT_READY', 503)
    }
  } else if (episodes.some(e => !fileReady(ctx, e.asset_id, 'video'))) add('videos', '每一集必须有完整视频', 'episodes')
  if (episodes.some(e => e.subtitle_asset_id && !fileReady(ctx, e.subtitle_asset_id, 'subtitle'))) add('subtitles', '字幕文件不可用', 'episodes')
  return issues
}
