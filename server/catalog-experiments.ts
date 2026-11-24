import { createHmac } from 'node:crypto'
import type { Request } from 'express'
import type { AppContext } from './types.js'
import type { CatalogChannel } from '../shared/catalog-channel.js'
export const ANALYTICS_VISIT_HEADER='X-Aurora-Visit'
export function experimentChannel(ctx: AppContext, config: CatalogChannel, req: Request): CatalogChannel {
  const visit=req.get(ANALYTICS_VISIT_HEADER)
  if(!config.configured||req.get('DNT')==='1'||!visit||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(visit))return config
  const active=ctx.analytics?.catalogSnapshot()?.experiments.find(e=>e.region===config.region&&e.locale===config.locale&&e.channelVersion===config.version)
  if(!active)return config
  // Stable for the page visit; an experiment changes order, never the allowed content set.
  const bucket=parseInt(createHmac('sha256',active.salt).update(visit).digest('hex').slice(0,8),16)
  if(bucket%100>=active.exposurePercent)return config
  const variant=(Math.floor(bucket/100)%2===0?'a':'b'),selected=active[variant]
  if(selected.dramaIds.length!==config.dramaIds.length||selected.dramaIds.some(id=>!config.dramaIds.includes(id)))return config
  return {...config,sort:'manual',dramaIds:[...selected.dramaIds],sections:structuredClone(selected.sections),
    experiment:{id:active.id,variant,channelVersion:active.channelVersion}}
}
