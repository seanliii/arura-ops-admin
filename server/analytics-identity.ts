import { createHmac, randomBytes } from 'node:crypto'
import type { AppContext } from './types.js'
export function analyticsKey(ctx: AppContext, value: string): string {
  let salt = ctx.db.prepare("SELECT value FROM settings WHERE key='analytics_actor_salt'").get()?.value as string | undefined
  if (!salt) {
    ctx.db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('analytics_actor_salt',?)").run(randomBytes(32).toString('hex'))
    salt = ctx.db.prepare("SELECT value FROM settings WHERE key='analytics_actor_salt'").get()!.value as string
  }
  return createHmac('sha256', salt).update(value).digest('hex')
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => JSON.stringify(key) + ':' + stable(item)).join(',') + '}'
  return JSON.stringify(value)
}
