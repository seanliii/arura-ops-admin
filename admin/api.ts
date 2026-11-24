import type { Asset, AppMode, PaymentMode } from '../shared/contracts'
const adminApiBase = import.meta.env.VITE_ADMIN_API_BASE?.trim() || '/api'
if (!/^\/(?:[A-Za-z0-9_-]+\/)*api$/.test(adminApiBase)) throw new Error('管理API必须为同源的明确路径')

export const SESSION_EXPIRED = 'dramaverse:admin-session-expired'
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}
export interface Integrations {
  mode: AppMode
  paymentMode: PaymentMode
  mediaMode: 'local' | 'tiktok'
  tiktokConfigured: boolean
  requirements: string[]
}
export interface AuditEvent {
  id: number | string
  actorId: string | null
  action: string
  targetType: string
  targetId: string | null
  createdAt: number
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}
function failure(status: number, payload: unknown, notify: boolean): ApiError {
  const data = payload as { error?: { code?: unknown; message?: unknown } } | null
  const code = typeof data?.error?.code === 'string' ? data.error.code : 'HTTP_ERROR'
  const text = typeof data?.error?.message === 'string'
    ? data.error.message : `请求失败（HTTP ${status}），请稍后重试。`
  if (status === 401 && notify) window.dispatchEvent(new Event(SESSION_EXPIRED))
  return new ApiError(status, code, text)
}
/** 不缓存会话，不存令牌；只通过同源 HttpOnly Cookie 认证。 */
export async function api<T>(
  path: string,
  options: { method?: string; body?: object | FormData; signal?: AbortSignal; notify401?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'DramaVerseJP', Accept: 'application/json' }
  const isForm = options.body instanceof FormData
  if (options.body && !isForm) headers['Content-Type'] = 'application/json'
  let response: Response
  try {
    response = await fetch(`${adminApiBase}${path}`, {
      method: options.method ?? 'GET', headers, credentials: 'same-origin', cache: 'no-store',
      body: options.body ? (isForm ? options.body as FormData : JSON.stringify(options.body)) : undefined,
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new Error('无法连接服务器，请检查网络或本地服务后重试。')
  }
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) throw failure(response.status, payload, options.notify401 !== false)
  if (payload === null) throw new Error('服务器未返回有效 JSON，请检查 API 服务配置。')
  return payload as T
}

/** XHR 提供真实上传字节进度；100% 仅代表收到服务器资产记录。 */
export function uploadAsset(file: File, kind: Asset['kind'], onProgress: (percent: number) => void) {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<Asset>((resolve, reject) => {
    xhr.open('POST', `${adminApiBase}/admin/assets?kind=${kind}`)
    // 同源请求默认携带 Cookie；不启用跨域凭证。
    xhr.setRequestHeader('X-Requested-With', 'DramaVerseJP')
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.timeout = 30 * 60 * 1000
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100)))
    }
    xhr.onload = () => {
      let payload: { asset?: Asset } | null = null
      try { payload = JSON.parse(xhr.responseText) } catch { /* 显示受控错误，不渲染 HTML 错误页 */ }
      if (xhr.status < 200 || xhr.status >= 300) return reject(failure(xhr.status, payload, true))
      if (!payload?.asset?.id) return reject(new Error('上传响应缺少资产记录，请刷新资产列表确认后再重试。'))
      onProgress(100)
      resolve(payload.asset)
    }
    xhr.onerror = () => reject(new Error('上传网络中断；已完成的文件仍保留，请刷新资产列表核对。'))
    xhr.ontimeout = () => reject(new Error('上传超时，请刷新资产列表核对后重试。'))
    xhr.onabort = () => reject(new DOMException('上传已取消', 'AbortError'))
    const form = new FormData()
    form.append('file', file, file.name)
    xhr.send(form)
  })
  return { promise, cancel: () => xhr.abort() }
}

export function formatDate(value: number) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}
export function formatBytes(value: number) {
  return value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`
}
export function publicAssetUrl(asset: Asset) {
  return asset.kind === 'video' ? undefined : `${adminApiBase}/assets/${encodeURIComponent(asset.id)}`
}
export function safeCover(url: string) {
  return /^\/api\/assets\/[^/?#]+$/.test(url) ? `${adminApiBase}${url.slice(4)}` : undefined
}
export const dramaStatus = { draft: '草稿', published: '已发布', archived: '已下架' }
export const orderStatus = {
  pending: '待支付', processing: '处理中', paid: '已支付',
  cancelled: '已取消', failed: '支付失败', refunded: '已退款',
}
