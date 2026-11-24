const WINDOW = 120000
const identityFields = ['visitor_key','account_key','journey_key','environment','market','drama_id','content_language','content_version','media_version']
const identity = e => JSON.stringify(identityFields.map(key => e[key] ?? null))
export const episodeScopeKey = e => JSON.stringify([e.drama_id, e.episode_id, e.content_language ?? null, e.content_version ?? null, e.media_version ?? null])

function coveredThrough(rows, end) {
  const duration = end.properties.durationMs
  if (!(duration > 0)) return false
  const intervals = rows.filter(e => e.occurred_at <= end.occurred_at)
    .flatMap(e => e.properties.segments ?? []).map(([a,b]) => [Math.max(0,a), Math.min(duration,b)])
    .filter(([a,b]) => b > a).sort((a,b) => a[0] - b[0])
  let covered = 0, through = 0
  for (const [a,b] of intervals) { if (b > through) covered += b - Math.max(through, a); through = Math.max(through, b) }
  return covered / duration >= .9 && rows.some(e => e.occurred_at <= end.occurred_at && e.properties.watchedMs >= 3000)
}
function summary(origins, incomplete, boundary) {
  const count = name => origins.filter(e => e.outcome === name).length
  const eligible = origins.filter(e => e.eligible)
  const preferenceObserved = eligible.filter(e => e.autoPlayDisabled != null)
  const frames = eligible.filter(e => e.frame).length
  const pending = count('observing')
  const mature = eligible.filter(e => boundary && e.event.occurred_at + WINDOW < boundary.clientCompleteBefore).length
  return {
    completeOrigins: origins.length, eligibleOrigins: eligible.length, nextRequests: eligible.filter(e => e.request).length,
    nextFirstFrames: frames, nextQualified: eligible.filter(e => e.qualified).length, pendingOrigins: pending,
    rate: { numerator: frames, denominator: eligible.length, value: !incomplete && !pending && eligible.length ? frames / eligible.length : null },
    exclusions: { versionEnd: count('version_end'), missingSupply: count('missing'), unavailableSupply: count('unavailable'), unknownSupply: count('unknown') },
    outcomes: { continued: count('continued'), playbackFailed: count('playback_failed'), laterReturn: count('later'),
      paidWithoutFrame: count('paid'), requestedWithoutFrame: count('requested'), unobserved: count('unobserved'), observing: pending },
    associationUnknown: origins.filter(e => !e.associationKnown).length,
    observation: { status: incomplete ? 'partial_history' : pending ? 'observing' : !boundary ? 'processing_unknown'
      : mature < eligible.length ? 'late_window' : 'mature', matureOrigins: mature,
      provisionalOrigins: eligible.length - mature, allowedLatenessDays: 7 },
    autoPlayDisabled: preferenceObserved.length ? preferenceObserved.filter(e => e.autoPlayDisabled).length : null,
    autoPlayPreferenceObserved: preferenceObserved.length, detailIncomplete: incomplete, windowMs: WINDOW,
    definition: '以同身份、作品、实际语言、内容及媒资版本、journey的合格完成起点关联下一集请求与首帧；120秒为产品观察假设。按完成日入组，期间重试成功也计一次；后续沿原起点关联，不把后集播放总数相除。收费仍在分母。连播选择只取同次播放开始至接续请求或观察窗结束前的最后显式操作；刷新恢复、无事件或顺序不明保持未知，不从未接续反推主动关闭。关闭与实际接续可能同时出现，不能据此断言未接续原因；迟到窗内为暂计，可随补报变化。',
    supplyDefinition: '只用完成前已接收、匹配原播放请求及版本的供给观测；这不是平台完整历史供给。“本版本末集”不代表全剧完结；未观测历史保持未知。',
  }
}
export function continuationReport(parsed, observations, selectOrigin, now, incomplete = false, boundary = null) {
  const grouped = new Map()
  for (const event of parsed) {
    if (event.source !== 'client' || !event.playback_key || !event.episode_id || event.occurred_at > now) continue
    if (!grouped.has(event.playback_key)) grouped.set(event.playback_key, [])
    grouped.get(event.playback_key).push(event)
  }
  const attempts = [...grouped.entries()].map(([id, rows]) => {
    rows.sort((a,b) => a.occurred_at - b.occurred_at || a.id.localeCompare(b.id))
    const preferences = rows.filter(e => e.name === 'autoplay_change')
    // A malformed preference association must not invalidate genuine playback.
    rows = rows.filter(e => e.name !== 'autoplay_change')
    const request = rows.find(e => e.name === 'play_request')
    const key = request ? identity(request) : null
    // In particular, never promote an anonymous request to a logged-in completion
    // merely because the old playback projection coalesced the account.
    const valid = Boolean(request && request.content_version != null && request.content_language &&
      (request.player_type !== 'tiktok' || request.media_version != null) &&
      rows.filter(e => e.name === 'play_request').length === 1 &&
      !rows.some(e => identity(e) !== key || e.episode_id !== request.episode_id ||
        JSON.parse(e.quality_flags ?? '[]').includes('content_changed_since_render')))
    const later = request ? rows.filter(e => e.occurred_at >= request.occurred_at) : rows
    const end = later.find(e => e.name === 'play_end' &&
      coveredThrough(later.filter(row => identity(row) === identity(e) && row.episode_id === e.episode_id), e))
    return { id, rows: later, preferences, request, end, key, valid }
  })
  const nextByIdentity = new Map()
  for (const item of attempts.filter(e => e.valid)) {
    const key = `${item.key}:${item.request.episode_id}`
    if (!nextByIdentity.has(key)) nextByIdentity.set(key, [])
    nextByIdentity.get(key).push(item)
  }
  const used = new Set(), origins = [], nextCompletion = new Map()
  // Assign before applying report filters. A completion just outside the selected
  // day still owns its next attempt; an earlier day must not steal that frame.
  for (const item of attempts.filter(e => e.end).sort((a,b) => b.end.occurred_at - a.end.occurred_at)) {
    const completionKey = `${identity(item.end)}:${item.end.episode_id}`
    const until = nextCompletion.get(completionKey) ?? Infinity
    nextCompletion.set(completionKey, item.end.occurred_at)
    if (!selectOrigin(item.end)) continue
    const origin = { event: item.end, eligible: false, outcome: 'unknown', frame: false, request: false,
      qualified: false, associationKnown: item.valid }
    if (!item.valid) { origins.push(origin); continue }
    const supply = observations.get(item.request.id)
    const known = supply && supply.observedAt <= item.end.occurred_at && supply.observedAt >= item.request.received_at - 1 &&
      supply.episodeId === item.request.episode_id && supply.contentVersion === item.request.content_version &&
      supply.mediaVersion === item.request.media_version
    if (!known) { origins.push(origin); continue }
    if (supply.availability !== 'available' || !supply.nextEpisodeId) {
      origin.outcome = ['version_end','missing','unavailable'].includes(supply.availability) ? supply.availability : 'unknown'
      origins.push(origin); continue
    }
    origin.eligible = true
    const next = (nextByIdentity.get(`${item.key}:${supply.nextEpisodeId}`) ?? [])
      .filter(e => !used.has(e.id) && e.request.occurred_at >= item.end.occurred_at &&
        e.request.occurred_at < until && e.id !== item.id)
    const deadline = item.end.occurred_at + WINDOW
    const preferenceUntil = Math.min(deadline, ...next.map(e => e.request.occurred_at))
    const choices = item.preferences.filter(e => identity(e) === item.key && e.episode_id === item.request.episode_id &&
      e.occurred_at >= item.request.occurred_at && e.occurred_at <= preferenceUntil && e.occurred_at < until &&
      typeof e.properties.autoNext === 'boolean' && !JSON.parse(e.quality_flags ?? '[]').includes('content_changed_since_render'))
    const lastAt = choices.at(-1)?.occurred_at
    const last = choices.filter(e => e.occurred_at === lastAt)
    // Same-millisecond contradictory actions have no reliable order in v2.
    if (last.length && last.every(e => e.properties.autoNext === last[0].properties.autoNext)) {
      origin.autoPlayDisabled = !last[0].properties.autoNext
    }
    for (const retry of next) used.add(retry.id)
    const frames = next.flatMap(retry => retry.rows
      .filter(e => e.name === 'first_frame' && e.properties.hasFrameSignal !== false && e.occurred_at < until)
      .map(frame => ({ frame, retry })))
    origin.request = next.some(e => e.request.occurred_at <= deadline)
    origin.frame = frames.some(({ frame }) => frame.occurred_at <= deadline)
    origin.qualified = frames.some(({ frame, retry }) => frame.occurred_at <= deadline && retry.rows.some(e =>
      e.properties.watchedMs >= 3000 && e.occurred_at >= frame.occurred_at && e.occurred_at <= deadline && e.occurred_at < until))
    origin.outcome = origin.frame ? 'continued' : frames.length ? 'later'
      : next.some(retry => retry.rows.some(e => e.name === 'play_error' && e.occurred_at <= deadline && e.occurred_at < until)) ? 'playback_failed'
        : supply.paid ? 'paid' : origin.request ? 'requested' : 'unobserved'
    if (!origin.frame && deadline > now) origin.outcome = 'observing'
    origins.push(origin)
  }
  return { ...summary(origins, incomplete, boundary), origins,
    forContent: (id, language) => summary(origins.filter(e => e.event.drama_id === id && (e.event.content_language ?? null) === language), incomplete, boundary),
    forEpisode: key => summary(origins.filter(e => episodeScopeKey(e.event) === key), incomplete, boundary) }
}
