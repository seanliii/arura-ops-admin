import { createHash } from 'node:crypto'
import type { Router } from 'express'
import { channel, channelLocale, channelRegion } from './catalog-channels.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { body, integer } from './validation.js'
import { analyticsKey, stable } from './analytics-identity.js'
import type { AnalyticsExperiment, CandidateMetric } from '../shared/analytics-operations.js'

const fail=(status:number,code:string,message:string)=>new ApiError(status,code,message)
const check=(value:Record<string,unknown>,allowed:string[])=>{
  if(Object.keys(value).some(key=>!allowed.includes(key)))throw fail(400,'INVALID_ANALYTICS_OPERATION','运营对照只允许已列出的参数，不接受改价、改权益或新增内容')
}
function identity(owner:string,requestId:unknown) {
  if(typeof requestId!=='string'||!/^[0-9a-f-]{36}$/.test(requestId))throw fail(400,'INVALID_ANALYTICS_OPERATION','缺少原请求编号')
  return createHash('sha256').update(owner+':'+requestId).digest('hex')
}
export function registerAnalyticsOperations(router:Router,ctx:AppContext){
  const store=()=>{if(!ctx.analytics)throw fail(503,'ANALYTICS_DISABLED','统计未启用，不能创建基于统计的编排');return ctx.analytics}
  for(const kind of ['candidates','experiments'] as const)router.get(`/api/admin/analytics/${kind}/:region/:locale`,asyncRoute(async(req,res)=>{
    ctx.requireAdmin(req)
    const region=channelRegion(req.params.region),locale=channelLocale(req.params.locale)
    const items=await store().call(`list-${kind}`,{region,locale})
    res.json({[kind]:items})
  }))
  router.post('/api/admin/analytics/candidates/:region/:locale',asyncRoute(async(req,res)=>{
    const user=ctx.requireAdmin(req),region=channelRegion(req.params.region),locale=channelLocale(req.params.locale),v=body(req.body)
    check(v,['requestId','version','metric'])
    const current=channel(ctx,region,locale),version=integer(v.version,'version',1)
    if(!current.configured||current.version!==version)throw fail(409,'VERSION_CONFLICT','先保存并核对当前主页版本，再生成候选')
    if(!['plays','playRate','paidRate','clickRate','watchSeconds'].includes(String(v.metric)))throw fail(400,'INVALID_ANALYTICS_OPERATION','请选择可核对的指标')
    const snapshot=await store().refreshCatalog(),scores=snapshot.channelScores[region]?.[locale]??{}
    const metric=v.metric as CandidateMetric
    const qualified=current.dramaIds.filter(id=>scores[id]&&scores[id].impressions>=100&&scores[id].plays>=30&&scores[id][metric]!==null)
    const ranked=[...qualified].sort((a,b)=>Number(scores[b][metric])-Number(scores[a][metric]))
    let pos=0
    // Unmeasured/new content keeps its original position; only sufficiently observed slots compete.
    const ids=current.dramaIds.map(id=>qualified.includes(id)?ranked[pos++]:id)
    const ownerKey=analyticsKey(ctx,'admin:'+user.id),id=identity(ownerKey,v.requestId),fingerprint=stable([region,locale,version,metric])
    const result=await store().call<{created:boolean;candidate:unknown}>('create-candidate',{id,ownerKey,region,locale,version,metric,dramaIds:ids,fingerprint,
      baseline:{fingerprint,smallSample:qualified.length!==current.dramaIds.length,generatedAt:snapshot.generatedAt,sourceDramaIds:current.dramaIds,
        channelLanguage:locale,statisticsScope:'channel-language-v1',
        minimumImpressions:100,minimumPlays:30,metrics:Object.fromEntries(current.dramaIds.map(id=>[id,scores[id]??null])),
        note:'候选只使用本地区、本内容频道的数据；未记录频道语言的旧记录不混入。仅保存为草稿，样本不足的剧保留原位，应用仍需原主页保存。'}})
    res.status(result.created?201:200).json(result)
  }))
  router.post('/api/admin/analytics/experiments/:region/:locale',asyncRoute(async(req,res)=>{
    const user=ctx.requireAdmin(req),region=channelRegion(req.params.region),locale=channelLocale(req.params.locale),v=body(req.body)
    check(v,['requestId','version','name','dramaIds','sectionIds','exposurePercent'])
    const version=integer(v.version,'version',1),current=channel(ctx,region,locale)
    if(!current.configured||current.version!==version)throw fail(409,'VERSION_CONFLICT','主页已变化，请重新保存后准备对照')
    if(typeof v.name!=='string'||!v.name.trim()||v.name.length>80)throw fail(400,'INVALID_ANALYTICS_OPERATION','实验名称须为1–80字')
    if(!Array.isArray(v.dramaIds)||v.dramaIds.length!==current.dramaIds.length||new Set(v.dramaIds).size!==v.dramaIds.length||
      v.dramaIds.some(id=>!current.dramaIds.includes(id as number)))throw fail(400,'INVALID_ANALYTICS_OPERATION','实验只能重排相同成片集合，不能加入或移除作品')
    const sections=current.sections??[]
    if(!Array.isArray(v.sectionIds)||v.sectionIds.length!==sections.length||new Set(v.sectionIds).size!==sections.length||
      v.sectionIds.some(id=>!sections.some(s=>s.id===id)))throw fail(400,'INVALID_ANALYTICS_OPERATION','实验只能重排相同栏目，不更换内容或名称')
    const exposurePercent=integer(v.exposurePercent,'exposurePercent',1,100)
    const result=await store().call<{created:boolean;experiment:AnalyticsExperiment}>('create-experiment',{
      id:identity(analyticsKey(ctx,'admin:'+user.id),v.requestId),region,locale,version,name:v.name.trim(),exposurePercent,
      a:{dramaIds:current.dramaIds,sections},b:{dramaIds:v.dramaIds,sections:v.sectionIds.map(id=>sections.find(s=>s.id===id))},
    })
    res.status(result.created?201:200).json(result)
  }))
  router.post('/api/admin/analytics/experiments/:id/actions/:action',asyncRoute(async(req,res)=>{
    const user=ctx.requireAdmin(req),v=body(req.body),action=String(req.params.action)
    if(!['activate','pause','complete'].includes(action))throw fail(400,'INVALID_ANALYTICS_OPERATION','未知的实验操作')
    check(v,action==='activate'?['version','confirmed']:[])
    const experiment=await store().call<AnalyticsExperiment>('get-experiment',{id:String(req.params.id)})
    if(action==='activate'){
      if(v.confirmed!==true)throw fail(400,'EXPERIMENT_CONFIRMATION_REQUIRED','请明确确认此实验将影响一部分观众的栏目与剧目顺序')
      const current=channel(ctx,experiment.region,channelLocale(experiment.locale))
      if(!current.configured||current.version!==integer(v.version,'version',1)||experiment.channelVersion!==current.version||
        stable(current.dramaIds)!==stable(experiment.a.dramaIds)||stable(current.sections??[])!==stable(experiment.a.sections))
        throw fail(409,'VERSION_CONFLICT','原编排已经变化；旧实验不能覆盖新主页，请新建对照')
    }
    const result=await store().call<AnalyticsExperiment>('state-experiment',{id:experiment.id,state:action==='activate'?'active':action==='pause'?'paused':'complete'})
    await store().refreshCatalog()
    ctx.audit(user.id,'analytics.experiment.'+action,'catalog',experiment.id,{region:experiment.region,locale:experiment.locale})
    res.json({experiment:result})
  }))
}
