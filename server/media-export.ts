import { createHash, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { basename, join, resolve } from 'node:path'
import type { Request, Response, Router } from 'express'
import { transaction } from './db.js'
import { privateAssetPath } from './media.js'
import { jpegImageEnd } from './jpeg-container.js'
import { ApiError, type AppContext } from './types.js'

type Row = Record<string, unknown>
type CoverInput = { assetId: string; dramaId: number; localVersion: number; ownerId: string }
const TTL = 15 * 60 * 1000
const MAX_BYTES = 5 * 1024 * 1024
const tokenPattern = /^[a-f0-9]{64}$/
const missing = () => new ApiError(404, 'NOT_FOUND', '资源不存在')
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
// 绑定整条资产记录，而非只绑定 id；路径、所有者、大小或摘要改变都须重新签发。
const fingerprint = (row: Row) => digest(JSON.stringify(row))

// 与官方 client 的 fileURL 保持同样的非公共地址范围。这里不下载或探测远端文件；
// 工作流交给 createImage 时仍须经过该 client 自身的 DNS 检查。
const nonPublic = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublic.addSubnet(address, prefix, 'ipv4')
nonPublic.addAddress('168.63.129.16', 'ipv4')
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20],
] as const) nonPublic.addSubnet(address, prefix, 'ipv6')
const globalIPv6 = new BlockList()
globalIPv6.addSubnet('2000::', 3, 'ipv6')
function publicAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !nonPublic.check(address, 'ipv4')
    : family === 6 && globalIPv6.check(address, 'ipv6') && !nonPublic.check(address, 'ipv6')
}
async function checkOrigin(source: string): Promise<void> {
  if (typeof source !== 'string' || source.length > 2048) throw missing()
  const url = new URL(source), hostname = url.hostname
  if (url.protocol !== 'https:' || source !== url.origin || url.username || url.password ||
    isIP(hostname.replace(/^\[|\]$/g, '')) || hostname.length > 253 || !hostname.includes('.') ||
    !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw missing()
  const localNames = ['localhost', 'local', 'internal', 'localdomain', 'lan', 'home', 'home.arpa', 'test', 'invalid', 'example', 'onion']
  if (localNames.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))) throw missing()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(missing()), 5000) }),
    ])
    if (!addresses.length || addresses.some(item => isIP(item.address) !== item.family || !publicAddress(item.address))) throw missing()
  } finally { clearTimeout(timer) }
}
function target(input: CoverInput): CoverInput {
  if (!input || typeof input.assetId !== 'string' || !input.assetId || input.assetId.length > 128 ||
    typeof input.ownerId !== 'string' || !input.ownerId || input.ownerId.length > 128 ||
    !Number.isSafeInteger(input.dramaId) || input.dramaId <= 0 ||
    !Number.isSafeInteger(input.localVersion) || input.localVersion <= 0) throw missing()
  // 异步期间不能被调用方修改 input 对象而切换目标。
  return { assetId: input.assetId, dramaId: input.dramaId, localVersion: input.localVersion, ownerId: input.ownerId }
}
function coverRow(ctx: AppContext, input: CoverInput, requireLogin: boolean): Row {
  const row = ctx.db.prepare(`SELECT a.* FROM assets a
    JOIN dramas d ON d.id=? AND d.cover_asset_id=a.id
    JOIN users u ON u.id=? AND u.role='admin' AND u.disabled=0
    WHERE a.id=? AND a.kind='cover' AND a.mime IN ('image/png','image/jpeg','image/webp')
      AND a.bytes BETWEEN 1 AND ${MAX_BYTES}
      AND d.status IN ('draft','archived') AND d.rights_confirmed=1 AND d.version=?
      AND (?=0 OR EXISTS (
        SELECT 1 FROM sessions s LEFT JOIN session_transports t ON t.token_hash=s.token_hash
        WHERE s.user_id=u.id AND s.expires_at>? AND COALESCE(t.transport,'cookie')='cookie'
      ))`).get(input.dramaId, input.ownerId, input.assetId, input.localVersion, Number(requireLogin), Date.now())
  if (!row || !Number.isSafeInteger(row.bytes) || typeof row.sha256 !== 'string' ||
    !tokenPattern.test(row.sha256) || typeof row.storage_path !== 'string') throw missing()
  return row
}

function webpChunks(bytes: Buffer, offset: number, end: number, framesAllowed: boolean): boolean {
  let imageData = false, animated = false, animationHeader = false
  while (offset + 8 <= end) {
    const kind = bytes.toString('latin1', offset, offset + 4), size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size + (size % 2) > end) return false
    if (kind === 'VP8 ') {
      if (size < 10 || (bytes[start] & 1) !== 0 ||
        bytes.toString('hex', start + 3, start + 6) !== '9d012a' ||
        !(bytes.readUInt16LE(start + 6) & 0x3fff) || !(bytes.readUInt16LE(start + 8) & 0x3fff)) return false
      imageData = true
    } else if (kind === 'VP8L') {
      if (size < 5 || bytes[start] !== 0x2f || (bytes[start + 4] & 0xe0) !== 0) return false
      imageData = true
    } else if (kind === 'VP8X') {
      if (!framesAllowed || offset !== 12 || size !== 10) return false
      animated = Boolean(bytes[start] & 2)
    } else if (kind === 'ANIM') {
      if (!animated || size !== 6) return false
      animationHeader = true
    } else if (kind === 'ANMF') {
      // 只展开一层动画帧，不递归接受嵌套 ANMF，且每一帧都要含真实图片块。
      if (!framesAllowed || !animationHeader || size <= 16 ||
        !webpChunks(bytes, start + 16, start + size, false)) return false
      imageData = true
    }
    offset = start + size + (size % 2)
  }
  return imageData && offset === end
}

/** 验证图片容器而非信任扩展名/数据库 MIME；不解码像素，也不执行元数据。 */
function imageMime(bytes: Buffer): string {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    let offset = 8, imageData = false
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), kind = bytes.toString('latin1', offset + 4, offset + 8)
      if (offset + size + 12 > bytes.length) break
      if (offset === 8 && (kind !== 'IHDR' || size !== 13 || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20))) break
      if (kind === 'IDAT' && size > 0) imageData = true
      offset += size + 12
      if (kind === 'IEND') {
        if (size === 0 && imageData && offset === bytes.length) return 'image/png'
        break
      }
    }
  }
  if (jpegImageEnd(bytes) === bytes.length) return 'image/jpeg'
  if (bytes.length >= 20 && bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString('latin1', 8, 12) === 'WEBP' &&
    webpChunks(bytes, 12, bytes.length, true)) return 'image/webp'
  throw missing()
}
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
const directory = (info: Stats) => info.isDirectory() && !info.isSymbolicLink()

async function readCover(ctx: AppContext, row: Row): Promise<Buffer> {
  const stored = String(row.storage_path), bytes = Number(row.bytes)
  if (stored !== resolve(stored)) throw missing()
  const path = await privateAssetPath(ctx, row)
  const dataDir = resolve(ctx.config.dataDir), root = join(dataDir, 'uploads')
  const [dataBefore, rootBefore, canonicalRoot] = await Promise.all([lstat(dataDir), lstat(root), realpath(root)])
  if (!directory(dataBefore) || !directory(rootBefore)) throw missing()
  // 不重新按文件名开流：无跟随链接地打开一次，读同一个文件描述符并核对内容。
  // NONBLOCK 防止检查之后被换成 FIFO，额外一字节用于检测读取途中变大的文件。
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size !== bytes) throw missing()
    const buffer = Buffer.alloc(bytes + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null)
      if (!bytesRead) break
      used += bytesRead
    }
    const [after, fileAfter, rootAfter, dataAfter, canonicalAfter] = await Promise.all([
      handle.stat(), lstat(path), lstat(root), lstat(dataDir), realpath(path),
    ])
    if (used !== bytes || after.size !== bytes || !sameFile(before, after) || !sameFile(after, fileAfter) ||
      !fileAfter.isFile() || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      !directory(rootAfter) || !directory(dataAfter) || !sameFile(rootBefore, rootAfter) || !sameFile(dataBefore, dataAfter) ||
      canonicalAfter !== join(canonicalRoot, basename(path))) throw missing()
    const content = buffer.subarray(0, bytes)
    if (digest(content) !== row.sha256 || imageMime(content) !== row.mime) throw missing()
    return content
  } finally { await handle.close() }
}

// Internal content-release reuse. These functions do not create a public export grant.
export { imageMime as previewCoverMime, readCover as readPreviewCover }

function activeGrant(ctx: AppContext, hash: string): { grant: Row; asset: Row } {
  const now = Date.now()
  const grant = ctx.db.prepare(`SELECT * FROM media_export_grants
    WHERE token_hash=? AND created_at<=? AND expires_at>? AND expires_at<=created_at+?`).get(hash, now, now, TTL)
  if (!grant) throw missing()
  const asset = coverRow(ctx, target({
    assetId: String(grant.asset_id), dramaId: Number(grant.drama_id),
    localVersion: Number(grant.local_version), ownerId: String(grant.owner_id),
  }), false)
  if (fingerprint(asset) !== grant.asset_fingerprint) throw missing()
  return { grant, asset }
}
function replyMissing(res: Response): void {
  if (res.headersSent) { res.destroy(); return }
  res.removeHeader('Content-Length')
  res.removeHeader('Content-Type')
  res.set(responseHeaders).status(404).json({ error: { code: 'NOT_FOUND', message: '资源不存在' } })
}

/** 临时授权表须从备份/管理 DTO 排除；初始化只补建此表，不改既有资产策略。 */
export function registerMediaExports(router: Router, ctx: AppContext): void {
  ctx.db.exec(`CREATE TABLE IF NOT EXISTS media_export_grants (
    token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
    local_version INTEGER NOT NULL CHECK(local_version>0),
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset_fingerprint TEXT NOT NULL CHECK(length(asset_fingerprint)=64),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS media_export_grants_expiry ON media_export_grants(expires_at);`)
  const serve = async (req: Request, res: Response): Promise<void> => {
    res.set(responseHeaders)
    try {
      const token = String(req.params.token)
      if (!tokenPattern.test(token) || req.path !== `/api/media-export/${token}` || Object.keys(req.query).length) throw missing()
      const hash = digest(token), { grant, asset } = activeGrant(ctx, hash)
      const content = await readCover(ctx, asset)
      // 含 close() 在内的全部异步操作之后重查；此后到发送字节之间不再 await。
      const fresh = activeGrant(ctx, hash)
      if (JSON.stringify(fresh.grant) !== JSON.stringify(grant)) throw missing()
      res.set({
        'Content-Type': String(asset.mime), 'Content-Length': String(content.length),
        'Cross-Origin-Resource-Policy': 'cross-origin',
      })
      // 不使用 send()/sendFile()，避免自动 ETag、条件 304 或按路径重新打开文件。
      res.status(200).end(req.method === 'HEAD' ? undefined : content)
    } catch { replyMissing(res) }
  }
  // 先约束原始路由参数，避免 Express 在进入处理器前解码恶意百分号并泄漏 400。
  router.get('/api/media-export/:token([a-f0-9]{64})', serve)
  router.head('/api/media-export/:token([a-f0-9]{64})', serve)
  router.use('/api/media-export', (_req, res) => {
    replyMissing(res)
  })
}

// 单独构造撤销函数，使闭包只持有 ctx/hash，不持有明文令牌或整条 URL。
function revoker(ctx: AppContext, hash: string): () => void {
  return () => {
    try { ctx.db.prepare('DELETE FROM media_export_grants WHERE token_hash=?').run(hash) }
    catch { throw missing() }
  }
}
/**
 * 仅供已鉴权的管理工作流调用，不提供签发 HTTP API。ownerId 必须来自 requireAdmin，
 * 并且签发前后仍有有效管理员 Cookie 会话；下载只复核账号状态，不要求 Cookie。
 * 调用方必须在平台用完或流程失败时 revoke，且不得把 url 放入 DTO、审计或日志。
 */
export async function issueCoverExport(
  ctx: AppContext, input: CoverInput, publicOrigin: string, delivery?: import('./media-actor.js').MediaActor,
): Promise<{ url: string; revoke: () => void }> {
  try {
    const selected = target(input)
    const authorize = () => {
      if (delivery) {
        if (delivery.kind !== 'delivery' || delivery.id !== selected.ownerId || delivery.dramaId !== selected.dramaId) throw missing()
        delivery.assertCurrent()
      }
    }
    authorize()
    const asset = coverRow(ctx, selected, !delivery), snapshot = fingerprint(asset)
    await checkOrigin(publicOrigin)
    await readCover(ctx, asset)
    return transaction(ctx.db, () => {
      authorize()
      if (fingerprint(coverRow(ctx, selected, !delivery)) !== snapshot) throw missing()
      const now = Date.now(), token = randomBytes(32).toString('hex'), hash = digest(token)
      ctx.db.prepare('DELETE FROM media_export_grants WHERE expires_at<=?').run(now)
      ctx.db.prepare(`INSERT INTO media_export_grants
        (token_hash,asset_id,drama_id,local_version,owner_id,asset_fingerprint,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(hash, selected.assetId, selected.dramaId, selected.localVersion, selected.ownerId, snapshot, now, now + TTL)
      return { url: `${publicOrigin}/api/media-export/${token}`, revoke: revoker(ctx, hash) }
    })
  } catch { throw missing() }
}
