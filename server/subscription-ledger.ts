import { createHash } from 'node:crypto'
import { recordAnalyticsSubscription } from './analytics-subscriptions.js'
import { ApiError, type AppContext } from './types.js'
import { loadSubscriptionReceipt } from './subscription-events.js'
import { invalidateSubscriptionAccess } from './subscription-access.js'
import {
  decodeSubscriptionContent, type SubscriptionContent, type SubscriptionAction, type SubscriptionDiscount,
} from './subscription-content.js'
import type { SubscriptionInfo } from './tiktok-subscription-client.js'
import type { SubscriptionLedgerLocation, SubscriptionReview } from '../shared/subscription-review.js'

export type SubscriptionLedgerEnvironment = 'sandbox' | 'production'
export type SubscriptionProcessingStatus =
  | 'unprocessed' | 'recorded' | 'duplicate' | 'pending_binding' | 'pending_environment'
  | 'invalid' | 'unsupported' | 'conflict' | 'retryable_error'
export type SubscriptionProcessingReason =
  | 'invalid_content' | 'unsupported_event' | 'receipt_unreadable' | 'storage_failure'
  | 'receipt_scope_conflict' | 'local_receiving_mode' | 'subscription_id_missing' | 'trade_id_missing'
  | 'operation_not_found' | 'operation_reference_conflict' | 'operation_action_conflict'
  | 'operation_contract_conflict' | 'identity_conflict' | 'contract_not_bound' | 'contract_owner_conflict'
  | 'environment_missing' | 'environment_ambiguous' | 'environment_conflict'
  | 'transaction_contract_conflict' | 'transaction_kind_conflict' | 'transaction_metadata_conflict'
  | 'event_identity_conflict' | 'action_trade_conflict'
export interface SubscriptionReceiptProcessing {
  receiptId: string
  status: SubscriptionProcessingStatus
  reason: SubscriptionProcessingReason | null
  action: SubscriptionAction | null
  environment: SubscriptionLedgerEnvironment | 'unknown'
  operationId: string | null
  businessEventId: string | null
  issueCount: number
  attempts: number
  lastAttemptAt: number | null
  nextAttemptAt: number | null
}
export interface SubscriptionLedgerTransaction {
  tradeOrderId: string
  subscriptionId: string
  tierId: string | null
  kind: 'create' | 'renew' | null
  paymentRecorded: boolean
  refunded: boolean
  revoked: boolean
  receiptConflict: boolean
  originalPrice: string | null
  actualPrice: string | null
  currency: string | null
  refundPrice: string | null
  refundCurrency: string | null
  benefitBeginRaw: string | null
  benefitEndRaw: string | null
  discounts: ReadonlyArray<SubscriptionDiscount> | null
}
export interface SubscriptionLedgerConfirmationReceipt {
  receiptId: string
  event: 'minis.subscription.create' | 'minis.subscription.reactivate'
  eventCreatedAt: number
  recordedAt: number
}
export interface SubscriptionOperationConfirmation {
  operationId: string
  confirmed: boolean
  confirmationReceiptId: string | null
  /** Local recording time; use eventCreatedAt for the original event date. */
  confirmedAt: number | null
  receiptConflict: boolean
  subscriptionId: string | null
  tradeOrderId: string | null
  environment: SubscriptionLedgerEnvironment | 'unknown'
  paymentRecorded: boolean
  refunded: boolean
  revoked: boolean
  receipt: SubscriptionLedgerConfirmationReceipt | null
  eventName: 'minis.subscription.create' | 'minis.subscription.reactivate' | null
  eventCreatedAt: number | null
  recordedAt: number | null
}
/** Event audit timeline. Use transaction history, not this list, for bills. */
export interface SubscriptionHistoryItem {
  id: string
  receiptId: string
  action: SubscriptionAction
  eventName: string
  subscriptionId: string
  tradeOrderId: string | null
  tierId: string
  operationId: string | null
  environment: SubscriptionLedgerEnvironment
  eventCreatedAt: number
  recordedAt: number
  transaction: SubscriptionLedgerTransaction | null
}
/** One item per economic transaction, including refund-before-payment rows. */
export interface SubscriptionTransactionHistoryItem extends SubscriptionLedgerTransaction {
  id: string
  operationId: string | null
  environment: SubscriptionLedgerEnvironment
  confirmation: 'confirmed' | 'unconfirmed' | 'conflict'
  confirmationReceiptId: string | null
  refundReceiptId: string | null
  revokeReceiptId: string | null
  confirmedAt: number | null
  eventCreatedAt: number | null
  recordedAt: number | null
  createdAt: number
  updatedAt: number
  hasConflict: boolean
}
export interface SubscriptionHistoryPage { items: SubscriptionHistoryItem[]; nextCursor: string | null }
export interface SubscriptionTransactionHistoryPage { items: SubscriptionTransactionHistoryItem[]; nextCursor: string | null }
export interface SubscriptionHistoryOptions { limit?: number; before?: string; tradeOrderId?: string; subscriptionId?: string }
export interface SubscriptionBindingResult {
  bound: number
  unchanged: number
  skipped: { subscriptionId: string; reason: 'environment_unverified' | 'invalid_observation' }[]
  conflicts: { subscriptionId: string; reason: 'environment_conflict' | 'contract_owner_conflict' | 'observation_conflict' }[]
}
export interface SubscriptionReprocessResult {
  scanned: number
  results: SubscriptionReceiptProcessing[]
  failures: { receiptId: string; code: 'SUBSCRIPTION_LEDGER_UNAVAILABLE' }[]
}

type ModeScope = { app: string; mode: string; environment: SubscriptionLedgerEnvironment | null }
type Identity = { userId: string; providerId: string; hash: string }
type ContractRow = {
  client_key: string; environment: SubscriptionLedgerEnvironment; subscription_id: string
  user_id: string; owner_identity: string; tier_id: string
  revoked_receipt_id: number | null; binding_source: string
}
type OperationRow = {
  id: string; client_key: string; receiving_mode: string; user_id: string; owner_identity: string
  action: 'create' | 'reactivate'; tier_id: string; trade_order_id: string | null; subscription_id: string | null
  source_environment: 'sandbox' | 'production' | 'unknown'
  confirmation_receipt_id: number | null; confirmed_at: number | null; receipt_conflict: number
}
type Metadata = {
  original_price: string | null; actual_price: string | null; currency: string | null
  refund_price: string | null; refund_currency: string | null
  benefit_begin_raw: string | null; benefit_end_raw: string | null; discounts_json: string | null
}
type TransactionRow = Metadata & {
  id: number; client_key: string; environment: SubscriptionLedgerEnvironment
  trade_order_id: string; subscription_id: string; user_id: string; owner_identity: string; tier_id: string | null
  operation_id: string | null; payment_kind: 'create' | 'renew' | null
  payment_receipt_id: number | null; refund_receipt_id: number | null; revoke_receipt_id: number | null
  receipt_conflict: number; metadata_receipt_id: number | null; created_at: number; updated_at: number
}
type EventRow = {
  id: number; client_key: string; environment: SubscriptionLedgerEnvironment; business_key: string
  action: SubscriptionAction; event_name: string; subscription_id: string; trade_order_id: string | null
  user_id: string; owner_identity: string; tier_id: string; operation_id: string | null
  receipt_id: number; event_created_at: number; recorded_at: number
}
type ProcessingRow = {
  status: SubscriptionProcessingStatus; reason: SubscriptionProcessingReason | null; action: SubscriptionAction | null
  environment: SubscriptionLedgerEnvironment | 'unknown'; operation_id: string | null
  business_event_id: number | null; issue_count: number; attempts: number; last_attempt_at: number
  next_attempt_at: number
}
type ReceiptMeta = { id: number; client_key: string; receiving_mode: string; event_type: string }
type Links = {
  action: SubscriptionAction | null; environment: SubscriptionLedgerEnvironment | 'unknown'
  operationId: string | null; userId: string | null; eventId: number | null
  ownerIdentity: string | null; subscriptionId: string | null; tradeOrderId: string | null
  transactionId: number | null; conflictOperations: Set<string>; issueCount: number
}
const metaKeys: (keyof Metadata)[] = [
  'original_price', 'actual_price', 'currency', 'refund_price', 'refund_currency',
  'benefit_begin_raw', 'benefit_end_raw', 'discounts_json',
]
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const one = <T>(ctx: AppContext, sql: string, ...args: (string | number | null)[]): T | undefined =>
  ctx.db.prepare(sql).get(...args) as unknown as T | undefined
const all = <T>(ctx: AppContext, sql: string, ...args: (string | number | null)[]): T[] =>
  ctx.db.prepare(sql).all(...args) as unknown as T[]
let savepointId = 0

/** Nested-safe atomic units. No database access at import time. */
function atomic<T>(ctx: AppContext, fn: () => T): T {
  const name = `subscription_ledger_${++savepointId}`
  ctx.db.exec(`SAVEPOINT ${name}`)
  try {
    const result = fn()
    ctx.db.exec(`RELEASE SAVEPOINT ${name}`)
    return result
  } catch (error) {
    ctx.db.exec(`ROLLBACK TO SAVEPOINT ${name}`)
    ctx.db.exec(`RELEASE SAVEPOINT ${name}`)
    throw error
  }
}
function scope(ctx: AppContext): ModeScope {
  if (!text(ctx.config.tiktokClientKey)) throw new ApiError(503, 'TIKTOK_UNCONFIGURED', '订阅所属应用尚未配置')
  return { app: ctx.config.tiktokClientKey, mode: ctx.config.mode,
    environment: ctx.config.mode === 'production' ? 'production' : ctx.config.mode === 'staging' ? 'sandbox' : null }
}
function identity(ctx: AppContext, s: ModeScope, userId: string): Identity | null {
  const user = one<{ provider: string; provider_id: string | null }>(ctx, 'SELECT provider,provider_id FROM users WHERE id=?', userId)
  // Account disabling affects access, not whether a historical payment existed.
  if (user?.provider !== 'tiktok' || !text(user.provider_id) || !user.provider_id.startsWith(`${s.app}:`) ||
      user.provider_id.length <= s.app.length + 1) return null
  return { userId, providerId: user.provider_id, hash: fingerprint([s.app, userId, user.provider_id]) }
}
function receiptNumber(value: string): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ApiError(400, 'INVALID_SUBSCRIPTION_RECEIPT_ID', '订阅收件编号无效')
  }
  return Number(value)
}
function pageLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new ApiError(400, 'INVALID_PAGINATION', '分页数量必须为1至100')
  return value
}
function receiptMeta(ctx: AppContext, id: number, s: ModeScope): ReceiptMeta {
  const row = one<ReceiptMeta>(ctx, `SELECT id,client_key,receiving_mode,event_type FROM subscription_webhook_receipts
    WHERE id=? AND client_key=? AND receiving_mode=?`, id, s.app, s.mode)
  if (!row) throw new ApiError(404, 'SUBSCRIPTION_RECEIPT_UNAVAILABLE', '无法读取此订阅通知')
  return row
}
class RejectedReceipt extends Error {
  constructor(readonly status: 'pending_binding' | 'pending_environment' | 'conflict', readonly reason: SubscriptionProcessingReason) {
    super(reason)
  }
}
function reject(status: RejectedReceipt['status'], reason: SubscriptionProcessingReason): never {
  throw new RejectedReceipt(status, reason)
}

/** Called after registerSubscriptionInbox; migrations preserve existing data/CHECKs. */
export function initializeSubscriptionLedger(ctx: AppContext): void {
  atomic(ctx, () => {
    const columns = new Set(all<{ name: string }>(ctx, 'PRAGMA table_info(subscription_operations)').map(row => row.name))
    if (!columns.size) throw new ApiError(503, 'SUBSCRIPTION_LEDGER_UNAVAILABLE', '订阅操作表尚未初始化')
    for (const [name, definition] of [
      ['confirmation_receipt_id', 'INTEGER REFERENCES subscription_webhook_receipts(id)'],
      ['confirmed_at', 'INTEGER'],
      ['receipt_conflict', 'INTEGER NOT NULL DEFAULT 0 CHECK(receipt_conflict IN (0,1))'],
    ]) {
      if (!columns.has(name)) ctx.db.exec(`ALTER TABLE subscription_operations ADD COLUMN ${name} ${definition}`)
    }
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS subscription_contracts (
        client_key TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
        subscription_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), owner_identity TEXT NOT NULL,
        tier_id TEXT NOT NULL, binding_source TEXT NOT NULL CHECK(binding_source IN ('receipt','platform_observation')),
        binding_receipt_id INTEGER REFERENCES subscription_webhook_receipts(id),
        observed_at INTEGER, revoked_receipt_id INTEGER REFERENCES subscription_webhook_receipts(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(client_key,environment,subscription_id)
      );
      CREATE TABLE IF NOT EXISTS subscription_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, client_key TEXT NOT NULL,
        environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
        trade_order_id TEXT NOT NULL, subscription_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
        owner_identity TEXT NOT NULL, tier_id TEXT, operation_id TEXT UNIQUE REFERENCES subscription_operations(id),
        payment_kind TEXT CHECK(payment_kind IN ('create','renew')),
        payment_receipt_id INTEGER REFERENCES subscription_webhook_receipts(id),
        refund_receipt_id INTEGER REFERENCES subscription_webhook_receipts(id),
        revoke_receipt_id INTEGER REFERENCES subscription_webhook_receipts(id),
        receipt_conflict INTEGER NOT NULL DEFAULT 0 CHECK(receipt_conflict IN (0,1)),
        original_price TEXT, actual_price TEXT, currency TEXT, refund_price TEXT, refund_currency TEXT,
        benefit_begin_raw TEXT, benefit_end_raw TEXT,
        discounts_json TEXT CHECK(discounts_json IS NULL OR json_valid(discounts_json)),
        metadata_receipt_id INTEGER REFERENCES subscription_webhook_receipts(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(client_key,environment,trade_order_id),
        FOREIGN KEY(client_key,environment,subscription_id)
          REFERENCES subscription_contracts(client_key,environment,subscription_id)
      );
      CREATE TABLE IF NOT EXISTS subscription_business_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, client_key TEXT NOT NULL,
        environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')), business_key TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('create','renew','reactivate','cancel','onhold','expire','refund','revoke')),
        event_name TEXT NOT NULL, subscription_id TEXT NOT NULL, trade_order_id TEXT,
        user_id TEXT NOT NULL REFERENCES users(id), owner_identity TEXT NOT NULL, tier_id TEXT NOT NULL,
        operation_id TEXT REFERENCES subscription_operations(id),
        receipt_id INTEGER NOT NULL UNIQUE REFERENCES subscription_webhook_receipts(id),
        event_created_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
        UNIQUE(client_key,environment,business_key),
        FOREIGN KEY(client_key,environment,subscription_id)
          REFERENCES subscription_contracts(client_key,environment,subscription_id)
      );
      CREATE INDEX IF NOT EXISTS subscription_history_owner
        ON subscription_business_events(client_key,environment,user_id,id);
      CREATE TABLE IF NOT EXISTS subscription_receipt_processing (
        receipt_id INTEGER PRIMARY KEY REFERENCES subscription_webhook_receipts(id),
        client_key TEXT NOT NULL, receiving_mode TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('recorded','duplicate','pending_binding','pending_environment',
          'invalid','unsupported','conflict','retryable_error')),
        reason TEXT, action TEXT, environment TEXT NOT NULL DEFAULT 'unknown',
        operation_id TEXT REFERENCES subscription_operations(id),
        business_event_id INTEGER REFERENCES subscription_business_events(id),
        user_id TEXT REFERENCES users(id), issue_count INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 1, last_attempt_at INTEGER NOT NULL,
        next_attempt_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS subscription_operation_responses (
        operation_id TEXT NOT NULL REFERENCES subscription_operations(id),
        lease_id TEXT NOT NULL, returned_trade_id TEXT NOT NULL,
        conflicting INTEGER NOT NULL CHECK(conflicting IN (0,1)), received_at INTEGER NOT NULL,
        PRIMARY KEY(operation_id,lease_id,returned_trade_id)
      );
      DROP INDEX IF EXISTS subscription_one_pending;
      -- This reserves unfinished dispatches. Unresolved conflicts are checked
      -- separately at reservation/dispatch/SDK boundaries: including them here
      -- would prevent saving a late conflict while another dispatch is in flight.
      CREATE UNIQUE INDEX subscription_one_pending ON subscription_operations(user_id,client_key,receiving_mode)
        WHERE confirmation_receipt_id IS NULL
          AND status IN ('checking','submitting','ready_for_sdk','awaiting_confirmation','outcome_unknown');
    `)
    const transactionColumns = new Set(all<{ name: string }>(ctx, 'PRAGMA table_info(subscription_transactions)').map(row => row.name))
    if (!transactionColumns.has('receipt_conflict')) {
      ctx.db.exec('ALTER TABLE subscription_transactions ADD COLUMN receipt_conflict INTEGER NOT NULL DEFAULT 0 CHECK(receipt_conflict IN (0,1))')
    }
    const processingColumns = new Set(all<{ name: string }>(ctx, 'PRAGMA table_info(subscription_receipt_processing)').map(row => row.name))
    if (!processingColumns.has('next_attempt_at')) {
      ctx.db.exec('ALTER TABLE subscription_receipt_processing ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0')
    }
  })
}

function processingDTO(id: string, row?: ProcessingRow): SubscriptionReceiptProcessing {
  return {
    receiptId: id, status: row?.status ?? 'unprocessed', reason: row?.reason ?? null,
    action: row?.action ?? null, environment: row?.environment ?? 'unknown', operationId: row?.operation_id ?? null,
    businessEventId: row?.business_event_id == null ? null : String(row.business_event_id),
    issueCount: row?.issue_count ?? 0, attempts: row?.attempts ?? 0, lastAttemptAt: row?.last_attempt_at ?? null,
    nextAttemptAt: row && row.next_attempt_at > 0 ? row.next_attempt_at : null,
  }
}
export function readSubscriptionProcessing(ctx: AppContext, receiptId: string): SubscriptionReceiptProcessing {
  const id = receiptNumber(receiptId), s = scope(ctx)
  receiptMeta(ctx, id, s)
  return processingDTO(receiptId, one<ProcessingRow>(ctx,
    'SELECT * FROM subscription_receipt_processing WHERE receipt_id=? AND client_key=? AND receiving_mode=?', id, s.app, s.mode))
}
function saveProcessing(
  ctx: AppContext, receipt: ReceiptMeta, links: Links, status: Exclude<SubscriptionProcessingStatus, 'unprocessed'>,
  reason: SubscriptionProcessingReason | null,
): SubscriptionReceiptProcessing {
  const previous = one<{ attempts: number }>(ctx, 'SELECT attempts FROM subscription_receipt_processing WHERE receipt_id=?', receipt.id)
  const attempts = (previous?.attempts ?? 0) + 1, now = Date.now()
  const retryable = status === 'pending_binding' || status === 'pending_environment' || status === 'retryable_error'
  const nextAttemptAt = retryable ? now + Math.min(5000 * 2 ** Math.min(attempts - 1, 6), 300_000) : 0
  ctx.db.prepare(`INSERT INTO subscription_receipt_processing
    (receipt_id,client_key,receiving_mode,status,reason,action,environment,operation_id,business_event_id,
      user_id,issue_count,attempts,last_attempt_at,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)
    ON CONFLICT(receipt_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,action=excluded.action,
      environment=excluded.environment,operation_id=excluded.operation_id,business_event_id=excluded.business_event_id,
      user_id=excluded.user_id,issue_count=excluded.issue_count,attempts=subscription_receipt_processing.attempts+1,
      last_attempt_at=excluded.last_attempt_at,next_attempt_at=excluded.next_attempt_at`)
    .run(receipt.id, receipt.client_key, receipt.receiving_mode, status, reason, links.action, links.environment,
      links.operationId, links.eventId, links.userId, links.issueCount, now, nextAttemptAt)
  return readSubscriptionProcessing(ctx, String(receipt.id))
}
function contractRow(ctx: AppContext, s: ModeScope, environment: SubscriptionLedgerEnvironment, id: string) {
  return one<ContractRow>(ctx, 'SELECT * FROM subscription_contracts WHERE client_key=? AND environment=? AND subscription_id=?',
    s.app, environment, id)
}
function transactionRow(ctx: AppContext, s: ModeScope, environment: SubscriptionLedgerEnvironment, tradeId: string) {
  return one<TransactionRow>(ctx, 'SELECT * FROM subscription_transactions WHERE client_key=? AND environment=? AND trade_order_id=?',
    s.app, environment, tradeId)
}

function resolveOperation(ctx: AppContext, s: ModeScope, event: SubscriptionContent, links: Links): OperationRow | undefined {
  const needsOperation = event.action === 'create' || event.action === 'reactivate'
  const byOrder = needsOperation && event.orderId
    ? one<OperationRow>(ctx, 'SELECT * FROM subscription_operations WHERE id=?', event.orderId) : undefined
  const byTrade = event.tradeOrderId ? one<OperationRow>(ctx,
    'SELECT * FROM subscription_operations WHERE client_key=? AND receiving_mode=? AND trade_order_id=?',
    s.app, s.mode, event.tradeOrderId) : undefined
  for (const row of [byOrder, byTrade]) {
    if (row?.client_key === s.app && row.receiving_mode === s.mode) links.conflictOperations.add(row.id)
  }
  const candidate = byOrder ?? byTrade
  if (candidate?.client_key === s.app && candidate.receiving_mode === s.mode) links.operationId = candidate.id
  if (byOrder && (byOrder.client_key !== s.app || byOrder.receiving_mode !== s.mode)) reject('conflict', 'operation_reference_conflict')
  if (needsOperation && event.orderId && event.tradeOrderId) {
    if ((!byOrder && byTrade) || (byOrder && byTrade && byOrder.id !== byTrade.id) ||
        (byOrder?.trade_order_id && byOrder.trade_order_id !== event.tradeOrderId)) {
      reject('conflict', 'operation_reference_conflict')
    }
  }
  if (needsOperation && candidate && candidate.action !== event.action) reject('conflict', 'operation_action_conflict')
  if ((event.action === 'renew' || event.action === 'cancel') && byTrade) reject('conflict', 'action_trade_conflict')
  return needsOperation || event.action === 'refund' || event.action === 'revoke' ? candidate : undefined
}
function resolveEnvironment(ctx: AppContext, s: ModeScope, event: SubscriptionContent): SubscriptionLedgerEnvironment {
  if (!s.environment) reject('pending_environment', 'local_receiving_mode')
  let environment = event.environment
  if (environment === 'unknown') {
    // Do not include server mode, configured tier names, checkout flags or
    // unconfirmed operations in this evidence set.
    const bindings = all<{ environment: SubscriptionLedgerEnvironment }>(ctx,
      'SELECT environment FROM subscription_contracts WHERE client_key=? AND subscription_id=?', s.app, event.subscriptionId)
    const transactions = event.tradeOrderId ? all<{ environment: SubscriptionLedgerEnvironment }>(ctx,
      'SELECT environment FROM subscription_transactions WHERE client_key=? AND subscription_id=? AND trade_order_id=?',
      s.app, event.subscriptionId, event.tradeOrderId) : []
    const known = new Set([...bindings, ...transactions].map(row => row.environment))
    if (known.size === 0) reject('pending_environment', 'environment_missing')
    if (known.size !== 1) reject('pending_environment', 'environment_ambiguous')
    environment = [...known][0]
  }
  if (environment !== s.environment) reject('conflict', 'environment_conflict')
  return environment
}
function metadata(event: SubscriptionContent): Metadata {
  return {
    original_price: event.originalPrice, actual_price: event.actualPrice, currency: event.currency,
    refund_price: event.refundPrice, refund_currency: event.refundCurrency,
    benefit_begin_raw: event.benefitBeginRaw, benefit_end_raw: event.benefitEndRaw,
    discounts_json: event.discounts === null ? null : JSON.stringify(event.discounts),
  }
}
function mergeMetadata(prior: TransactionRow | undefined, incoming: Metadata): Metadata {
  const merged = { ...incoming }
  for (const key of metaKeys) {
    const old = prior?.[key] ?? null, value = incoming[key]
    if (old !== null && value !== null && old !== value) reject('conflict', 'transaction_metadata_conflict')
    merged[key] = old ?? value
  }
  return merged
}

function applyEvent(ctx: AppContext, s: ModeScope, receipt: ReceiptMeta, event: SubscriptionContent, links: Links): 'recorded' | 'duplicate' {
  if (event.clientKey !== s.app || event.eventName !== receipt.event_type) reject('conflict', 'receipt_scope_conflict')
  if (!event.subscriptionId) reject('pending_binding', 'subscription_id_missing')
  const op = resolveOperation(ctx, s, event, links)
  const environment = resolveEnvironment(ctx, s, event)
  links.environment = environment
  const needsOperation = event.action === 'create' || event.action === 'reactivate'
  if (needsOperation && !op) reject('pending_binding', 'operation_not_found')
  const tradeId = event.tradeOrderId ?? (needsOperation ? op?.trade_order_id ?? null : null)
  links.subscriptionId = event.subscriptionId
  links.tradeOrderId = tradeId
  if (!tradeId && event.action !== 'onhold' && event.action !== 'expire') reject('pending_binding', 'trade_id_missing')
  let contract = contractRow(ctx, s, environment, event.subscriptionId)
  const who = op ? identity(ctx, s, op.user_id) : contract ? identity(ctx, s, contract.user_id) : null
  if (!op && !contract) reject('pending_binding', 'contract_not_bound')
  if (!who || (op && op.owner_identity !== who.providerId) ||
      (contract && (contract.user_id !== who.userId || contract.owner_identity !== who.hash)) ||
      (event.userOpenId !== null && who.providerId !== `${s.app}:${event.userOpenId}`)) {
    reject('conflict', 'identity_conflict')
  }
  links.userId = who.userId
  links.ownerIdentity = who.hash
  if (op) {
    if (op.subscription_id && op.subscription_id !== event.subscriptionId) reject('conflict', 'operation_contract_conflict')
    if (op.trade_order_id && op.trade_order_id !== tradeId) reject('conflict', 'operation_reference_conflict')
    if (op.source_environment !== 'unknown' && op.source_environment !== environment) reject('conflict', 'environment_conflict')
    if (!text(op.tier_id)) reject('pending_binding', 'contract_not_bound')
  }
  if (!contract) {
    if (!op) reject('pending_binding', 'contract_not_bound')
    ctx.db.prepare(`INSERT INTO subscription_contracts
      (client_key,environment,subscription_id,user_id,owner_identity,tier_id,binding_source,binding_receipt_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'receipt',?,?,?)`)
      .run(s.app, environment, event.subscriptionId, who.userId, who.hash, op.tier_id, receipt.id, Date.now(), Date.now())
    contract = contractRow(ctx, s, environment, event.subscriptionId)!
  }
  const tierId = needsOperation ? op!.tier_id : contract.tier_id
  const prior = tradeId ? transactionRow(ctx, s, environment, tradeId) : undefined
  const moneyEvent = ['create', 'renew', 'refund', 'revoke'].includes(event.action)
  if (prior && (prior.subscription_id !== event.subscriptionId || prior.user_id !== who.userId || prior.owner_identity !== who.hash)) {
    reject('conflict', 'transaction_contract_conflict')
  }
  links.transactionId = prior?.id ?? null
  const otherActions = tradeId ? all<{ action: SubscriptionAction; subscription_id: string }>(ctx,
    'SELECT action,subscription_id FROM subscription_business_events WHERE client_key=? AND environment=? AND trade_order_id=?',
    s.app, environment, tradeId) : []
  if ((moneyEvent && otherActions.some(row => row.action === 'cancel' || row.action === 'reactivate')) ||
      (!moneyEvent && prior) || otherActions.some(row => row.subscription_id !== event.subscriptionId)) {
    reject('conflict', 'action_trade_conflict')
  }
  const businessKey = fingerprint(tradeId ? [event.action, tradeId] : [event.action, event.subscriptionId, event.eventCreatedAt])
  const existingEvent = one<EventRow>(ctx,
    'SELECT * FROM subscription_business_events WHERE client_key=? AND environment=? AND business_key=?', s.app, environment, businessKey)
  if (existingEvent && (existingEvent.subscription_id !== event.subscriptionId || existingEvent.user_id !== who.userId ||
      existingEvent.owner_identity !== who.hash ||
      (existingEvent.operation_id !== null && op && existingEvent.operation_id !== op.id))) {
    reject('conflict', 'event_identity_conflict')
  }
  if (moneyEvent) {
    const paymentKind = event.action === 'create' || event.action === 'renew' ? event.action : null
    if (prior?.payment_kind && paymentKind && prior.payment_kind !== paymentKind) reject('conflict', 'transaction_kind_conflict')
    if (prior?.operation_id && op && prior.operation_id !== op.id) reject('conflict', 'operation_reference_conflict')
    const merged = mergeMetadata(prior, metadata(event))
    const paymentReceipt = prior?.payment_receipt_id ?? (paymentKind ? receipt.id : null)
    const refundReceipt = prior?.refund_receipt_id ?? (event.action === 'refund' || event.action === 'revoke' ? receipt.id : null)
    const revokeReceipt = prior?.revoke_receipt_id ?? (event.action === 'revoke' ? receipt.id : null)
    const savedTier = prior?.payment_kind ? prior.tier_id : paymentKind ? tierId : prior?.tier_id ?? null
    if (!prior) {
      ctx.db.prepare(`INSERT INTO subscription_transactions
        (client_key,environment,trade_order_id,subscription_id,user_id,owner_identity,tier_id,operation_id,
         payment_kind,payment_receipt_id,refund_receipt_id,revoke_receipt_id,
         original_price,actual_price,currency,refund_price,refund_currency,benefit_begin_raw,benefit_end_raw,discounts_json,
         metadata_receipt_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(s.app, environment, tradeId, event.subscriptionId, who.userId, who.hash, savedTier, op?.id ?? null,
          paymentKind, paymentReceipt, refundReceipt, revokeReceipt, ...metaKeys.map(key => merged[key]), receipt.id, Date.now(), Date.now())
    } else {
      const enriched = metaKeys.some(key => prior[key] === null && merged[key] !== null)
      ctx.db.prepare(`UPDATE subscription_transactions SET tier_id=?,operation_id=?,payment_kind=?,
        payment_receipt_id=?,refund_receipt_id=?,revoke_receipt_id=?,
        original_price=?,actual_price=?,currency=?,refund_price=?,refund_currency=?,benefit_begin_raw=?,benefit_end_raw=?,discounts_json=?,
        metadata_receipt_id=?,updated_at=? WHERE id=?`)
        .run(savedTier, prior.operation_id ?? op?.id ?? null, prior.payment_kind ?? paymentKind,
          paymentReceipt, refundReceipt, revokeReceipt, ...metaKeys.map(key => merged[key]),
          enriched ? receipt.id : prior.metadata_receipt_id, Date.now(), prior.id)
    }
  }
  let recordedEvent = existingEvent
  if (!recordedEvent) {
    const result = ctx.db.prepare(`INSERT INTO subscription_business_events
      (client_key,environment,business_key,action,event_name,subscription_id,trade_order_id,user_id,owner_identity,
       tier_id,operation_id,receipt_id,event_created_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(s.app, environment, businessKey, event.action, event.eventName, event.subscriptionId, tradeId, who.userId,
        who.hash, tierId, op?.id ?? null, receipt.id, event.eventCreatedAt, Date.now())
    recordedEvent = one<EventRow>(ctx, 'SELECT * FROM subscription_business_events WHERE id=?', Number(result.lastInsertRowid))!
  } else if (recordedEvent.operation_id === null && op) {
    // A refund may have been recorded before the local operation was available.
    // Filling a missing link is not a second refund or an identity conflict.
    ctx.db.prepare('UPDATE subscription_business_events SET operation_id=? WHERE id=?').run(op.id, recordedEvent.id)
  }
  links.eventId = recordedEvent.id
  if (needsOperation) {
    if (op!.confirmation_receipt_id !== null) {
      const proof = one<EventRow>(ctx, 'SELECT * FROM subscription_business_events WHERE receipt_id=?', op!.confirmation_receipt_id)
      if (!proof || proof.trade_order_id !== tradeId || proof.subscription_id !== event.subscriptionId ||
          proof.action !== event.action || proof.operation_id !== op!.id) reject('conflict', 'operation_reference_conflict')
    }
    // Keep the technical execution status. A confirmed operation no longer holds
    // the pending-operation slot, even if the HTTP/SDK side is still awaiting it.
    ctx.db.prepare(`UPDATE subscription_operations SET trade_order_id=COALESCE(trade_order_id,?),
      subscription_id=COALESCE(subscription_id,?),source_environment=?,
      receipt_conflict=CASE WHEN confirmation_receipt_id IS NULL THEN 0 ELSE receipt_conflict END,
      confirmation_receipt_id=COALESCE(confirmation_receipt_id,?),confirmed_at=COALESCE(confirmed_at,?)
      WHERE id=? AND client_key=? AND receiving_mode=?`)
      .run(tradeId, event.subscriptionId, environment, recordedEvent.receipt_id, Date.now(), op!.id, s.app, s.mode)
  }
  if (event.action === 'revoke') {
    ctx.db.prepare(`UPDATE subscription_contracts SET revoked_receipt_id=COALESCE(revoked_receipt_id,?),updated_at=?
      WHERE client_key=? AND environment=? AND subscription_id=?`)
      .run(receipt.id, Date.now(), s.app, environment, event.subscriptionId)
  }
  if(ctx.analytics && tradeId){
    const transaction=ctx.db.prepare('SELECT id FROM subscription_transactions WHERE client_key=? AND environment=? AND trade_order_id=?').get(s.app,environment,tradeId)
    if(transaction)recordAnalyticsSubscription(ctx,Number(transaction.id))
  }
  invalidateSubscriptionAccess(ctx, who.userId)
  return existingEvent ? 'duplicate' : 'recorded'
}

/** Only stored, previously verified and authenticated encrypted receipts enter here. */
export function processSubscriptionReceipt(ctx: AppContext, receiptId: string): SubscriptionReceiptProcessing {
  const id = receiptNumber(receiptId), s = scope(ctx), receipt = receiptMeta(ctx, id, s)
  const links: Links = { action: null, environment: 'unknown', operationId: null, userId: null,
    ownerIdentity: null, subscriptionId: null, tradeOrderId: null,
    eventId: null, transactionId: null, conflictOperations: new Set(), issueCount: 0 }
  let decoded: ReturnType<typeof decodeSubscriptionContent>
  try { decoded = decodeSubscriptionContent(loadSubscriptionReceipt(ctx, receiptId).rawBody) }
  catch {
    return atomic(ctx, () => saveProcessing(ctx, receipt, links, 'retryable_error', 'receipt_unreadable'))
  }
  if (decoded.kind !== 'event') {
    return atomic(ctx, () => saveProcessing(ctx, receipt, links,
      decoded.kind === 'invalid' ? 'invalid' : 'unsupported', decoded.kind === 'invalid' ? 'invalid_content' : 'unsupported_event'))
  }
  links.action = decoded.value.action
  links.issueCount = decoded.value.issues.length
  links.environment = decoded.value.environment
  const event = decoded.value
  const prior = readSubscriptionProcessing(ctx, receiptId)
  if (prior.status === 'recorded' || prior.status === 'duplicate') return prior
  try {
    return atomic(ctx, () => {
      try {
        // A business rejection must roll back even a binding inserted earlier in
        // this attempt, while retaining a separate safe processing outcome.
        const status = atomic(ctx, () => applyEvent(ctx, s, receipt, event, links))
        return saveProcessing(ctx, receipt, links, status, null)
      } catch (error) {
        if (!(error instanceof RejectedReceipt)) throw error
        links.eventId = null
        // A receipt outside this receiving environment is quarantined on its
        // own processing row. Even a matching user/order cannot let it poison
        // a valid confirmation or transaction in another environment.
        const canAffectLedger = links.environment !== 'unknown' && links.environment === s.environment
        let affected = canAffectLedger && links.userId ? identity(ctx, s, links.userId) : null
        if (affected && links.ownerIdentity !== null && affected.hash !== links.ownerIdentity) affected = null
        if (canAffectLedger && !affected && !links.userId && event.userOpenId !== null) {
          const user = one<{ id: string }>(ctx, "SELECT id FROM users WHERE provider='tiktok' AND provider_id=?", `${s.app}:${event.userOpenId}`)
          if (user) affected = identity(ctx, s, user.id)
        }
        // An ambiguous order/trade pair must not flag another user's operation.
        if (error.status === 'conflict' && canAffectLedger && affected) for (const operationId of links.conflictOperations) {
          ctx.db.prepare(`UPDATE subscription_operations SET receipt_conflict=1
            WHERE id=? AND client_key=? AND receiving_mode=? AND user_id=? AND owner_identity=?`)
            .run(operationId, s.app, s.mode, affected.userId, affected.providerId)
        }
        if (error.status === 'conflict' && canAffectLedger && links.transactionId !== null &&
            affected && ['transaction_metadata_conflict', 'transaction_kind_conflict'].includes(error.reason)) {
          ctx.db.prepare(`UPDATE subscription_transactions SET receipt_conflict=1
            WHERE id=? AND client_key=? AND environment=? AND user_id=? AND owner_identity=?
              AND subscription_id=? AND trade_order_id=?`)
            .run(links.transactionId, s.app, links.environment, affected.userId, affected.hash, links.subscriptionId, links.tradeOrderId)
        }
        if (links.userId) invalidateSubscriptionAccess(ctx, links.userId)
        return saveProcessing(ctx, receipt, links, error.status, error.reason)
      }
    })
  } catch {
    links.eventId = null
    try { return atomic(ctx, () => saveProcessing(ctx, receipt, links, 'retryable_error', 'storage_failure')) }
    catch { throw new ApiError(503, 'SUBSCRIPTION_LEDGER_UNAVAILABLE', '订阅账本暂时无法安全处理，请稍后重试') }
  }
}

/** Bind an authenticated current query; it creates no payment/confirmation rows. */
export function bindObservedSubscriptionContracts(
  ctx: AppContext, userId: string, subscriptions: SubscriptionInfo[],
): SubscriptionBindingResult {
  const s = scope(ctx), who = identity(ctx, s, userId)
  if (!who) throw new ApiError(409, 'SUBSCRIPTION_IDENTITY_MISMATCH', '无法确认该应用的订阅用户身份')
  if (!Array.isArray(subscriptions)) throw new ApiError(400, 'INVALID_SUBSCRIPTION_OBSERVATION', '订阅观察必须是列表')
  const result: SubscriptionBindingResult = { bound: 0, unchanged: 0, skipped: [], conflicts: [] }
  const groups = new Map<string, SubscriptionInfo[]>()
  for (const item of subscriptions) {
    if (!item || !text(item.subscriptionId)) {
      result.skipped.push({ subscriptionId: '', reason: 'invalid_observation' })
      continue
    }
    const group = groups.get(item.subscriptionId) ?? []
    group.push(item)
    groups.set(item.subscriptionId, group)
  }
  // Validate the entire SID group before writing its first row. Otherwise a
  // contradictory duplicate could leave a false source for environment inheritance.
  const consistent: SubscriptionInfo[] = []
  for (const [subscriptionId, group] of groups) {
    if (group.some(item => !text(item.tierId) || !text(item.latestTradeOrderId) ||
        typeof item.isSubscriptionRightsValid !== 'boolean' || typeof item.isRenewalNormal !== 'boolean' ||
        !['sandbox', 'production', 'unknown'].includes(item.environment))) {
      result.skipped.push({ subscriptionId, reason: 'invalid_observation' })
      continue
    }
    // Match the access service's SID consistency checks; no latest-trade lookup
    // is used to assign a payment, and renewalNormal is not current access.
    if (new Set(group.map(item => fingerprint([item.tierId, item.environment, item.isSubscriptionRightsValid]))).size !== 1) {
      result.conflicts.push({ subscriptionId, reason: 'observation_conflict' })
      continue
    }
    consistent.push(group[0])
  }
  return atomic(ctx, () => {
    for (const item of consistent) {
      if (!s.environment || item.environment === 'unknown') {
        result.skipped.push({ subscriptionId: item.subscriptionId, reason: 'environment_unverified' })
        continue
      }
      if (item.environment !== s.environment) {
        result.conflicts.push({ subscriptionId: item.subscriptionId, reason: 'environment_conflict' })
        continue
      }
      const prior = contractRow(ctx, s, item.environment, item.subscriptionId)
      if (prior && (prior.user_id !== userId || prior.owner_identity !== who.hash)) {
        result.conflicts.push({ subscriptionId: item.subscriptionId, reason: 'contract_owner_conflict' })
        continue
      }
      if (prior) {
        if (prior.tier_id === item.tierId) result.unchanged++
        else result.bound++
        // Current tier observations never rewrite historical transaction facts.
        ctx.db.prepare(`UPDATE subscription_contracts SET tier_id=?,binding_source='platform_observation',
          observed_at=?,updated_at=? WHERE client_key=? AND environment=? AND subscription_id=?`)
          .run(item.tierId, Date.now(), Date.now(), s.app, item.environment, item.subscriptionId)
      } else {
        ctx.db.prepare(`INSERT INTO subscription_contracts
          (client_key,environment,subscription_id,user_id,owner_identity,tier_id,binding_source,observed_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'platform_observation',?,?,?)`)
          .run(s.app, item.environment, item.subscriptionId, userId, who.hash, item.tierId, Date.now(), Date.now(), Date.now())
        result.bound++
      }
    }
    return result
  })
}

/** Fair, bounded explicit work; no worker or retry timer starts at import time. */
export function reprocessSubscriptionReceipts(ctx: AppContext, limit = 25, force = false): SubscriptionReprocessResult {
  const s = scope(ctx), take = pageLimit(limit, 25)
  const rows = all<{ id: number }>(ctx, `SELECT r.id FROM subscription_webhook_receipts r
    LEFT JOIN subscription_receipt_processing p ON p.receipt_id=r.id
    WHERE r.client_key=? AND r.receiving_mode=? AND
      (p.receipt_id IS NULL OR (p.status IN ('pending_binding','pending_environment','retryable_error')
        AND (?=1 OR p.next_attempt_at<=?)))
    ORDER BY COALESCE(p.attempts,0),COALESCE(p.last_attempt_at,0),r.id LIMIT ?`,
    s.app, s.mode, force === true ? 1 : 0, Date.now(), take)
  const result: SubscriptionReprocessResult = { scanned: rows.length, results: [], failures: [] }
  for (const row of rows) {
    try { result.results.push(processSubscriptionReceipt(ctx, String(row.id))) }
    catch { result.failures.push({ receiptId: String(row.id), code: 'SUBSCRIPTION_LEDGER_UNAVAILABLE' }) }
  }
  return result
}

function transactionDTO(row: TransactionRow): SubscriptionLedgerTransaction {
  // This is our own stored, parser-audited JSON, not webhook decoding.
  const decoded = row.discounts_json === null ? null : JSON.parse(row.discounts_json) as SubscriptionDiscount[]
  const discounts = decoded === null ? null : decoded.map(discount => {
    const safe: SubscriptionDiscount = {}
    for (const key of ['party', 'source', 'discountAmount', 'discountRate', 'currency'] as const) {
      if (typeof discount[key] === 'string') safe[key] = discount[key]
    }
    return safe
  })
  return {
    tradeOrderId: row.trade_order_id, subscriptionId: row.subscription_id, tierId: row.tier_id,
    kind: row.payment_kind, paymentRecorded: row.payment_receipt_id !== null,
    refunded: row.refund_receipt_id !== null, revoked: row.revoke_receipt_id !== null,
    receiptConflict: row.receipt_conflict !== 0,
    originalPrice: row.original_price, actualPrice: row.actual_price, currency: row.currency,
    refundPrice: row.refund_price, refundCurrency: row.refund_currency,
    benefitBeginRaw: row.benefit_begin_raw, benefitEndRaw: row.benefit_end_raw, discounts,
  }
}
export function readOperationConfirmation(ctx: AppContext, operationId: string): SubscriptionOperationConfirmation | null {
  const s = scope(ctx)
  const op = one<OperationRow>(ctx, 'SELECT * FROM subscription_operations WHERE id=? AND client_key=? AND receiving_mode=?',
    operationId, s.app, s.mode)
  if (!op) return null
  const proof = op.confirmation_receipt_id === null ? undefined
    : one<EventRow>(ctx, 'SELECT * FROM subscription_business_events WHERE receipt_id=?', op.confirmation_receipt_id)
  const who = identity(ctx, s, op.user_id)
  const contradictory = op.confirmation_receipt_id !== null && (!proof || !who ||
    proof.operation_id !== op.id || proof.client_key !== s.app || proof.environment !== s.environment ||
    proof.user_id !== op.user_id || proof.owner_identity !== who.hash || op.owner_identity !== who.providerId ||
    proof.trade_order_id !== op.trade_order_id || proof.subscription_id !== op.subscription_id ||
    proof.action !== op.action || proof.event_name !== `minis.subscription.${op.action}` ||
    (op.source_environment !== 'unknown' && op.source_environment !== proof.environment))
  const receiptConflict = Boolean(op.receipt_conflict) || contradictory
  const matchingProof = contradictory ? undefined : proof
  const environment = matchingProof?.environment ?? op.source_environment
  const transaction = matchingProof?.trade_order_id ? transactionRow(ctx, s, matchingProof.environment, matchingProof.trade_order_id) : undefined
  const contract = matchingProof ? contractRow(ctx, s, matchingProof.environment, matchingProof.subscription_id) : undefined
  const receipt: SubscriptionLedgerConfirmationReceipt | null = matchingProof &&
    (matchingProof.action === 'create' || matchingProof.action === 'reactivate') ? {
      receiptId: String(matchingProof.receipt_id),
      event: matchingProof.action === 'create' ? 'minis.subscription.create' : 'minis.subscription.reactivate',
      eventCreatedAt: matchingProof.event_created_at, recordedAt: matchingProof.recorded_at,
    } : null
  return {
    operationId: op.id, confirmed: Boolean(proof) && !receiptConflict,
    confirmationReceiptId: op.confirmation_receipt_id === null ? null : String(op.confirmation_receipt_id),
    confirmedAt: op.confirmed_at, receiptConflict, subscriptionId: op.subscription_id,
    tradeOrderId: op.trade_order_id, environment, paymentRecorded: transaction?.payment_receipt_id != null,
    refunded: transaction?.refund_receipt_id != null,
    revoked: transaction?.revoke_receipt_id != null || contract?.revoked_receipt_id != null,
    receipt, eventName: receipt?.event ?? null,
    eventCreatedAt: receipt?.eventCreatedAt ?? null, recordedAt: receipt?.recordedAt ?? null,
  }
}
export function readSubscriptionTransactionHistory(
  ctx: AppContext, userId: string, options: SubscriptionHistoryOptions = {},
): SubscriptionTransactionHistoryPage {
  const s = scope(ctx), who = identity(ctx, s, userId)
  const limit = pageLimit(options.limit, 25)
  const before = options.before === undefined ? Number.MAX_SAFE_INTEGER : receiptNumber(options.before)
  if (!who || !s.environment) return { items: [], nextCursor: null }
  const filters: string[] = [], values: string[] = []
  for (const [key, column] of [['tradeOrderId', 'trade_order_id'], ['subscriptionId', 'subscription_id']] as const) {
    const value = options[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new ApiError(400, 'INVALID_SUBSCRIPTION_FILTER', '请填写完整的交易或订阅编号')
    }
    filters.push(`${column}=?`); values.push(value)
  }
  const rows = all<TransactionRow>(ctx, `SELECT * FROM subscription_transactions
    WHERE client_key=? AND environment=? AND user_id=? AND owner_identity=? AND id<?
    ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT ?`, s.app, s.environment, userId, who.hash, before, ...values, limit + 1)
  const items = rows.slice(0, limit).map((transaction): SubscriptionTransactionHistoryItem => {
    const proof = transaction.payment_receipt_id === null ? undefined
      : one<EventRow>(ctx, 'SELECT * FROM subscription_business_events WHERE receipt_id=?', transaction.payment_receipt_id)
    return {
      ...transactionDTO(transaction), id: String(transaction.id), operationId: transaction.operation_id,
      environment: transaction.environment,
      confirmation: transaction.receipt_conflict ? 'conflict' : transaction.payment_receipt_id === null ? 'unconfirmed' : 'confirmed',
      confirmationReceiptId: transaction.payment_receipt_id === null ? null : String(transaction.payment_receipt_id),
      refundReceiptId: transaction.refund_receipt_id === null ? null : String(transaction.refund_receipt_id),
      revokeReceiptId: transaction.revoke_receipt_id === null ? null : String(transaction.revoke_receipt_id),
      confirmedAt: proof?.event_created_at ?? null, eventCreatedAt: proof?.event_created_at ?? null,
      recordedAt: proof?.recorded_at ?? null, hasConflict: Boolean(transaction.receipt_conflict),
      createdAt: transaction.created_at, updatedAt: transaction.updated_at,
    }
  })
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null }
}

export interface SubscriptionLifecycleObservation {
  action: SubscriptionAction
  eventCreatedAt: number
  count: number
  receiptId: string
  tradeOrderId: string | null
  tierId: string | null
}
/** The latest *event time* per action, not the latest receiving order. */
export function readSubscriptionLifecycle(ctx: AppContext, userId: string, subscriptionId: string): SubscriptionLifecycleObservation[] {
  const s = scope(ctx), who = identity(ctx, s, userId)
  if (!who || !s.environment) return []
  return all<{ action: SubscriptionAction; event_created_at: number; n: number; receipt: number; trade: string | null; tier: string | null }>(ctx, `
    WITH ranked AS (
      SELECT e.action,e.event_created_at,e.receipt_id,e.trade_order_id,t.tier_id,
        RANK() OVER (PARTITION BY e.action ORDER BY e.event_created_at DESC) AS position
      FROM subscription_business_events e LEFT JOIN subscription_transactions t
        ON t.client_key=e.client_key AND t.environment=e.environment AND t.user_id=e.user_id
        AND t.owner_identity=e.owner_identity AND t.subscription_id=e.subscription_id AND t.trade_order_id=e.trade_order_id
      WHERE e.client_key=? AND e.environment=? AND e.user_id=? AND e.owner_identity=? AND e.subscription_id=?
        AND e.action IN ('create','renew','reactivate','expire','onhold','cancel')
    )
    SELECT action,event_created_at,COUNT(*) AS n,MIN(receipt_id) AS receipt,MIN(trade_order_id) AS trade,MIN(tier_id) AS tier
    FROM ranked WHERE position=1 GROUP BY action,event_created_at`,
  s.app, s.environment, userId, who.hash, subscriptionId).map(row => ({
    action: row.action, eventCreatedAt: row.event_created_at, count: row.n,
    receiptId: String(row.receipt), tradeOrderId: row.n === 1 ? row.trade : null, tierId: row.n === 1 ? row.tier : null,
  }))
}

export function readSubscriptionReviewReceipts(
  ctx: AppContext, userId: string, item: SubscriptionTransactionHistoryItem, additional: string[],
): SubscriptionReview['receipts'] {
  const s = scope(ctx), who = identity(ctx, s, userId)
  if (!who || !s.environment) return []
  const ids = [...new Set([item.confirmationReceiptId, item.refundReceiptId, item.revokeReceiptId, ...additional].filter(
    (value): value is string => value !== null,
  ))]
  if (!ids.length) return []
  return all<EventRow>(ctx, `SELECT * FROM subscription_business_events
    WHERE client_key=? AND environment=? AND user_id=? AND owner_identity=? AND subscription_id=?
      AND receipt_id IN (${ids.map(() => '?').join(',')}) ORDER BY event_created_at,receipt_id`,
  s.app, s.environment, userId, who.hash, item.subscriptionId, ...ids).map(event => ({
    id: String(event.receipt_id), event: event.event_name,
    eventCreatedAt: event.event_created_at, recordedAt: event.recorded_at,
  }))
}

/** Links come from processed events, never from unverified raw notification fields. */
export function readSubscriptionReceiptLocation(ctx: AppContext, receiptId: string): SubscriptionLedgerLocation | null {
  const s = scope(ctx)
  if (!s.environment) return null
  const event = one<EventRow>(ctx, `SELECT e.* FROM subscription_receipt_processing p
    JOIN subscription_business_events e ON e.id=p.business_event_id
    WHERE p.receipt_id=? AND p.client_key=? AND p.receiving_mode=?
      AND p.status IN ('recorded','duplicate') AND p.environment=?
      AND e.client_key=p.client_key AND e.environment=p.environment AND e.user_id=p.user_id`,
  receiptNumber(receiptId), s.app, s.mode, s.environment)
  if (!event) return null
  const who = identity(ctx, s, event.user_id)
  if (!who || who.hash !== event.owner_identity) return null
  return { userId: event.user_id, subscriptionId: event.subscription_id, tradeOrderId: event.trade_order_id }
}

/** Action/event history stays separate from the per-transaction bill list. */
export function readSubscriptionHistory(
  ctx: AppContext, userId: string, options: SubscriptionHistoryOptions = {},
): SubscriptionHistoryPage {
  const s = scope(ctx), who = identity(ctx, s, userId)
  const limit = pageLimit(options.limit, 25)
  const before = options.before === undefined ? Number.MAX_SAFE_INTEGER : receiptNumber(options.before)
  if (!who || !s.environment) return { items: [], nextCursor: null }
  const rows = all<EventRow>(ctx, `SELECT * FROM subscription_business_events
    WHERE client_key=? AND environment=? AND user_id=? AND owner_identity=? AND id<?
    ORDER BY id DESC LIMIT ?`, s.app, s.environment, userId, who.hash, before, limit + 1)
  const items = rows.slice(0, limit).map((event): SubscriptionHistoryItem => {
    const transaction = event.trade_order_id ? transactionRow(ctx, s, event.environment, event.trade_order_id) : undefined
    return {
      id: String(event.id), receiptId: String(event.receipt_id), action: event.action, eventName: event.event_name,
      subscriptionId: event.subscription_id, tradeOrderId: event.trade_order_id, tierId: event.tier_id,
      operationId: event.operation_id, environment: event.environment,
      eventCreatedAt: event.event_created_at, recordedAt: event.recorded_at,
      transaction: transaction ? transactionDTO(transaction) : null,
    }
  })
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null }
}
