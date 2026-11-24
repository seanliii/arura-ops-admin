import type { ContentListFilters } from '../shared/content-operations'
import { DRAMA_TEXT_LOCALES } from '../shared/drama-localizations'

export function newContentFilters(preferredLanguage = false): ContentListFilters {
  let language = ''
  if (preferredLanguage) {
    try {
      const value = localStorage.getItem('aurora:admin:content-language')
      if (DRAMA_TEXT_LOCALES.some(code => code === value)) language = value!
    } catch { /* 无本地存储时仍可使用筛选。 */ }
  }
  return { query: '', status: '', region: '', language, workView: 'all', page: 1, scrollY: 0 }
}

export function clearContentFilters(): ContentListFilters {
  try { localStorage.removeItem('aurora:admin:content-language') } catch { /* 不影响退出会话。 */ }
  return newContentFilters()
}
