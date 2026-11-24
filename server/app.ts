import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import multer from 'multer'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, projectDir } from './config.js'
import { openDatabase } from './db.js'
import { currentUser, requestSessionHash, registerAuth } from './auth.js'
import { registerContent } from './content.js'
import { registerWebPlayback } from './web-playback.js'
import { registerMedia } from './media.js'
import { registerPlatformMedia } from './platform-media.js'
import { registerCloudUploads } from './cloud-upload.js'
import { registerMediaExports } from './media-export.js'
import { registerMediaRegistration } from './media-registration.js'
import { registerPreviewCatalog } from './preview-catalog.js'
import { registerLibrary } from './library.js'
import { registerCommerce } from './commerce.js'
import { registerLegalPages } from './legal.js'
import { registerMediaDelivery } from './media-delivery.js'
import { registerContentOperations } from './content-operations.js'
import { registerDeliveryEfficiency } from './delivery-efficiency.js'
import { AnalyticsStore } from './analytics-store.js'
import { registerAnalytics } from './analytics.js'
import { corsRequests, corsResponseHeaders } from './http-policy.js'
import { sessionSourcePolicy, allowMinisCrossSiteWrite, hasBearerHeader } from './session-transport.js'
import { ApiError, type AppContext, type ServerConfig } from './types.js'

function limitRequests(max: number, windowMs: number): RequestHandler {
  const buckets = new Map<string, { count: number; until: number }>()
  return (req, res, next) => {
    const now = Date.now(), key = req.ip || req.socket.remoteAddress || 'unknown'
    // No background timer; stale entries are bounded and close() leaves no live handles.
    if (buckets.size > 10000) for (const [ip, bucket] of buckets) if (bucket.until <= now) buckets.delete(ip)
    let bucket = buckets.get(key)
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 20000 && !bucket) return next(new ApiError(429, 'RATE_LIMITED', '请求过多，请稍后再试'))
      bucket = { count: 0, until: now + windowMs }; buckets.set(key, bucket)
    }
    if (++bucket.count > max) { res.set('Retry-After', String(Math.ceil((bucket.until - now) / 1000))); return next(new ApiError(429, 'RATE_LIMITED', '请求过多，请稍后再试')) }
    next()
  }
}
export function createApp(options: Partial<ServerConfig> = {}) {
  const config = loadConfig(options), db = openDatabase(config), app = express()
  const ctx: AppContext = {
    db, config,
    user: req => currentUser(ctx, req),
    sessionHash: req => requestSessionHash(ctx, req),
    requireUser(req) { const user = currentUser(ctx, req); if (!user) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录'); return user },
    requireAdmin(req) {
      if (hasBearerHeader(req)) throw new ApiError(403, 'COOKIE_SESSION_REQUIRED', '管理端仅接受Cookie会话')
      const user = ctx.requireUser(req); if (user.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', '需要管理员权限'); return user
    },
    audit(actorId, action, type, targetId, detail = {}) { db.prepare('INSERT INTO audit_log(actor_id,action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?,?)').run(actorId, action, type, targetId, JSON.stringify(detail), Date.now()) },
  }
  if (config.analyticsEnabled) ctx.analytics = new AnalyticsStore(config)
  app.disable('x-powered-by'); app.disable('etag')
  // Only validated IP/CIDR entries; never trust every caller or a fixed hop count.
  app.set('trust proxy', config.trustedProxies?.length ? config.trustedProxies : false)
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin' })
    next()
  })
  const businessLimit = limitRequests(600, 60000), statisticsLimit = limitRequests(1800, 60000)
  app.use('/api', corsResponseHeaders(config), (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() },
    (req, res, next) => (['/analytics/events','/catalog/events'].includes(req.path) ? statisticsLimit : businessLimit)(req, res, next),
    corsRequests(config), sessionSourcePolicy(ctx))
  app.use((req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/api/webhooks/tiktok') return next()
    if (req.get('X-Requested-With') !== 'DramaVerseJP') return next(new ApiError(403, 'CSRF_REJECTED', '缺少合法的写入请求标记'))
    const origin = req.get('Origin')
    if (!origin || !config.allowedOrigins.includes(origin)) return next(new ApiError(403, 'ORIGIN_REJECTED', '请求来源不被允许'))
    if (req.get('Sec-Fetch-Site') === 'cross-site' && config.cookieSameSite !== 'none' && !allowMinisCrossSiteWrite(ctx, req))
      return next(new ApiError(403, 'ORIGIN_REJECTED', '不允许跨站写入'))
    next()
  })
  const authLimit = limitRequests(30, 60000)
  app.use('/api/auth', (req, res, next) => req.method === 'POST' && req.path !== '/logout' ? authLimit(req, res, next) : next())
  const json = express.json({ limit: '1mb', strict: true }), statisticsJson = express.json({ limit: '64kb', strict: true })
  // Commerce owns raw-body signature verification; do not consume its body first.
  app.use('/api/webhooks/tiktok', express.raw({ type: 'application/json', limit: '256kb' }))
  app.use((req, res, next) => req.path === '/api/webhooks/tiktok' ? next()
    : req.path === '/api/analytics/events' ? statisticsJson(req, res, next) : json(req, res, next))
  const router = express.Router()
  registerAuth(router, ctx); registerContent(router, ctx); registerMedia(router, ctx); registerLibrary(router, ctx)
  registerWebPlayback(router, ctx)
  registerPlatformMedia(router, ctx)
  registerCloudUploads(router, ctx)
  registerMediaExports(router, ctx)
  registerMediaRegistration(router, ctx)
  registerMediaDelivery(router, ctx)
  registerContentOperations(router, ctx)
  registerDeliveryEfficiency(router, ctx)
  registerAnalytics(router, ctx)
  registerPreviewCatalog(router, ctx)
  app.use(router)
  const commerceRouter = express.Router()
  registerCommerce(commerceRouter, ctx)
  app.use('/api', commerceRouter)
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', '接口不存在')))
  registerLegalPages(app)
  const adminDist = join(projectDir, 'dist-admin'), serviceDist = join(projectDir, 'dist-service')
  app.use('/admin', express.static(adminDist, { dotfiles: 'deny', index: 'index.html' }))
  app.get(['/admin', '/admin/*'], (_req, res, next) => existsSync(join(adminDist, 'index.html')) ? res.sendFile(join(adminDist, 'index.html')) : next())
  app.use(express.static(serviceDist, { dotfiles: 'deny', index: 'index.html' }))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/admin') || req.path.split('/').some(p => p.startsWith('.')) || !existsSync(join(serviceDist, 'index.html'))) return next()
    res.sendFile(join(serviceDist, 'index.html'))
  })
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', '页面不存在')))
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) return next(error)
    let failure: ApiError
    if (error instanceof ApiError) failure = error
    else if (error instanceof multer.MulterError) failure = new ApiError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, error.code, error.code === 'LIMIT_FILE_SIZE' ? '上传文件超过大小限制' : '上传只接受一个file文件，不接受其他字段')
    else if ((error as { type?: string })?.type === 'entity.too.large') failure = new ApiError(413, 'BODY_TOO_LARGE', _req.path === '/api/webhooks/tiktok' ? '回调请求不能超过256KB' : 'JSON请求不能超过1MB')
    else if ((error as { type?: string })?.type === 'entity.parse.failed' || error instanceof SyntaxError) failure = new ApiError(400, 'INVALID_JSON', 'JSON格式错误')
    else if (error instanceof Error && /multipart|Unexpected end of form/i.test(error.message)) failure = new ApiError(400, 'INVALID_MULTIPART', '上传表单不完整')
    else failure = new ApiError(500, 'INTERNAL_ERROR', '服务暂时不可用')
    // Range responses may already have media metadata but must still return JSON errors.
    res.removeHeader('Content-Length'); res.removeHeader('Content-Type')
    res.status(failure.status).json({ error: { code: failure.code, message: failure.message } })
  }
  app.use(errors)
  let closed = false
  return { app, ctx, close() { if (!closed) { closed = true; ctx.analytics?.destroy(); db.close() } } }
}
