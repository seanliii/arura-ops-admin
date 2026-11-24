import type { DatabaseSync } from 'node:sqlite'
import type { Request, Response, NextFunction, Router } from 'express'
import type { AppMode, PaymentMode, User } from '../shared/contracts.js'
import type { BytePlusUploadConfig } from '../shared/cloud-upload.js'
import type { MediaRegistrationConfig } from '../shared/media-registration.js'
import type { SubscriptionConfig } from '../shared/subscriptions.js'
import type { AnalyticsStore } from './analytics-store.js'

export interface ServerConfig {
  analyticsEnabled?: boolean
  /** Trusted storefront market. Never inferred from an untrusted locale/query/header. */
  catalogRegion?: string
  dataDir: string
  mode: AppMode
  paymentMode: PaymentMode
  allowedOrigins: string[]
  /** Explicit proxy IPs/CIDRs only; omitted/empty means trust no forwarding headers. */
  trustedProxies?: string[]
  cookieSecure: boolean
  cookieSameSite?: 'strict' | 'none'
  sessionCookieName?: string
  sessionCookiePath?: string
  sessionHours: number
  uploadMaxBytes: number
  vipPrice: number
  vipDays: number
  tiktokClientKey?: string
  tiktokClientSecret?: string
  tiktokWebhookSecret?: string
  /** 仅production可启用固定loopback沙箱通知转发；staging不配置，避免循环。 */
  sandboxWebhookTarget?: string
  tokenEncryptionKey?: string
  byteplusUpload?: BytePlusUploadConfig
  /** Independent read-only credentials; does not enable uploading or web purchases. */
  webPlayback?: { origin: string; region: string; accessKeyId: string; secretAccessKey: string }
  cloudUploadMaxBytes?: number
  mediaRegistration?: MediaRegistrationConfig
  subscription?: SubscriptionConfig
}
export interface AppContext {
  db: DatabaseSync
  config: ServerConfig
  analytics?: AnalyticsStore
  user(req: Request): User | null
  sessionHash(req: Request): string | null
  requireUser(req: Request): User
  requireAdmin(req: Request): User
  audit(actorId: string | null, action: string, type: string, id: string, detail?: object): void
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
export const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { Promise.resolve(handler(req, res)).catch(next) }
export type RegisterRoutes = (router: Router, ctx: AppContext) => void
