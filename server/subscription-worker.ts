/** Executes already-authenticated queued receipts; it never creates a payment. */
export interface SubscriptionReceiptWorker {
  /** Stops new batches and waits for the in-flight batch before the database closes. */
  stop(): Promise<void>
}

export function startSubscriptionReceiptWorker(
  run: () => unknown | Promise<unknown>,
  onError: () => void = () => { console.warn('订阅通知处理暂时失败，稍后重试。') },
): SubscriptionReceiptWorker {
  if (typeof run !== 'function') throw new TypeError('订阅处理函数未配置')
  let stopped = false
  let inFlight: Promise<void> | undefined
  const tick = () => {
    if (stopped || inFlight) return
    const task = Promise.resolve().then(async () => {
      if (!stopped) await run()
    }).catch(() => {
      // Neither processing errors nor logger failures may expose raw receipts or
      // keep the worker permanently busy.
      try { onError() } catch { /* leave the durable receipt for the next batch */ }
    }).finally(() => {
      if (inFlight === task) inFlight = undefined
    })
    inFlight = task
  }
  const timer = setInterval(tick, 1000)
  timer.unref?.()
  tick()
  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}
