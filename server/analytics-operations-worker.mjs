import { randomBytes } from 'node:crypto'
import { clicksAfterExposure } from './analytics-clicks.mjs'
import { timingSlices } from './analytics-timing.mjs'
const failure=(code)=>Object.assign(new Error(code),{code})
const candidate=row=>({id:row.id,createdAt:row.created_at,region:row.region,locale:row.locale,channelVersion:row.channel_version,
  metric:row.metric,dramaIds:JSON.parse(row.order_json),smallSample:JSON.parse(row.baseline_json).smallSample,baseline:JSON.parse(row.baseline_json)})
const experiment=(row,secret=false)=>({id:row.id,name:row.name,region:row.region,locale:row.locale,channelVersion:row.channel_version,
  createdAt:row.created_at,updatedAt:row.updated_at,state:row.state,exposurePercent:row.exposure_percent,
  a:JSON.parse(row.a_json),b:JSON.parse(row.b_json),...(secret?{salt:row.salt}:{})})
export function operation(db,action,p) {
  if(action==='list-candidates')return db.prepare('SELECT * FROM analytics_candidates WHERE region=? AND locale=? ORDER BY created_at DESC LIMIT 30').all(p.region,p.locale).map(candidate)
  if(action==='create-candidate'){
    const old=db.prepare('SELECT * FROM analytics_candidates WHERE id=?').get(p.id)
    if(old){
      if(JSON.parse(old.baseline_json).fingerprint!==p.fingerprint)throw failure('ANALYTICS_OPERATION_CONFLICT')
      return {created:false,candidate:candidate(old)}
    }
    db.prepare(`INSERT INTO analytics_candidates(id,created_at,owner_key,region,locale,channel_version,metric,order_json,baseline_json)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(p.id,Date.now(),p.ownerKey,p.region,p.locale,p.version,p.metric,JSON.stringify(p.dramaIds),JSON.stringify(p.baseline))
    return {created:true,candidate:candidate(db.prepare('SELECT * FROM analytics_candidates WHERE id=?').get(p.id))}
  }
  if(action==='list-experiments')return db.prepare('SELECT * FROM analytics_experiments WHERE region=? AND locale=? ORDER BY created_at DESC LIMIT 30').all(p.region,p.locale).map(e=>experiment(e))
  if(action==='get-experiment'){
    const row=db.prepare('SELECT * FROM analytics_experiments WHERE id=?').get(p.id)
    if(!row)throw failure('ANALYTICS_NOT_FOUND')
    return experiment(row)
  }
  if(action==='create-experiment'){
    const old=db.prepare('SELECT * FROM analytics_experiments WHERE id=?').get(p.id)
    if(old){
      if(old.name!==p.name||old.channel_version!==p.version||old.region!==p.region||old.locale!==p.locale||
        old.a_json!==JSON.stringify(p.a)||old.b_json!==JSON.stringify(p.b)||old.exposure_percent!==p.exposurePercent)throw failure('ANALYTICS_OPERATION_CONFLICT')
      return {created:false,experiment:experiment(old)}
    }
    db.prepare(`INSERT INTO analytics_experiments(id,created_at,updated_at,region,locale,channel_version,name,a_json,b_json,state,salt,exposure_percent)
      VALUES(?,?,?,?,?,?,?,?,?,'draft',?,?)`).run(p.id,Date.now(),Date.now(),p.region,p.locale,p.version,p.name,JSON.stringify(p.a),JSON.stringify(p.b),randomBytes(24).toString('hex'),p.exposurePercent)
    return {created:true,experiment:experiment(db.prepare('SELECT * FROM analytics_experiments WHERE id=?').get(p.id))}
  }
  if(action==='state-experiment'){
    const row=db.prepare('SELECT * FROM analytics_experiments WHERE id=?').get(p.id)
    if(!row)throw failure('ANALYTICS_NOT_FOUND')
    if(row.state==='complete'&&p.state!=='complete')throw failure('ANALYTICS_EXPERIMENT_FINISHED')
    if(p.state==='active'&&db.prepare("SELECT 1 FROM analytics_experiments WHERE region=? AND locale=? AND state='active' AND id<>?").get(row.region,row.locale,p.id))throw failure('ANALYTICS_EXPERIMENT_ACTIVE')
    db.prepare('UPDATE analytics_experiments SET state=?,updated_at=? WHERE id=?').run(p.state,Date.now(),p.id)
    return experiment(db.prepare('SELECT * FROM analytics_experiments WHERE id=?').get(p.id))
  }
  throw failure('ANALYTICS_OPERATION_INVALID')
}
export function catalogSnapshot(db,now=Date.now()) {
  const since=now-7*86400000,metrics={},scores={},channelMetrics={},channelScores={}
  const events=db.prepare(`SELECT id,name,source,occurred_at,market,drama_id,episode_id,visitor_key,account_key,order_id,
    channel_language,playback_key,properties FROM analytics_events WHERE occurred_at>=? AND occurred_at<=? AND drama_id IS NOT NULL
    AND (name IN ('card_impression','card_click','payment_confirmed','refund_confirmed') OR (source='client' AND playback_key IS NOT NULL))
    ORDER BY occurred_at,id`).all(since,now).map(e=>({...e,properties:JSON.parse(e.properties)}))
  const attributedClicks=new Set(clicksAfterExposure(events).map(e=>e.id))
  const channelClicks=new Set(clicksAfterExposure(events,['channel_language']).map(e=>e.id))
  const plays=db.prepare('SELECT market,drama_id,visitor_key,account_key,episode_id,channel_language FROM analytics_playbacks WHERE qualified_at>=? AND qualified_at<=?').all(since,now)
  const groups=new Map()
  function group(e,locale){
    const key=JSON.stringify([e.market,locale,e.drama_id])
    if(!groups.has(key))groups.set(key,{market:e.market,locale,id:e.drama_id,impressions:new Set(),clicks:new Set(),plays:new Set(),visits:new Set(),accounts:new Set(),payments:[],refunds:new Set(),seconds:0})
    return groups.get(key)
  }
  function scopes(e){
    // Region-wide compatibility remains available, but unknown channel records
    // never become evidence for a particular language, sound track or country.
    const result=[group(e,null)]
    if(typeof e.channel_language==='string'&&e.channel_language)result.push(group(e,e.channel_language))
    return result
  }
  for(const e of events){
    if(!['card_impression','card_click','payment_confirmed','refund_confirmed'].includes(e.name))continue
    for(const g of scopes(e)){
      if(e.name==='card_impression'&&e.source==='client')g.impressions.add(e.visitor_key)
      else if(e.name==='card_click'&&(g.locale===null?attributedClicks:channelClicks).has(e.id))g.clicks.add(e.visitor_key)
      else if(e.name==='payment_confirmed'&&e.source==='server')g.payments.push(e)
      else if(e.name==='refund_confirmed'&&e.source==='server')g.refunds.add(e.order_id)
    }
  }
  for(const e of plays){
    for(const g of scopes(e)){
      g.plays.add(e.visitor_key+':'+e.episode_id);g.visits.add(e.visitor_key)
      if(e.account_key)g.accounts.add(e.account_key)
    }
  }
  for(const e of timingSlices(events)){
    if(e.wallValue>0)for(const g of scopes(e))g.seconds+=e.wallValue/1000
  }
  for(const g of groups.values()){
    const engaged=[...g.visits].filter(v=>g.impressions.has(v)).length
    const buyers=new Set(g.payments.filter(p=>!g.refunds.has(p.order_id)&&g.accounts.has(p.account_key)).map(p=>p.account_key))
    const m={impressions:g.impressions.size,plays:g.plays.size,engagedVisits:engaged,viewers:g.accounts.size,buyers:buyers.size,
      playRate:g.impressions.size?engaged/g.impressions.size:null,paidRate:g.accounts.size?buyers.size/g.accounts.size:null}
    const score={...m,clickRate:g.impressions.size?[...g.clicks].filter(v=>g.impressions.has(v)).length/g.impressions.size:null,watchSeconds:g.seconds}
    if(g.locale===null){
      ;(metrics[g.market]??={})[g.id]=m
      ;(scores[g.market]??={})[g.id]=score
    }else{
      ;((channelMetrics[g.market]??={})[g.locale]??={})[g.id]=m
      ;((channelScores[g.market]??={})[g.locale]??={})[g.id]=score
    }
  }
  return {generatedAt:now,metrics,scores,channelMetrics,channelScores,
    experiments:db.prepare("SELECT * FROM analytics_experiments WHERE state='active'").all().map(row=>experiment(row,true))}
}
