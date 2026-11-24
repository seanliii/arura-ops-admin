import type { AnalyticsClientEvent, AnalyticsSupplyObservation } from '../shared/analytics.js'
import { fileReady } from './catalog-policy.js'
import { readRegistrationMetadata } from './registration-metadata.js'
import type { AppContext } from './types.js'

/** 只在请求接收时观测；报告还必须核对 observedAt 不晚于完成。 */
export function observeAnalyticsSupply(ctx: AppContext, e: AnalyticsClientEvent,
  drama: Record<string, any> | undefined, episode: Record<string, any> | undefined,
  mediaVersion: number | null, now: number): AnalyticsSupplyObservation | undefined {
  if (e.name !== 'play_request' || !drama || !episode || e.context?.contentVersion !== Number(drama.version)) return
  const next = ctx.db.prepare('SELECT id,asset_id FROM episodes WHERE drama_id=? AND seq=?').get(drama.id, Number(episode.seq) + 1)
  const metadata = readRegistrationMetadata(drama.registration_metadata)
  const lastSeq = Number(ctx.db.prepare('SELECT max(seq) n FROM episodes WHERE drama_id=?').get(drama.id)!.n)
  const missing = !next && (lastSeq > Number(episode.seq) || (metadata.totalEpisodes ?? 0) > Number(episode.seq))
  return {
    observedAt: now, contentVersion: Number(drama.version), mediaVersion, episodeId: Number(episode.id),
    nextEpisodeId: next ? Number(next.id) : null,
    availability: next ? (ctx.config.mode !== 'local' || fileReady(ctx, next.asset_id, 'video') ? 'available' : 'unavailable')
      : missing ? 'missing' : 'version_end',
    paid: Boolean(next && Number(episode.seq) + 1 > Number(drama.free_episodes)),
    seriesComplete: !next && metadata.albumStatus === 3 && metadata.totalEpisodes === Number(episode.seq),
  }
}
