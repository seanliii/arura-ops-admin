import type { Request, Router } from 'express'
import type { Library } from '../shared/contracts.js'
import { ApiError, type AppContext } from './types.js'
import { body, boolean, integer, number, id } from './validation.js'
import { publishedRow } from './content.js'
import { hasEpisodeAccess } from './commerce.js'

function libraryUser(ctx: AppContext, req: Request) {
  const user = ctx.requireUser(req)
  // This is an account expectation, never a credential or a query user ID.
  // Older clients omit it; new pages must not follow a shared cookie into B.
  const owner = req.get('X-Library-Owner')
  if (owner !== undefined && owner !== user.id) {
    throw new ApiError(409, 'SESSION_CHANGED', '账号已变化，请刷新登录状态后重试')
  }
  return user
}

function library(ctx: AppContext, userId: string): Library {
  return {
    favorites: ctx.db.prepare('SELECT drama_id FROM favorites WHERE user_id=? ORDER BY created_at DESC,drama_id').all(userId).map(row => Number(row.drama_id)),
    following: ctx.db.prepare('SELECT drama_id FROM following WHERE user_id=? ORDER BY created_at DESC,drama_id').all(userId).map(row => Number(row.drama_id)),
    history: ctx.db.prepare('SELECT * FROM progress WHERE user_id=? ORDER BY updated_at DESC,drama_id').all(userId).map(row => ({ dramaId: Number(row.drama_id), episodeId: Number(row.episode_id), currentTime: Number(row.current_time), duration: Number(row.duration), completed: Boolean(row.completed), updatedAt: Number(row.updated_at) })),
  }
}
export function registerLibrary(router: Router, ctx: AppContext): void {
  router.get('/api/library', (req, res) => res.json(library(ctx, libraryUser(ctx, req).id)))
  router.put('/api/library/favorites/:dramaId', (req, res) => {
    const user = libraryUser(ctx, req), dramaId = id(req.params.dramaId), saved = boolean(body(req.body).saved, 'saved')
    if (saved) {
      publishedRow(ctx, dramaId)
      ctx.db.prepare('INSERT INTO favorites(user_id,drama_id,created_at) VALUES(?,?,?) ON CONFLICT(user_id,drama_id) DO NOTHING').run(user.id, dramaId, Date.now())
    } else ctx.db.prepare('DELETE FROM favorites WHERE user_id=? AND drama_id=?').run(user.id, dramaId)
    res.json(library(ctx, user.id))
  })
  router.put('/api/library/following/:dramaId', (req, res) => {
    const user = libraryUser(ctx, req), dramaId = id(req.params.dramaId), saved = boolean(body(req.body).saved, 'saved')
    if (saved) {
      publishedRow(ctx, dramaId)
      ctx.db.prepare('INSERT INTO following(user_id,drama_id,created_at) VALUES(?,?,?) ON CONFLICT(user_id,drama_id) DO NOTHING').run(user.id, dramaId, Date.now())
    } else ctx.db.prepare('DELETE FROM following WHERE user_id=? AND drama_id=?').run(user.id, dramaId)
    res.json(library(ctx, user.id))
  })
  router.put('/api/library/progress', (req, res) => {
    const user = libraryUser(ctx, req), input = body(req.body)
    const dramaId = integer(input.dramaId, 'dramaId', 1), episodeId = integer(input.episodeId, 'episodeId', 1)
    publishedRow(ctx, dramaId)
    if (!ctx.db.prepare('SELECT id FROM episodes WHERE id=? AND drama_id=?').get(episodeId, dramaId)) throw new ApiError(400, 'EPISODE_MISMATCH', '剧集不属于该作品')
    if (!hasEpisodeAccess(ctx, user.id, episodeId)) throw new ApiError(402, 'PAYMENT_REQUIRED', '没有该剧集的播放权限')
    const duration = number(input.duration, 'duration', 0, 86400)
    const currentTime = number(input.currentTime, 'currentTime', 0, duration)
    const completed = boolean(input.completed, 'completed')
    ctx.db.prepare(`INSERT INTO progress(user_id,drama_id,episode_id,current_time,duration,completed,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id,drama_id) DO UPDATE SET episode_id=excluded.episode_id,current_time=excluded.current_time,duration=excluded.duration,completed=excluded.completed,updated_at=excluded.updated_at`)
      .run(user.id, dramaId, episodeId, currentTime, duration, Number(completed), Date.now())
    res.json(library(ctx, user.id))
  })
  router.delete('/api/library/history', (req, res) => {
    const user = libraryUser(ctx, req)
    ctx.db.prepare('DELETE FROM progress WHERE user_id=?').run(user.id)
    res.json(library(ctx, user.id))
  })
}
