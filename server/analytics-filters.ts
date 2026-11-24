import { ANALYTICS_TIMEZONES, ANALYTICS_DEVICE_SYSTEMS, ANALYTICS_NETWORK_TYPES,
  ANALYTICS_NETWORK_QUALITIES, ANALYTICS_NETWORK_SOURCES, ANALYTICS_PLAYER_TYPES,
  analyticsEnvironment } from '../shared/analytics.js'
import { DRAMA_TEXT_LOCALES } from '../shared/drama-localizations.js'
import { ApiError, type AppContext } from './types.js'

export const ANALYTICS_FILTER_KEYS = ['from','to','timezone','market','uiLanguage','contentLanguage','channelLanguage',
  'dramaId','episodeId','sectionId','entrySource','deviceOS','playerType','networkType','networkQuality','networkSource',
  'buildId','includeSamples','contentVersion','mediaVersion','channelVersion'] as const
export function parseAnalyticsFilters(q: Record<string, unknown>, ctx: Pick<AppContext, 'config'>, now = Date.now()) {
  const invalid = () => new ApiError(400, 'INVALID_ANALYTICS_FILTER', '统计筛选格式或范围不正确')
  if (Object.keys(q).some(k => !(ANALYTICS_FILTER_KEYS as readonly string[]).includes(k)) ||
    Object.values(q).some(v => typeof v !== 'string')) throw invalid()
  const timezone = String(q.timezone ?? 'Asia/Shanghai')
  if (!(ANALYTICS_TIMEZONES as readonly string[]).includes(timezone)) throw invalid()
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map(p => [p.type, p.value]))
  const today = `${parts.year}-${parts.month}-${parts.day}`
  const from = String(q.from ?? new Date(Date.parse(today + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0, 10))
  const to = String(q.to ?? today)
  for (const day of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) ||
      new Date(day).toISOString().slice(0, 10) !== day) throw invalid()
  }
  if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000) throw invalid()
  if (q.market && !/^[A-Z]{2}$/.test(String(q.market))) throw invalid()
  for (const key of ['uiLanguage','contentLanguage','channelLanguage']) if (q[key] && !DRAMA_TEXT_LOCALES.includes(q[key] as never)) throw invalid()
  for (const key of ['dramaId','episodeId','contentVersion','mediaVersion','channelVersion']) {
    if (q[key] !== undefined && q[key] !== '' &&
      (!(key === 'channelVersion' ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(String(q[key])) || !Number.isSafeInteger(Number(q[key])))) throw invalid()
  }
  for (const key of ['sectionId','entrySource','buildId']) if (q[key] && !/^[\p{L}\p{N}_.:-]{1,100}$/u.test(String(q[key]))) throw invalid()
  for (const [key, values] of [
    ['deviceOS',ANALYTICS_DEVICE_SYSTEMS], ['playerType',ANALYTICS_PLAYER_TYPES], ['networkType',ANALYTICS_NETWORK_TYPES],
    ['networkQuality',ANALYTICS_NETWORK_QUALITIES], ['networkSource',ANALYTICS_NETWORK_SOURCES],
  ] as const) if (q[key] && !(values as readonly unknown[]).includes(q[key])) throw invalid()
  if (q.includeSamples && !['true','false'].includes(String(q.includeSamples))) throw invalid()
  return { ...q, from, to, timezone, environment: analyticsEnvironment(ctx.config.mode),
    dramaId: q.dramaId ? Number(q.dramaId) : undefined, episodeId: q.episodeId ? Number(q.episodeId) : undefined,
    contentVersion: q.contentVersion ? Number(q.contentVersion) : undefined,
    mediaVersion: q.mediaVersion ? Number(q.mediaVersion) : undefined,
    channelVersion: q.channelVersion !== undefined && q.channelVersion !== '' ? Number(q.channelVersion) : undefined,
    includeSamples: q.includeSamples ? q.includeSamples === 'true' : ctx.config.mode === 'local' }
}
