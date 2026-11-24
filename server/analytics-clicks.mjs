/** Attribute within the selected window using occurrence time, not arrival order. */
export function clicksAfterExposure(events, scopeFields = []) {
  const key = event => JSON.stringify([event.market, event.visitor_key, event.drama_id, ...scopeFields.map(field => event[field] ?? null)])
  const firstExposure = new Map()
  for (const event of events) {
    if (event.source !== 'client' || event.name !== 'card_impression' ||
        !event.visitor_key || !event.drama_id || !Number.isFinite(event.occurred_at)) continue
    const identity = key(event)
    firstExposure.set(identity, Math.min(firstExposure.get(identity) ?? Infinity, event.occurred_at))
  }
  return events.filter(event => event.source === 'client' && event.name === 'card_click' &&
    Number.isFinite(event.occurred_at) && event.occurred_at >= (firstExposure.get(key(event)) ?? Infinity))
}
