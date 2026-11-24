import type { PageInfo } from './content-operations.js'

export type WorkAction = 'start' | 'pause' | 'finish'
export interface DeliveryWorkState {
  jobId: string
  status: 'idle' | 'running' | 'paused' | 'finished'
  closedMs: number
  runningSince: number | null
  lastObservedAt: number | null
  observedAt: number
  canStart: boolean
}
export interface DeliveryWorkReceipt {
  jobId: string
  requestId: string
  action: WorkAction
  savedAt: number
  state: DeliveryWorkState
}
export interface EfficiencyJob {
  id: string
  dramaId: number
  title: string
  status: string
  createdAt: number
  completedAt: number | null
  durationMs: number | null
  ageMs: number | null
}
export interface EfficiencyRound {
  requestId: string
  dramaId: number
  title: string
  platformVersion: number
  round: number
  submittedAt: number
  acknowledged: boolean
  result: 'approved' | 'rejected' | 'withdrawn' | 'waiting' | 'unknown'
  lowerBoundMs: number | null
  upperBoundMs: number | null
  observedAt: number | null
  resubmissionAfterRejection: boolean
}
export interface DeliveryEfficiency {
  generatedAt: number
  scope: {
    region: string | null
    contentLanguage: string | null
    dramaId: number | null
    from: string
    to: string
    timeZone: 'UTC'
    partialDay: boolean
    basis: string
  }
  completed: { count: number; p50Ms: number | null; p95Ms: number | null; jobs: EfficiencyJob[]; pagination: PageInfo }
  coverage: { completedJobs: number; timedJobs: number; unknownJobs: number; invalidJobs: number; ratio: number | null }
  excluded: { cancelledJobs: number }
  activity: { jobs: EfficiencyJob[]; pagination: PageInfo }
  manual: { recordedJobs: number; cohortJobs: number; closedUnionMs: number | null; coverage: number | null; openIntervals: number; contributors: number }
  platform: {
    attempts: number
    acknowledged: number
    resolved: number
    resubmissionsAfterRejection: number
    rounds: EfficiencyRound[]
    pagination: PageInfo
  }
}
export function efficiencyDuration(ms: number | null) {
  if (ms === null) return '未知'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
