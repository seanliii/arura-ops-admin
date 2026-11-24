/** 仅保存本次管理会话的阅读状态；不向片单或用户资料写入筛选。 */
export type AnalysisFilters = {
  from: string; to: string; timezone: string; market: string; uiLanguage: string
  contentLanguage: string; channelLanguage: string; dramaId: string; episodeId: string
  sectionId: string; contentVersion: string; mediaVersion: string; channelVersion: string
  entrySource: string; deviceOS: string; playerType: string; networkType: string
  networkQuality: string; networkSource: string; buildId: string; includeSamples: boolean | null
}
export type AnalysisTab = 'overview' | 'content' | 'paths'
export type AnalysisDetail = '' | 'conversion' | 'retention' | 'quality' | 'delivery'
export interface AnalysisState {
  filters: AnalysisFilters
  appliedFilters?: AnalysisFilters
  tab: AnalysisTab
  detail: AnalysisDetail
  contentId: number | null
  contentLanguage: string
  scrollY: number
  focusId: string
  moreFilters: boolean
  contentSort: 'exposedVisits' | 'viewingVisits' | 'click'
  contentLens: 'start' | 'continue' | 'return'
  showComparison: boolean
}
export interface AnalysisEvidence {
  filters: Record<string, unknown>
  generatedAt: number
  title: string
  dramaId: number
  contentLanguage: string
}
export interface AnalysisAction {
  target: 'edit' | 'episodes' | 'review' | 'home' | 'orders'
  evidence: AnalysisEvidence
  region?: string
  locale?: string
  orderId?: string
}
export function localDay(time: number, timezone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(time).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
export function shiftDay(day: string, days: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
}
export function newAnalysisState(now = Date.now()): AnalysisState {
  const today = localDay(now)
  return {
    filters: { from: shiftDay(today, -7), to: shiftDay(today, -1), timezone: 'Asia/Shanghai',
      market: '', uiLanguage: '', contentLanguage: '', channelLanguage: '', dramaId: '', episodeId: '',
      sectionId: '', contentVersion: '', mediaVersion: '', channelVersion: '',
      entrySource: '', deviceOS: '', playerType: '', networkType: '', networkQuality: '', networkSource: '',
      buildId: '', includeSamples: null },
    tab: 'overview', detail: '', contentId: null, contentLanguage: '', scrollY: 0, focusId: '', moreFilters: false,
    contentSort: 'viewingVisits', contentLens: 'start', showComparison: false,
  }
}
const scopeLabels: Record<string, string> = {
  from: '开始', to: '结束', timezone: '时区', environment: '数据环境', market: '发行市场',
  contentLanguage: '实际内容语言', channelLanguage: '频道语言', uiLanguage: '界面语言',
  dramaId: '作品', episodeId: '单集', sectionId: '栏目', entrySource: '入口', deviceOS: '设备',
  playerType: '播放器', networkType: '网络', networkQuality: '网络质量', networkSource: '网络来源',
  buildId: '前端版本', includeSamples: '包含测试内容',
  contentVersion: '内容版本', mediaVersion: '媒资版本', channelVersion: '片单版本',
}
export function evidenceScope(filters: Record<string, unknown>) {
  return Object.entries(filters).filter(([key, value]) => key in scopeLabels && value !== '' && value != null)
    .map(([key, value]) => `${scopeLabels[key]}：${typeof value === 'boolean' ? value ? '是' : '否' : value}`).join(' · ')
}
