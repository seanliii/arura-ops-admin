import { createHash, randomBytes } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Router } from 'express'
import { ApiError, asyncRoute, type AppContext } from './types.js'
import { publicDramaCondition } from './catalog-policy.js'
import { getWebVideo, webVideoFailure } from './byteplus-playback-client.js'
import { id } from './validation.js'

const TTL = 5 * 60_000
const MAX_GRANTS = 2_000
const MAX_STREAMS = 32
type Grant = { episodeId: number; snapshot: string; url: string; size: number; expiresAt: number }

function eligibility(ctx: AppContext, episodeId: number): { snapshot: string; vid: string } {
  if (ctx.config.mode === 'local' || !ctx.config.webPlayback) throw new ApiError(503, 'WEB_VIDEO_NOT_CONFIGURED', '网页试看尚未配置')
  const row = ctx.db.prepare(`SELECT d.id,d.version,d.status,d.regions,d.language,d.free_episodes,d.rights_confirmed,
    e.id AS episode_id,e.seq,e.byteplus_vid,e.platform_episode_id
    FROM dramas d JOIN episodes e ON e.drama_id=d.id WHERE e.id=? AND ${publicDramaCondition(ctx, 'd')}`).get(episodeId)
  if (!row) throw new ApiError(404, 'NOT_FOUND', '作品不存在或未发布')
  // Web preview is free-only even for admins, VIPs or holders of TikTok entitlements.
  if (Number(row.seq) > Number(row.free_episodes)) throw new ApiError(403, 'WEB_PLAYBACK_TIKTOK_REQUIRED', '请在TikTok内解锁并观看付费剧集')
  if (!row.rights_confirmed || typeof row.byteplus_vid !== 'string' || !row.byteplus_vid) throw new ApiError(404, 'NOT_FOUND', '视频不可用')
  const configHash = createHash('sha256').update(JSON.stringify([
    ctx.config.mode, ctx.config.catalogRegion, ctx.config.tiktokClientKey, ctx.config.webPlayback,
  ])).digest('hex')
  return { snapshot: JSON.stringify([row, configHash]), vid: row.byteplus_vid }
}

export function registerWebPlayback(router: Router, ctx: AppContext): void {
  // Process-local, bounded, disposable on restart; never store cloud URLs or grants in business tables/logs.
  const grants = new Map<string, Grant>()
  let pending = 0, streams = 0
  const check = (grant: Grant) => {
    if (grant.expiresAt <= Date.now()) throw new ApiError(410, 'WEB_VIDEO_EXPIRED', '试看链接已过期，请重新播放')
    if (eligibility(ctx, grant.episodeId).snapshot !== grant.snapshot) throw new ApiError(409, 'PLAYBACK_CONTEXT_CHANGED', '内容已变化，请重新播放')
  }
  router.post('/api/episodes/:id/web-playback', asyncRoute(async (req, res) => {
    const episodeId = id(req.params.id), before = eligibility(ctx, episodeId)
    for (const [key, grant] of grants) if (grant.expiresAt <= Date.now()) grants.delete(key)
    if (grants.size + pending >= MAX_GRANTS || pending >= MAX_STREAMS) throw new ApiError(503, 'WEB_VIDEO_BUSY', '试看服务繁忙，请稍后重试')
    pending++
    try {
      const source = await getWebVideo(ctx.config.webPlayback!, before.vid)
      const grant: Grant = { episodeId, snapshot: before.snapshot, ...source, expiresAt: Date.now() + TTL }
      check(grant)
      if (res.destroyed) return
      const token = randomBytes(32).toString('hex')
      grants.set(createHash('sha256').update(token).digest('hex'), grant)
      res.json({ kind: 'web', url: `/api/media/web-stream/${token}`, expiresAt: grant.expiresAt })
    } finally { pending-- }
  }))
  // Express GET also handles HEAD. Every request, including seeking, repeats the content check.
  router.get('/api/media/web-stream/:token', asyncRoute(async (req, res) => {
    const token = req.params.token
    const grant = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)
      ? grants.get(createHash('sha256').update(token).digest('hex')) : undefined
    if (!grant) throw new ApiError(404, 'NOT_FOUND', '试看链接不存在')
    check(grant)
    const range = req.get('Range')
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new ApiError(416, 'INVALID_RANGE', '视频范围无效')
    if (streams >= MAX_STREAMS) throw new ApiError(503, 'WEB_VIDEO_BUSY', '试看服务繁忙，请稍后重试')
    streams++
    const controller = new AbortController()
    const cancel = () => controller.abort()
    res.once('close', cancel)
    // Covers body transfer, not only response headers. The client may renew an expired grant.
    let timeout = setTimeout(cancel, 12_000)
    let upstream: Response | undefined
    try {
      upstream = await fetch(grant.url, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) },
        redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      })
      clearTimeout(timeout)
      timeout = setTimeout(cancel, Math.max(1, grant.expiresAt - Date.now()))
      check(grant)
      if (upstream.redirected) throw webVideoFailure()
      if (upstream.status === 416) throw new ApiError(416, 'INVALID_RANGE', '视频范围无效')
      if (![200, 206].includes(upstream.status) || !/^video\/mp4(?:;|$)/i.test(upstream.headers.get('content-type') ?? '')
        || !/^\d+$/.test(upstream.headers.get('content-length') ?? '') || upstream.headers.has('content-encoding')) throw webVideoFailure()
      const length = Number(upstream.headers.get('content-length'))
      if (!Number.isSafeInteger(length) || length <= 0 || length > grant.size) throw webVideoFailure()
      const contentRange = upstream.headers.get('content-range')
      if (upstream.status === 206) {
        const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
        if (!range || !match || Number(match[3]) !== grant.size || Number(match[2]) >= grant.size
          || Number(match[2]) - Number(match[1]) + 1 !== length) throw webVideoFailure()
        const requested = range.match(/^bytes=(\d*)-(\d*)$/)!
        const start = requested[1] ? Number(requested[1]) : Math.max(0, grant.size - Number(requested[2]))
        const end = requested[1] && requested[2] ? Math.min(Number(requested[2]), grant.size - 1) : grant.size - 1
        if (Number(match[1]) !== start || Number(match[2]) !== end) throw webVideoFailure()
      } else if (length !== grant.size || contentRange) throw webVideoFailure()
      res.status(upstream.status).set({
        'Content-Type': 'video/mp4', 'Content-Length': String(length), 'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store', ...(contentRange ? { 'Content-Range': contentRange } : {}),
      })
      if (req.method === 'HEAD') { res.end(); return }
      if (!upstream.body) throw webVideoFailure()
      let received = 0
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          try {
            check(grant)
            received += chunk.length
            if (received > length) throw webVideoFailure()
            done(null, chunk)
          } catch (e) { done(e as Error) }
        },
        flush(done) { done(received === length ? undefined : webVideoFailure()) },
      })
      await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), verify, res, { signal: controller.signal })
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return }
      // Never allow a fetch exception containing a signed URL to escape.
      throw error instanceof ApiError ? error : webVideoFailure()
    } finally {
      controller.abort(); clearTimeout(timeout); res.off('close', cancel); streams--
      if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {})
    }
  }))
}
