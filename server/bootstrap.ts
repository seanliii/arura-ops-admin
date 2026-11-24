import { randomBytes, randomUUID } from 'node:crypto'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { hashPassword, publicUser } from './auth.js'
import { transaction } from './db.js'
import { ApiError, type AppContext } from './types.js'
import type { User } from '../shared/contracts.js'

/**
 * Explicit provisioning entry point for trusted server/test launchers.
 * No environment reads, credential files, logging, listeners or implicit resets.
 * Existing ordinary/disabled/provider accounts are never promoted or reactivated.
 */
export async function ensureAdmin(ctx: AppContext, email: string, password: string): Promise<User> {
  if (typeof email !== 'string' || email.trim().length > 254 || /[\u0000-\u001f\u007f]/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new ApiError(400, 'INVALID_EMAIL', '管理员邮箱格式错误')
  }
  if (typeof password !== 'string' || password.length < 10 || password.length > 256) {
    throw new ApiError(400, 'INVALID_PASSWORD', '管理员密码长度需为10至256个字符')
  }
  const address = email.trim().toLowerCase()
  const existingAdmin = (): User | null => {
    const row = ctx.db.prepare('SELECT * FROM users WHERE email=?').get(address)
    if (!row) return null
    if (row.role !== 'admin' || row.provider !== 'local' || !row.password_hash) {
      throw new ApiError(409, 'ADMIN_EMAIL_CONFLICT', '该邮箱已被其他账户使用，不能自动提权')
    }
    if (row.disabled) throw new ApiError(403, 'ACCOUNT_DISABLED', '管理员账户已停用，不能自动重新启用')
    return publicUser(row)
  }
  const existing = existingAdmin()
  if (existing) return existing
  const hash = await hashPassword(password)
  return transaction(ctx.db, () => {
    // The asynchronous KDF allows another caller to create this email first.
    const concurrent = existingAdmin()
    if (concurrent) return concurrent
    const userId = randomUUID()
    ctx.db.prepare("INSERT INTO users(id,email,password_hash,nickname,role,provider,created_at) VALUES(?,?,?,'管理者','admin','local',?)")
      .run(userId, address, hash, Date.now())
    ctx.audit(null, 'admin.ensure', 'user', userId)
    return publicUser(ctx.db.prepare('SELECT * FROM users WHERE id=?').get(userId)!)
  })
}

/** Called explicitly by the executable, never as an import-time side effect. */
export async function bootstrap(ctx: AppContext): Promise<void> {
  if (ctx.db.prepare("SELECT id FROM users WHERE role='admin'").get()) return
  const configuredEmail = process.env.DRAMA_ADMIN_EMAIL?.trim().toLowerCase()
  const configuredPassword = process.env.DRAMA_ADMIN_PASSWORD
  if (Boolean(configuredEmail) !== Boolean(configuredPassword)) throw new Error('DRAMA_ADMIN_EMAIL与DRAMA_ADMIN_PASSWORD必须同时设置')
  if (ctx.config.mode !== 'local' && (!configuredEmail || !configuredPassword)) throw new Error('首次平台环境启动必须显式提供管理员环境凭据')
  if (configuredEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configuredEmail)) throw new Error('管理员邮箱格式错误')
  if (configuredPassword && (configuredPassword.length < 10 || configuredPassword.length > 256)) throw new Error('管理员密码长度需为10至256个字符')
  const email = configuredEmail || `admin-${randomBytes(6).toString('hex')}@local.invalid`
  const password = configuredPassword || randomBytes(24).toString('base64url')
  const hash = await hashPassword(password), userId = randomUUID()
  // Check again after the KDF so two starts cannot create two initial accounts.
  if (ctx.db.prepare("SELECT id FROM users WHERE role='admin'").get()) return
  const file = join(ctx.config.dataDir, 'admin-credentials.txt')
  let wroteFile = false
  if (!configuredPassword) {
    await writeFile(file, `email=${email}\npassword=${password}\n`, { flag: 'wx', mode: 0o600 })
    wroteFile = true
  }
  try {
    transaction(ctx.db, () => {
      if (ctx.db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw new Error('管理员邮箱已被普通账户使用，不能自动提权')
      ctx.db.prepare("INSERT INTO users(id,email,password_hash,nickname,role,provider,created_at) VALUES(?,?,?,'管理者','admin','local',?)").run(userId, email, hash, Date.now())
      ctx.audit(null, 'admin.bootstrap', 'user', userId, { generated: !configuredPassword })
    })
  } catch (e) { if (wroteFile) await unlink(file).catch(() => {}); throw e }
  if (wroteFile) console.info(file)
}
