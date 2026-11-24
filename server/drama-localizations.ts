import { DRAMA_TEXT_LOCALES, type DramaLocalizations, type DramaTextLocale } from '../shared/drama-localizations.js'
import { ApiError } from './types.js'
import { body, text } from './validation.js'
export function readDramaLocalizations(raw: unknown): DramaLocalizations { return JSON.parse(String(raw ?? '{}')) }
export function mergeDramaLocalizations(raw: unknown, input: unknown): DramaLocalizations {
  const patch = body(input), result = readDramaLocalizations(raw)
  for (const [locale, entry] of Object.entries(patch)) {
    if (!DRAMA_TEXT_LOCALES.includes(locale as DramaTextLocale)) throw new ApiError(400, 'LOCALIZATION_INVALID', '请选择支持的文案语言，不改变原声或发行地区')
    const key = locale as DramaTextLocale
    if (entry === null) { delete result[key]; continue }
    const content = body(entry)
    if (Object.keys(content).some(field => field !== 'title' && field !== 'desc')) {
      throw new ApiError(400, 'LOCALIZATION_INVALID', '多语文案仅支持剧名和简介')
    }
    const next = { ...result[key] }
    for (const field of ['title', 'desc'] as const) {
      if (content[field] === undefined) continue
      const value = text(content[field], `localizations.${locale}.${field}`, field === 'title' ? 200 : 10000, true)
      if (value) next[field] = value
      else delete next[field]
    }
    if (Object.keys(next).length) result[key] = next
    else delete result[key]
  }
  // 固定序列不随不同表单的保存顺序变化，避免同一内容产生不同快照摘要。
  return Object.fromEntries(DRAMA_TEXT_LOCALES.filter(locale => result[locale]).map(locale => [locale, result[locale]]))
}
