import { isIP } from 'node:net'
import type { MediaRegistrationConfig } from '../shared/media-registration.js'

export function loadMediaRegistrationConfig(
  override?: MediaRegistrationConfig, env: NodeJS.ProcessEnv = process.env,
): MediaRegistrationConfig | undefined {
  const legacy = (override as (MediaRegistrationConfig & { japaneseLanguageId?: unknown }) | undefined)?.japaneseLanguageId
  const nonblank = (value: unknown) => value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== '')
  if (nonblank(legacy) || nonblank(env.TIKTOK_MEDIA_JA_LANGUAGE_ID)) {
    throw new Error('TIKTOK_MEDIA_JA_LANGUAGE_ID/japaneseLanguageId已废弃，请移除旧ID并显式设置TIKTOK_MEDIA_JA_LANGUAGE_CODE=ja；不会自动转换数字')
  }
  const publicOrigin = override?.publicOrigin ?? env.DRAMA_MEDIA_PUBLIC_ORIGIN?.trim() ?? ''
  const language = override?.japaneseLanguageCode ?? env.TIKTOK_MEDIA_JA_LANGUAGE_CODE?.trim() ?? ''
  if (!override && !publicOrigin && language === '') return undefined
  const invalid = () => new Error('云端剧目登记需要精确的公开HTTPS来源与显式日语码TIKTOK_MEDIA_JA_LANGUAGE_CODE=ja；没有默认语言值')
  if (typeof publicOrigin !== 'string' || language !== 'ja') throw invalid()
  let url: URL
  try { url = new URL(publicOrigin) } catch { throw invalid() }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.origin !== publicOrigin || url.username || url.password ||
    isIP(host) || host.startsWith('[') || !host.includes('.') ||
    host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
    ['localhost', 'local', 'internal', 'lan'].some(suffix => host === suffix || host.endsWith(`.${suffix}`))) throw invalid()
  return { publicOrigin, japaneseLanguageCode: language }
}
