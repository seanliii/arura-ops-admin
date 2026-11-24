import { createHash, randomBytes } from 'node:crypto'
import type { Request, RequestHandler } from 'express'
import { ApiError, type AppContext } from './types.js'
import { transaction } from './db.js'
import { MINIS_TRANSPORT, MINIS_SESSION_TTL_MS, type BusinessSession } from '../shared/session-transport.js'

export const sessionCookie = 'drama_session'
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
type Context = Pick<AppContext, 'db' | 'config'>
type Credential = { kind: 'cookie' | 'minis-bearer'; hash: string } | { kind: 'none' | 'invalid' | 'conflict' }

export function requestPath(req: Request): string {
  return (req.originalUrl || req.url || req.path || '/').split('?')[0].replace(/\/+$/, '').toLowerCase()
}
export function cookieOnlyPath(path: string): boolean {
  return path === '/api/admin' || path.startsWith('/api/admin/') ||
    ['/api/auth/login', '/api/auth/register', '/api/auth/password'].includes(path)
}
export function hasBearerHeader(req: Request): boolean { return req.headers.authorization !== undefined }
export function isMinisBootstrap(req: Request): boolean {
  return req.method === 'POST' && requestPath(req) === '/api/auth/tiktok' &&
    req.headers['x-session-transport'] === MINIS_TRANSPORT &&
    req.headers.cookie === undefined && !hasBearerHeader(req)
}
function credential(req: Request, cookieName: string): Credential {
  if (hasBearerHeader(req)) {
    if (req.headers.cookie !== undefined) return { kind: 'conflict' }
    const value = req.headers.authorization
    const match = typeof value === 'string' && /^Bearer ([a-f0-9]{64})$/i.exec(value)
    return match && /^[a-f0-9]{64}$/.test(match[1])
      ? { kind: MINIS_TRANSPORT, hash: tokenHash(match[1]) } : { kind: 'invalid' }
  }
  const cookies = (req.headers.cookie || '').split(';').map(s => s.trim())
    .filter(s => s.startsWith(`${cookieName}=`))
  if (cookies.length !== 1) return { kind: 'none' }
  const value = cookies[0].slice(cookieName.length + 1)
  return /^[a-f0-9]{64}$/.test(value) ? { kind: 'cookie', hash: tokenHash(value) } : { kind: 'none' }
}

function allowedOrigin(ctx: Context, value: unknown): string | null {
  if (typeof value !== 'string' || !ctx.config.allowedOrigins.includes(value)) return null
  try { return new URL(value).origin === value ? value : null } catch { return null }
}

/** Origin一旦存在就不使用补充判断；空值、null、错误值均不能被metadata覆盖。 */
function bearerRequestOrigin(ctx: Context, req: Request): string | null {
  if (req.headers.origin !== undefined) return allowedOrigin(ctx, req.headers.origin)
  if (!['GET', 'HEAD'].includes(req.method) || req.headers['sec-fetch-site'] !== 'same-origin' ||
    !['cors', 'same-origin'].includes(String(req.headers['sec-fetch-mode'])) ||
    req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined) return null
  try {
    // 与Express的protocol/hostname getter使用同一个可信代理函数。
    // hostname会丢端口，故仅在同一信任判断通过后取XFHost完整authority。
    const trust = req.app?.get('trust proxy fn')
    const peer = req.socket?.remoteAddress
    const trusted = typeof trust === 'function' && typeof peer === 'string' && trust(peer, 0)
    const forwarded = req.headers['x-forwarded-host']
    const authority = trusted && forwarded !== undefined
      ? typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null
      : req.headers.host
    if (typeof authority !== 'string' || !authority || /[\s/\\@?#,]/.test(authority)) return null
    // req.protocol只在现有trust proxy配置认可socket时使用X-Forwarded-Proto。
    const protocol = req.protocol?.toLowerCase()
    if (protocol !== 'https' && protocol !== 'http') return null
    const url = new URL(`${protocol}://${authority}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return allowedOrigin(ctx, url.origin)
  } catch { return null }
}

/** 只查有效凭据；来源匹配由下方同一规则执行。不将旧未绑定Bearer认领给首次来访者。 */
function activeSession(ctx: Context, req: Request) {
  const source = credential(req, ctx.config.sessionCookieName ?? sessionCookie)
  if (!('hash' in source)) return null
  const row = ctx.db.prepare(`SELECT u.*,s.token_hash AS session_hash,
      COALESCE(t.transport,'cookie') AS session_transport,o.origin AS session_origin
    FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN session_transports t ON t.token_hash=s.token_hash
    LEFT JOIN session_origins o ON o.token_hash=s.token_hash
    WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0`).get(source.hash, Date.now())
  if (!row || row.session_transport !== source.kind) return null
  if (source.kind === MINIS_TRANSPORT && (row.provider !== 'tiktok' || row.role !== 'user' ||
    typeof row.session_origin !== 'string' || !row.session_origin)) return null
  if (ctx.config.mode !== 'local' && row.provider === 'local' && row.role !== 'admin') return null
  return { hash: source.hash, transport: source.kind, origin: row.session_origin, user: row }
}

/** 每次重新查数据库与来源；供媒体等异步操作二次检查，不能缓存旧身份或旧绑定。 */
export function resolveSession(ctx: Context, req: Request) {
  const session = activeSession(ctx, req)
  if (!session) return null
  if (session.transport === MINIS_TRANSPORT) {
    const origin = bearerRequestOrigin(ctx, req)
    return origin && origin === session.origin ? session : null
  }
  // Cookie旧路径不增加Fetch Metadata要求。
  return req.headers.origin !== undefined && !allowedOrigin(ctx, req.headers.origin) ? null : session
}
export function requestSessionHash(ctx: Context, req: Request): string | null {
  return resolveSession(ctx, req)?.hash ?? null
}
export function allowMinisCrossSiteWrite(ctx: Context, req: Request): boolean {
  if (isMinisBootstrap(req)) return true
  return !cookieOnlyPath(requestPath(req)) && resolveSession(ctx, req)?.transport === MINIS_TRANSPORT
}
export function sessionSourcePolicy(ctx: Context): RequestHandler {
  return (req, _res, next) => {
    if (req.method === 'OPTIONS' || requestPath(req) === '/api/webhooks/tiktok') return next()
    const marker = req.headers['x-session-transport']
    if (marker !== undefined) {
      if (req.headers.cookie !== undefined || hasBearerHeader(req))
        return next(new ApiError(400, 'SESSION_CREDENTIAL_CONFLICT', '登录引导不得携带Cookie或Authorization'))
      if (!isMinisBootstrap(req))
        return next(new ApiError(400, 'INVALID_SESSION_TRANSPORT', '会话传输标记仅用于TikTok登录引导'))
      if (!allowedOrigin(ctx, req.headers.origin))
        return next(new ApiError(403, 'ORIGIN_REJECTED', '请求来源不被允许'))
    }
    if (hasBearerHeader(req)) {
      if (req.headers.cookie !== undefined)
        return next(new ApiError(400, 'SESSION_CREDENTIAL_CONFLICT', 'Cookie与Authorization不得同时使用'))
      const origin = bearerRequestOrigin(ctx, req)
      if (!origin)
        return next(new ApiError(403, 'ORIGIN_REJECTED', '请求来源不被允许'))
      const session = activeSession(ctx, req)
      if (!session)
        return next(new ApiError(401, 'UNAUTHENTICATED', '业务会话无效或已过期'))
      if (session.origin !== origin)
        return next(new ApiError(403, 'ORIGIN_REJECTED', '请求来源与会话绑定来源不一致'))
      if (cookieOnlyPath(requestPath(req)))
        return next(new ApiError(403, 'COOKIE_SESSION_REQUIRED', '此接口仅接受Cookie会话'))
    }
    next()
  }
}

/** 与sessions原子写入标记，不能出现短暂的“无标记Bearer被视作旧Cookie”。 */
export function issueMinisSession(ctx: Context, userId: string, origin: string | undefined): BusinessSession {
  const boundOrigin = allowedOrigin(ctx, origin)
  if (!boundOrigin) throw new ApiError(403, 'ORIGIN_REJECTED', '登录来源不被允许')
  const token = randomBytes(32).toString('hex'), now = Date.now(), expiresAt = now + MINIS_SESSION_TTL_MS
  transaction(ctx.db, () => {
    ctx.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now)
    ctx.db.prepare('DELETE FROM playback_grants WHERE expires_at<=?').run(now)
    ctx.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
      .run(tokenHash(token), userId, expiresAt, now)
    ctx.db.prepare('INSERT INTO session_transports(token_hash,transport) VALUES(?,?)').run(tokenHash(token), MINIS_TRANSPORT)
    ctx.db.prepare('INSERT INTO session_origins(token_hash,origin) VALUES(?,?)').run(tokenHash(token), boundOrigin)
  })
  return { token, tokenType: 'Bearer', expiresAt }
}
