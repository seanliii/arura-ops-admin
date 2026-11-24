PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS analytics_events (
 id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, name TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('client','server')),
 environment TEXT NOT NULL CHECK(environment IN ('production','official_test','internal')),
 occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
 visitor_key TEXT NOT NULL, account_key TEXT, journey_key TEXT NOT NULL, page_key TEXT NOT NULL,
 playback_key TEXT, page TEXT NOT NULL, market TEXT NOT NULL, country TEXT,
 ui_language TEXT, content_language TEXT, channel_language TEXT, audio_language TEXT, subtitle_language TEXT, subtitle_mode TEXT,
 drama_id INTEGER, work_id INTEGER, episode_id INTEGER, media_version INTEGER, content_version INTEGER,
 channel_version INTEGER, section_id TEXT, position INTEGER, entry_source TEXT NOT NULL,
 device_os TEXT NOT NULL, player_type TEXT, network_type TEXT NOT NULL,
 network_quality TEXT NOT NULL DEFAULT 'unknown', network_source TEXT NOT NULL DEFAULT 'unrecorded', build_id TEXT,
 order_id TEXT, amount INTEGER, amount_text TEXT, currency TEXT, sample INTEGER NOT NULL DEFAULT 0,
 experiment_id TEXT, variant TEXT, quality_flags TEXT NOT NULL, properties TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analytics_events_time ON analytics_events(occurred_at,market,content_language,drama_id);
CREATE INDEX IF NOT EXISTS analytics_events_journey ON analytics_events(journey_key,occurred_at,name);
CREATE INDEX IF NOT EXISTS analytics_events_visit ON analytics_events(visitor_key,account_key);
CREATE INDEX IF NOT EXISTS analytics_events_order ON analytics_events(order_id,name);
CREATE INDEX IF NOT EXISTS analytics_events_playback ON analytics_events(playback_key,occurred_at);
CREATE TABLE IF NOT EXISTS analytics_supply_observations (
 event_id TEXT PRIMARY KEY REFERENCES analytics_events(id) ON DELETE CASCADE,
 playback_key TEXT NOT NULL, observed_at INTEGER NOT NULL, snapshot TEXT NOT NULL CHECK(json_valid(snapshot))
);
CREATE TABLE IF NOT EXISTS analytics_receipts (
 id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, received_at INTEGER NOT NULL, source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analytics_playbacks (
 id TEXT PRIMARY KEY, visitor_key TEXT NOT NULL, account_key TEXT, journey_key TEXT NOT NULL,
 environment TEXT NOT NULL, market TEXT NOT NULL, country TEXT,
 ui_language TEXT, content_language TEXT, channel_language TEXT, audio_language TEXT, subtitle_language TEXT, subtitle_mode TEXT,
 drama_id INTEGER NOT NULL, episode_id INTEGER NOT NULL, sample INTEGER NOT NULL DEFAULT 0,
 media_version INTEGER, content_version INTEGER, channel_version INTEGER, section_id TEXT, position INTEGER,
 entry_source TEXT NOT NULL, device_os TEXT NOT NULL, player_type TEXT, network_type TEXT NOT NULL,
 network_quality TEXT NOT NULL DEFAULT 'unknown', network_source TEXT NOT NULL DEFAULT 'unrecorded', build_id TEXT,
 requested_at INTEGER, first_frame_at INTEGER, first_frame_ms REAL, frame_signal INTEGER NOT NULL DEFAULT 0,
 timing_version INTEGER NOT NULL DEFAULT 1, rebuffer_signal INTEGER NOT NULL DEFAULT 0, qualified_at INTEGER,
 watched_ms REAL NOT NULL DEFAULT 0, wall_ms REAL NOT NULL DEFAULT 0, stall_ms REAL NOT NULL DEFAULT 0,
 duration_ms REAL NOT NULL DEFAULT 0, coverage_ms REAL NOT NULL DEFAULT 0,
 intervals TEXT NOT NULL DEFAULT '[]', ended_at INTEGER, error_code TEXT, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS analytics_playbacks_time ON analytics_playbacks(requested_at,market,content_language,drama_id);
CREATE TABLE IF NOT EXISTS analytics_actor_days (
 day TEXT NOT NULL, timezone TEXT NOT NULL, account_key TEXT NOT NULL, environment TEXT NOT NULL,
 market TEXT NOT NULL, content_language TEXT NOT NULL, drama_id INTEGER NOT NULL,
 first_seen INTEGER NOT NULL, watched_ms REAL NOT NULL DEFAULT 0,
 PRIMARY KEY(day,timezone,account_key,environment,market,content_language,drama_id)
);
CREATE TABLE IF NOT EXISTS analytics_daily (
 day TEXT NOT NULL, timezone TEXT NOT NULL, environment TEXT NOT NULL, market TEXT NOT NULL,
 content_language TEXT NOT NULL, drama_id INTEGER NOT NULL, episode_id INTEGER NOT NULL,
 name TEXT NOT NULL, currency TEXT NOT NULL, sample INTEGER NOT NULL,
 count INTEGER NOT NULL DEFAULT 0, amount INTEGER NOT NULL DEFAULT 0, value REAL NOT NULL DEFAULT 0, money_text TEXT NOT NULL DEFAULT '0',
 PRIMARY KEY(day,timezone,environment,market,content_language,drama_id,episode_id,name,currency,sample)
);
CREATE TABLE IF NOT EXISTS analytics_actor_first (
 account_key TEXT NOT NULL, environment TEXT NOT NULL, market TEXT NOT NULL,
 content_language TEXT NOT NULL, drama_id INTEGER NOT NULL, first_seen INTEGER NOT NULL,
 PRIMARY KEY(account_key,environment,market,content_language,drama_id)
);
CREATE TABLE IF NOT EXISTS analytics_summary (
 day TEXT NOT NULL, timezone TEXT NOT NULL, scope_key TEXT NOT NULL, dimensions TEXT NOT NULL,
 name TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, value REAL NOT NULL DEFAULT 0,
 PRIMARY KEY(day,timezone,scope_key,name)
);
CREATE INDEX IF NOT EXISTS analytics_summary_dates ON analytics_summary(timezone,day);
CREATE TABLE IF NOT EXISTS analytics_retention_first (
 account_key TEXT NOT NULL, scope_key TEXT NOT NULL, dimensions TEXT NOT NULL, first_seen INTEGER NOT NULL,
 PRIMARY KEY(account_key,scope_key)
);
CREATE TABLE IF NOT EXISTS analytics_retention_days (
 day TEXT NOT NULL, timezone TEXT NOT NULL, account_key TEXT NOT NULL, scope_key TEXT NOT NULL,
 dimensions TEXT NOT NULL, first_seen INTEGER NOT NULL,
 PRIMARY KEY(day,timezone,account_key,scope_key)
);
CREATE INDEX IF NOT EXISTS analytics_retention_dates ON analytics_retention_days(timezone,day);
CREATE TABLE IF NOT EXISTS analytics_money (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, occurred_at INTEGER NOT NULL, dimensions TEXT NOT NULL,
 amount_text TEXT, currency TEXT, pricing_confirmed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS analytics_candidates (
 id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, owner_key TEXT NOT NULL,
 region TEXT NOT NULL, locale TEXT NOT NULL, channel_version INTEGER NOT NULL,
 metric TEXT NOT NULL, order_json TEXT NOT NULL, baseline_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'draft'
);
CREATE TABLE IF NOT EXISTS analytics_experiments (
 id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 region TEXT NOT NULL, locale TEXT NOT NULL, channel_version INTEGER NOT NULL,
 name TEXT NOT NULL, a_json TEXT NOT NULL, b_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('draft','active','paused','complete')),
 salt TEXT NOT NULL, exposure_percent INTEGER NOT NULL CHECK(exposure_percent BETWEEN 1 AND 100)
);
