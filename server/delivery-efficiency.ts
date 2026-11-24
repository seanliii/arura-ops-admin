import type { Router } from 'express'
import type { AppContext } from './types.js'
import { ApiError } from './types.js'
import { body, integer, text } from './validation.js'
import { transaction } from './db.js'
import { scopeRows } from './content-operations.js'
import type { PageInfo } from '../shared/content-operations.js'
import type { DeliveryEfficiency, DeliveryWorkReceipt, DeliveryWorkState, EfficiencyJob, EfficiencyRound, WorkAction } from '../shared/delivery-efficiency.js'

type Row = Record<string, any>
type Interval = [number, number]
const DAY = 86_400_000, terminal = new Set(['complete', 'cancelled'])
const stamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const invalid = (message: string) => new ApiError(400, 'INVALID_EFFICIENCY_INPUT', message)
function utcDay(value: string) {
  const parsed = Date.parse(`${value}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !stamp(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
    throw invalid('日期必须是有效的 UTC 自然日')
  return parsed
}
function queryRange(q: Row, now: number) {
  const allowed = new Set(['from', 'to', 'region', 'language', 'dramaId', 'page', 'pageSize', 'activePage', 'roundPage'])
  if (Object.entries(q).some(([key, value]) => !allowed.has(key) || typeof value !== 'string')) throw invalid('不支持该筛选或重复参数')
  const today = Math.floor(now / DAY) * DAY
  const from = q.from || new Date(today - 7 * DAY).toISOString().slice(0, 10)
  const to = q.to || new Date(today - DAY).toISOString().slice(0, 10)
  const start = utcDay(from), end = utcDay(to) + DAY
  if (start >= end || end - start > 366 * DAY || end > today + DAY) throw invalid('请选择不超过366天且不晚于今天的日期范围')
  return { from, to, start, end, partialDay: end > today }
}
function paginate<T>(rows: T[], q: Row, key = 'page') {
  for (const field of [key, 'pageSize']) if (q[field] !== undefined && !/^[1-9]\d*$/.test(q[field])) throw invalid('页码和每页条数必须为正整数')
  const page = integer(Number(q[key] ?? 1), key, 1, 1_000_000), pageSize = integer(Number(q.pageSize ?? 25), 'pageSize', 1, 100)
  const pagination: PageInfo = { page, pageSize, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / pageSize)) }
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), pagination }
}
function jobRow(ctx: AppContext, jobId: string): Row {
  const job = ctx.db.prepare('SELECT * FROM media_delivery_jobs WHERE id=?').get(jobId)
  if (!job) throw new ApiError(404, 'DELIVERY_NOT_FOUND', '没有找到原交付批次')
  return job
}
function workEvents(ctx: AppContext, owner: string, jobId: string) {
  return ctx.db.prepare('SELECT * FROM delivery_work_events WHERE owner_id=? AND job_id=? ORDER BY id').all(owner, jobId) as Row[]
}
/** 只闭合明确 start→pause/finish；查看页面和历史读取从不补事件。 */
function intervals(events: Row[]) {
  const closed: Interval[] = []
  let start: number | null = null
  for (const event of events) {
    if (event.action === 'start') start = event.observed_at
    else if (start !== null && stamp(event.observed_at) && event.observed_at >= start) {
      closed.push([start, event.observed_at]); start = null
    }
  }
  return { closed, start }
}
function workState(ctx: AppContext, owner: string, job: Row, now: number): DeliveryWorkState {
  const events = workEvents(ctx, owner, job.id), last = events.at(-1), spans = intervals(events)
  return { jobId: job.id, status: !last ? 'idle' : last.action === 'start' ? 'running' : last.action === 'pause' ? 'paused' : 'finished',
    closedMs: spans.closed.reduce((sum, [a, b]) => sum + b - a, 0), runningSince: spans.start,
    lastObservedAt: last?.observed_at ?? null, observedAt: now, canStart: !terminal.has(job.status) && last?.action !== 'start' }
}
function unionMs(spans: Interval[]) {
  let total = 0, end = -1
  for (const [a, b] of spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    total += Math.max(0, b - Math.max(end, a)); end = Math.max(end, b)
  }
  return total
}
function manualSummary(ctx: AppContext, jobs: EfficiencyJob[], now: number): DeliveryEfficiency['manual'] {
  const chosen = new Set(jobs.map(j => j.id))
  const groups = new Map<string, Row[]>()
  for (const event of ctx.db.prepare('SELECT id,job_id,owner_id,action,observed_at FROM delivery_work_events ORDER BY id').all() as Row[]) {
    if (!chosen.has(event.job_id) || !stamp(event.observed_at) || event.observed_at > now) continue
    const key = JSON.stringify([event.owner_id, event.job_id])
    const group = groups.get(key) ?? []; group.push(event); groups.set(key, group)
  }
  const byOwner = new Map<string, Interval[]>(), recorded = new Set<string>()
  let openIntervals = 0
  for (const events of groups.values()) {
    const { closed, start } = intervals(events)
    if (start !== null) openIntervals++
    if (!closed.length) continue
    recorded.add(events[0].job_id)
    const owner = events[0].owner_id
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), ...closed])
  }
  return { cohortJobs: jobs.length, recordedJobs: recorded.size, openIntervals, contributors: byOwner.size,
    coverage: jobs.length ? recorded.size / jobs.length : null,
    closedUnionMs: byOwner.size ? [...byOwner.values()].reduce((sum, spans) => sum + unionMs(spans), 0) : null }
}
function platformSummary(ctx: AppContext, allowed: Map<number, Row>, start: number, end: number, q: Row, now: number): DeliveryEfficiency['platform'] {
  const submits = (ctx.db.prepare("SELECT * FROM platform_media_operations WHERE action='submit_review' ORDER BY created_at,request_id").all() as Row[])
    .filter(row => allowed.has(row.drama_id) && row.created_at <= now)
  const observations = ctx.db.prepare(`SELECT o.*,p.album_id,p.client_key FROM platform_media_observations o
    JOIN platform_media_operations p ON p.request_id=o.request_id
    WHERE p.action='sync' AND p.status='succeeded' ORDER BY o.observed_at,o.id`).all() as Row[]
  const same = (a: Row, b: Row) => a.drama_id === b.drama_id && a.album_id === b.album_id &&
    a.client_key === b.client_key && a.platform_version === b.platform_version
  const previous = new Map<string, EfficiencyRound>()
  const all = submits.map((op, i): EfficiencyRound => {
    const next = submits.slice(i + 1).find(s => same(s, op)), key = JSON.stringify([op.drama_id, op.album_id, op.client_key, op.platform_version])
    const samples = observations.filter(o => same(o, op) && o.observed_at >= op.created_at &&
      o.observed_at <= now && (!next || o.observed_at < next.created_at))
    // 未确认受理不能借随后同版本结果声称这次请求成功。
    const result = op.acknowledged ? samples.find(o => [2, 3, 4, 6, 7].includes(o.review_status)) : undefined
    const wait = op.acknowledged ? samples.filter(o => [1, 5].includes(o.review_status) &&
      (!result || o.observed_at <= result.observed_at)).at(-1) : undefined
    const prior = previous.get(key)
    const round: EfficiencyRound = { requestId: op.request_id, dramaId: op.drama_id, title: String(allowed.get(op.drama_id)!.title),
      platformVersion: op.platform_version, round: (prior?.round ?? 0) + 1, submittedAt: op.created_at, acknowledged: !!op.acknowledged,
      result: result ? [2, 6].includes(result.review_status) ? 'approved' : [3, 7].includes(result.review_status) ? 'rejected' : 'withdrawn'
        : wait ? 'waiting' : 'unknown',
      lowerBoundMs: wait ? wait.observed_at - op.created_at : null,
      upperBoundMs: result ? result.observed_at - op.created_at : null, observedAt: result?.observed_at ?? wait?.observed_at ?? null,
      resubmissionAfterRejection: !!op.acknowledged && prior?.result === 'rejected' }
    previous.set(key, round); return round
  }).filter(round => round.submittedAt >= start && round.submittedAt < end)
  const page = paginate(all, q, 'roundPage')
  return { attempts: all.length, acknowledged: all.filter(r => r.acknowledged).length,
    resolved: all.filter(r => r.upperBoundMs !== null).length, resubmissionsAfterRejection: all.filter(r => r.resubmissionAfterRejection).length,
    rounds: page.rows, pagination: page.pagination }
}
export function readDeliveryEfficiency(ctx: AppContext, q: Row, now = Date.now()): DeliveryEfficiency {
  const range = queryRange(q, now), allowed = new Map(scopeRows(ctx, q).map(d => [Number(d.id), d]))
  const rows = ctx.db.prepare(`SELECT j.*,d.title,
    (SELECT min(o.observed_at) FROM media_delivery_observations o WHERE o.job_id=j.id AND o.status='complete') completed_at
    FROM media_delivery_jobs j JOIN dramas d ON d.id=j.drama_id ORDER BY j.created_at DESC,j.id DESC`).all() as Row[]
  let allCompleted = 0, timed = 0, invalidJobs = 0, cancelled = 0
  const completed: EfficiencyJob[] = [], active: EfficiencyJob[] = []
  for (const j of rows) {
    if (!allowed.has(j.drama_id)) continue
    const valid = stamp(j.created_at) && stamp(j.completed_at) && j.completed_at >= j.created_at && j.completed_at <= now
    const dto: EfficiencyJob = { id: j.id, dramaId: j.drama_id, title: j.title, status: j.status, createdAt: j.created_at,
      completedAt: valid ? j.completed_at : null, durationMs: valid ? j.completed_at - j.created_at : null,
      ageMs: !terminal.has(j.status) && stamp(j.created_at) && now >= j.created_at ? now - j.created_at : null }
    if (j.status === 'complete') {
      allCompleted++
      if (valid) {
        timed++
        if (j.completed_at >= range.start && j.completed_at < range.end) completed.push(dto)
      } else if (j.completed_at !== null) invalidJobs++
    } else if (j.status === 'cancelled') cancelled++
    else if (j.active === 1) active.push({ ...dto, completedAt: null, durationMs: null })
  }
  completed.sort((a, b) => b.completedAt! - a.completedAt! || a.id.localeCompare(b.id))
  const values = completed.map(j => j.durationMs!).sort((a, b) => a - b)
  const percentile = (p: number) => values.length ? values[Math.ceil(values.length * p) - 1]! : null
  const done = paginate(completed, q), current = paginate(active, q, 'activePage')
  return { generatedAt: now, scope: { region: q.region || null, contentLanguage: q.language || null, dramaId: q.dramaId ? Number(q.dramaId) : null,
      from: range.from, to: range.to, timeZone: 'UTC', partialDay: range.partialDay,
      basis: '当前作品发行地区与实际成片语言，不是观众所在国家；成功批次按首次完成观测日统计，计时覆盖另以本范围全部历史已完成批次为分母。' },
    completed: { count: values.length, p50Ms: percentile(.5), p95Ms: percentile(.95), jobs: done.rows, pagination: done.pagination },
    coverage: { completedJobs: allCompleted, timedJobs: timed, unknownJobs: allCompleted - timed, invalidJobs, ratio: allCompleted ? timed / allCompleted : null },
    excluded: { cancelledJobs: cancelled }, activity: { jobs: current.rows, pagination: current.pagination },
    manual: manualSummary(ctx, completed, now), platform: platformSummary(ctx, allowed, range.start, range.end, q, now) }
}
export function registerDeliveryEfficiency(router: Router, ctx: AppContext) {
  router.get('/api/admin/delivery-efficiency', (req, res) => {
    ctx.requireAdmin(req); res.json(readDeliveryEfficiency(ctx, req.query))
  })
  const route = '/api/admin/delivery-work/:jobId'
  router.get(`${route}/requests/:requestId`, (req, res) => {
    const actor = ctx.requireAdmin(req)
    const row = ctx.db.prepare('SELECT receipt_json FROM delivery_work_events WHERE owner_id=? AND job_id=? AND request_id=?')
      .get(actor.id, text(req.params.jobId, 'jobId', 100), text(req.params.requestId, 'requestId', 100))
    if (!row) throw new ApiError(404, 'WORK_REQUEST_NOT_FOUND', '没有找到原计时操作，可用原编号重试；不会自动开始')
    res.json(JSON.parse(String(row.receipt_json)))
  })
  router.get(route, (req, res) => {
    const actor = ctx.requireAdmin(req)
    res.json(workState(ctx, actor.id, jobRow(ctx, text(req.params.jobId, 'jobId', 100)), Date.now()))
  })
  router.post(route, (req, res) => {
    const actor = ctx.requireAdmin(req), input = body(req.body), jobId = text(req.params.jobId, 'jobId', 100)
    if (Object.keys(input).some(k => !['action', 'requestId'].includes(k)) ||
      typeof input.action !== 'string' || !['start', 'pause', 'finish'].includes(input.action) || typeof input.requestId !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.requestId))
      throw invalid('请明确选择开始、暂停或结束；时间由服务器记录，不接受代填历史')
    const action = input.action as WorkAction, requestId = input.requestId
    const receipt = transaction(ctx.db, () => {
      const old = ctx.db.prepare('SELECT * FROM delivery_work_events WHERE owner_id=? AND request_id=?').get(actor.id, requestId)
      if (old) {
        if (old.job_id !== jobId || old.action !== action) throw new ApiError(409, 'WORK_REQUEST_CONFLICT', '原编号属于另一份操作，请核对原结果')
        return JSON.parse(String(old.receipt_json)) as DeliveryWorkReceipt
      }
      const job = jobRow(ctx, jobId), now = Date.now(), state = workState(ctx, actor.id, job, now)
      if (!stamp(now) || now < job.created_at || state.lastObservedAt !== null && now < state.lastObservedAt)
        throw new ApiError(409, 'WORK_CLOCK_REVERSED', '服务器时点早于上一条记录，未追加计时，请先核对时间')
      if (action === 'start' ? !state.canStart : action === 'pause' ? state.status !== 'running' : !['running', 'paused'].includes(state.status))
        throw new ApiError(409, 'WORK_STATE_CONFLICT', '人工计时状态已变化，请重新读取；已完成或取消的任务不能新开始')
      const result: DeliveryWorkReceipt = { jobId, requestId, action, savedAt: now, state: { ...state, observedAt: now, lastObservedAt: now,
        status: action === 'start' ? 'running' : action === 'pause' ? 'paused' : 'finished',
        runningSince: action === 'start' ? now : null,
        closedMs: state.closedMs + (state.runningSince !== null && action !== 'start' ? now - state.runningSince : 0),
        canStart: action !== 'start' && !terminal.has(job.status) } }
      ctx.db.prepare('INSERT INTO delivery_work_events(owner_id,job_id,request_id,action,observed_at,receipt_json) VALUES(?,?,?,?,?,?)')
        .run(actor.id, jobId, requestId, action, now, JSON.stringify(result))
      return result
    })
    res.json(receipt)
  })
}
