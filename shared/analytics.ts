export const ANALYTICS_VERSION = 2 as const
export const ANALYTICS_TIMEZONES = ['UTC','Asia/Shanghai','Asia/Taipei','Asia/Tokyo','Asia/Seoul','Asia/Singapore','Asia/Kuala_Lumpur',
  'Asia/Bangkok','Asia/Ho_Chi_Minh','Asia/Jakarta','Asia/Manila','Asia/Phnom_Penh','Asia/Vientiane',
  'Asia/Yangon','Asia/Dili','Asia/Brunei','America/Sao_Paulo','America/Mexico_City'] as const
export const ANALYTICS_CLIENT_EVENTS = [
  'page_view', 'card_impression', 'card_click', 'detail_view', 'search', 'search_result_click',
  'login_start', 'login_success', 'login_cancel', 'play_request', 'first_frame', 'qualified_play',
  'play_segment', 'play_pause', 'play_seek', 'play_end', 'play_error', 'stall_start', 'stall_end',
  'episode_select', 'paywall_view', 'purchase_click', 'purchase_cancel', 'play_after_purchase',
  'favorite_click', 'experiment_exposure', 'login_error', 'load_error', 'autoplay_change',
] as const
export const ANALYTICS_SERVER_EVENTS = [
  'order_created', 'order_cancelled', 'order_failed', 'payment_confirmed', 'refund_confirmed',
  'entitlement_granted', 'entitlement_revoked', 'favorite_added', 'favorite_removed',
] as const
export type AnalyticsClientEventName = typeof ANALYTICS_CLIENT_EVENTS[number]
export type AnalyticsServerEventName = typeof ANALYTICS_SERVER_EVENTS[number]
export type AnalyticsEnvironment = 'production' | 'official_test' | 'internal'
export const ANALYTICS_PAGES = ['home', 'search', 'detail', 'player', 'checkout', 'profile', 'account', 'subscriptions'] as const
export const ANALYTICS_DEVICE_SYSTEMS = ['ios', 'android', 'windows', 'macos', 'linux', 'other'] as const
export const ANALYTICS_CONNECTION_TYPES = ['bluetooth', 'cellular', 'ethernet', 'mixed', 'none', 'other', 'unknown', 'wifi', 'wimax'] as const
export const ANALYTICS_NETWORK_QUALITIES = ['slow-2g', '2g', '3g', '4g', 'unknown'] as const
// Old clients put an unspecified network hint in networkType. Retain it without
// relabelling the historical value as either radio technology or measured speed.
export const ANALYTICS_NETWORK_TYPES = [...ANALYTICS_CONNECTION_TYPES, 'slow-2g', '2g', '3g', '4g'] as const
export const ANALYTICS_NETWORK_SOURCES = ['browser', 'unavailable', 'unrecorded'] as const
export const ANALYTICS_PLAYER_TYPES = ['local', 'tiktok', 'unknown'] as const
export interface AnalyticsContext {
  uiLanguage?: string
  contentLanguage?: string
  channelLanguage?: string
  sectionId?: string
  position?: number
  channelVersion?: number
  contentVersion?: number
  buildId?: string
  source?: 'catalog' | 'search' | 'history' | 'favorite' | 'direct' | 'next_episode' | 'resume' | 'unknown'
  deviceOS?: typeof ANALYTICS_DEVICE_SYSTEMS[number]
  playerType?: 'local' | 'tiktok'
  networkType?: typeof ANALYTICS_NETWORK_TYPES[number]
  networkQuality?: typeof ANALYTICS_NETWORK_QUALITIES[number]
  networkSource?: 'browser' | 'unavailable'
  experimentId?: string
  variant?: 'a' | 'b'
}
export interface AnalyticsProperties {
  /** Only autoplay_change: an explicit user action, never restored preferences. */
  autoNext?: boolean
  timingVersion?: 2
  hasRebufferSignal?: boolean
  watchDeltaMs?: number
  wallDeltaMs?: number
  stallDeltaMs?: number
  watchedMs?: number
  wallMs?: number
  stallMs?: number
  durationMs?: number
  firstFrameMs?: number
  mediaTimeMs?: number
  fromMs?: number
  toMs?: number
  resultCount?: number
  queryLength?: number
  errorCode?: string
  playerDiagnostic?: PlayerDiagnostic
  ended?: boolean
  replay?: boolean
  hasFrameSignal?: boolean
  segments?: [number, number][]
}
export interface AnalyticsClientEvent {
  id: string
  name: AnalyticsClientEventName
  occurredAt: number
  visitId: string
  journeyId: string
  pageId: string
  page: typeof ANALYTICS_PAGES[number]
  dramaId?: number
  episodeId?: number
  playbackId?: string
  orderId?: string
  context?: AnalyticsContext
  properties?: AnalyticsProperties
}
export interface AnalyticsBatch { version: typeof ANALYTICS_VERSION; accountId?: string | null; events: AnalyticsClientEvent[] }
export interface AnalyticsAccepted { accepted: number; duplicates: number; ignored?: 'administrator' | 'disabled' }
/** 服务端当次读取的版本供给；不是客户端自报，也不回填成过去发生时的事实。 */
export interface AnalyticsSupplyObservation {
  observedAt: number
  contentVersion: number
  mediaVersion: number | null
  episodeId: number
  nextEpisodeId: number | null
  availability: 'available' | 'unavailable' | 'missing' | 'version_end'
  paid: boolean
  seriesComplete: boolean
}
export interface AnalyticsEventRecord {
  id: string
  inputHash: string
  name: string
  source: 'client' | 'server'
  environment: AnalyticsEnvironment
  occurredAt: number
  receivedAt: number
  visitorKey: string
  accountKey: string | null
  journeyKey: string
  pageKey: string
  playbackKey: string | null
  page: string
  market: string
  country: string | null
  uiLanguage: string | null
  contentLanguage: string | null
  channelLanguage: string | null
  audioLanguage: string | null
  subtitleLanguage: string | null
  subtitleMode: string | null
  dramaId: number | null
  workId: number | null
  episodeId: number | null
  mediaVersion: number | null
  contentVersion: number | null
  channelVersion: number | null
  sectionId: string | null
  position: number | null
  entrySource: string
  deviceOS: string
  playerType: string | null
  networkType: string
  networkQuality?: string
  networkSource?: string
  buildId: string | null
  orderId: string | null
  amount: number | null
  amountText?: string | null
  currency: string | null
  sample: boolean
  experimentId: string | null
  variant: string | null
  qualityFlags: string[]
  properties: AnalyticsProperties
  supplyObservation?: AnalyticsSupplyObservation
}
export interface AnalyticsStatus {
  available: boolean
  storage: 'independent-sqlite'
  environment: AnalyticsEnvironment
  events: number
  playbacks: number
  receivedThrough: number | null
  businessCursor: number
  queued: number
  version: 2
}
export function analyticsEnvironment(mode: string): AnalyticsEnvironment {
  return mode === 'production' ? 'production' : mode === 'staging' ? 'official_test' : 'internal'
}
import type { PlayerDiagnostic } from './player-diagnostics.js'
