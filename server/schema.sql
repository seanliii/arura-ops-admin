PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT UNIQUE COLLATE NOCASE, password_hash TEXT,
 nickname TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
 provider TEXT NOT NULL DEFAULT 'local', provider_id TEXT UNIQUE,
 created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('video','cover','subtitle')), original_name TEXT NOT NULL,
 storage_path TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
 sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dramas (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 category TEXT NOT NULL DEFAULT '恋愛', language TEXT NOT NULL DEFAULT 'ja',
 regions TEXT NOT NULL DEFAULT '["JP"]', tags TEXT NOT NULL DEFAULT '[]',
 cover_asset_id TEXT REFERENCES assets(id), status TEXT NOT NULL DEFAULT 'draft'
 CHECK(status IN ('draft','published','archived')), version INTEGER NOT NULL DEFAULT 1,
 free_episodes INTEGER NOT NULL DEFAULT 1 CHECK(free_episodes>=0),
 episode_price INTEGER NOT NULL DEFAULT 66 CHECK(episode_price>=0),
 bundle_price INTEGER NOT NULL DEFAULT 500 CHECK(bundle_price>=0),
 rights_confirmed INTEGER NOT NULL DEFAULT 0, is_sample INTEGER NOT NULL DEFAULT 0,
 platform_album_id TEXT, platform_review_status TEXT NOT NULL DEFAULT 'unconfigured',
 registration_metadata TEXT NOT NULL DEFAULT '{}',
 localizations TEXT NOT NULL DEFAULT '{}', work_id INTEGER REFERENCES dramas(id),
 delivery_profile TEXT NOT NULL DEFAULT '{}', production_sources TEXT NOT NULL DEFAULT '{}',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_channels (
 region TEXT NOT NULL, locale TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 fallback TEXT NOT NULL CHECK(fallback IN ('original','strict')),
 drama_ids TEXT NOT NULL, updated_at INTEGER NOT NULL,
 sort_mode TEXT NOT NULL DEFAULT 'manual', sections_json TEXT NOT NULL DEFAULT '[]',
 PRIMARY KEY(region,locale)
);
CREATE TABLE IF NOT EXISTS content_events (
 event_id TEXT PRIMARY KEY, visitor_hash TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 region TEXT NOT NULL, drama_id INTEGER NOT NULL REFERENCES dramas(id), episode_id INTEGER NOT NULL DEFAULT 0,
 kind TEXT NOT NULL CHECK(kind IN ('impression','play')), created_at INTEGER NOT NULL,
 UNIQUE(visitor_hash,drama_id,episode_id,kind)
);
CREATE TABLE IF NOT EXISTS operations_changes (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('drama','catalog')), target_key TEXT NOT NULL,
 actor_id TEXT NOT NULL, created_at INTEGER NOT NULL,
 before_version INTEGER NOT NULL, after_version INTEGER NOT NULL,
 before_json TEXT NOT NULL, after_json TEXT NOT NULL, context_json TEXT NOT NULL,
 supply_before TEXT NOT NULL, supply_after TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_changes_target ON operations_changes(kind,target_key,seq);
CREATE INDEX IF NOT EXISTS content_events_reporting ON content_events(region,created_at,drama_id);
CREATE TABLE IF NOT EXISTS drama_edition_requests (
 user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, drama_id INTEGER NOT NULL REFERENCES dramas(id),
 created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_id)
);
CREATE TABLE IF NOT EXISTS episodes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, drama_id INTEGER NOT NULL REFERENCES dramas(id),
 seq INTEGER NOT NULL CHECK(seq>0), title TEXT NOT NULL,
 duration_seconds REAL NOT NULL DEFAULT 0 CHECK(duration_seconds>=0),
 asset_id TEXT REFERENCES assets(id), subtitle_asset_id TEXT REFERENCES assets(id),
 platform_episode_id TEXT, byteplus_vid TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(drama_id,seq)
);
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL
 CHECK(kind IN ('episode','drama','vip')), target_id INTEGER, title TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0), currency TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('sandbox','tiktok')),
 status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','processing','paid','cancelled','failed','refunded')),
 request_key TEXT NOT NULL, trade_order_id TEXT UNIQUE, created_at INTEGER NOT NULL,
 paid_at INTEGER, expires_at INTEGER NOT NULL, UNIQUE(user_id,request_key)
);
CREATE TABLE IF NOT EXISTS entitlements (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('episode','drama','vip')), target_id INTEGER,
 order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), starts_at INTEGER NOT NULL,
 expires_at INTEGER, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS entitlements_user ON entitlements(user_id);
CREATE TABLE IF NOT EXISTS payment_events (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), provider TEXT NOT NULL,
 event_type TEXT NOT NULL, received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 drama_id INTEGER NOT NULL REFERENCES dramas(id), created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,drama_id)
);
CREATE TABLE IF NOT EXISTS following (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 drama_id INTEGER NOT NULL REFERENCES dramas(id), created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,drama_id)
);
CREATE TABLE IF NOT EXISTS progress (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 drama_id INTEGER NOT NULL REFERENCES dramas(id), episode_id INTEGER NOT NULL REFERENCES episodes(id),
 current_time REAL NOT NULL, duration REAL NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,drama_id)
);
CREATE TABLE IF NOT EXISTS playback_grants (
 token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), session_hash TEXT,
 episode_id INTEGER NOT NULL REFERENCES episodes(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
 target_type TEXT NOT NULL, target_id TEXT, detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS analytics_outbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
 payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media_delivery_jobs (
 id TEXT PRIMARY KEY, drama_id INTEGER NOT NULL REFERENCES dramas(id),
 owner_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, intent_hash TEXT NOT NULL,
 expected_episodes INTEGER NOT NULL CHECK(expected_episodes BETWEEN 1 AND 10000),
 auto_publish INTEGER NOT NULL CHECK(auto_publish IN (0,1)),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 status TEXT NOT NULL DEFAULT 'queued', phase TEXT NOT NULL DEFAULT 'uploads',
 metadata_hash TEXT NOT NULL, target_hash TEXT NOT NULL DEFAULT '', initial_episodes_json TEXT NOT NULL DEFAULT '[]', source_hash TEXT,
 registration_request_id TEXT NOT NULL, registration_job_id TEXT,
 operation_id TEXT, operation_action TEXT, operation_version INTEGER,
 album_id TEXT, platform_version INTEGER,
 next_run_at INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0,
 lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, message TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(owner_id,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS media_delivery_one_active ON media_delivery_jobs(drama_id) WHERE active=1;
CREATE INDEX IF NOT EXISTS media_delivery_due ON media_delivery_jobs(active,status,next_run_at);
-- 仅新发生的阶段观测；不以旧 updated_at 倒填完成时间。
CREATE TABLE IF NOT EXISTS media_delivery_observations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES media_delivery_jobs(id),
 status TEXT NOT NULL, phase TEXT NOT NULL, observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_delivery_observed ON media_delivery_observations(job_id,observed_at,id);
-- 人工明确点击的计时观察，与平台等待/业务审计分开；不回填旧任务。
CREATE TABLE IF NOT EXISTS delivery_work_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL REFERENCES users(id), job_id TEXT NOT NULL REFERENCES media_delivery_jobs(id),
 request_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('start','pause','finish')),
 observed_at INTEGER NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 UNIQUE(owner_id,request_id)
);
CREATE INDEX IF NOT EXISTS delivery_work_by_job ON delivery_work_events(job_id,owner_id,id);
CREATE TABLE IF NOT EXISTS episode_title_batches (
 owner_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL,
 drama_id INTEGER NOT NULL REFERENCES dramas(id), fingerprint TEXT NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,request_id)
);
CREATE TABLE IF NOT EXISTS platform_tokens (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 encrypted_tokens TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- Local attempt outcomes, not invented TikTok order statuses. Existing orders are
-- left untouched; lack of an attempt record is not proof of non-creation.
CREATE TABLE IF NOT EXISTS platform_order_attempts (
 order_id TEXT PRIMARY KEY REFERENCES orders(id),
 state TEXT NOT NULL CHECK(state IN ('submitting','created','unknown','not_created')),
 error_code TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
 is_sandbox INTEGER CHECK(is_sandbox IN (0,1)), updated_at INTEGER NOT NULL
);

-- Local SDK dispatch evidence, not a platform cancellation/settlement state.
-- A trade can be dispatched at most once, including across reloads and workers.
CREATE TABLE IF NOT EXISTS beans_payment_attempts (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  id TEXT NOT NULL UNIQUE,
  context_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('started','succeeded','cancelled','failed','unknown','not_started')),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  released_at INTEGER
);
-- Latest read-only platform check, never a settlement or a payment receipt.
-- The durable cooldown also prevents another worker from querying the same order;
-- check_id prevents a slow, older request from overwriting a newer check.
CREATE TABLE IF NOT EXISTS platform_order_checks (
 order_id TEXT PRIMARY KEY REFERENCES orders(id), trade_order_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','SUCCESS','UNCONFIRMED')),
 checked_at INTEGER NOT NULL, next_check_at INTEGER NOT NULL, check_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_events_order ON payment_events(order_id);
-- Preserve every business request key, including keys that reuse an unresolved order.
CREATE TABLE IF NOT EXISTS order_request_keys (
 user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
 order_id TEXT NOT NULL REFERENCES orders(id),
 PRIMARY KEY(user_id,request_key)
);
-- One row per verified delivery, including repeated identical payloads.
-- No uniqueness constraint on order/event/fingerprint and no automatic money movement.
CREATE TABLE IF NOT EXISTS payment_review_deliveries (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
 trade_order_id TEXT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type='minis.trade_order.redeem.refund_traceback'),
 status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status='pending_review'),
 amount_raw TEXT, payload_sha256 TEXT NOT NULL,
 is_sandbox INTEGER CHECK(is_sandbox IN (0,1)), received_at INTEGER NOT NULL
);

-- 媒资专用记录：不迁移/重写历史订单、权益或剧目。旧库启动时幂等补建。
-- 请求在 HTTP 之前提交；未知写操作保留，不因重启、换请求 ID 或读失败重发。
CREATE TABLE IF NOT EXISTS platform_media_operations (
 request_id TEXT PRIMARY KEY, drama_id INTEGER NOT NULL REFERENCES dramas(id),
 action TEXT NOT NULL CHECK(action IN ('sync','submit_review','set_online','authorize_app','list','delist')),
 verify_access INTEGER NOT NULL DEFAULT 0 CHECK(verify_access IN (0,1)),
 album_id TEXT NOT NULL, platform_version INTEGER NOT NULL CHECK(platform_version>0),
 client_key TEXT NOT NULL, local_version INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('submitting','succeeded','failed','unknown','awaiting_sync','superseded','reconciled')),
 acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)),
 prior_review_status INTEGER, prior_needs_sync INTEGER NOT NULL DEFAULT 1,
 review_id TEXT, result_version INTEGER, reconciled_by TEXT,
 error_code TEXT, message TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lease_until INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_media_operations_drama ON platform_media_operations(drama_id,status,created_at);
-- 只追加本次确实收到的成功查询结果，供版本/轮次回看；失败查询不改写此前观测。
CREATE TABLE IF NOT EXISTS platform_media_observations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE REFERENCES platform_media_operations(request_id),
 drama_id INTEGER NOT NULL REFERENCES dramas(id), platform_version INTEGER NOT NULL, local_version INTEGER NOT NULL,
 review_status INTEGER NOT NULL, publish_status INTEGER NOT NULL, observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_media_observed ON platform_media_observations(drama_id,platform_version,observed_at,id);
CREATE TABLE IF NOT EXISTS platform_media_bindings (
 drama_id INTEGER PRIMARY KEY REFERENCES dramas(id),
 album_id TEXT, client_key TEXT, platform_version INTEGER CHECK(platform_version>0),
 current_version INTEGER CHECK(current_version>0), online_version INTEGER CHECK(online_version>0),
 review_status INTEGER CHECK(review_status BETWEEN 0 AND 7),
 publish_status INTEGER CHECK(publish_status IN (0,1,2)),
 synced_local_version INTEGER, synced_at INTEGER,
 authorized_client_key TEXT, authorized_at INTEGER,
 needs_sync INTEGER NOT NULL DEFAULT 1 CHECK(needs_sync IN (0,1)),
 operation_id TEXT REFERENCES platform_media_operations(request_id),
 synced_operation_id TEXT REFERENCES platform_media_operations(request_id),
 versions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(versions_json))
);
CREATE TABLE IF NOT EXISTS platform_media_episodes (
 drama_id INTEGER NOT NULL REFERENCES platform_media_bindings(drama_id) ON DELETE CASCADE,
 local_episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL CHECK(seq>0), episode_id TEXT NOT NULL, vid TEXT NOT NULL,
 PRIMARY KEY(drama_id,seq), UNIQUE(drama_id,episode_id), UNIQUE(local_episode_id)
);

-- 无关联记录的历史sessions仍是Cookie。新会话与来源标记必须在同一事务写入。
CREATE TABLE IF NOT EXISTS session_transports (
 token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
 transport TEXT NOT NULL CHECK(transport IN ('cookie','minis-bearer'))
);

-- 仅新Bearer写入绑定来源。旧Cookie无需此记录；旧无绑定Bearer必须重新登录。
CREATE TABLE IF NOT EXISTS session_origins (
 token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
 origin TEXT NOT NULL
);

-- 只保存上传任务与核验事实，不保存STS或分片上传授权，不冒充平台剧集关联。
CREATE TABLE IF NOT EXISTS cloud_upload_tasks (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
 drama_id INTEGER NOT NULL REFERENCES dramas(id), seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 10000),
 reserved_seq INTEGER CHECK(reserved_seq BETWEEN 1 AND 10000),
 title TEXT NOT NULL, file_name TEXT NOT NULL, file_bytes INTEGER NOT NULL CHECK(file_bytes>0 AND file_bytes<=20000000000),
 account_id TEXT NOT NULL, config_fingerprint TEXT NOT NULL, media_marker TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('created','uploading','awaiting_verification','verifying','verified','cancelled')),
 candidate_vid TEXT, claimed_vid TEXT, duration_seconds REAL, verified_at INTEGER,
 issued_at INTEGER, credential_after INTEGER NOT NULL DEFAULT 0,
 lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, message TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(owner_id,request_key), UNIQUE(account_id,claimed_vid)
);
-- seq保存最初上传目标，不因后续编辑而改写；导入/取消后释放预留，由episodes本身的唯一集号负责占用。
CREATE UNIQUE INDEX IF NOT EXISTS cloud_upload_reserved_seq ON cloud_upload_tasks(drama_id,reserved_seq) WHERE status<>'cancelled';
CREATE INDEX IF NOT EXISTS cloud_upload_owner ON cloud_upload_tasks(owner_id,created_at);

-- 导入只创建本地草稿；保留导入凭据，删除单集后网络重放不能悄悄将其重建。
CREATE TABLE IF NOT EXISTS cloud_upload_imports (
 task_id TEXT PRIMARY KEY REFERENCES cloud_upload_tasks(id),
 episode_id INTEGER UNIQUE REFERENCES episodes(id) ON DELETE SET NULL,
 imported_at INTEGER NOT NULL
);

-- 依附原上传任务，保存已有VID登记回执；与BytePlus文件核验、剧目版本及付款权益分开。
-- write_id非空意味着可能已发出写入，即使进程崩溃也只能先查询，不能盲目重发。
CREATE TABLE IF NOT EXISTS cloud_video_registrations (
 task_id TEXT PRIMARY KEY REFERENCES cloud_upload_tasks(id),
 vid TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('checking','sending','registered','failed','unknown')),
 write_id TEXT, acknowledged_vid TEXT, confirmed_at INTEGER,
 lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, message TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- 明确的登记意图与分步回执。只保存业务信息，不保存临时下载地址或云服务密钥。
-- 接回应用之外已获得的真实空Album/封面回执。地域与应用身份独立于尚未确认的日语字段。
CREATE TABLE IF NOT EXISTS media_registration_recoveries (
 drama_id INTEGER PRIMARY KEY REFERENCES dramas(id),
 owner_id TEXT NOT NULL REFERENCES users(id),
 album_id TEXT NOT NULL UNIQUE, cover_pic_id TEXT NOT NULL,
 target_fingerprint TEXT NOT NULL,
 local_version INTEGER NOT NULL,
 cover_asset_id TEXT NOT NULL REFERENCES assets(id),
 cover_sha256 TEXT NOT NULL, cover_bytes INTEGER NOT NULL,
 recovered_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media_registration_jobs (
 id TEXT PRIMARY KEY, drama_id INTEGER NOT NULL REFERENCES dramas(id),
 owner_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
 local_version INTEGER NOT NULL, source_hash TEXT NOT NULL, config_fingerprint TEXT NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 phase TEXT NOT NULL CHECK(phase IN ('cover','create','update','verify','done')),
 status TEXT NOT NULL CHECK(status IN ('ready','running','failed','unknown','stale','registered','superseded')),
 cover_pic_id TEXT, album_id TEXT, base_platform_version INTEGER, result_platform_version INTEGER,
 episode_map_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(episode_map_json)),
 lease_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 write_started INTEGER NOT NULL DEFAULT 0 CHECK(write_started IN (0,1)),
 unresolved_write INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_write IN (0,1)),
 pending_attempt_id TEXT,
 error_code TEXT, message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(owner_id,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS media_registration_one_current ON media_registration_jobs(drama_id) WHERE status<>'superseded';
CREATE TABLE IF NOT EXISTS media_registration_attempts (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES media_registration_jobs(id),
 phase TEXT NOT NULL CHECK(phase IN ('cover','create','update')),
 source_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','unknown','rejected','confirmed','reconciled')),
 receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media_registration_requests (
 owner_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
 job_id TEXT NOT NULL REFERENCES media_registration_jobs(id), intent_hash TEXT NOT NULL,
 PRIMARY KEY(owner_id,request_key)
);

-- Subscription prices retain the provider's decimal text and currency, not Beans.
-- These are preparation/dispatch records, not paid orders or membership grants.
CREATE TABLE IF NOT EXISTS subscription_quotes (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 client_key TEXT NOT NULL, receiving_mode TEXT NOT NULL,
 owner_identity TEXT NOT NULL, config_hash TEXT NOT NULL,
 device_platform TEXT NOT NULL CHECK(device_platform IN ('android','iphone')),
 offers_json TEXT NOT NULL CHECK(json_valid(offers_json)),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_operations (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 client_key TEXT NOT NULL, receiving_mode TEXT NOT NULL, owner_identity TEXT NOT NULL,
 quote_id TEXT NOT NULL REFERENCES subscription_quotes(id),
 action TEXT NOT NULL CHECK(action IN ('create','reactivate')), tier_id TEXT NOT NULL,
 offer_json TEXT NOT NULL CHECK(json_valid(offer_json)),
 device_platform TEXT NOT NULL CHECK(device_platform IN ('android','iphone')),
 status TEXT NOT NULL CHECK(status IN ('checking','submitting','ready_for_sdk','awaiting_confirmation','outcome_unknown','not_created')),
 lease_id TEXT NOT NULL, lease_until INTEGER NOT NULL,
 trade_order_id TEXT, subscription_id TEXT, sdk_started_at INTEGER,
 error_code TEXT, provider_status TEXT CHECK(provider_status IN ('PENDING','SUCCESS','REFUNDED')),
 source_environment TEXT NOT NULL DEFAULT 'unknown' CHECK(source_environment IN ('sandbox','production','unknown')),
 checked_at INTEGER, next_check_at INTEGER NOT NULL DEFAULT 0, check_id TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(client_key,receiving_mode,trade_order_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_one_pending ON subscription_operations(user_id,client_key,receiving_mode)
 WHERE status IN ('checking','submitting','ready_for_sdk','awaiting_confirmation','outcome_unknown');
CREATE TABLE IF NOT EXISTS subscription_operation_requests (
 user_id TEXT NOT NULL REFERENCES users(id), client_key TEXT NOT NULL, receiving_mode TEXT NOT NULL,
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 operation_id TEXT NOT NULL REFERENCES subscription_operations(id),
 PRIMARY KEY(user_id,client_key,receiving_mode,request_key)
);
-- Current platform benefits, never a payment ledger or a fabricated expiry period.
CREATE TABLE IF NOT EXISTS subscription_access_cache (
 user_id TEXT NOT NULL REFERENCES users(id), client_key TEXT NOT NULL, receiving_mode TEXT NOT NULL,
 owner_identity TEXT NOT NULL, config_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('valid','inactive','unverified')),
 reason TEXT, checked_at INTEGER, fresh_until INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,client_key,receiving_mode)
);
