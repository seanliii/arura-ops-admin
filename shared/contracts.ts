/** Shared wire contract. IDs from TikTok remain strings; local catalog IDs are integers. */
import type { PlatformSubscriptionAccess } from './subscriptions.js'
import type { RegistrationMetadata } from './registration-metadata.js'
import type { DramaLocalizations } from './drama-localizations.js'
import type { CatalogSelection, DramaEdition } from './catalog-channel.js'
import type { ContentDelivery, ProductionSources } from './content-delivery.js'
export type AppMode = 'local' | 'staging' | 'production'
export type PaymentMode = 'sandbox' | 'disabled' | 'tiktok'
export type Role = 'user' | 'admin'
export type DramaStatus = 'draft' | 'published' | 'archived'
export type OrderKind = 'episode' | 'drama' | 'vip'
export type OrderStatus = 'pending' | 'processing' | 'paid' | 'cancelled' | 'failed' | 'refunded'

export interface User {
  id: string
  email: string | null
  nickname: string
  role: Role
  provider: 'local' | 'tiktok'
  createdAt: number
}
export interface Meta {
  analytics?: { enabled: boolean; version: 2; autoplayPreference?: boolean; playerDiagnostics?: boolean }
  mode: AppMode
  paymentMode: PaymentMode
  mediaMode: 'local' | 'tiktok'
  registrationEnabled: boolean
  vipPrice: number
  vipDays: number
}
export interface Episode {
  id: number
  dramaId: number
  seq: number
  title: string
  duration: string
  durationSeconds: number
  isFree: boolean
  canPlay: boolean
  thumb: string
  price: number
  mediaReady: boolean
  assetId?: string | null
  subtitleAssetId?: string | null
  platformEpisodeId?: string | null
  byteplusVid?: string | null
}
export interface Drama {
  metricsEnabled?: boolean
  delivery?: ContentDelivery
  /** Only returned to admins. Contains private source indexes, never viewer playback addresses. */
  productionSources?: ProductionSources
  /** Versions share a work identity, not order entitlements or platform media IDs. */
  workId?: number
  editions?: DramaEdition[]
  catalogSelection?: CatalogSelection
  localizations?: DramaLocalizations
  /** 仅管理员返回；旧客户端和公开片库可不包含此资料。 */
  registrationMetadata?: RegistrationMetadata
  id: number
  title: string
  category: string
  cover: string
  desc: string
  totalEpisodes: number
  /** True only when editorial completion and the complete uploaded episode count agree. */
  seriesComplete?: boolean
  freeEpisodes: number
  tags: string[]
  episodes: Episode[]
  status: DramaStatus
  version: number
  episodePrice: number
  bundlePrice: number
  language: string
  regions: string[]
  rightsConfirmed: boolean
  platformAlbumId?: string | null
  platformReviewStatus?: string
  isSample: boolean
  createdAt: number
  updatedAt: number
}
export interface Asset {
  id: string
  kind: 'video' | 'cover' | 'subtitle'
  originalName: string
  mime: string
  bytes: number
  sha256: string
  url?: string
  createdAt: number
}
export interface WatchProgress {
  dramaId: number
  episodeId: number
  currentTime: number
  duration: number
  completed: boolean
  updatedAt: number
}
export interface Library {
  favorites: number[]
  /** Independent of favorites; omitted by older servers and guest storage. */
  following?: number[]
  history: WatchProgress[]
}
export interface Entitlement {
  id: string
  kind: OrderKind
  targetId: number | null
  orderId: string
  expiresAt: number | null
}
export interface SessionInfo {
  user: User | null
  entitlements: Entitlement[]
  vipExpiresAt: number | null
  subscriptionAccess?: PlatformSubscriptionAccess
}
/** Returned only when claiming one SDK dispatch; never included in Order or persisted by the client. */
export interface PaymentAttemptClaim {
  attemptId: string
  tradeOrderId: string
  /** Secret capability for reporting this invocation's result, not payment authority. */
  reportToken: string
}
export interface Order {
  id: string
  kind: OrderKind
  targetId: number | null
  /** Server-resolved content ownership, independent of language-specific catalog shelves.
   * Absent on older servers; null for non-content/deleted targets. Never an access grant. */
  dramaId?: number | null
  episodeSeq?: number | null
  title: string
  amount: number
  currency: 'TEST_CREDITS' | 'BEANS'
  provider: 'sandbox' | 'tiktok'
  status: OrderStatus
  tradeOrderId: string | null
  /** Local one-use SDK dispatch evidence only; never proof of settlement or platform closure. */
  paymentAttempt?: {
    outcome: 'started' | 'succeeded' | 'cancelled' | 'failed' | 'unknown' | 'not_started'
    released: boolean
  }
  createdAt: number
  paidAt: number | null
  expiresAt: number
  userId?: string
  userEmail?: string | null
}
export type Playback =
  | { kind: 'local'; url: string; expiresAt: number; subtitleUrl?: string }
  | { kind: 'web'; url: string; expiresAt: number }
  | { kind: 'tiktok'; albumId: string; episodeId: string; vid: string; playAuthToken?: string; subscriptionAccess?: PlatformSubscriptionAccess }
export interface ApiFailure {
  error: { code: string; message: string }
}

/** 官方状态数字不与本地发布状态混用；未查询到的字段明确为 null。 */
export type PlatformMediaReviewStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
export type PlatformMediaPublishStatus = 0 | 1 | 2
export type PlatformMediaAction = 'sync' | 'submit_review' | 'set_online' | 'authorize_app' | 'list' | 'delist'
export type PlatformMediaOperationStatus = 'submitting' | 'succeeded' | 'failed' | 'unknown' | 'awaiting_sync' | 'superseded' | 'reconciled'
export interface PlatformMediaVersion {
  version: number
  reviewStatus: PlatformMediaReviewStatus | null
  episodeCount: number | null
}
export interface PlatformMediaEpisode {
  localEpisodeId: number
  seq: number
  episodeId: string
  vid: string
}
export interface PlatformMediaOperation {
  requestId: string
  action: PlatformMediaAction
  status: PlatformMediaOperationStatus
  albumId: string
  platformVersion: number
  localVersion: number
  resultVersion: number | null
  reviewId: string | null
  errorCode: string | null
  message: string
  reconciledBy: string | null
  createdAt: number
  updatedAt: number
}
export interface PlatformMediaState {
  dramaId: number
  localVersion: number
  mode: AppMode
  configured: boolean
  albumId: string | null
  platformVersion: number | null
  currentVersion: number | null
  onlineVersion: number | null
  reviewStatus: PlatformMediaReviewStatus | null
  publishStatus: PlatformMediaPublishStatus | null
  syncedLocalVersion: number | null
  syncedAt: number | null
  authorization: 'authorized' | 'unconfirmed'
  authorizedAt: number | null
  needsSync: boolean
  readyToPublish: boolean
  reasons: string[]
  versions: PlatformMediaVersion[]
  episodes: PlatformMediaEpisode[]
  operations: PlatformMediaOperation[]
}
export interface PlatformMediaResponse {
  media: PlatformMediaState
  operation?: PlatformMediaOperation
}
