import type { Request } from 'express'
import { ApiError, type AppContext } from './types.js'

/**
 * Internal execution authority. Never parsed from request JSON.
 * Manual actions remain bound to their original cookie session. A delivery worker
 * uses its separate, revocable, per-drama database grant rather than a saved login.
 */
export interface MediaActor {
  id: string
  dramaId: number
  identity: string
  kind: 'request' | 'delivery'
  assertCurrent(): void
}
export function requestMediaActor(ctx: AppContext, req: Request, dramaId: number): MediaActor {
  const admin = ctx.requireAdmin(req), session = ctx.sessionHash(req)
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', '请重新登录管理员')
  return {
    id: admin.id, dramaId, identity: session, kind: 'request',
    assertCurrent() {
      const current = ctx.requireAdmin(req)
      if (current.id !== admin.id || ctx.sessionHash(req) !== session) {
        throw new ApiError(401, 'ADMIN_SESSION_CHANGED', '管理员会话已变化，停止继续操作；已有回执保留')
      }
    },
  }
}
export function assertMediaActor(actor: MediaActor, dramaId: number): void {
  if (!actor || actor.dramaId !== dramaId) throw new ApiError(403, 'MEDIA_ACTOR_SCOPE', '本次授权只适用于选定剧目')
  actor.assertCurrent()
}
