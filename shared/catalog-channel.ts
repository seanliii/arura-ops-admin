import type { DramaTextLocale } from './drama-localizations.js'
import type { Drama } from './contracts.js'
export const CATALOG_SORTS = ['manual', 'plays', 'playRate', 'paidRate'] as const
export type CatalogSort = typeof CATALOG_SORTS[number]
export interface CatalogSection { id: string; title: string; dramaIds: number[] }
export interface CatalogMetrics {
  impressions: number; plays: number; engagedVisits: number; viewers: number; buyers: number
  playRate: number | null; paidRate: number | null
}

/** 同一规则用于观众目录与后台编排预览；同分保持手选先后，缺测值不造高排名。 */
export function sortCatalog<T extends Pick<Drama, 'id'>>(dramas: T[], mode: CatalogSort = 'manual', metrics: Record<string, CatalogMetrics> = {}): T[] {
  if (mode === 'manual') return dramas
  return [...dramas].sort((a, b) => {
    const av = metrics[String(a.id)]?.[mode], bv = metrics[String(b.id)]?.[mode]
    return (bv ?? -1) - (av ?? -1)
  })
}

export interface CatalogChannel {
  region: string
  locale: DramaTextLocale
  version: number
  configured: boolean
  /** "original" permits only the operator's explicitly selected non-matching titles in a separate section. */
  fallback: 'original' | 'strict'
  dramaIds: number[]
  recommendationIds?: number[]
  sort?: CatalogSort
  sections?: CatalogSection[]
  experiment?: { id: string; variant: 'a' | 'b'; channelVersion: number }
}
export interface DramaEdition {
  id: number
  language: string
  title: string
  label?: string
}
export interface CatalogSelection {
  requestedLocale: DramaTextLocale
  contentLanguage: string
  fallback: boolean
  channelVersion?: number
  experiment?: CatalogChannel['experiment']
}
export const CONTENT_LANGUAGE_LABELS: Record<string, string> = {
  'zh-Hans': '简体中文', en: 'English', 'zh-Hant': '繁體中文', ja: '日本語',
  es: 'Español', fr: 'Français', ar: 'العربية', zh: '中文', und: '未确认',
  ko: '한국어', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia',
  'pt-BR': 'Português (Brasil)', 'es-419': 'Español (Latinoamérica)', ms: 'Bahasa Melayu',
}
/** 运营后台用中文解释语言；观众端仍显示语言自称，不据此推断所在国家。 */
export const OPERATOR_LANGUAGE_LABELS: Record<string, string> = {
  'zh-Hans': '简体中文', 'zh-Hant': '繁体中文', zh: '中文', und: '待确认',
  en: '英语 · English', ja: '日语 · 日本語', ko: '韩语 · 한국어', th: '泰语 · ไทย',
  vi: '越南语 · Tiếng Việt', id: '印尼语 · Bahasa Indonesia', ms: '马来语 · Bahasa Melayu',
  'pt-BR': '葡萄牙语（巴西）', 'es-419': '西班牙语（拉美）', es: '西班牙语',
  fr: '法语 · Français', ar: '阿拉伯语 · العربية',
}
