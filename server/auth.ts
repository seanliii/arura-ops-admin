import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { CookieOptions, Request, Response, Router } from 'express'
import type { User, SessionInfo } from '../shared/contracts.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { activeEntitlements } from './commerce.js'
import { exchangeTikTokCode, storePlatformTokens } from './platform.js'
import { transaction } from './db.js'
import { readSubscriptionAccess } from './subscription-access.js'
import { body, text } from './validation.js'
import { sessionCookie, tokenHash, resolveSession, hasBearerHeader, isMinisBootstrap, issueMinisSession } from './session-transport.js'

export { sessionCookie, tokenHash, requestSessionHash } from './session-transport.js'
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (e, key) => e ? reject(e) : resolve(key)))
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await derive(password, salt)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}
export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  const parts = (hash || '').split('$')
  const valid = parts[0] === 'scrypt' && /^[a-f0-9]{32}$/.test(parts[1] || '') && /^[a-f0-9]{128}$/.test(parts[2] || '')
  // Even nonexistent accounts do the same expensive work, reducing identity probing.
  const salt = valid ? Buffer.from(parts[1], 'hex') : Buffer.alloc(16)
  const result = await derive(password, salt)
  return valid && timingSafeEqual(result, Buffer.from(parts[2], 'hex'))
}
export function publicUser(row: Record<string, unknown>): User {
  return { id: String(row.id), email: row.email === null ? null : String(row.email), nickname: String(row.nickname), role: row.role as User['role'], provider: row.provider as User['provider'], createdAt: Number(row.created_at) }
}
export function currentUser(ctx: Pick<AppContext, 'db' | 'config'>, req: Request): User | null {
  const session = resolveSession(ctx, req)
  return session ? publicUser(session.user) : null
}
export function sessionInfo(ctx: AppContext, req: Request): SessionInfo {
  return infoFor(ctx, ctx.user(req))
}
function infoFor(ctx: AppContext, user: User | null): SessionInfo {
  const entitlements = user ? activeEntitlements(ctx, user.id) : []
  const vip = entitlements.filter(e => e.kind === 'vip' && e.expiresAt !== null).map(e => e.expiresAt!)
  return { user, entitlements, vipExpiresAt: vip.length ? Math.max(...vip) : null,
    ...(user?.provider === 'tiktok' && ctx.config.subscription
      ? { subscriptionAccess: readSubscriptionAccess(ctx, user.id) } : {}) }
}
function sessionCookieOptions(ctx: AppContext): CookieOptions {
  return { httpOnly: true, secure: ctx.config.cookieSecure, sameSite: ctx.config.cookieSameSite ?? 'strict', path: ctx.config.sessionCookiePath ?? '/' }
}
function setSession(ctx: AppContext, req: Request, res: Response, userId: string): void {
  const now = Date.now(), token = randomBytes(32).toString('hex')
  const maxAge = ctx.config.sessionHours * 3600000
  transaction(ctx.db, () => {
    ctx.db.prepare('DELETE FROM sessions WHERE token_hash=? OR expires_at<=?').run(ctx.sessionHash(req), now)
    ctx.db.prepare('DELETE FROM playback_grants WHERE expires_at<=?').run(now)
    ctx.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(tokenHash(token), userId, now + maxAge, now)
    ctx.db.prepare("INSERT INTO session_transports(token_hash,transport) VALUES(?,'cookie')").run(tokenHash(token))
  })
  res.cookie(ctx.config.sessionCookieName ?? sessionCookie, token, { ...sessionCookieOptions(ctx), maxAge })
}
function email(value: unknown): string {
  const result = text(value, 'email', 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new ApiError(400, 'INVALID_EMAIL', '邮箱格式错误')
  return result
}
function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 256) throw new ApiError(400, 'INVALID_PASSWORD', '密码长度需为10至256个字符')
  return value
}
export function registerAuth(router: Router, ctx: AppContext): void {
  router.get('/api/auth/me', (req, res) => res.json(sessionInfo(ctx, req)))
  router.post('/api/auth/register', asyncRoute(async (req, res) => {
    if (ctx.config.mode !== 'local') throw new ApiError(403, 'REGISTRATION_DISABLED', '此环境仅使用TikTok用户身份，不开放本地注册')
    const input = body(req.body), address = email(input.email), pass = password(input.password)
    const nickname = input.nickname === undefined ? address.split('@')[0] : text(input.nickname, 'nickname', 80)
    const hash = await hashPassword(pass), userId = randomUUID(), now = Date.now()
    transaction(ctx.db, () => {
      if (ctx.db.prepare('SELECT id FROM users WHERE email=?').get(address)) throw new ApiError(409, 'EMAIL_EXISTS', '邮箱已注册')
      ctx.db.prepare("INSERT INTO users(id,email,password_hash,nickname,role,provider,created_at) VALUES(?,?,?,?,'user','local',?)").run(userId, address, hash, nickname, now)
      ctx.audit(userId, 'user.register', 'user', userId)
    })
    setSession(ctx, req, res, userId)
    res.status(201).json(infoFor(ctx, publicUser(ctx.db.prepare('SELECT * FROM users WHERE id=?').get(userId)!)))
  }))
  router.post('/api/auth/login', asyncRoute(async (req, res) => {
    const input = body(req.body), address = email(input.email)
    if (typeof input.password !== 'string' || input.password.length > 256) throw new ApiError(400, 'INVALID_PASSWORD', '密码格式错误')
    const row = ctx.db.prepare("SELECT * FROM users WHERE email=? AND provider='local'").get(address)
    const verified = await verifyPassword(input.password, row ? row.password_hash as string | null : null)
    if (!verified || !row || row.disabled || (ctx.config.mode !== 'local' && row.role !== 'admin')) throw new ApiError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确，或账户不可用')
    // Re-read after the asynchronous KDF: concurrent password changes/disable must win.
    const fresh = ctx.db.prepare('SELECT * FROM users WHERE id=? AND disabled=0 AND password_hash=?').get(String(row.id), String(row.password_hash))
    if (!fresh) throw new ApiError(401, 'INVALID_CREDENTIALS', '账户状态已变化，请重试')
    setSession(ctx, req, res, String(fresh.id)); ctx.audit(String(fresh.id), 'user.login', 'user', String(fresh.id))
    res.json(infoFor(ctx, publicUser(fresh)))
  }))
  router.post('/api/auth/logout', (req, res) => {
    const hash = ctx.sessionHash(req)
    transaction(ctx.db, () => { ctx.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash); ctx.db.prepare('DELETE FROM playback_grants WHERE session_hash=?').run(hash) })
    if (!hasBearerHeader(req)) res.clearCookie(ctx.config.sessionCookieName ?? sessionCookie, sessionCookieOptions(ctx))
    res.json({ ok: true })
  })
  router.post('/api/auth/password', asyncRoute(async (req, res) => {
    const user = ctx.requireUser(req), input = body(req.body)
    const next = password(input.newPassword)
    if (typeof input.oldPassword !== 'string' || input.oldPassword.length > 256) throw new ApiError(400, 'INVALID_PASSWORD', '原密码格式错误')
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id)!
    if (user.provider !== 'local' || !await verifyPassword(input.oldPassword, row.password_hash as string | null)) throw new ApiError(401, 'INVALID_CREDENTIALS', '原密码错误')
    const hash = await hashPassword(next)
    transaction(ctx.db, () => {
      if (!ctx.user(req)) throw new ApiError(401, 'UNAUTHENTICATED', '会话已失效')
      const result = ctx.db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?').run(hash, user.id, row.password_hash)
      if (!result.changes) throw new ApiError(409, 'PASSWORD_CHANGED', '密码已被其他会话修改')
      ctx.db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id, ctx.sessionHash(req))
      ctx.db.prepare('DELETE FROM playback_grants WHERE user_id=? AND session_hash<>?').run(user.id, ctx.sessionHash(req))
      ctx.audit(user.id, 'user.password', 'user', user.id)
    })
    res.json({ ok: true })
  }))
  router.post('/api/auth/tiktok', asyncRoute(async (req, res) => {
    if (!isMinisBootstrap(req)) throw new ApiError(400, 'MINIS_BOOTSTRAP_REQUIRED', 'TikTok登录必须显式使用无Cookie的业务Bearer引导')
    const origin = req.headers.origin
    if (!ctx.config.tiktokClientKey || !ctx.config.tiktokClientSecret) throw new ApiError(503, 'PLATFORM_UNCONFIGURED', 'TikTok登录尚未配置')
    if (!ctx.config.tokenEncryptionKey) throw new ApiError(503, 'TOKEN_ENCRYPTION_UNCONFIGURED', '平台登录凭据的安全存储尚未配置')
    const code = text(body(req.body).code, 'code', 4096)
    const identity = await exchangeTikTokCode(code, ctx.config)
    if (!identity.openId || !identity.accessToken) throw new ApiError(502, 'PLATFORM_RESPONSE_INVALID', '平台未返回有效身份')
    const providerId = `${ctx.config.tiktokClientKey}:${identity.openId}`
    const user = transaction(ctx.db, () => {
      let row = ctx.db.prepare("SELECT * FROM users WHERE provider='tiktok' AND provider_id=?").get(providerId)
      if (!row) {
        const userId = randomUUID()
        ctx.db.prepare("INSERT INTO users(id,nickname,role,provider,provider_id,created_at) VALUES(?,'TikTokユーザー','user','tiktok',?,?)").run(userId, providerId, Date.now())
        row = ctx.db.prepare('SELECT * FROM users WHERE id=?').get(userId)!
      }
      if (row.disabled) throw new ApiError(403, 'ACCOUNT_DISABLED', '账户已停用')
      if (row.role !== 'user') throw new ApiError(403, 'USER_ACCOUNT_REQUIRED', '此登录仅用于TikTok普通用户')
      storePlatformTokens(ctx, String(row.id), identity)
      return publicUser(row)
    })
    const businessSession = issueMinisSession(ctx, user.id, origin)
    res.json({ ...infoFor(ctx, user), businessSession })
  }))
}
