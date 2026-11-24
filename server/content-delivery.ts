import type { ContentDelivery, ProductionSources } from '../shared/content-delivery.js'
import { contentLocale } from '../shared/content-delivery.js'
import { DRAMA_TEXT_LOCALES, type DramaTextLocale } from '../shared/drama-localizations.js'
import { ApiError } from './types.js'

const fail = () => new ApiError(400, 'INVALID_CONTENT_DELIVERY', '请如实填写成片服务语言、音轨和字幕信息；有字幕须指定语言，无字幕不能填写字幕语言')
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail()
  return value as Record<string, unknown>
}
function saved(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {}
  try { return object(JSON.parse(raw)) } catch { return {} }
}
function locale(value: unknown): DramaTextLocale | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !DRAMA_TEXT_LOCALES.includes(value as DramaTextLocale)) throw fail()
  return value as DramaTextLocale
}
export function readDelivery(raw: unknown, audioLanguage: string): ContentDelivery {
  const v = saved(raw)
  return {
    contentLocale: v.contentLocale === null ? null : DRAMA_TEXT_LOCALES.includes(v.contentLocale as DramaTextLocale) ? v.contentLocale as DramaTextLocale : contentLocale(audioLanguage),
    subtitleMode: ['none', 'burned', 'external'].includes(String(v.subtitleMode)) ? v.subtitleMode as ContentDelivery['subtitleMode'] : 'unknown',
    subtitleLanguage: DRAMA_TEXT_LOCALES.includes(v.subtitleLanguage as DramaTextLocale) ? v.subtitleLanguage as DramaTextLocale : null,
    label: typeof v.label === 'string' ? v.label : '',
  }
}
export function mergeDelivery(raw: unknown, input: unknown, audioLanguage: string): ContentDelivery {
  const patch = object(input)
  if (Object.keys(patch).some(k => !['contentLocale', 'subtitleMode', 'subtitleLanguage', 'label'].includes(k))) throw fail()
  const v = { ...readDelivery(raw, audioLanguage), ...patch }
  const target = locale(v.contentLocale), subtitles = locale(v.subtitleLanguage)
  if (typeof v.subtitleMode !== 'string' || !['unknown', 'none', 'burned', 'external'].includes(v.subtitleMode) ||
    typeof v.label !== 'string' || v.label.length > 80 || /[\u0000-\u001f]/.test(v.label)) throw fail()
  if (['burned', 'external'].includes(String(v.subtitleMode)) && !subtitles) throw fail()
  if (['none', 'unknown'].includes(String(v.subtitleMode)) && subtitles) throw fail()
  // Marking English as Japanese is not localization. The target must be justified by audio or subtitles.
  if (target && target !== contentLocale(audioLanguage) && target !== subtitles) throw fail()
  return { contentLocale: target, subtitleMode: v.subtitleMode as ContentDelivery['subtitleMode'], subtitleLanguage: subtitles, label: v.label.trim() }
}
export function readProductionSources(raw: unknown): ProductionSources {
  const v = saved(raw)
  return Object.fromEntries(['master', 'audio', 'subtitles', 'notes'].map(k => [k, typeof v[k] === 'string' ? v[k] : ''])) as unknown as ProductionSources
}
export function mergeProductionSources(raw: unknown, input: unknown): ProductionSources {
  const patch = object(input)
  if (Object.keys(patch).some(k => !['master', 'audio', 'subtitles', 'notes'].includes(k))) throw fail()
  const v = { ...readProductionSources(raw), ...patch }
  for (const entry of Object.values(v)) if (typeof entry !== 'string' || entry.length > 1500 || /\u0000/.test(entry)) throw fail()
  return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, value.trim()])) as unknown as ProductionSources
}
