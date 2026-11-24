import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { AnalyticsAccepted, AnalyticsEventRecord, AnalyticsStatus } from '../shared/analytics.js'
import { analyticsEnvironment, ANALYTICS_TIMEZONES } from '../shared/analytics.js'
import { ApiError, type ServerConfig } from './types.js'
import type { AnalyticsCatalogSnapshot } from '../shared/analytics-operations.js'

export class AnalyticsStore {
  private worker?: Worker
  private ready?: Promise<void>
  private closing = false
  private sequence = 0
  private snapshotValue?: AnalyticsCatalogSnapshot
  private refreshing?: Promise<AnalyticsCatalogSnapshot>
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor(readonly config: ServerConfig) {}
  private unavailable(code = 'ANALYTICS_UNAVAILABLE') { return new ApiError(503, code, '统计暂不可用；观看、登录和付款不依赖统计服务') }
  private failPending(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
  }
  private start() {
    if (this.closing) return Promise.reject(this.unavailable())
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const worker = this.worker = new Worker(new URL('./analytics-worker.mjs', import.meta.url), {
        workerData: { directory: join(this.config.dataDir, 'analytics'), environment: analyticsEnvironment(this.config.mode), timezones: ANALYTICS_TIMEZONES },
      })
      worker.unref()
      let ready = false
      worker.on('message', (message: { ready?: boolean; id?: number; ok?: boolean; result?: unknown; code?: string }) => {
        if (message.ready !== undefined) {
          if (message.ready) { ready = true; resolve() }
          else reject(this.unavailable(message.code))
          return
        }
        const call = this.pending.get(message.id!)
        if (!call) return
        this.pending.delete(message.id!); clearTimeout(call.timer)
        if (message.ok) call.resolve(message.result)
        else call.reject(new ApiError(message.code === 'ANALYTICS_NOT_FOUND' ? 404 :
          ['ANALYTICS_EVENT_CONFLICT','ANALYTICS_OPERATION_CONFLICT','ANALYTICS_EXPERIMENT_FINISHED','ANALYTICS_EXPERIMENT_ACTIVE'].includes(message.code??'') ? 409 : 503,
          message.code ?? 'ANALYTICS_STORAGE_ERROR', message.code === 'ANALYTICS_EVENT_CONFLICT'
            ? '该事件编号已用于另一条记录，未重复累计' : '统计写入未确认，请保留原事件编号重试'))
      })
      worker.on('error', () => { reject(this.unavailable()); this.failPending(this.unavailable()) })
      worker.on('exit', () => {
        if (!ready) reject(this.unavailable())
        this.failPending(this.unavailable())
        if (this.worker === worker) { this.worker = undefined; this.ready = undefined }
      })
    })
    return this.ready
  }
  async call<T>(action: string, payload: object = {}): Promise<T> {
    // Capture before startup awaits. Earlier ingress calls await the same ready
    // promise and post FIFO; the serial worker acknowledges this report barrier.
    const submittedAt = Date.now()
    if (this.closing && action !== 'close') throw this.unavailable()
    if (this.pending.size >= 64) throw new ApiError(429, 'ANALYTICS_BUSY', '统计队列繁忙，稍后使用原事件编号重试')
    await this.start()
    if (this.pending.size >= 64) throw new ApiError(429, 'ANALYTICS_BUSY', '统计队列繁忙，稍后使用原事件编号重试')
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(this.unavailable('ANALYTICS_TIMEOUT')) }, 15000)
      timer.unref()
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      this.worker!.postMessage({ id, action, payload, submittedAt })
    })
  }
  ingest(events: AnalyticsEventRecord[], businessCursor?: number) {
    return this.call<AnalyticsAccepted>('ingest', { events, businessCursor })
  }
  catalogSnapshot(): AnalyticsCatalogSnapshot | undefined {
    return !this.closing && this.snapshotValue && Date.now()-this.snapshotValue.generatedAt<120000 ? this.snapshotValue : undefined
  }
  refreshCatalog(): Promise<AnalyticsCatalogSnapshot> {
    if(this.refreshing)return this.refreshing
    const run=this.call<AnalyticsCatalogSnapshot>('catalog-snapshot').then(value=>{this.snapshotValue=value;return value})
    this.refreshing=run
    void run.finally(()=>{if(this.refreshing===run)this.refreshing=undefined}).catch(()=>{})
    return run
  }
  async status(): Promise<AnalyticsStatus> {
    const result = await this.call<Omit<AnalyticsStatus, 'queued'>>('status')
    return { ...result, queued: this.pending.size }
  }
  snapshot(target: string) { return this.call<{ cursor: number }>('snapshot', { target }) }
  async stop() {
    if (this.closing) return
    if (this.worker) {
      try { await this.call('close') } finally { this.closing = true; this.failPending(this.unavailable()); await this.worker?.terminate() }
    } else this.closing = true
  }
  destroy() {
    this.closing = true; this.failPending(this.unavailable())
    void this.worker?.terminate()
  }
}
