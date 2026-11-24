export type ContentWorkView = 'all' | 'action' | 'review' | 'published'
export type ContentEditorStep = 'basic' | 'episodes' | 'publish'
export interface ReadinessIssue { field: string; label: string; step: ContentEditorStep; code: string; status: number }
export interface ContentReadiness {
  draft: { ready: boolean; issues: ReadinessIssue[] }
  review: { ready: boolean; issues: ReadinessIssue[] }
  publish: { ready: boolean; issues: ReadinessIssue[] }
}
export interface ContentOperationSummary {
  dramaId: number
  status: string
  label: string
  needsAction: boolean
  hasReview: boolean
  nextAction: { label: string; step: ContentEditorStep }
  latestJobId: string | null
}
export interface EpisodeTitleReceipt {
  requestId: string; dramaId: number; beforeVersion: number; afterVersion: number; savedAt: number
  counts: { saved: number; failed: number; unchanged: number }
  rows: { episodeId: number; seq: number | null; oldTitle: string | null; title: string;
    status: 'saved' | 'failed' | 'unchanged'; message: string }[]
}
export interface DeliveryHistoryRow {
  id: string; dramaId: number; title: string; status: string; phase: string; message: string
  expectedEpisodes: number; autoPublish: boolean; createdAt: number; updatedAt: number
  completedAt: number | null; completedDurationMs: number | null; ongoingAgeMs: number | null
  platformVersion: number | null
  nextRunAt: number | null
}
export interface PageInfo { page: number; pageSize: number; total: number; pages: number }
export interface ContentListFilters {
  query: string; status: string; region: string; language: string
  workView: ContentWorkView; page: number; scrollY: number
}
export interface DeliveryHistory {
  jobs: DeliveryHistoryRow[]; pagination: PageInfo; observedAt: number
  scope: { region: string | null; contentLanguage: string | null; dramaId: number | string | null; basis: string }
}
export interface ContentOperationsDetail {
  dramaId: number; version: number; generatedAt: number
  summary: ContentOperationSummary; readiness: ContentReadiness
  platform: {
    platformVersion: number | null; localVersion: number | null
    reviewStatus: number | null; publishStatus: number | null; syncedAt: number | null; needsSync: boolean
    nextQueryAt: number | null
    queryIssue: { status: string; at: number; message: string } | null
    rounds: { requestId: string; round: number; albumId: string; platformVersion: number | null; localVersion: number
      status: string; acknowledged: boolean; reviewId: string | null; submittedAt: number; message: string
      observations: { observed_at: number; review_status: number | null; publish_status: number | null }[] }[]
    resultReason: string
  }
  delivery: DeliveryHistory
  uploads: {
    counts: Record<'success' | 'failed' | 'unknown' | 'pending' | 'cancelled', number>
    scope: string
    groups: Record<'success' | 'failed' | 'unknown' | 'pending' | 'cancelled', {
      id: string; seq: number; title: string; status: string; registrationStatus: string | null
      hasKnownVideo: boolean; episodeId: number | null; message: string
    }[]>
  }
}
