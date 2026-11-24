export const DRAMA_TEXT_LOCALES = ['zh-Hans', 'en', 'zh-Hant', 'ja', 'es', 'fr', 'ar', 'ko', 'th', 'vi', 'id', 'pt-BR', 'es-419', 'ms'] as const
export type DramaTextLocale = typeof DRAMA_TEXT_LOCALES[number]
export interface DramaLocalizedText { title?: string; desc?: string }
/** 可选内容译文；不是配音/字幕可用性，也不覆盖原始标题和简介。 */
export type DramaLocalizations = Partial<Record<DramaTextLocale, DramaLocalizedText>>
