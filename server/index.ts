import { createApp } from './app.js'
import { bootstrap } from './bootstrap.js'
import { reprocessSubscriptionReceipts } from './subscription-ledger.js'
import { startSubscriptionReceiptWorker, type SubscriptionReceiptWorker } from './subscription-worker.js'
import { startMediaDeliveryWorker, type MediaDeliveryWorker } from './media-delivery-worker.js'
import { runMediaDeliveryBatch } from './media-delivery.js'
import { startAnalyticsPump } from './analytics-ledger.js'

const server = createApp()
let subscriptionWorker: SubscriptionReceiptWorker | undefined
let deliveryWorker: MediaDeliveryWorker | undefined
let analyticsPump: ReturnType<typeof startAnalyticsPump> | undefined
const close = async () => {
  await deliveryWorker?.stop()
  await subscriptionWorker?.stop()
  await analyticsPump?.stop()
  await server.ctx.analytics?.stop()
  server.close()
}
try {
  await bootstrap(server.ctx)
  const host = process.env.DRAMA_HOST || '127.0.0.1'
  const port = Number(process.env.DRAMA_PORT || process.env.PORT || 5310)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在1至65535之间')
  const listener = server.app.listen(port, host, () => console.info(`DramaVerseJP http://${host}:${port}`))
  if (server.ctx.analytics) analyticsPump = startAnalyticsPump(server.ctx)
  if (server.ctx.config.mode !== 'local') deliveryWorker = startMediaDeliveryWorker(() => runMediaDeliveryBatch(server.ctx))
  if (server.ctx.config.mode !== 'local' && server.ctx.config.tiktokClientKey &&
    server.ctx.config.tiktokClientSecret && server.ctx.config.tokenEncryptionKey) {
    subscriptionWorker = startSubscriptionReceiptWorker(() => {
      const batch = reprocessSubscriptionReceipts(server.ctx, 25)
      if (batch.failures.length || batch.results.some(result => result.status === 'retryable_error')) {
        throw new Error('SUBSCRIPTION_BATCH_RETRY')
      }
    })
  }
  listener.requestTimeout = 5 * 60000
  listener.headersTimeout = 15000
  listener.on('error', () => { console.error('服务监听失败，请检查地址和端口'); void close(); process.exitCode = 1 })
  const stop = () => {
    void deliveryWorker?.stop()
    void subscriptionWorker?.stop()
    void analyticsPump?.stop()
    listener.close(() => { void close() })
    listener.closeIdleConnections()
    const timeout = setTimeout(() => { listener.closeAllConnections(); void close() }, 10000)
    timeout.unref()
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
} catch (error) {
  await close()
  // Bootstrap validation contains no supplied values, so it is safe to show.
  console.error(error instanceof Error ? error.message : '服务器启动失败')
  process.exitCode = 1
}
