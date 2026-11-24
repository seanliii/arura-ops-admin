import type { DramaLocalizations } from './drama-localizations.js'
import type { ContentDelivery } from './content-delivery.js'

/** A content release, never a database/session export. Prices apply only to official staging. */
export interface PreviewOffer { freeEpisodes: number; episodePrice: number; bundlePrice: number }
export interface PreviewManifest {
  v: 1
  clientKey: string
  sourceDramaId: number
  sourceVersion: number
  albumId: string
  platformVersion: number
  authorizedClientKey: string
  drama: {
    title: string; desc: string; category: string; language: string; regions: string[]
    tags: string[]; localizations: DramaLocalizations
    delivery?: ContentDelivery
  }
  cover: { mime: string; sha256: string; base64: string }
  episodes: { sourceId: number; seq: number; title: string; durationSeconds: number; episodeId: string; vid: string }[]
  offer: PreviewOffer
}
export interface PreviewReceipt {
  releaseId: string
  sourceDramaId: number
  sourceVersion: number
  state: 'checking' | 'published' | 'failed' | 'unknown'
  targetDramaId: number | null
  episodeCount: number
  freeEpisodes: number
  episodePrice: number
  bundlePrice: number
  errorCode: string | null
  message: string
  updatedAt: number
}
export interface PreviewSource {
  id: number; version: number; title: string; language: string; regions: string[]
  episodeCount: number; ready: boolean; reasons: string[]
}
export interface PreviewCatalogState {
  configured: boolean
  mode: string
  reason: string | null
  dramas: PreviewSource[]
  receipts: PreviewReceipt[]
}
