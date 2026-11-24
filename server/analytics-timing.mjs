/** Preserve the existing segment/cumulative protocol for reports and ranking. */
export function timingSlices(rows) {
  const segmented = new Set(rows.filter(e => e.source === 'client' && e.playback_key &&
    (e.properties.timingVersion === 2 || e.properties.wallDeltaMs !== undefined || e.properties.stallDeltaMs !== undefined)).map(e => e.playback_key))
  const previous = new Map(), result = []
  for (const e of rows) {
    if (e.source !== 'client' || !e.playback_key) continue
    const old = previous.get(e.playback_key) ?? { wall: 0, stall: 0 }, p = e.properties
    const wall = Math.max(old.wall, p.wallMs ?? 0), stall = Math.max(old.stall, p.stallMs ?? 0)
    const wallValue = segmented.has(e.playback_key) ? p.wallDeltaMs ?? 0 : wall - old.wall
    const stallValue = segmented.has(e.playback_key) ? p.stallDeltaMs ?? 0 : stall - old.stall
    previous.set(e.playback_key, { wall, stall })
    result.push({ ...e, wallValue, stallValue, rebufferMeasured: p.timingVersion === 2 && p.hasRebufferSignal === true })
  }
  return result
}
