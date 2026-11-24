import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, readFileSync, lstatSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerConfig } from './types.js'

const environmentKey = 'runtime_environment'

/** Evidence of local/test use in a legacy database that predates environment labels. */
function hasLocalData(db: DatabaseSync): boolean {
  return Boolean(db.prepare(`
    SELECT 1 WHERE
      EXISTS (SELECT 1 FROM users WHERE provider='local' AND role<>'admin')
      OR EXISTS (SELECT 1 FROM orders WHERE provider='sandbox' OR currency='TEST_CREDITS')
      OR EXISTS (SELECT 1 FROM payment_events WHERE provider='sandbox')
      OR EXISTS (SELECT 1 FROM platform_order_attempts WHERE is_sandbox=1)
      OR EXISTS (SELECT 1 FROM payment_review_deliveries WHERE is_sandbox=1)
      OR EXISTS (SELECT 1 FROM playback_grants)
      OR EXISTS (SELECT 1 FROM dramas WHERE is_sample=1)
      OR EXISTS (SELECT 1 FROM audit_log WHERE
        CASE WHEN json_valid(detail) THEN
          (action='admin.bootstrap' AND json_extract(detail,'$.generated')=1)
          OR (action='drama.publish' AND json_extract(detail,'$.mode') IN ('local','staging'))
        ELSE 0 END
      )
      OR EXISTS (
        SELECT 1 FROM dramas d WHERE d.status='published' AND (
          d.platform_review_status<>'approved'
          OR NULLIF(TRIM(d.platform_album_id),'') IS NULL
          OR NOT EXISTS (SELECT 1 FROM episodes e WHERE e.drama_id=d.id)
          OR EXISTS (SELECT 1 FROM episodes e WHERE e.drama_id=d.id
            AND (NULLIF(TRIM(e.platform_episode_id),'') IS NULL OR NULLIF(TRIM(e.byteplus_vid),'') IS NULL))
        )
      )
  `).get())
}

export function openDatabase(config: ServerConfig): DatabaseSync {
  for (const dir of [config.dataDir, join(config.dataDir, 'uploads')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (lstatSync(dir).isSymbolicLink()) throw new Error('私有存储目录不可为符号链接')
    chmodSync(dir, 0o700)
  }
  const path = join(config.dataDir, 'drama.sqlite')
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('数据库不可为符号链接')
  const db = new DatabaseSync(path)
  try {
    chmodSync(path, 0o600)
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    transaction(db, () => {
      const hasSettings = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()
      const marker = hasSettings ? db.prepare('SELECT value FROM settings WHERE key=?').get(environmentKey) : undefined
      if (marker && marker.value !== config.mode) {
        throw new Error(`数据库环境不匹配：此库标记为 ${marker.value}，不能以 ${config.mode} 启动。请使用独立数据目录，原数据未删除。`)
      }
      // Schema creation and the first label are atomic. Rejection rolls back schema
      // additions too; never clear orders, sessions or content to make a DB "clean".
      const uploadColumns = db.prepare('PRAGMA table_info(cloud_upload_tasks)').all()
      const migrateUploadSlots = uploadColumns.length > 0 && !uploadColumns.some(column => column.name === 'reserved_seq')
      if (migrateUploadSlots) {
        db.exec('ALTER TABLE cloud_upload_tasks ADD COLUMN reserved_seq INTEGER CHECK(reserved_seq BETWEEN 1 AND 10000)')
      }
      const dramaColumns = db.prepare('PRAGMA table_info(dramas)').all()
      if (dramaColumns.length && !dramaColumns.some(column => column.name === 'work_id')) {
        // Existing records keep their IDs, versions, orders, progress and platform receipts.
        db.exec('ALTER TABLE dramas ADD COLUMN work_id INTEGER REFERENCES dramas(id)')
      }
      const hadBeansAttempts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='beans_payment_attempts'").get()
      db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
      if (!hadBeansAttempts) {
        // Before this table existed, even a pending trade may have reached the
        // SDK. Quarantine it once; absence of a callback is not "not started".
        // Preserve orders, request keys, receipts and entitlements verbatim.
        db.exec(`INSERT INTO beans_payment_attempts(order_id,id,context_hash,outcome,started_at,updated_at)
          SELECT o.id,'legacy:' || o.id,'legacy-unverified','unknown',o.created_at,o.created_at
          FROM orders o LEFT JOIN platform_order_attempts a ON a.order_id=o.id
          WHERE o.provider='tiktok' AND o.kind IN ('episode','drama') AND o.currency='BEANS'
          AND o.status IN ('pending','processing','cancelled','failed')
          AND (a.state IS NULL OR a.state<>'not_created')`)
      }
      if (!db.prepare('PRAGMA table_info(platform_media_operations)').all().some(column => column.name === 'verify_access')) {
        db.exec('ALTER TABLE platform_media_operations ADD COLUMN verify_access INTEGER NOT NULL DEFAULT 0 CHECK(verify_access IN (0,1))')
      }
      if (!db.prepare('PRAGMA table_info(media_delivery_jobs)').all().some(column => column.name === 'target_hash')) {
        db.exec("ALTER TABLE media_delivery_jobs ADD COLUMN target_hash TEXT NOT NULL DEFAULT ''")
      }
      if (!db.prepare('PRAGMA table_info(catalog_channels)').all().some(column => column.name === 'enabled')) {
        db.exec('ALTER TABLE catalog_channels ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
      }
      for (const [name, fallback] of [['sort_mode', 'manual'], ['sections_json', '[]']]) {
        if (!db.prepare('PRAGMA table_info(catalog_channels)').all().some(column => column.name === name)) {
          db.exec(`ALTER TABLE catalog_channels ADD COLUMN ${name} TEXT NOT NULL DEFAULT '${fallback}'`)
        }
      }
      for (const column of ['delivery_profile', 'production_sources']) {
        if (!db.prepare('PRAGMA table_info(dramas)').all().some(c => c.name === column)) {
          db.exec(`ALTER TABLE dramas ADD COLUMN ${column} TEXT NOT NULL DEFAULT '{}'`)
        }
      }
      // A work may have two deliveries with the same audio language but different caption languages.
      db.exec('DROP INDEX IF EXISTS drama_work_language')
      if (!db.prepare('PRAGMA table_info(dramas)').all().some(column => column.name === 'registration_metadata')) {
        // 旧剧目不推断发行/完结事实，不改变内容版本或已保存平台回执。
        db.exec("ALTER TABLE dramas ADD COLUMN registration_metadata TEXT NOT NULL DEFAULT '{}'")
      }
      if (!db.prepare('PRAGMA table_info(dramas)').all().some(column => column.name === 'localizations')) {
        db.exec("ALTER TABLE dramas ADD COLUMN localizations TEXT NOT NULL DEFAULT '{}'")
      }
      const registrationColumns = db.prepare('PRAGMA table_info(media_registration_jobs)').all()
      if (!registrationColumns.some(column => column.name === 'unresolved_write')) {
        db.exec(`ALTER TABLE media_registration_jobs ADD COLUMN unresolved_write INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_write IN (0,1));
          UPDATE media_registration_jobs SET unresolved_write=1,status='unknown'
          WHERE status='unknown' OR (status='running' AND write_started=1)
            OR (phase='update' AND status IN ('running','failed','stale') AND result_platform_version IS NULL);`)
      }
      if (!registrationColumns.some(column => column.name === 'pending_attempt_id')) {
        db.exec('ALTER TABLE media_registration_jobs ADD COLUMN pending_attempt_id TEXT')
      }
      if (migrateUploadSlots) {
        db.exec(`UPDATE cloud_upload_tasks SET reserved_seq=seq WHERE status<>'cancelled'
          AND NOT EXISTS (SELECT 1 FROM cloud_upload_imports i WHERE i.task_id=cloud_upload_tasks.id)`)
      }
      // 新索引仍原子地保护未完成上传的预留号；已导入单集改号或删除，不再被历史任务卡住。
      db.exec('DROP INDEX IF EXISTS cloud_upload_active_seq')
      if (!marker && config.mode === 'production' && hasLocalData(db)) {
        throw new Error('未标记的数据库含本地或测试数据，拒绝生产启动。请使用独立生产数据目录，原数据未删除。')
      }
      if (!marker && config.mode === 'staging' &&
        (hasLocalData(db) || db.prepare("SELECT 1 FROM users WHERE role<>'admin' LIMIT 1").get() ||
          db.prepare('SELECT 1 FROM orders LIMIT 1').get())) {
        throw new Error('未标记数据库包含已有业务数据，不能认领为预发布环境；请使用独立目录，原数据未删除。')
      }
      if (!marker) db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(environmentKey, config.mode)
    })
    db.exec('PRAGMA journal_mode = WAL;')
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) if (existsSync(sidecar)) chmodSync(sidecar, 0o600)
    return db
  } catch (e) { db.close(); throw e }
}
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const result = fn(); db.exec('COMMIT'); return result } catch (e) { db.exec('ROLLBACK'); throw e }
}
