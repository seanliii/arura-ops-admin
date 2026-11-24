import type { CatalogMetrics, CatalogSection } from './catalog-channel.js'
export type CandidateMetric = 'plays' | 'playRate' | 'paidRate' | 'clickRate' | 'watchSeconds'
export interface AnalyticsCandidate {
  id: string; createdAt: number; region: string; locale: string; channelVersion: number
  metric: CandidateMetric; dramaIds: number[]; smallSample: boolean; baseline: Record<string, unknown>
}
export interface AnalyticsExperiment {
  id: string; name: string; region: string; locale: string; channelVersion: number
  createdAt: number; updatedAt: number; state: 'draft' | 'active' | 'paused' | 'complete'; exposurePercent: number
  a: { dramaIds: number[]; sections: CatalogSection[] }
  b: { dramaIds: number[]; sections: CatalogSection[] }
}
export interface AnalyticsCatalogSnapshot {
  generatedAt: number
  metrics: Record<string, Record<string, CatalogMetrics>>
  scores: Record<string, Record<string, CatalogMetrics & { clickRate: number | null; watchSeconds: number }>>
  channelMetrics: Record<string, Record<string, Record<string, CatalogMetrics>>>
  channelScores: Record<string, Record<string, Record<string, CatalogMetrics & { clickRate: number | null; watchSeconds: number }>>>
  experiments: (AnalyticsExperiment & { salt: string })[]
}
