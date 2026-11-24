import { ApiError, type ServerConfig } from './types.js'

const TARGET = 'http://127.0.0.1:5315/api/webhooks/tiktok'
const TIMEOUT_MS = 8_000
const MAX_RECEIPT_BYTES = 16 * 1024
const sandboxEvents = new Set([
  'minis.subscription.create', 'minis.subscription.renew', 'minis.subscription.cancel',
  'minis.subscription.onhold', 'minis.subscription.expire', 'minis.subscription.reactivate',
  'minis.subscription.refund', 'minis.subscription.revoke',
  'minis.trade_order.redeem.success', 'minis.trade_order.redeem.refund_success',
  'minis.trade_order.redeem.refund_traceback',
])
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function loadSandboxWebhookTarget(mode: ServerConfig['mode'], value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (mode !== 'production' || value !== TARGET) {
    throw new Error('TIKTOK_SANDBOX_WEBHOOK_TARGET仅允许production配置为http://127.0.0.1:5315/api/webhooks/tiktok；staging不得再次转发')
  }
  return value
}
/** 仅分类已实现事件；签名与当前App必须先由原webhook入口验证。 */
export function isSandboxWebhook(event: unknown): boolean {
  if (!record(event) || typeof event.event !== 'string' || !sandboxEvents.has(event.event)) return false
  let content: unknown = event.content
  try { if (typeof content === 'string') content = JSON.parse(content) } catch { return false }
  return record(content) && content.is_sandbox === true
}
async function confirmedReceipt(response: Response): Promise<void> {
  if (!response.ok || response.redirected || !response.body) throw new Error()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_RECEIPT_BYTES) throw new Error()
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const receipt: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  // 普通订单只返回{ok:true}；订阅另有received:true。忽略或矛盾错误不能作为接收确认。
  if (!record(receipt) || receipt.ok !== true || (receipt.received !== undefined && receipt.received !== true) ||
    receipt.ignored === true || Object.hasOwn(receipt, 'error')) throw new Error()
}
/** 不落库、不重签、不重试；接收进程仍须独立验签、检查App及沙箱环境。 */
export async function relaySandboxWebhook(
  config: Pick<ServerConfig, 'mode' | 'sandboxWebhookTarget'>,
  rawBody: Buffer, signature: string, contentType: string,
): Promise<void> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const target = loadSandboxWebhookTarget(config.mode, config.sandboxWebhookTarget)
    if (!target || !Buffer.isBuffer(rawBody) || !signature) throw new Error()
    const send = async () => {
      const response = await fetch(target, {
        method: 'POST', headers: { 'Content-Type': contentType, 'TikTok-Signature': signature },
        body: new Uint8Array(rawBody), credentials: 'omit', redirect: 'error', signal: abort.signal,
      })
      await confirmedReceipt(response)
    }
    await Promise.race([
      send(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error()) }, TIMEOUT_MS)
      }),
    ])
  } catch {
    abort.abort()
    // 不带上游正文、URL、签名或用户信息；让平台保留原通知并重试。
    throw new ApiError(503, 'SANDBOX_WEBHOOK_RELAY_UNAVAILABLE', '沙箱通知尚未确认接收，请重试原通知')
  } finally { clearTimeout(timer) }
}
