import { DRAMA_TEXT_LOCALES, type DramaTextLocale } from './drama-localizations.js'

/** The audio language remains Drama.language; this describes a completed delivery, not UI text. */
export interface ContentDelivery {
  contentLocale: DramaTextLocale | null
  subtitleMode: 'unknown' | 'none' | 'burned' | 'external'
  subtitleLanguage: DramaTextLocale | null
  label: string
}
/** Private source-location index. Saving this does not upload or back up production masters. */
export interface ProductionSources {
  master: string
  audio: string
  subtitles: string
  notes: string
}
export function contentLocale(value: unknown): DramaTextLocale | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) return null
  try {
    const parts = Intl.getCanonicalLocales(value.trim().replace(/_/g, '-'))[0].toLowerCase().split('-')
    if (parts[0] === 'pt') return parts.length === 1 || parts.includes('br') ? 'pt-BR' : null
    if (parts[0] === 'es' && parts.some(p => ['419', 'mx', 'ar', 'bo', 'cl', 'co', 'cr', 'cu', 'do', 'ec', 'gt', 'hn', 'ni', 'pa', 'pe', 'pr', 'py', 'sv', 'uy', 've', 'us', 'bz'].includes(p))) return 'es-419'
    if (parts[0] === 'zh') {
      if (parts.includes('hans')) return 'zh-Hans'
      if (parts.includes('hant') || parts.some(p => ['tw', 'hk', 'mo'].includes(p))) return 'zh-Hant'
      return 'zh-Hans'
    }
    return DRAMA_TEXT_LOCALES.includes(parts[0] as DramaTextLocale) ? parts[0] as DramaTextLocale : null
  } catch { return null }
}
export function audienceLanguage(drama: { language?: string; delivery?: ContentDelivery }): DramaTextLocale | null {
  // An explicit "not yet confirmed" is not permission to infer a channel from the audio.
  return drama.delivery ? drama.delivery.contentLocale : contentLocale(drama.language)
}
