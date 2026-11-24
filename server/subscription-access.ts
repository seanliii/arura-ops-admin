import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { PlatformSubscriptionAccess } from '../shared/subscriptions.js'
import { ApiError, type AppContext, type ServerConfig } from './types.js'
import { getActiveSubscriptions, type SubscriptionInfo } from './tiktok-subscription-client.js'

type Access = PlatformSubscriptionAccess
type Reason = Access['reason']
type Observation = { status: 'valid' | 'inactive' | 'unverified'; reason: Reason }
type CacheRow = {
  owner_identity: string; config_hash: string; status: string; reason: unknown
  checked_at: number | null; fresh_until: number; revision: number
}
type Scope = {
  db: DatabaseSync
  userId: string
  app: string
  mode: 'staging' | 'production'
  providerId: string
  userCreatedAt: number
  ownerIdentity: string
  configHash: string
  key: string
  tierIds: string[]
  requestConfig: ServerConfig
}
type Inspection = { scope: Scope } | { access: Access }
type Pending = { revision: number; promise: Promise<Access> }

const FRESH_MS = 30_000
const SOURCE = 'tiktok_current_subscription' as const
const SAFE_REASONS = new Set<unknown>([
  'not_configured', 'not_tiktok_user', 'provider_unavailable', 'environment_unverified',
  'identity_changed', 'refresh_required', 'login_required',
])
// Per-connection and per-scope, with no database work or timers at module load.
// Database revision checks, not this optimization, protect against late writes.
const pendingByDatabase = new WeakMap<DatabaseSync, Map<string, Pending>>()
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const access = (
  status: Access['status'], reason: Reason, checkedAt: number | null = null, refreshAt: number | null = null,
): Access => ({ source: SOURCE, status, checkedAt, refreshAt, reason })
const unverified = (reason: Reason, checkedAt: number | null = null): Access => access('unverified', reason, checkedAt)

/** Read current identity/configuration, never decrypt tokens or load process.env. */
function inspect(ctx: AppContext, userId: string): Inspection {
  const config = ctx.config, ids = config.subscription?.tierIds
  if (!['staging', 'production'].includes(config.mode) || !text(config.tiktokClientKey) ||
      !text(config.tiktokClientSecret) || !text(config.tokenEncryptionKey) ||
      !/^[0-9a-f]{64}$/i.test(config.tokenEncryptionKey) || !Array.isArray(ids) || !ids.length ||
      Array.from(ids).some(id => !text(id) || id !== id.trim())) {
    return { access: access('unconfigured', 'not_configured') }
  }
  if (!text(userId)) return { access: unverified('not_tiktok_user') }
  const user = ctx.db.prepare('SELECT provider,provider_id,role,disabled,created_at FROM users WHERE id=?').get(userId) as {
    provider: string; provider_id: string | null; role: string; disabled: number; created_at: number
  } | undefined
  if (!user || user.provider !== 'tiktok' || user.role !== 'user') return { access: unverified('not_tiktok_user') }
  if (user.disabled !== 0) return { access: unverified('login_required') }
  const app = config.tiktokClientKey
  if (!text(user.provider_id) || !user.provider_id.startsWith(`${app}:`) ||
      !text(user.provider_id.slice(app.length + 1))) return { access: unverified('identity_changed') }
  // Removing a user's authorization must not leave a locally cached true usable.
  // Read existence only; token contents and refresh remain owned by the adapter.
  if (!ctx.db.prepare('SELECT 1 FROM platform_tokens WHERE user_id=?').get(userId)) {
    return { access: unverified('login_required') }
  }
  const tierIds = [...new Set(ids)].sort()
  const ownerIdentity = hash([userId, user.provider_id, user.created_at])
  // Only access-affecting configuration. Suspending new sales (paymentMode or
  // sandboxCheckout) does not suspend an already-authorized subscription.
  const configHash = hash([
    'subscription-access-v1', app, config.mode, tierIds, config.tiktokClientSecret, config.tokenEncryptionKey,
  ])
  return { scope: {
    db: ctx.db, userId, app, mode: config.mode as Scope['mode'],
    providerId: user.provider_id, userCreatedAt: user.created_at, ownerIdentity, configHash, tierIds,
    key: JSON.stringify([userId, app, config.mode, ownerIdentity, configHash]),
    // A caller changing its configuration while awaiting HTTP must not silently
    // change the credentials or scope used by an already-started request.
    requestConfig: { ...config, subscription: { ...config.subscription!, tierIds: [...tierIds] } },
  } }
}

function cacheRow(scope: Scope): CacheRow | undefined {
  return scope.db.prepare(`SELECT owner_identity,config_hash,status,reason,checked_at,fresh_until,revision
    FROM subscription_access_cache WHERE user_id=? AND client_key=? AND receiving_mode=?`)
    .get(scope.userId, scope.app, scope.mode) as CacheRow | undefined
}
function bound(row: CacheRow, scope: Scope): boolean {
  return row.owner_identity === scope.ownerIdentity && row.config_hash === scope.configHash
}
function current(ctx: AppContext, before: Scope): boolean {
  const now = inspect(ctx, before.userId)
  return 'scope' in now && now.scope.db === before.db && now.scope.key === before.key
}
function cached(scope: Scope, row: CacheRow | undefined): Access {
  if (!row) return unverified('refresh_required')
  if (row.owner_identity !== scope.ownerIdentity) return unverified('identity_changed')
  if (row.config_hash !== scope.configHash) return unverified('refresh_required')
  const now = Date.now()
  const checkedAt = typeof row.checked_at === 'number' && Number.isSafeInteger(row.checked_at) &&
    row.checked_at >= 0 && row.checked_at <= now ? row.checked_at : null
  const refreshAt = checkedAt !== null && Number.isSafeInteger(row.fresh_until)
    ? Math.min(row.fresh_until, checkedAt + FRESH_MS) : 0
  if (checkedAt === null || refreshAt <= now) return unverified('refresh_required', checkedAt)
  if (row.status === 'valid' || row.status === 'inactive') return access(row.status, null, checkedAt, refreshAt)
  if (row.status !== 'unverified') return unverified('refresh_required', checkedAt)
  const reason = SAFE_REASONS.has(row.reason) ? row.reason as Reason : 'provider_unavailable'
  return access('unverified', reason, checkedAt, refreshAt)
}

/** Pure local read. refreshAt is observation freshness, NEVER membership expiry. */
export function readSubscriptionAccess(ctx: AppContext, userId: string): PlatformSubscriptionAccess {
  const state = inspect(ctx, userId)
  return 'access' in state ? state.access : cached(state.scope, cacheRow(state.scope))
}

function classify(subscriptions: SubscriptionInfo[], scope: Scope): Observation {
  const byId = new Map<string, SubscriptionInfo>()
  const conflicts = new Map<string, 'provider_unavailable' | 'environment_unverified'>()
  for (const item of subscriptions) {
    const previous = byId.get(item.subscriptionId)
    if (!previous) { byId.set(item.subscriptionId, item); continue }
    if (previous.environment !== item.environment) conflicts.set(item.subscriptionId, 'environment_unverified')
    else if ((previous.tierId !== item.tierId ||
      previous.isSubscriptionRightsValid !== item.isSubscriptionRightsValid) && !conflicts.has(item.subscriptionId)) {
      conflicts.set(item.subscriptionId, 'provider_unavailable')
    }
  }
  const matching = subscriptions.filter(item => scope.tierIds.includes(item.tierId))
  // Check before discarding non-VIP records: a conflicting row for the same
  // subscription cannot be hidden simply by naming a different tier.
  for (const item of matching) {
    const conflict = conflicts.get(item.subscriptionId)
    if (conflict) return { status: 'unverified', reason: conflict }
  }
  const expected = scope.mode === 'staging' ? 'sandbox' : 'production'
  if (matching.some(item => item.environment !== expected)) {
    return { status: 'unverified', reason: 'environment_unverified' }
  }
  // Cancellation of renewal is not loss of current rights. No timestamp unit,
  // synthetic paid period, latest trade receipt or money mutation is involved.
  return { status: matching.some(item => item.isSubscriptionRightsValid) ? 'valid' : 'inactive', reason: null }
}

async function fetchObservation(ctx: AppContext, scope: Scope, revision: number): Promise<Access> {
  let observation: Observation
  try {
    const subscriptions = await getActiveSubscriptions({ ...ctx, db: scope.db, config: scope.requestConfig }, scope.userId)
    observation = classify(subscriptions, scope)
  } catch (error) {
    // Only classify information the real adapter actually exposes. It currently
    // maps upstream HTTP failures to 502; never guess that a generic 502 is 401.
    observation = { status: 'unverified', reason: error instanceof ApiError && error.status === 401
      ? 'login_required' : 'provider_unavailable' }
  }
  if (!current(ctx, scope)) return unverified('identity_changed')
  const checkedAt = Date.now(), refreshAt = checkedAt + FRESH_MS
  const written = scope.db.prepare(`UPDATE subscription_access_cache
    SET status=?,reason=?,checked_at=?,fresh_until=?
    WHERE user_id=? AND client_key=? AND receiving_mode=? AND owner_identity=? AND config_hash=? AND revision=?
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND provider='tiktok' AND role='user'
        AND disabled=0 AND provider_id=? AND created_at=?)
      AND EXISTS (SELECT 1 FROM platform_tokens WHERE user_id=?)`)
    .run(observation.status, observation.reason, checkedAt, refreshAt,
      scope.userId, scope.app, scope.mode, scope.ownerIdentity, scope.configHash, revision,
      scope.userId, scope.providerId, scope.userCreatedAt, scope.userId)
  if (Number(written.changes) !== 1) return unverified('refresh_required')
  return access(observation.status, observation.reason, checkedAt, refreshAt)
}

async function awaitCurrent(ctx: AppContext, scope: Scope, job: Pending): Promise<Access> {
  const result = await job.promise
  // Every coalesced caller has its own mutable context. The initiating caller's
  // checks alone cannot authorize another caller which switched app/environment.
  if (!current(ctx, scope)) return unverified('identity_changed')
  const row = cacheRow(scope)
  if (!row || !bound(row, scope) || row.revision !== job.revision) return unverified('refresh_required')
  if (result.refreshAt === null) return { ...result }
  return cached(scope, row)
}

/** Explicit awaited refresh only. No background refresh/retry/expiry timers. */
export async function refreshSubscriptionAccess(
  ctx: AppContext, userId: string, force = false,
): Promise<PlatformSubscriptionAccess> {
  const state = inspect(ctx, userId)
  if ('access' in state) return state.access
  const scope = state.scope, row = cacheRow(scope)
  let pending = pendingByDatabase.get(scope.db)
  const existing = pending?.get(scope.key)
  if (existing && row && bound(row, scope) && row.revision === existing.revision) {
    return awaitCurrent(ctx, scope, existing)
  }
  const local = cached(scope, row)
  if (!force && local.refreshAt !== null) return local
  // Atomic revision reservation also protects independently-running workers.
  // Clear freshness before a forced request: failures cannot fall back to old true.
  const reserved = scope.db.prepare(`INSERT INTO subscription_access_cache
    (user_id,client_key,receiving_mode,owner_identity,config_hash,status,reason,checked_at,fresh_until,revision)
    VALUES (?,?,?,?,?,'unverified','refresh_required',NULL,0,1)
    ON CONFLICT(user_id,client_key,receiving_mode) DO UPDATE SET
      owner_identity=excluded.owner_identity,config_hash=excluded.config_hash,
      status='unverified',reason='refresh_required',checked_at=NULL,fresh_until=0,
      revision=subscription_access_cache.revision+1
    RETURNING revision`).get(scope.userId, scope.app, scope.mode, scope.ownerIdentity, scope.configHash) as { revision: number }
  if (!pending) { pending = new Map(); pendingByDatabase.set(scope.db, pending) }
  const job: Pending = { revision: reserved.revision, promise: fetchObservation(ctx, scope, reserved.revision) }
  pending.set(scope.key, job)
  const cleanup = () => {
    // An invalidation may already have replaced this job with a newer revision.
    if (pending!.get(scope.key) === job) pending!.delete(scope.key)
  }
  void job.promise.then(cleanup, cleanup)
  return awaitCurrent(ctx, scope, job)
}

/**
 * Current app/environment only. Single UPDATE; safe inside the webhook's existing
 * transaction. Never BEGIN/COMMIT here, delete history, or mutate orders/rights.
 */
export function invalidateSubscriptionAccess(ctx: AppContext, userId: string): void {
  if (!text(userId) || !text(ctx.config.tiktokClientKey)) return
  ctx.db.prepare(`UPDATE subscription_access_cache SET fresh_until=0,revision=revision+1
    WHERE user_id=? AND client_key=? AND receiving_mode=?`)
    .run(userId, ctx.config.tiktokClientKey, ctx.config.mode)
}
