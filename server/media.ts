import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, open, readFile, truncate, unlink } from 'node:fs/promises'
import { resolve, sep, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import multer from 'multer'
import type { Request, Response, Router } from 'express'
import type { Asset } from '../shared/contracts.js'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { tokenHash } from './auth.js'
import { hasEpisodeAccess } from './commerce.js'
import { transaction } from './db.js'
import { publicDramaCondition } from './content.js'
import { jpegImageEnd } from './jpeg-container.js'

export function assetDto(row: Record<string, unknown>): Asset {
  const kind = row.kind as Asset['kind']
  return { id: String(row.id), kind, originalName: String(row.original_name), mime: String(row.mime), bytes: Number(row.bytes), sha256: String(row.sha256), createdAt: Number(row.created_at), ...(kind === 'video' ? {} : { url: `/api/assets/${row.id}` }) }
}
export async function privateAssetPath(ctx: AppContext, row: Record<string, unknown>): Promise<string> {
  const root = resolve(ctx.config.dataDir, 'uploads') + sep
  const path = resolve(String(row.storage_path))
  if (!path.startsWith(root) || path.slice(root.length).includes(sep)) throw new ApiError(404, 'ASSET_UNAVAILABLE', '媒体文件不可用')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== Number(row.bytes)) throw new Error('invalid media')
  } catch { throw new ApiError(404, 'ASSET_UNAVAILABLE', '媒体文件不可用') }
  return path
}
async function detectType(path: string, kind: Asset['kind'], bytes: number): Promise<string> {
  const handle = await open(path, 'r')
  const head = Buffer.alloc(64)
  try { await handle.read(head, 0, head.length, 0) } finally { await handle.close() }
  if (kind === 'video' && bytes >= 16 && head.toString('ascii', 4, 8) === 'ftyp' && head.readUInt32BE(0) >= 16 && head.readUInt32BE(0) <= bytes) return 'video/mp4'
  if (kind === 'cover') {
    if (bytes >= 24 && head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && head.toString('ascii', 12, 16) === 'IHDR') return 'image/png'
    if (bytes >= 4 && head[0] === 255 && head[1] === 216 && head[2] === 255) return 'image/jpeg'
    if (bytes >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  }
  if (kind === 'subtitle') {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let prefix = ''
    try {
      for await (const chunk of createReadStream(path)) {
        const str = decoder.decode(chunk as Buffer, { stream: true })
        if (str.includes('\u0000')) throw new Error('NUL')
        if (prefix.length < 128) prefix += str.slice(0, 128 - prefix.length)
      }
      decoder.decode()
      if (/^WEBVTT(?:[ \t][^\r\n]*)?(?:\r?\n|$)/.test(prefix) && bytes >= 6) return 'text/vtt; charset=utf-8'
    } catch { /* invalid UTF-8 is rejected, not replaced */ }
  }
  throw new ApiError(415, 'UNSUPPORTED_MEDIA', '文件内容不是有效的MP4、PNG/JPEG/WebP或UTF-8 WEBVTT')
}
export async function streamFile(req: Request, res: Response, path: string, mime: string, bytes: number): Promise<void> {
  let start = 0, end = bytes - 1
  res.set({ 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    let valid = Boolean(match && (match[1] || match[2]))
    if (match && valid) {
      if (!match[1]) {
        const suffix = Number(match[2]); valid = Number.isSafeInteger(suffix) && suffix > 0
        start = Math.max(0, bytes - suffix)
      } else {
        start = Number(match[1]); end = match[2] ? Number(match[2]) : end
        valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end
        end = Math.min(end, bytes - 1)
      }
      valid = valid && start < bytes
    }
    if (!valid) { res.set('Content-Range', `bytes */${bytes}`); throw new ApiError(416, 'RANGE_NOT_SATISFIABLE', '请求的媒体范围无效') }
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${bytes}`)
  }
  res.set('Content-Length', String(end - start + 1))
  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(path, { start, end })
  try { await pipeline(stream, res) } catch (e) {
    if (!res.destroyed) throw e
  }
}
export function registerMedia(router: Router, ctx: AppContext): void {
  const storage: multer.StorageEngine = {
    _handleFile(_req, file, done) {
      const filename = randomUUID(), path = join(ctx.config.dataDir, 'uploads', filename)
      const hash = createHash('sha256')
      let bytes = 0
      file.stream.on('data', (chunk: Buffer) => { hash.update(chunk); bytes += chunk.length })
      const stream = createWriteStream(path, { flags: 'wx', mode: 0o600 })
      pipeline(file.stream, stream).then(() => {
        const info = { path, filename, size: bytes, destination: join(ctx.config.dataDir, 'uploads'), sha256: hash.digest('hex') }
        done(null, info)
      })
        .catch(async e => { await unlink(path).catch(() => {}); done(e) })
    },
    _removeFile(_req, file, done) { unlink(file.path).then(() => done(null)).catch(done) },
  }
  const upload = multer({ storage, limits: { fileSize: ctx.config.uploadMaxBytes, files: 1, fields: 0, parts: 2, fieldNameSize: 100 } }).single('file')
  router.post('/api/admin/assets', (req, _res, next) => {
    try {
      ctx.requireAdmin(req)
      if (!['video', 'cover', 'subtitle'].includes(String(req.query.kind))) throw new ApiError(400, 'INVALID_ASSET_KIND', '请选择文件类型')
      if (!req.is('multipart/form-data')) throw new ApiError(400, 'MULTIPART_REQUIRED', '上传必须使用multipart的file字段')
      next()
    } catch (e) { next(e) }
  }, upload, asyncRoute(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'FILE_REQUIRED', '缺少file文件')
    const file = req.file, kind = req.query.kind as Asset['kind']
    try {
      const user = ctx.requireAdmin(req)
      const mime = await detectType(file.path, kind, file.size)
      const assetId = randomUUID()
      const name = file.originalname.replace(/[\x00-\x1f\x7f]/g, '').split(/[\\/]/).pop()!.slice(0, 255) || 'upload'
      let bytes = file.size
      let hash = (file as Express.Multer.File & { sha256: string }).sha256
      if (kind === 'cover' && mime === 'image/jpeg') {
        // 只处理本次上传的发布副本，不改用户原图或其他资产。导出保持严格检查。
        if (bytes > 5 * 1024 * 1024) throw new ApiError(413, 'COVER_TOO_LARGE', 'JPEG封面不能超过5MiB')
        const content = await readFile(file.path)
        const end = jpegImageEnd(content)
        if (content.length !== bytes || end === null) throw new ApiError(415, 'UNSUPPORTED_MEDIA', 'JPEG封面不完整或图片结构无效，请重新导出图片')
        if (end !== bytes) {
          await truncate(file.path, end)
          bytes = end
          hash = createHash('sha256').update(content.subarray(0, end)).digest('hex')
        }
      }
      transaction(ctx.db, () => {
        if (ctx.requireAdmin(req).id !== user.id) throw new ApiError(401, 'UNAUTHENTICATED', '上传期间管理员登录已变化，请重新登录')
        ctx.db.prepare('INSERT INTO assets(id,owner_id,kind,original_name,storage_path,mime,bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(assetId, user.id, kind, name, file.path, mime, bytes, hash, Date.now())
        ctx.audit(user.id, 'asset.upload', 'asset', assetId, { kind, bytes })
      })
      res.status(201).json({ asset: assetDto(ctx.db.prepare('SELECT * FROM assets WHERE id=?').get(assetId)!) })
    } catch (e) { await unlink(file.path).catch(() => {}); throw e }
  }))
  router.get('/api/admin/assets', (req, res) => { ctx.requireAdmin(req); res.json({ assets: ctx.db.prepare('SELECT * FROM assets ORDER BY created_at DESC').all().map(assetDto) }) })
  router.get('/api/assets/:id', asyncRoute(async (req, res) => {
    const assetId = String(req.params.id)
    const asset = ctx.db.prepare("SELECT * FROM assets WHERE id=? AND kind IN ('cover','subtitle')").get(assetId)
    const isPublic = () => Boolean(ctx.db.prepare(`SELECT d.id FROM dramas d WHERE ${publicDramaCondition(ctx, 'd')} AND (d.cover_asset_id=? OR EXISTS (SELECT 1 FROM episodes e WHERE e.drama_id=d.id AND e.subtitle_asset_id=?)) LIMIT 1`).get(assetId, assetId))
    const canRead = () => ctx.user(req)?.role === 'admin' || isPublic()
    if (!asset || !canRead()) throw new ApiError(404, 'NOT_FOUND', '资源不存在')
    const path = await privateAssetPath(ctx, asset)
    if (!canRead()) throw new ApiError(404, 'NOT_FOUND', '资源不存在')
    res.vary('Cookie')
    // <img> can omit Origin. Only already-public covers/subtitles may be embedded;
    // admin draft previews and all video streams retain the default same-origin CORP.
    if (isPublic()) res.set('Cross-Origin-Resource-Policy', 'cross-origin')
    await streamFile(req, res, path, String(asset.mime), Number(asset.bytes))
  }))
  router.get('/api/media/stream/:token', asyncRoute(async (req, res) => {
    if (ctx.config.mode !== 'local') throw new ApiError(404, 'LOCAL_MEDIA_DISABLED', '平台环境不提供本地视频流')
    const token = String(req.params.token)
    if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError(404, 'NOT_FOUND', '播放凭证不存在')
    const grant = ctx.db.prepare('SELECT * FROM playback_grants WHERE token_hash=? AND expires_at>?').get(tokenHash(token), Date.now())
    if (!grant) throw new ApiError(401, 'GRANT_EXPIRED', '播放凭证已过期，请重新获取')
    const episode = ctx.db.prepare(`SELECT e.*,d.status,d.language,d.regions FROM episodes e JOIN dramas d ON d.id=e.drama_id WHERE e.id=? AND ${publicDramaCondition(ctx, 'd')}`).get(grant.episode_id)
    if (!episode) throw new ApiError(404, 'NOT_FOUND', '内容已下架')
    const user = ctx.user(req)
    if (grant.session_hash && (!user || user.id !== grant.user_id || ctx.sessionHash(req) !== grant.session_hash)) throw new ApiError(401, 'SESSION_REQUIRED', '此播放凭证只对原登录会话有效')
    if (!hasEpisodeAccess(ctx, grant.session_hash ? user!.id : null, Number(episode.id))) throw new ApiError(402, 'PAYMENT_REQUIRED', '播放权益已失效')
    const asset = ctx.db.prepare("SELECT * FROM assets WHERE id=? AND kind='video'").get(episode.asset_id)
    if (!asset) throw new ApiError(404, 'ASSET_UNAVAILABLE', '视频不可用')
    const path = await privateAssetPath(ctx, asset)
    // Recheck after filesystem await: logout/refund/unpublish may have happened meanwhile.
    const freshUser = ctx.user(req)
    if (grant.session_hash && (!freshUser || freshUser.id !== grant.user_id)) throw new ApiError(401, 'SESSION_REQUIRED', '登录已失效')
    if (!ctx.db.prepare("SELECT id FROM dramas WHERE id=? AND status='published'").get(episode.drama_id)) throw new ApiError(404, 'NOT_FOUND', '内容已下架')
    if (!hasEpisodeAccess(ctx, grant.session_hash ? freshUser!.id : null, Number(episode.id))) throw new ApiError(402, 'PAYMENT_REQUIRED', '播放权益已失效')
    if (Number(grant.expires_at) <= Date.now()) throw new ApiError(401, 'GRANT_EXPIRED', '播放凭证已过期')
    await streamFile(req, res, path, String(asset.mime), Number(asset.bytes))
  }))
}
