import { dayAt, decimalAdd } from './analytics-projections.mjs'
import { clicksAfterExposure } from './analytics-clicks.mjs'
import { timingSlices } from './analytics-timing.mjs'
import { continuationReport, episodeScopeKey } from './analytics-continuation.mjs'
const stages = [
  ['impression','card_impression','看到剧'],['click','card_click','点击剧目'],['detail','detail_view','详情可见'],
  ['request','play_request','请求播放'],['firstFrame','first_frame','出现首帧'],['qualified','qualified_play','有效观看'],
  ['paywall','paywall_view','到达付费点'],['purchaseClick','purchase_click','点击购买'],['order','order_created','服务端建单'],
  ['paid','payment_confirmed','确认付款'],['entitlement','entitlement_granted','权益生效'],['resumed','play_after_purchase','原集续播'],
]
const rate = (numerator,denominator) => ({ numerator,denominator,value:denominator ? numerator/denominator : null })
const distinct = (rows,key) => new Set(rows.map(key).filter(x=>x!==null && x!==undefined)).size
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b)
  return sorted.length ? sorted[Math.max(0,Math.ceil(sorted.length*p)-1)] : null
}
function match(e,f) {
  return (!f.market || e.market===f.market) && (!f.uiLanguage || e.ui_language===f.uiLanguage)
    && (!f.contentLanguage || e.content_language===f.contentLanguage) && (!f.channelLanguage || e.channel_language===f.channelLanguage)
    && (!f.dramaId || e.drama_id===f.dramaId) && (!f.episodeId || e.episode_id===f.episodeId) && (!f.sectionId || e.section_id===f.sectionId)
    && (!f.entrySource || e.entry_source===f.entrySource) && (!f.deviceOS || e.device_os===f.deviceOS)
    && (!f.playerType || (e.player_type??'unknown')===f.playerType)
    && (!f.networkType || (e.network_type??'unknown')===f.networkType)
    && (!f.networkQuality || (e.network_quality??'unknown')===f.networkQuality)
    && (!f.networkSource || (e.network_source??'unrecorded')===f.networkSource)
    && (!f.buildId || e.build_id===f.buildId) && (f.includeSamples || !e.sample)
    && (f.contentVersion == null || e.content_version===f.contentVersion)
    && (f.mediaVersion == null || e.media_version===f.mediaVersion)
    && (f.channelVersion == null || e.channel_version===f.channelVersion)
}
function inDate(time,f) { const day=dayAt(time,f.timezone); return day>=f.from && day<=f.to }
function orderEvents(events,name,source) {
  const result=new Map()
  for(const e of events){
    if(e.name!==name||e.source!==source||!e.order_id)continue
    if(!result.has(e.order_id))result.set(e.order_id,[])
    result.get(e.order_id).push(e)
  }
  return result
}
function sameOrderContent(order,event) {
  return order.order_id&&order.order_id===event.order_id&&order.account_key&&order.account_key===event.account_key
    &&order.environment===event.environment&&order.market===event.market&&order.drama_id!==null&&order.drama_id===event.drama_id
    &&(order.episode_id===null||order.episode_id===event.episode_id)
}
function nextOrderEvent(index,previous) {
  return index.get(previous.order_id)?.find(e=>sameOrderContent(previous,e)&&e.occurred_at>=previous.occurred_at)
}
function retention(db,f,now,boundary) {
  const firstRows=db.prepare('SELECT * FROM analytics_retention_first').all().map(e=>({...e,...JSON.parse(e.dimensions)})).filter(e=>match(e,f))
  const first=new Map()
  for(const row of firstRows) first.set(row.account_key,Math.min(first.get(row.account_key)??Infinity,row.first_seen))
  const activeRows=db.prepare('SELECT * FROM analytics_retention_days WHERE timezone=? AND day>=? AND day<=?').all(f.timezone,f.from,dayAt(now,f.timezone))
    .map(e=>({...e,...JSON.parse(e.dimensions)})).filter(e=>match(e,f))
  const active=new Set(activeRows.map(e=>e.account_key+':'+e.day)), cohorts=new Map()
  const today=dayAt(now,f.timezone)
  for(const [account,at] of first) {
    const day=dayAt(at,f.timezone)
    if(day<f.from || day>f.to)continue
    if(!cohorts.has(day))cohorts.set(day,{day,size:0,d1:0,d7:0,d30:0,maturity:{}})
    const cohort=cohorts.get(day);cohort.size++
    for(const n of [1,7,30]) {
      const future=new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10)
      const completeDay = boundary ? dayAt(boundary.clientCompleteBefore,f.timezone) : null
      const state = future>=today ? 'observing' : !completeDay ? 'processing_unknown' : future>=completeDay ? 'late_window' : 'mature'
      cohort.maturity['d'+n]=state
      if(state!=='mature')cohort['d'+n]=null
      else if(cohort['d'+n]!==null && active.has(account+':'+future))cohort['d'+n]++
    }
  }
  return [...cohorts.values()].sort((a,b)=>b.day.localeCompare(a.day)).map(c=>({...c,
    d1Rate:c.d1===null?null:c.d1/c.size,d7Rate:c.d7===null?null:c.d7/c.size,d30Rate:c.d30===null?null:c.d30/c.size}))
}
function money(events) {
  const groups=new Map()
  const priced=new Map(events.filter(e=>e.source==='server'&&['subscription_charge_priced','subscription_refund_priced'].includes(e.name))
    .map(e=>[e.order_id+':'+e.name.replace('_priced',''),e]))
  for(const e of events) {
    if(e.source!=='server' || !['payment_confirmed','refund_confirmed','subscription_charge','subscription_refund'].includes(e.name))continue
    const supplement=priced.get(e.order_id+':'+e.name)
    const currency=e.currency??supplement?.currency??'UNKNOWN'
    if(!groups.has(currency))groups.set(currency,{currency,gross:'0',refunds:'0',net:'0',confirmedOrders:0,paidOrders:0,zeroValueOrders:0,refundedOrders:0,unpriced:0})
    const value=groups.get(currency), amount=e.amount_text??supplement?.amount_text??(e.amount===null?null:String(e.amount))
    const refund=e.name==='refund_confirmed'||e.name==='subscription_refund'
    if(refund)value.refundedOrders++;else value.confirmedOrders++
    if(amount===null){value.unpriced++;continue}
    if(!refund){if(decimalAdd(amount,'0')==='0')value.zeroValueOrders++;else value.paidOrders++}
    value[refund?'refunds':'gross']=decimalAdd(value[refund?'refunds':'gross'],amount)
  }
  for(const value of groups.values())value.net=decimalAdd(value.gross,value.refunds==='0'?'0':'-'+value.refunds)
  return [...groups.values()]
}
function groupContent(events,plays) {
  const versions = new Map([...events, ...plays].filter(e=>e.drama_id).map(e=>[
    JSON.stringify([e.drama_id,e.content_language??null]), {dramaId:e.drama_id,contentLanguage:e.content_language??null},
  ]))
  return [...versions.values()].map(({dramaId,contentLanguage})=>{
    const e=events.filter(e=>e.drama_id===dramaId&&(e.content_language??null)===contentLanguage)
    const p=plays.filter(e=>e.drama_id===dramaId&&(e.content_language??null)===contentLanguage)
    const impressions=e.filter(e=>e.name==='card_impression'),clicks=clicksAfterExposure(e)
    const exposed=new Set(impressions.map(e=>e.visitor_key))
    const viewers=p.filter(p=>p.qualified_at!==null),accountViewers=new Set(viewers.map(p=>p.account_key).filter(Boolean))
    const buyers=new Set(e.filter(e=>e.name==='payment_confirmed'&&e.source==='server').map(e=>e.account_key).filter(x=>accountViewers.has(x)))
    return {dramaId,contentLanguage,impressions:impressions.length,exposedVisits:exposed.size,rawClicks:e.filter(e=>e.name==='card_click').length,
      clickedVisits:distinct(clicks.filter(e=>exposed.has(e.visitor_key)),e=>e.visitor_key),
      plays:distinct(viewers,e=>e.visitor_key+':'+e.episode_id),viewingVisits:distinct(viewers,e=>e.visitor_key),
      watchSeconds:p.reduce((sum,x)=>sum+x.wall_ms,0)/1000,completePlays:p.filter(x=>x.ended_at!==null&&x.duration_ms>0&&x.coverage_ms/x.duration_ms>=.9).length,
      loggedViewers:accountViewers.size,buyers:buyers.size,smallSample:exposed.size<100||viewers.length<30,
      clickRate:rate(distinct(clicks.filter(e=>exposed.has(e.visitor_key)),e=>e.visitor_key),exposed.size),
      paidRate:rate(buyers.size,accountViewers.size),
    }
  })
}
export function analyticsReport(db,f,zones,now=Date.now(),processingBoundary=null) {
  const from=Date.parse(f.from+'T00:00:00Z')-15*3600000,to=Date.parse(f.to+'T00:00:00Z')+40*3600000
  const raw=db.prepare('SELECT * FROM analytics_events WHERE occurred_at>=? AND occurred_at<? ORDER BY occurred_at,id LIMIT 250001').all(from,to)
  if(raw.length>250000)throw Object.assign(new Error('Select a narrower report window'),{code:'ANALYTICS_REPORT_TOO_LARGE'})
  const parsed=raw.map(e=>({...e,properties:JSON.parse(e.properties)}))
  const events=parsed.filter(e=>inDate(e.occurred_at,f)&&match(e,f))
  const timing=timingSlices(parsed).filter(e=>inDate(e.occurred_at,f)&&match(e,f))
  const allPlays=db.prepare('SELECT * FROM analytics_playbacks WHERE COALESCE(requested_at,first_frame_at,qualified_at,updated_at)>=? AND COALESCE(requested_at,first_frame_at,qualified_at,updated_at)<?').all(from,to)
  const plays=allPlays.filter(e=>inDate(e.requested_at??e.first_frame_at??e.qualified_at??e.updated_at,f)&&match(e,f))
  const byJourney=new Map()
  const paymentsByOrder=orderEvents(events,'payment_confirmed','server')
  const grantsByOrder=orderEvents(events,'entitlement_granted','server')
  const resumesByOrder=orderEvents(events,'play_after_purchase','client')
  for(const e of events) {
    if(!e.drama_id)continue
    const key=e.journey_key+':'+e.drama_id
    if(!byJourney.has(key))byJourney.set(key,[])
    byJourney.get(key).push(e)
  }
  const counts=stages.map(()=>0)
  const orderStage=stages.findIndex(([id])=>id==='order')
  for(const rows of byJourney.values()) {
    let at=-Infinity,completePrefix=true
    for(let i=0;i<orderStage;i++) {
      const found=rows.find(e=>e.name===stages[i][1]&&e.source==='client'&&e.occurred_at>=at)
      if(!found){completePrefix=false;break}
      at=found.occurred_at;counts[i]++
    }
    if(!completePrefix)continue
    // A journey can contain several attempts. Follow each actual order rather
    // than stitching one attempt's creation to another's payment or entitlement.
    const attempts=rows.filter(e=>e.name==='order_created'&&e.source==='server'&&e.order_id&&e.occurred_at>=at)
    let reached=attempts.length?1:0
    for(const created of attempts){
      const paid=nextOrderEvent(paymentsByOrder,created)
      if(!paid)continue
      reached=Math.max(reached,2)
      const granted=nextOrderEvent(grantsByOrder,paid)
      if(!granted)continue
      reached=Math.max(reached,3)
      // Re-entry may have a new journey. The original order, account, content
      // and event chronology still have to agree before it counts as resumed.
      if(nextOrderEvent(resumesByOrder,granted)){reached=4;break}
    }
    for(let i=0;i<reached;i++)counts[orderStage+i]++
  }
  const funnel=stages.map(([id,name,label],i)=>({id,name,label,count:counts[i],fromPrevious:i?rate(counts[i],counts[i-1]):null}))
  const impressions=events.filter(e=>e.name==='card_impression'),exposed=new Set(impressions.map(e=>e.visitor_key+':'+e.drama_id))
  const clicks=clicksAfterExposure(events)
  const paid=events.filter(e=>e.name==='payment_confirmed'&&e.source==='server'),orders=events.filter(e=>e.name==='order_created'&&e.source==='server')
  const createdIds=new Set(orders.map(e=>e.order_id))
  const paidInCreatedCohort=new Set(paid.filter(e=>createdIds.has(e.order_id)).map(e=>e.order_id))
  const paidIds=new Set(paid.map(e=>e.order_id)),resumed=events.filter(e=>e.name==='play_after_purchase'&&e.source==='client'&&
    paymentsByOrder.get(e.order_id)?.some(p=>sameOrderContent(p,e)&&e.occurred_at>=p.occurred_at))
  const frameJourneys=new Set(plays.filter(p=>p.frame_signal).map(p=>p.journey_key))
  const observedResumeIds=new Set(resumed.map(e=>e.order_id))
  const observablePaid=new Set(paid.filter(p=>{
    const flags=JSON.parse(p.quality_flags??'[]')
    return p.drama_id!==null&&!flags.includes('attribution_unavailable')&&!flags.includes('legacy_ledger_import')
      &&(frameJourneys.has(p.journey_key)||observedResumeIds.has(p.order_id))
  }).map(p=>p.order_id))
  const entitlementDelays=[],resumeDelays=[]
  for(const paymentRows of paymentsByOrder.values()){
    for(const payment of paymentRows){
      const granted=nextOrderEvent(grantsByOrder,payment)
      if(!granted)continue
      entitlementDelays.push(granted.occurred_at-payment.occurred_at)
      const continued=nextOrderEvent(resumesByOrder,granted)
      if(continued)resumeDelays.push(continued.occurred_at-granted.occurred_at)
      break // Multiple deliveries/observations do not add timing samples.
    }
  }
  const qualified=plays.filter(p=>p.qualified_at!==null)
  const frameTimes=plays.map(p=>p.first_frame_ms).filter(v=>v!==null),measurable=plays.filter(p=>p.frame_signal)
  const errorGroups=new Map()
  for(const e of events.filter(e=>['play_error','load_error'].includes(e.name))) {
    const code=e.properties.errorCode??'UNKNOWN';errorGroups.set(code,(errorGroups.get(code)??0)+1)
  }
  const timeline=db.prepare('SELECT * FROM analytics_summary WHERE timezone=? AND day>=? AND day<=? ORDER BY day').all(f.timezone,f.from,f.to)
    .map(e=>({...e,...JSON.parse(e.dimensions)})).filter(e=>match(e,f))
  const wall=timing.reduce((sum,e)=>sum+e.wallValue,0)
  const qualityTiming=timing.filter(e=>e.rebufferMeasured)
  const qualityWall=qualityTiming.reduce((sum,e)=>sum+e.wallValue,0)
  const stalled=qualityTiming.reduce((sum,e)=>sum+e.stallValue,0)
  const days=new Map()
  for(const e of timeline) {
    if(!days.has(e.day))days.set(e.day,{day:e.day,impressions:0,qualifiedAttempts:0,watchSeconds:0,payments:0,refunds:0})
    const day=days.get(e.day)
    if(e.name==='card_impression')day.impressions+=e.count
    if(e.name==='qualified_play')day.qualifiedAttempts+=e.count
    if(e.name==='watch_wall_ms')day.watchSeconds+=e.value/1000
    if(e.name==='payment_confirmed')day.payments+=e.count
    if(e.name==='refund_confirmed')day.refunds+=e.count
  }
  const sections=new Map()
  for(const e of events.filter(e=>['card_impression','card_click'].includes(e.name))) {
    const key=[e.section_id??'unknown',e.position??-1,e.channel_version??0].join(':')
    if(!sections.has(key))sections.set(key,{sectionId:e.section_id,position:e.position,channelVersion:e.channel_version,impressions:0,clicks:0})
    sections.get(key)[e.name==='card_impression'?'impressions':'clicks']++
  }
  const variants=new Map()
  for(const e of events.filter(e=>e.experiment_id&&e.variant)) {
    const key=e.experiment_id+':'+e.variant
    if(!variants.has(key))variants.set(key,{experimentId:e.experiment_id,variant:e.variant,exposureVisits:new Set(),clickVisits:new Set(),paidOrders:new Set()})
    const row=variants.get(key)
    if(e.name==='card_impression'||e.name==='experiment_exposure')row.exposureVisits.add(e.visitor_key)
    if(e.name==='card_click')row.clickVisits.add(e.visitor_key)
    if(e.name==='payment_confirmed'&&e.order_id)row.paidOrders.add(e.order_id)
  }
  const first=db.prepare("SELECT min(occurred_at) n FROM analytics_events WHERE source='client'").get().n??null
  const financial=db.prepare('SELECT * FROM analytics_money WHERE occurred_at>=? AND occurred_at<?').all(from,to)
    .map(e=>({...e,...JSON.parse(e.dimensions),source:'server',order_id:e.id,amount:null})).filter(e=>inDate(e.occurred_at,f)&&match(e,f))
  const cleanupThrough=Number(db.prepare("SELECT value FROM analytics_meta WHERE key='raw_pruned_before'").get()?.value??0)
  const incompleteDetails=cleanupThrough>0&&Date.parse(f.from+'T00:00:00Z')<cleanupThrough
  // A user can pause overnight. Fetch original rows for observed completion IDs,
  // rather than substituting a coalesced projection or today's catalog.
  const completionKeys=[...new Set(parsed.filter(e=>e.name==='play_end'&&e.playback_key).map(e=>e.playback_key))]
  const continuationRows=[...parsed], observations=new Map()
  for(let i=0;i<completionKeys.length;i+=400){
    const keys=completionKeys.slice(i,i+400), placeholders=keys.map(()=>'?').join(',')
    const earlier=db.prepare(`SELECT * FROM analytics_events WHERE playback_key IN (${placeholders})
      AND (occurred_at<? OR occurred_at>=?) LIMIT 250001`).all(...keys,from,to)
    continuationRows.push(...earlier.map(e=>({...e,properties:JSON.parse(e.properties)})))
    if(continuationRows.length>250000)throw Object.assign(new Error('Select a narrower report window'),{code:'ANALYTICS_REPORT_TOO_LARGE'})
    for(const row of db.prepare(`SELECT event_id,snapshot FROM analytics_supply_observations WHERE playback_key IN (${placeholders})`).all(...keys)){
      observations.set(row.event_id,JSON.parse(row.snapshot))
    }
  }
  const continuation=continuationReport(continuationRows,observations,
    e=>inDate(e.occurred_at,f)&&match(e,f),now,incompleteDetails,processingBoundary)
  const {origins,forContent,forEpisode,...continuationSummary}=continuation
  // A playback may have started outside this date/language/network filter while
  // actual viewing segments belong inside it. Keep that episode visible without
  // fabricating another playback request or another first frame.
  const watchedEpisodes=timing.filter(e=>e.episode_id&&e.wallValue>0)
  const episodeScopes = new Map([...plays,...watchedEpisodes,...origins.map(e=>e.event)].map(e=>[episodeScopeKey(e),e]))
  const byEpisode=[...episodeScopes].map(([key,example])=>{
    const id=example.episode_id, rows=plays.filter(e=>episodeScopeKey(e)===key)
    return {episodeId:id,dramaId:example.drama_id,contentLanguage:example.content_language??null,
      contentVersion:example.content_version??null,mediaVersion:example.media_version??null,scopeKey:key,
      requests:rows.filter(e=>e.requested_at!==null).length,
      firstFrames:rows.filter(e=>e.first_frame_at!==null).length,qualifiedVisits:distinct(rows.filter(e=>e.qualified_at!==null),e=>e.visitor_key),
      completed:rows.filter(e=>e.ended_at!==null&&e.duration_ms>0&&e.coverage_ms/e.duration_ms>=.9).length,
      watchSeconds:timeline.filter(e=>e.episode_id===id&&e.name==='watch_wall_ms').reduce((sum,e)=>sum+e.value,0)/1000}
  })
  if(!incompleteDetails){
    for(const day of days.values())day.watchSeconds=0
    for(const e of timing){
      const day=dayAt(e.occurred_at,f.timezone)
      if(!days.has(day))days.set(day,{day,impressions:0,qualifiedAttempts:0,watchSeconds:0,payments:0,refunds:0})
      days.get(day).watchSeconds+=e.wallValue/1000
    }
  }
  const releases=[...new Set(plays.map(p=>p.build_id??'unknown'))].map(build=>({build,
    requests:plays.filter(p=>(p.build_id??'unknown')===build&&p.requested_at!==null).length,
    errors:plays.filter(p=>(p.build_id??'unknown')===build&&p.error_code).length}))
  const environmentGroups=new Map()
  for(const p of plays){
    const dimensions={deviceOS:p.device_os??'other',playerType:p.player_type??'unknown',
      networkType:p.network_type??'unknown',networkQuality:p.network_quality??'unknown',networkSource:p.network_source??'unrecorded',
      buildId:p.build_id??null}
    const key=JSON.stringify(dimensions)
    if(!environmentGroups.has(key))environmentGroups.set(key,{...dimensions,rows:[]})
    environmentGroups.get(key).rows.push(p)
  }
  const environments=[...environmentGroups.values()].map(({rows,...dimensions})=>({...dimensions,
    observedPlaybacks:rows.length,requests:rows.filter(p=>p.requested_at!==null).length,
    firstFrames:rows.filter(p=>p.first_frame_at!==null).length,errors:rows.filter(p=>p.error_code).length,
    frameSignalAvailable:rows.filter(p=>p.frame_signal).length,
    p50:percentile(rows.map(p=>p.first_frame_ms).filter(v=>v!==null),.5),
    p95:percentile(rows.map(p=>p.first_frame_ms).filter(v=>v!==null),.95),
  })).sort((a,b)=>b.requests-a.requests)
  const alerts=releases.filter(r=>r.requests>=30&&r.errors/r.requests>=.2).map(r=>({id:'playback-errors:'+r.build,
    level:'warning',message:`版本 ${r.build} 的 ${r.requests} 次播放请求中，${r.errors} 次上报错误。请按设备和原播放路径复验；这不是自动认定线上故障。`}))
  const refusals=events.filter(e=>e.name==='load_error'&&['PAYMENT_REQUIRED','ACCESS_DENIED'].includes(e.properties.errorCode)&&e.account_key)
    .filter(e=>paid.some(p=>p.account_key===e.account_key&&p.drama_id===e.drama_id&&(!p.episode_id||p.episode_id===e.episode_id)&&p.occurred_at<=e.occurred_at&&
      !events.some(r=>r.name==='refund_confirmed'&&r.order_id===p.order_id&&r.occurred_at<=e.occurred_at)))
  if(refusals.length)alerts.push({id:'paid-access-recheck',level:'warning',message:`观察到 ${refusals.length} 次同账户同内容在确认付款后上报拒权，请核对原订单、权益和播放请求。统计不会自动退款或改变权限。`})
  return {
    available:true,dataState:incompleteDetails?'partial_history':events.length||timeline.length?'ready':'empty',generatedAt:now,filters:f,
    // Private handoff to the main thread, which alone can read the current ledger.
    // Kept separate from the original event funnel: historic grants are not current rights.
    __orderObservations:[...paymentsByOrder.entries()].map(([orderId,rows])=>{
      const payment=rows[0]
      const resumeTimes=(resumesByOrder.get(orderId)??[]).filter(e=>sameOrderContent(payment,e)&&
        e.occurred_at>=payment.occurred_at&&e.occurred_at<=now&&e.properties.hasFrameSignal===true).map(e=>e.occurred_at)
      return {orderId,accountKey:payment.account_key,dramaId:payment.drama_id,episodeId:payment.episode_id,
        environment:payment.environment,paidAt:payment.occurred_at,resumeTimes,
        conflicting:rows.some(e=>e.account_key!==payment.account_key||e.drama_id!==payment.drama_id||
          e.episode_id!==payment.episode_id||e.environment!==payment.environment||e.occurred_at!==payment.occurred_at)}
    }),
    scope:{environment:f.environment,countrySource:'unavailable',actorScope:'匿名访次与已登录账号分开；访次不是人数',firstClientEventAt:first,
      lastReceivedAt:db.prepare('SELECT max(received_at) n FROM analytics_events').get().n??null,processingBoundary,
      rawWindowDays:30,timezone:f.timezone,unknownCountryEvents:events.filter(e=>!e.country).length,
      detailsPrunedBefore:cleanupThrough||null,detailMetricsIncomplete:incompleteDetails,
      deviceNetworkDefinition:'设备系统按浏览器公开信息分类，不是独立真机证明；网络接入类型与浏览器速度档位估计分别记录。4g档位不代表蜂窝4G，不推测国家，也不主动测速。',
      playbackGroupingDefinition:'播放请求、首帧与错误按该播放请求时记录的设备/网络分组；观看时长、趋势和留存按事件或实际片段发生时的条件筛选。切换网络不会重建实际视频。',
      clickDefinition:'点击率只计本筛选范围内，同一访次同一部剧先曝光、后点击的访次；迟到上报按实际发生时间核对，后来的曝光不补成先前点击的来源。原始点击次数另列。',
      episodeGroupingDefinition:'逐集按作品、实际语言、内容与媒资版本分行。请求与首帧按播放开始日，接续按合格完成日入组，观看时长按实际片段归属。切语、切网或跨日可有时长而无新请求，不表示丢失播放。',
      orderPathDefinition:'建单、付款、权益和续播按同一订单、账号与内容逐项连接，并核对记录的发生时间；不同订单的成功步骤不能拼接。前一笔取消不遮掉后来有效购买，退出重进可按原订单关联，较早播放不倒算成付款后续播。',
      orderTimingDefinition:'只计算本筛选范围内同一订单配对后的记录时差；付款到权益来自服务端，权益到续播还依赖浏览器记录时间和实际帧信号。没有匹配记录、顺序矛盾或跨出观察窗口时不填0毫秒，也不直接判为发权/播放失败；这不是TikTok收银台全程耗时。',
      stallDefinition:'卡顿率仅统计新版实际提供播放中卡顿信号的记录，排除首次加载、暂停与拖动等待；旧版缓冲与未提供信号的SDK不当作0卡顿或混入分母。保留原事件，不改历史事实。',
      resumeDefinition:'只比较有完整关联且已观察到视频帧能力的内容订单；续播须对应同一订单、账号和内容，记录时间不早于确认付款。不将缺少关联或帧信号的订单算作流失。覆盖数量与全部确认订单同时展示。'},
    overview:{impressions:impressions.length,exposedVisits:exposed.size,viewingVisits:distinct(qualified,p=>p.visitor_key),
      loggedViewers:distinct(qualified,p=>p.account_key),qualifiedPlays:distinct(qualified,p=>p.visitor_key+':'+p.episode_id),
      playbackAttempts:plays.filter(p=>p.requested_at!==null).length,watchSeconds:wall/1000,paidOrders:paidIds.size,
      completePlays:plays.filter(p=>p.ended_at!==null&&p.duration_ms>0&&p.coverage_ms/p.duration_ms>=.9).length},
    funnel,rates:{click:rate(distinct(clicks,e=>e.visitor_key+':'+e.drama_id),exposed.size),
      payment:rate(paidInCreatedCohort.size,createdIds.size),resumed:{...rate(distinct(resumed.filter(e=>observablePaid.has(e.order_id)),e=>e.order_id),observablePaid.size),
        totalPaidOrders:paidIds.size,unobservableOrders:paidIds.size-observablePaid.size}},
    orderTimings:{
      paymentToEntitlement:{samples:entitlementDelays.length,totalPaidOrders:paidIds.size,
        unpairedOrders:paidIds.size-entitlementDelays.length,p50:percentile(entitlementDelays,.5),p95:percentile(entitlementDelays,.95)},
      entitlementToResume:{samples:resumeDelays.length,grantedOrders:entitlementDelays.length,
        unobservedOrders:entitlementDelays.length-resumeDelays.length,p50:percentile(resumeDelays,.5),p95:percentile(resumeDelays,.95)},
    },
    continuation:continuationSummary,
    alerts,money:money(financial),content:groupContent(events,plays).map(c=>({...c,continuation:forContent(c.dramaId,c.contentLanguage),
      watchSeconds:timing.filter(e=>e.drama_id===c.dramaId&&(e.content_language??null)===c.contentLanguage).reduce((sum,e)=>sum+e.wallValue,0)/1000})),
    episodes:byEpisode.map(row=>({...row,continuation:forEpisode(row.scopeKey),
      watchSeconds:timing.filter(e=>episodeScopeKey(e)===row.scopeKey).reduce((sum,e)=>sum+e.wallValue,0)/1000})),
    sections:[...sections.values()],retention:retention(db,f,now,processingBoundary),
    retentionScope:{allowedLatenessDays:7,processingBoundary,
      anonymousViewingVisits:distinct(events.filter(e=>e.source==='client'&&!e.account_key&&e.properties.watchedMs>=3000),e=>e.visitor_key),
      cohortDefinition:'当前范围内首次已观察有效观看的账户组，不是账户一生首次观看。匿名访次单列，不拼接成账户。',
      maturityDefinition:'观察日结束，且7天允许迟到窗已越过本次串行处理边界，才计算成熟回访；最近收件时间不是完整处理水位。'},
    quality:{firstFrame:{p50:percentile(frameTimes,.5),p95:percentile(frameTimes,.95),samples:frameTimes.length,measurableRequests:measurable.length,
      unavailableRequests:plays.filter(p=>!p.frame_signal).length},stallRatio:rate(stalled,qualityWall+stalled),
      stallCoverage:{measuredPlaybacks:distinct(qualityTiming,p=>p.playback_key),
        unmeasuredPlaybacks:distinct(timing.filter(p=>!p.rebufferMeasured),p=>p.playback_key),
        legacyPlaybacks:plays.filter(p=>p.timing_version!==2).length,definitionVersion:2},
      errors:[...errorGroups].map(([code,count])=>({code,count})),
      errorsByRelease:releases,environments,
      networkCoverage:{observedPlaybacks:plays.length,browserReported:plays.filter(p=>p.network_source==='browser').length,
        browserUnavailable:plays.filter(p=>p.network_source==='unavailable').length,
        unrecorded:plays.filter(p=>!p.network_source||p.network_source==='unrecorded').length,
        qualityKnown:plays.filter(p=>p.network_quality&&p.network_quality!=='unknown').length}},
    timeline:[...days.values()],timelineScope:'日汇总已使用同一组市场、语言、剧目、栏目、设备与来源筛选。次数不是去重用户，不将每日人数相加。',
    experiments:[...variants.values()].map(v=>({...v,exposureVisits:v.exposureVisits.size,clickVisits:v.clickVisits.size,paidOrders:v.paidOrders.size,
      smallSample:v.exposureVisits.size<100})),
    cautions:['客户端行为是应用内观察，不是TikTok官方流量统计。','付款与退款只来自服务器业务事实；测试积分不是收入。原生订阅不擅自摊到某一部剧。',
      '没有观测到付款后首帧，不等于用户一定无法播放。','首帧只统计有实际视频帧回调的播放；SDK未提供信号时显示未采集。'],
  }
}
