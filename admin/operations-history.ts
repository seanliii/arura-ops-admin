import type { AnalysisEvidence } from './operations-context'
import type { CatalogSection, CatalogSort } from '../shared/catalog-channel'
import { continuationValue, resultPercent, type ContinuationResult } from './operations-results'

export const operationMetrics = {
  viewingVisits: '有效观看访次', clickRate: '曝光后点击率', continuation: '下一集接续率', d1: '次日账户回访率',
}
export type OperationMetric = keyof typeof operationMetrics
export interface OperationNote { reason: string; primaryMetric: OperationMetric; observationDays: number }
export const newOperationNote = (): OperationNote => ({ reason: '', primaryMetric: 'viewingVisits', observationDays: 7 })
export const noteChanged = (note: OperationNote) => JSON.stringify(note) !== JSON.stringify(newOperationNote())
export function saveOperationContext(note: OperationNote, evidence?: AnalysisEvidence | null, restoredFrom?: string) {
  if (!noteChanged(note) && !evidence && !restoredFrom) return undefined
  return { ...note, ...(evidence ? { evidence } : {}), ...(restoredFrom ? { restoredFrom } : {}) }
}
export interface OperationChange {
  id: string; kind: 'drama' | 'catalog'; key: string; sequence: number; createdAt: number
  beforeVersion: number; afterVersion: number
  context: OperationNote & { evidence: AnalysisEvidence | null; restoredFrom?: string }
  changes: { field: string; before: unknown; after: unknown }[]
}
export interface OperationRestore {
  readOnly: true; id: string; kind: 'drama' | 'catalog'; key: string; currentVersion: number
  allowed: boolean; blockers: string[]; note: string
  draft: {
    title?: string; desc?: string; category?: string; tags?: string[]; coverAssetId?: string | null
    configured?: boolean; dramaIds?: number[]; fallback?: 'strict' | 'original'; sort?: CatalogSort; sections?: CatalogSection[]
  }
}
export interface OperationMeasures {
  viewingVisits: number; exposures: number; qualifiedAttempts: number
  clickRate: { numerator: number; denominator: number; value: number | null }
  continuation: ContinuationResult
  d1: { numerator: number; denominator: number; value: number | null }
}
interface Guardrails {
  playbackErrors: number; availableContent: number
  refunds: { currency: string; orders: number; amount: number }[]
  financialCoverage: { note: string }
  dataQuality: { state: string; detailIncomplete: boolean; unavailableFrameSignals: number }
}
export interface OperationReview {
  readOnly: true; causal: false; change: OperationChange; status: string; reasons: string[]
  scope: Record<string, unknown>; scopeAdjustments: string[]
  windows: { before: { from: string; to: string }; after: { from: string; to: string }; excludedChangeDay: string }
  versionPair: { field: string; before: number; after: number }; primaryMetric: OperationMetric
  interpretation: string; before: OperationMeasures | null; after: OperationMeasures | null
  guardrails?: { before: Guardrails; after: Guardrails; note: string }
}
export const reviewLabels: Record<string, string> = {
  unavailable: '统计暂不可用', not_comparable: '条件已变化，不可直接比较', incomplete: '数据不完整，暂不判断',
  observing: '观察期未结束', processing_unknown: '处理进度待确认', late_window: '迟到数据仍可能补入',
  small_sample: '样本不足，继续观察', descriptive: '可查看前后变化，不能归因',
}
export const changeFields: Record<string, string> = {
  title: '剧目标题', desc: '简介', category: '分类', tags: '标签', coverAssetId: '封面',
  configured: '选片方式', dramaIds: '片单顺序', fallback: '其他语言推荐', sort: '作品排序', sections: '栏目',
  language: '原声语言', regions: '发行范围', freeEpisodes: '免费集数', rightsConfirmed: '版权确认',
  episodePrice: '单集价格（原存储单位）', bundlePrice: '整剧价格（原存储单位）',
  isSample: '测试标记', registrationMetadata: '发行资料', localizations: '多语介绍',
  delivery: '成片资料', productionSources: '制作来源',
}
export function changeValue(field: string, value: unknown): string {
  if (field === 'configured') return value ? '手动片单' : '自动选片'
  if (value == null || value === '') return '未设置'
  if (field === 'fallback') return value === 'original' ? '独立推荐其他语言' : '只选本频道语言'
  if (field === 'coverAssetId') return `封面资产 ${value}`
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value) && value.every(v => ['string', 'number'].includes(typeof v))) {
    return value.length ? value.map(v => field === 'dramaIds' ? `#${v}` : String(v)).join(field === 'dramaIds' ? ' → ' : '、') : '未设置'
  }
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}
export function reviewMetric(m: OperationMeasures | null, key: OperationMetric) {
  if (!m) return { value: '暂不可用', sample: '未取得可用报告' }
  if (key === 'viewingVisits') return { value: `${m.viewingVisits} 访次`, sample: `曝光 ${m.exposures} 访次` }
  if (key === 'continuation') return { value: continuationValue(m.continuation),
    sample: `${m.continuation.rate.numerator} / ${m.continuation.rate.denominator} 个可接续起点` }
  const rate = key === 'd1' ? m.d1 : m.clickRate
  return { value: resultPercent(rate.value), sample: `${rate.numerator} / ${rate.denominator} ${key === 'd1' ? '成熟账户' : '曝光访次'}` }
}
