import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync, backup } from 'node:sqlite'
import { existsSync, mkdirSync, lstatSync, chmodSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { projectEvent, projectDimensions } from './analytics-projections.mjs'
import { analyticsReport } from './analytics-reports.mjs'
import { catalogSnapshot, operation } from './analytics-operations-worker.mjs'

// This worker owns the statistics connection. It never opens the business database.
const directory = workerData.directory
let db
const columns = [
  'id','input_hash','name','source','environment','occurred_at','received_at','visitor_key','account_key',
  'journey_key','page_key','playback_key','page','market','country','ui_language','content_language','channel_language',
  'audio_language','subtitle_language','subtitle_mode','drama_id','work_id','episode_id','media_version',
  'content_version','channel_version','section_id','position','entry_source','device_os','player_type',
  'network_type','network_quality','network_source','build_id','order_id','amount','amount_text','currency','sample','experiment_id','variant','quality_flags','properties',
]
function values(e) {
  return [e.id,e.inputHash,e.name,e.source,e.environment,e.occurredAt,e.receivedAt,e.visitorKey,e.accountKey,
    e.journeyKey,e.pageKey,e.playbackKey,e.page,e.market,e.country,e.uiLanguage,e.contentLanguage,e.channelLanguage,e.audioLanguage,
    e.subtitleLanguage,e.subtitleMode,e.dramaId,e.workId,e.episodeId,e.mediaVersion,e.contentVersion,e.channelVersion,
    e.sectionId,e.position,e.entrySource,e.deviceOS,e.playerType,e.networkType,e.networkQuality ?? 'unknown',e.networkSource ?? 'unrecorded',
    e.buildId,e.orderId,e.amount,e.amountText ?? null,e.currency,
    Number(e.sample),e.experimentId,e.variant,JSON.stringify(e.qualityFlags),JSON.stringify(e.properties)]
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE')
  try { const result = fn(); db.exec('COMMIT'); return result }
  catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
}
function store(events, businessCursor) {
  return transaction(() => {
    let accepted = 0, duplicates = 0
    const insert = db.prepare(`INSERT INTO analytics_events(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
    for (const e of events) {
      if (e.environment !== workerData.environment) throw Object.assign(new Error('Environment mismatch'), { code: 'ANALYTICS_ENVIRONMENT_MISMATCH' })
      const prior = db.prepare('SELECT input_hash FROM analytics_receipts WHERE id=?').get(e.id)
      if (prior) {
        if (prior.input_hash !== e.inputHash) throw Object.assign(new Error('Event identity reused'), { code: 'ANALYTICS_EVENT_CONFLICT' })
        duplicates++
        continue
      }
      // A confirmed receipt is inserted in the same transaction as the event.
      insert.run(...values(e))
      if (e.supplyObservation && e.source === 'client' && e.name === 'play_request' && e.playbackKey) {
        db.prepare('INSERT INTO analytics_supply_observations(event_id,playback_key,observed_at,snapshot) VALUES(?,?,?,?)')
          .run(e.id, e.playbackKey, e.supplyObservation.observedAt, JSON.stringify(e.supplyObservation))
      }
      db.prepare('INSERT INTO analytics_receipts(id,input_hash,received_at,source) VALUES(?,?,?,?)').run(e.id,e.inputHash,e.receivedAt,e.source)
      projectEvent(db,e,workerData.timezones)
      accepted++
    }
    if (Number.isSafeInteger(businessCursor) && businessCursor >= 0) {
      db.prepare("INSERT INTO analytics_meta(key,value) VALUES('business_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(businessCursor))
    }
    return { accepted, duplicates }
  })
}
function status() {
  return {
    available: true, storage: 'independent-sqlite', environment: workerData.environment, version: 2,
    events: Number(db.prepare('SELECT count(*) n FROM analytics_events').get().n),
    playbacks: Number(db.prepare('SELECT count(*) n FROM analytics_playbacks').get().n),
    receivedThrough: db.prepare('SELECT max(received_at) n FROM analytics_events').get().n ?? null,
    businessCursor: Number(db.prepare("SELECT value FROM analytics_meta WHERE key='business_cursor'").get()?.value ?? 0),
  }
}
function maintenance(now=Date.now()){
  const cutoff=now-30*86400000,retention=now-400*86400000
  const result=transaction(()=>{
    const events=Number(db.prepare('DELETE FROM analytics_events WHERE occurred_at<?').run(cutoff).changes)
    const playbacks=Number(db.prepare('DELETE FROM analytics_playbacks WHERE COALESCE(requested_at,qualified_at,first_frame_at,updated_at)<?').run(cutoff).changes)
    // Transaction receipts stay replay-safe. Client receipt IDs carry no user keys.
    db.prepare("DELETE FROM analytics_receipts WHERE source='client' AND received_at<?").run(retention)
    for(const table of ['analytics_actor_days','analytics_retention_days'])db.prepare(`DELETE FROM ${table} WHERE day<?`).run(new Date(retention).toISOString().slice(0,10))
    db.prepare('DELETE FROM analytics_retention_first WHERE first_seen<? AND account_key NOT IN(SELECT account_key FROM analytics_retention_days)').run(retention)
    db.prepare('DELETE FROM analytics_actor_first WHERE first_seen<? AND account_key NOT IN(SELECT account_key FROM analytics_actor_days)').run(retention)
    if(events||playbacks)db.prepare("INSERT INTO analytics_meta(key,value) VALUES('raw_pruned_before',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)").run(String(cutoff))
    db.prepare("INSERT INTO analytics_meta(key,value) VALUES('maintenance_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now))
    return{eventsPruned:events,playbacksPruned:playbacks,rawBefore:cutoff}
  })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return result
}
function maintainIfDue() {
  const at=Number(db.prepare("SELECT value FROM analytics_meta WHERE key='maintenance_at'").get()?.value??0)
  if(Date.now()-at>3600000)maintenance()
}
try {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink()) throw Error('Statistics directory cannot be a symlink')
  const file = join(directory, 'analytics.sqlite')
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw Error('Statistics file cannot be a symlink')
  db = new DatabaseSync(file)
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='analytics_meta'").get()){
    const environment=db.prepare("SELECT value FROM analytics_meta WHERE key='environment'").get()?.value
    if(environment&&environment!==workerData.environment)throw Error('Statistics environment mismatch')
  }
  chmodSync(directory, 0o700); chmodSync(file, 0o600)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=250; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;')
  db.exec(readFileSync(new URL('./analytics-schema.sql', import.meta.url), 'utf8'))
  for (const table of ['analytics_events','analytics_playbacks']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'channel_language')) db.exec(`ALTER TABLE ${table} ADD COLUMN channel_language TEXT`)
    for (const [column, value] of [['network_quality','unknown'], ['network_source','unrecorded']]) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${value}'`)
    }
  }
  for (const [table, column, definition] of [
    ['analytics_events','amount_text','TEXT'],['analytics_playbacks','frame_signal','INTEGER NOT NULL DEFAULT 0'],
    ['analytics_playbacks','timing_version','INTEGER NOT NULL DEFAULT 1'],['analytics_playbacks','rebuffer_signal','INTEGER NOT NULL DEFAULT 0'],
    ['analytics_daily','value','REAL NOT NULL DEFAULT 0'],['analytics_daily','money_text',"TEXT NOT NULL DEFAULT '0'"],
  ]) if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  transaction(() => {
    const prior = db.prepare("SELECT value FROM analytics_meta WHERE key='environment'").get()
    if (prior && prior.value !== workerData.environment) throw Error('Statistics environment mismatch')
    db.prepare("INSERT OR IGNORE INTO analytics_meta(key,value) VALUES('environment',?)").run(workerData.environment)
    db.prepare("INSERT OR IGNORE INTO analytics_meta(key,value) VALUES('business_cursor','0')").run()
  })
  if (!db.prepare("SELECT 1 FROM analytics_meta WHERE key='projection_version'").get()) {
    transaction(() => {
      if (db.prepare('SELECT count(*) n FROM analytics_daily').get().n || db.prepare('SELECT count(*) n FROM analytics_playbacks').get().n) {
        throw Error('Existing projections have no version; preserve them for explicit review')
      }
      for (const row of db.prepare('SELECT * FROM analytics_events ORDER BY occurred_at,id').all()) {
        const e={}
        for(const [key,value] of Object.entries(row)) e[key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())]=value
        e.properties=JSON.parse(row.properties);e.qualityFlags=JSON.parse(row.quality_flags)
        e.sample=Boolean(row.sample);e.deviceOS=row.device_os
        projectEvent(db,e,workerData.timezones)
      }
      db.prepare("INSERT INTO analytics_meta(key,value) VALUES('projection_version','1')").run()
      db.prepare("INSERT OR IGNORE INTO analytics_meta(key,value) VALUES('dimension_projection_version','1')").run()
    })
  }
  if(!db.prepare("SELECT 1 FROM analytics_meta WHERE key='dimension_projection_version'").get()){
    transaction(()=>{
      const previous=new Map()
      for(const row of db.prepare('SELECT * FROM analytics_events ORDER BY occurred_at,id').all()){
        const e={}
        for(const [key,value]of Object.entries(row))e[key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())]=value
        e.properties=JSON.parse(row.properties);e.sample=Boolean(row.sample);e.deviceOS=row.device_os
        const old=previous.get(e.playbackKey)??{wall:0,stall:0},p=e.properties
        const wall=Math.max(old.wall,p.wallMs??0),stall=Math.max(old.stall,p.stallMs??0)
        projectDimensions(db,e,workerData.timezones,p.wallDeltaMs??wall-old.wall,p.stallDeltaMs??stall-old.stall)
        if(e.playbackKey)previous.set(e.playbackKey,{wall,stall})
      }
      db.prepare("INSERT INTO analytics_meta(key,value) VALUES('dimension_projection_version','1')").run()
    })
  }
  let serial = Promise.resolve()
  parentPort.on('message', message => {
    serial = serial.then(async () => {
      try {
        let result
        // The existing server pump reads status even with no new traffic or
        // transactions. Keep retention running then, and prune before reads or
        // snapshots expose expired detail. Ingest still prunes after storing.
        if (!['ingest','maintenance','close'].includes(message.action)) maintainIfDue()
        if (message.action === 'ingest') {
          result = store(message.payload.events, message.payload.businessCursor)
          maintainIfDue()
        }
        else if (message.action === 'status') result = status()
        else if (message.action === 'report') {
          const processedAt = Date.now()
          const submittedAt = Math.min(processedAt, message.submittedAt)
          result = analyticsReport(db,message.payload,workerData.timezones,processedAt,Number.isFinite(submittedAt) ? {
            source: 'serial_ingress_barrier', requestSequence: message.id, enqueuedAt: submittedAt, processedAt,
            clientCompleteBefore: submittedAt - 7 * 86400000, allowedLatenessDays: 7,
          } : null)
        }
        else if (message.action === 'catalog-snapshot') result = catalogSnapshot(db)
        else if (message.action === 'maintenance') result = maintenance(message.payload.now??Date.now())
        else if (['list-candidates','create-candidate','list-experiments','get-experiment','create-experiment','state-experiment'].includes(message.action))
          result = transaction(()=>operation(db,message.action,message.payload))
        else if (message.action === 'snapshot') {
          const target = resolve(message.payload.target)
          if (!target.endsWith('.sqlite') || dirname(target) === directory) throw Error('Invalid snapshot target')
          await backup(db, target)
          result = { cursor: status().businessCursor }
        } else if (message.action === 'close') {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); db = undefined
          parentPort.postMessage({ id: message.id, ok: true, result: {} }); parentPort.close(); return
        } else throw Object.assign(new Error('Unknown analytics operation'), { code: 'ANALYTICS_OPERATION_INVALID' })
        parentPort.postMessage({ id: message.id, ok: true, result })
      } catch (error) {
        parentPort.postMessage({ id: message.id, ok: false, code: String(error?.code ?? 'ANALYTICS_STORAGE_ERROR') })
      }
    })
  })
  parentPort.postMessage({ ready: true })
} catch {
  try { db?.close() } catch {}
  parentPort.postMessage({ ready: false, code: 'ANALYTICS_STORAGE_UNAVAILABLE' })
  parentPort.close()
}
