import { createHash } from 'node:crypto'
import type { AnalyticsEventRecord } from '../shared/analytics.js'
import { analyticsEnvironment } from '../shared/analytics.js'
import { analyticsKey, stable } from './analytics-identity.js'
import type { AppContext } from './types.js'
type Row = Record<string, any>
function tag(row: Row) {
  return [row.payment_receipt_id??0,row.refund_receipt_id??0,row.revoke_receipt_id??0,row.metadata_receipt_id??0,row.receipt_conflict].join(':')
}
function store(ctx: AppContext, value: AnalyticsEventRecord) {
  if(ctx.db.prepare('SELECT 1 FROM analytics_outbox WHERE event_id=?').get(value.id))return
  value.inputHash=createHash('sha256').update(stable(value)).digest('hex')
  ctx.db.prepare('INSERT INTO analytics_outbox(event_id,payload,created_at) VALUES(?,?,?)').run(value.id,JSON.stringify(value),Date.now())
}
function amount(value: unknown) { return typeof value==='string'&&/^\d{1,30}(?:\.\d{1,9})?$/.test(value)?value:null }
function currency(value: unknown) {return typeof value==='string'&&/^[A-Za-z]{3}$/.test(value)?value:null}
/** A read of the already verified ledger, never a provider call or an entitlement grant. */
export function recordAnalyticsSubscription(ctx: AppContext, transactionId: number) {
  if(!ctx.analytics)return
  const row=ctx.db.prepare('SELECT * FROM subscription_transactions WHERE id=?').get(transactionId) as Row|undefined
  if(!row || row.client_key!==ctx.config.tiktokClientKey ||
      row.environment!==(ctx.config.mode==='production'?'production':'sandbox'))return
  const key=`subscription:${row.id}`,now=Date.now()
  const base: AnalyticsEventRecord={
    id:'',inputHash:'',name:'subscription_observed',source:'server',environment:analyticsEnvironment(ctx.config.mode),
    occurredAt:now,receivedAt:now,visitorKey:analyticsKey(ctx,'subscription-visit:'+row.id),
    accountKey:analyticsKey(ctx,'account:'+row.user_id),journeyKey:analyticsKey(ctx,'subscription-journey:'+row.id),
    pageKey:analyticsKey(ctx,'subscription-page:'+row.id),playbackKey:null,page:'subscriptions',
    market:ctx.config.catalogRegion??'JP',country:null,uiLanguage:null,contentLanguage:null,channelLanguage:null,
    audioLanguage:null,subtitleLanguage:null,subtitleMode:null,dramaId:null,workId:null,episodeId:null,mediaVersion:null,
    contentVersion:null,channelVersion:null,sectionId:null,position:null,entrySource:'unknown',deviceOS:'other',
    playerType:'tiktok',networkType:'unknown',buildId:null,orderId:key,amount:null,amountText:null,currency:null,
    sample:false,experimentId:null,variant:null,qualityFlags:['attribution_unavailable','subscription_not_allocated_to_drama'],properties:{},
  }
  for(const kind of ['charge','refund'] as const){
    const receiptId=kind==='charge'?row.payment_receipt_id:row.refund_receipt_id
    if(!receiptId || row.receipt_conflict)continue
    const receipt=ctx.db.prepare('SELECT event_created_at FROM subscription_webhook_receipts WHERE id=?').get(receiptId)
    if(!receipt)continue
    const code=currency(kind==='charge'?row.currency:row.refund_currency)
    const value=code?amount(kind==='charge'?row.actual_price:row.refund_price):null
    const id=`${key}:${kind}`,prior=ctx.db.prepare('SELECT payload FROM analytics_outbox WHERE event_id=?').get(id)
    if(!prior)store(ctx,{...base,id,name:`subscription_${kind}`,occurredAt:Number(receipt.event_created_at),
      amountText:value,currency:code,qualityFlags:[...base.qualityFlags,...(value===null?['price_unconfirmed']:[])]})
    else if(JSON.parse(String(prior.payload)).amountText===null && value!==null){
      store(ctx,{...base,id:`${id}:priced`,name:`subscription_${kind}_priced`,occurredAt:Number(receipt.event_created_at),
        amountText:value,currency:code,qualityFlags:[...base.qualityFlags,'price_received_later']})
    }
  }
  store(ctx,{...base,id:`${key}:observed:${tag(row)}`,qualityFlags:[...base.qualityFlags,...(row.receipt_conflict?['receipt_conflict']:[])]})
}
export function importSubscriptionAnalyticsPage(ctx: AppContext) {
  if(!ctx.analytics || !ctx.config.tiktokClientKey)return
  const rows=ctx.db.prepare(`SELECT t.id FROM subscription_transactions t WHERE t.client_key=? AND t.environment=? AND NOT EXISTS(
    SELECT 1 FROM analytics_outbox a WHERE a.event_id='subscription:'||t.id||':observed:'||
      COALESCE(t.payment_receipt_id,0)||':'||COALESCE(t.refund_receipt_id,0)||':'||COALESCE(t.revoke_receipt_id,0)||':'||
      COALESCE(t.metadata_receipt_id,0)||':'||t.receipt_conflict)
    ORDER BY t.id LIMIT 25`).all(ctx.config.tiktokClientKey,ctx.config.mode==='production'?'production':'sandbox')
  if(!rows.length)return
  ctx.db.exec('BEGIN IMMEDIATE')
  try{for(const row of rows)recordAnalyticsSubscription(ctx,Number(row.id));ctx.db.exec('COMMIT')}
  catch(error){ctx.db.exec('ROLLBACK');throw error}
}
