/** 内容原声与发行地区分别记录；未知语言不能靠修改标签进入片库。 */
export const CONTENT_LANGUAGES = ['ja', 'en', 'zh', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'ar', 'ko', 'th', 'vi', 'id', 'pt-BR', 'es-419', 'ms'] as const
export type ContentLanguage = typeof CONTENT_LANGUAGES[number]
export function isContentLanguage(value: unknown): value is ContentLanguage {
  return typeof value === 'string' && CONTENT_LANGUAGES.some(language => language === value)
}
