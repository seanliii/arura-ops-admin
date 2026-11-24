import {createHash} from 'node:crypto'
const formatters = new Map()
export function dayAt(time, timezone) {
  let format = formatters.get(timezone)
  if (!format) {
    format = new Intl.DateTimeFormat('en', { timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(timezone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(time).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
export function decimalAdd(a, b) {
  const parse = value => {
    const match = /^(-?)(\d+)(?:\.(\d{1,9}))?$/.exec(String(value))
    if (!match) throw Object.assign(new Error('Unconfirmed money format'), { code: 'ANALYTICS_MONEY_FORMAT' })
    return { integer: BigInt((match[1] || '') + match[2] + (match[3] || '')), scale: (match[3] || '').length }
  }
  const x = parse(a), y = parse(b), scale = Math.max(x.scale, y.scale)
  const result = x.integer * 10n ** BigInt(scale - x.scale) + y.integer * 10n ** BigInt(scale - y.scale)
  const sign = result < 0n ? '-' : '', text = String(result < 0n ? -result : result).padStart(scale + 1, '0')
  return scale ? sign + (text.slice(0, -scale) + '.' + text.slice(-scale)).replace(/\.?0+$/, '') : sign + text
}
const dimensionFields=['environment','market','country','uiLanguage','contentLanguage','channelLanguage','audioLanguage','subtitleLanguage','subtitleMode',
  'dramaId','workId','episodeId','mediaVersion','contentVersion','channelVersion','sectionId','position','entrySource','deviceOS','playerType','networkType','networkQuality','networkSource','buildId','sample','experimentId','variant']
export function eventDimensions(e){
  return Object.fromEntries(dimensionFields.map(key=>[key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()).replace('device_o_s','device_os'),key==='sample'?Number(e[key]):e[key]??null]))
}
export function projectDimensions(db,e,zones,wallDelta=0,stallDelta=0){
  const dimensions=eventDimensions(e),json=JSON.stringify(dimensions),scope=createHash('sha256').update(json).digest('hex')
  const add=(name,count,value)=>{for(const timezone of zones)db.prepare(`INSERT INTO analytics_summary(day,timezone,scope_key,dimensions,name,count,value)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(day,timezone,scope_key,name) DO UPDATE SET count=count+excluded.count,value=value+excluded.value`)
    .run(dayAt(e.occurredAt,timezone),timezone,scope,json,name,count,value)}
  add(e.name,1,0)
  if(wallDelta>0)add('watch_wall_ms',0,wallDelta)
  if(stallDelta>0)add('stall_ms',0,stallDelta)
  if(e.properties.timingVersion===2&&e.properties.hasRebufferSignal===true){
    if(wallDelta>0)add('measured_watch_wall_ms',0,wallDelta)
    if(stallDelta>0)add('measured_rebuffer_ms',0,stallDelta)
  }
  const p=e.properties
  if(e.source==='client'&&e.accountKey&&e.dramaId&&(p.watchedMs??0)>=3000&&(wallDelta>0||e.name==='qualified_play')){
    db.prepare(`INSERT INTO analytics_retention_first(account_key,scope_key,dimensions,first_seen) VALUES(?,?,?,?)
      ON CONFLICT(account_key,scope_key) DO UPDATE SET first_seen=MIN(first_seen,excluded.first_seen)`).run(e.accountKey,scope,json,e.occurredAt)
    for(const timezone of zones)db.prepare(`INSERT INTO analytics_retention_days(day,timezone,account_key,scope_key,dimensions,first_seen)
      VALUES(?,?,?,?,?,?) ON CONFLICT(day,timezone,account_key,scope_key) DO UPDATE SET first_seen=MIN(first_seen,excluded.first_seen)`)
      .run(dayAt(e.occurredAt,timezone),timezone,e.accountKey,scope,json,e.occurredAt)
  }
  if(e.source==='server'&&['payment_confirmed','refund_confirmed','subscription_charge','subscription_refund'].includes(e.name)){
    const money=e.amountText??(e.amount==null?null:String(e.amount))
    db.prepare('INSERT OR IGNORE INTO analytics_money(id,name,occurred_at,dimensions,amount_text,currency,pricing_confirmed) VALUES(?,?,?,?,?,?,?)')
      .run(e.id,e.name,e.occurredAt,json,money,e.currency,Number(money!==null))
  }else if(e.source==='server'&&['subscription_charge_priced','subscription_refund_priced'].includes(e.name)){
    const id=e.id.replace(/:priced$/,'')
    db.prepare('UPDATE analytics_money SET amount_text=?,currency=?,pricing_confirmed=1 WHERE id=? AND pricing_confirmed=0').run(e.amountText,e.currency,id)
  }
}
function daily(db, e, name, count, value, zones) {
  for (const timezone of zones) {
    db.prepare(`INSERT INTO analytics_daily(day,timezone,environment,market,content_language,drama_id,episode_id,name,currency,sample,count,value)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(day,timezone,environment,market,content_language,drama_id,episode_id,name,currency,sample)
      DO UPDATE SET count=count+excluded.count,value=value+excluded.value`).run(
      dayAt(e.occurredAt, timezone),timezone,e.environment,e.market,e.contentLanguage ?? '',e.dramaId ?? 0,e.episodeId ?? 0,
      name,e.currency ?? '',Number(e.sample),count,value)
    if (e.source === 'server' && ['payment_confirmed','refund_confirmed','subscription_charge','subscription_refund','subscription_charge_priced','subscription_refund_priced'].includes(name)) {
      const money = e.amountText ?? (e.amount == null ? null : String(e.amount))
      if (money !== null) {
        const values = [dayAt(e.occurredAt, timezone),timezone,e.environment,e.market,e.contentLanguage ?? '',e.dramaId ?? 0,e.episodeId ?? 0,name,e.currency ?? '',Number(e.sample)]
        const old = db.prepare(`SELECT money_text FROM analytics_daily WHERE day=? AND timezone=? AND environment=? AND market=? AND content_language=?
          AND drama_id=? AND episode_id=? AND name=? AND currency=? AND sample=?`).get(...values)
        db.prepare(`UPDATE analytics_daily SET money_text=? WHERE day=? AND timezone=? AND environment=? AND market=? AND content_language=?
          AND drama_id=? AND episode_id=? AND name=? AND currency=? AND sample=?`).run(decimalAdd(old.money_text,money),...values)
      }
    }
  }
}
function intervals(previous, added, duration) {
  const sorted = [...previous,...added].filter(p => Array.isArray(p) && p.length === 2 && p[1] >= p[0])
    .map(([a,b]) => [Math.max(0,a),duration > 0 ? Math.min(duration,b) : b]).filter(([a,b]) => b > a).sort((a,b) => a[0]-b[0])
  const result = []
  for (const item of sorted) {
    const last = result[result.length-1]
    if (last && item[0] <= last[1] + .01) last[1] = Math.max(last[1],item[1])
    else result.push(item)
  }
  return result
}
const min = (a,b) => a == null ? b : b == null ? a : Math.min(a,b)
const playbackNames = new Set(['play_request','first_frame','qualified_play','play_segment','play_pause','play_seek','play_end','play_error','stall_start','stall_end'])
export function projectEvent(db, e, zones) {
  daily(db,e,e.name,1,0,zones)
  if (e.source !== 'client' || !e.playbackKey || !e.dramaId || !e.episodeId || !playbackNames.has(e.name)) {projectDimensions(db,e,zones);return}
  const p = e.properties
  const columns = {
    id:e.playbackKey,visitor_key:e.visitorKey,account_key:e.accountKey,journey_key:e.journeyKey,
    environment:e.environment,market:e.market,country:e.country,ui_language:e.uiLanguage,content_language:e.contentLanguage,
    channel_language:e.channelLanguage ?? null,audio_language:e.audioLanguage,subtitle_language:e.subtitleLanguage,subtitle_mode:e.subtitleMode,
    drama_id:e.dramaId,episode_id:e.episodeId,sample:Number(e.sample),media_version:e.mediaVersion,content_version:e.contentVersion,
    channel_version:e.channelVersion,section_id:e.sectionId,position:e.position,entry_source:e.entrySource,device_os:e.deviceOS,
    player_type:e.playerType,network_type:e.networkType,network_quality:e.networkQuality??'unknown',network_source:e.networkSource??'unrecorded',
    build_id:e.buildId,updated_at:e.receivedAt,timing_version:p.timingVersion===2?2:1,rebuffer_signal:Number(p.hasRebufferSignal===true),
  }
  db.prepare(`INSERT OR IGNORE INTO analytics_playbacks(${Object.keys(columns).join(',')}) VALUES(${Object.keys(columns).map(()=>'?').join(',')})`).run(...Object.values(columns))
  const old = db.prepare('SELECT * FROM analytics_playbacks WHERE id=?').get(e.playbackKey)
  if (old.drama_id !== e.dramaId || old.episode_id !== e.episodeId || old.visitor_key !== e.visitorKey ||
      (old.account_key && e.accountKey && old.account_key !== e.accountKey)) {
    throw Object.assign(new Error('Playback identity conflict'), { code: 'ANALYTICS_EVENT_CONFLICT' })
  }
  if (e.name === 'play_request' && (old.requested_at === null || e.occurredAt < old.requested_at)) {
    // Arrival order is not event order: a buffered first-frame event can arrive
    // first. Classify playback attempts by the actual request snapshot, without
    // rewriting the raw events or moving already-recorded watch segments.
    const fields = ['environment','market','country','ui_language','content_language','channel_language','audio_language',
      'subtitle_language','subtitle_mode','sample','media_version','content_version','channel_version','section_id','position',
      'entry_source','device_os','player_type','network_type','network_quality','network_source','build_id','timing_version','rebuffer_signal']
    db.prepare(`UPDATE analytics_playbacks SET ${fields.map(key=>key+'=?').join(',')} WHERE id=?`)
      .run(...fields.map(key=>columns[key]),e.playbackKey)
  }
  const watched = Math.max(old.watched_ms,p.watchedMs ?? 0), wall = Math.max(old.wall_ms,p.wallMs ?? 0)
  const stalled = Math.max(old.stall_ms,p.stallMs ?? 0), duration = Math.max(old.duration_ms,p.durationMs ?? 0)
  const coverage = intervals(JSON.parse(old.intervals),p.segments ?? [],duration)
  const covered = coverage.reduce((sum,[a,b])=>sum+b-a,0)
  const qualifiedAt = (p.watchedMs ?? 0) >= 3000 ? min(old.qualified_at,e.occurredAt) : old.qualified_at
  const frameAt = e.name === 'first_frame' ? min(old.first_frame_at,e.occurredAt) : old.first_frame_at
  const frameMs = e.name === 'first_frame' ? min(old.first_frame_ms,p.firstFrameMs ?? null) : old.first_frame_ms
  db.prepare(`UPDATE analytics_playbacks SET account_key=COALESCE(account_key,?),requested_at=?,first_frame_at=?,first_frame_ms=?,
    frame_signal=?,qualified_at=?,watched_ms=?,wall_ms=?,stall_ms=?,duration_ms=?,coverage_ms=?,intervals=?,ended_at=?,error_code=?,updated_at=? WHERE id=?`).run(
    e.accountKey,e.name==='play_request'?min(old.requested_at,e.occurredAt):old.requested_at,frameAt,frameMs,
    old.frame_signal || Number(p.hasFrameSignal === true),qualifiedAt,watched,wall,stalled,duration,covered,JSON.stringify(coverage),
    e.name==='play_end'?min(old.ended_at,e.occurredAt):old.ended_at,p.errorCode ?? old.error_code,e.receivedAt,e.playbackKey)
  const wallDelta=p.wallDeltaMs??(p.timingVersion===2?0:Math.max(0,wall-old.wall_ms))
  const stallDelta=p.stallDeltaMs??(p.timingVersion===2?0:Math.max(0,stalled-old.stall_ms))
  if (wallDelta>0) daily(db,e,'watch_wall_ms',0,wallDelta,zones)
  if (stallDelta>0) daily(db,e,'stall_ms',0,stallDelta,zones)
  projectDimensions(db,e,zones,wallDelta,stallDelta)
  if ((p.watchedMs ?? 0) >= 3000 && qualifiedAt != null && e.accountKey) {
    db.prepare(`INSERT INTO analytics_actor_first(account_key,environment,market,content_language,drama_id,first_seen)
      VALUES(?,?,?,?,?,?) ON CONFLICT(account_key,environment,market,content_language,drama_id)
      DO UPDATE SET first_seen=MIN(first_seen,excluded.first_seen)`).run(e.accountKey,e.environment,e.market,e.contentLanguage??'',e.dramaId,qualifiedAt)
    for (const timezone of zones) {
      db.prepare(`INSERT INTO analytics_actor_days(day,timezone,account_key,environment,market,content_language,drama_id,first_seen,watched_ms)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(day,timezone,account_key,environment,market,content_language,drama_id)
        DO UPDATE SET first_seen=MIN(first_seen,excluded.first_seen),watched_ms=watched_ms+excluded.watched_ms`).run(
        dayAt(e.occurredAt,timezone),timezone,e.accountKey,e.environment,e.market,e.contentLanguage??'',e.dramaId,qualifiedAt,Math.max(0,wall-old.wall_ms))
    }
  }
}
