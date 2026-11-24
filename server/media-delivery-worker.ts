export interface MediaDeliveryWorker { stop(): Promise<void> }
/** One bounded task step at a time. Durable next_run_at provides moderation polling and backoff. */
export function startMediaDeliveryWorker(run: () => Promise<void>, onError = () => console.warn('自动媒资交付本轮未完成，将按原任务继续核对。')): MediaDeliveryWorker {
  let stopped = false, pending: Promise<void> | undefined
  function tick() {
    if (stopped || pending) return
    const work = Promise.resolve().then(() => { if (!stopped) return run() }).catch(() => {
      try { onError() } catch { /* diagnostics must not stop the worker */ }
    }).finally(() => { if (pending === work) pending = undefined })
    pending = work
  }
  const timer = setInterval(tick, 2000); timer.unref?.(); tick()
  return { async stop() { stopped = true; clearInterval(timer); await pending } }
}
