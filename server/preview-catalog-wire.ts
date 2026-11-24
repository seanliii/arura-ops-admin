import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { PreviewManifest, PreviewOffer, PreviewReceipt } from '../shared/preview-catalog.js'
import { ApiError } from './types.js'
import { mergeDramaLocalizations } from './drama-localizations.js'
import { mergeDelivery } from './content-delivery.js'
import { isContentLanguage } from '../shared/content-language.js'
import { body, integer, number, strings, text } from './validation.js'

export const PREVIEW_TARGET = 'http://127.0.0.1:5315/api/admin/preview-catalog/receive'
export const PREVIEW_ORIGIN = 'https://auroradrama.app'
export const PREVIEW_SIGNATURE = 'X-Aurora-Preview-Signature'
export interface PreviewBridgeConfig { secret?: string; target?: string }
export interface PreviewPacket { kind: 'publish' | 'status'; issuedAt: number; releaseId: string; manifest?: PreviewManifest }
export const previewError = (status: number, code: string, message: string) => new ApiError(status, code, message)
export function previewConfig(mode: string, env: NodeJS.ProcessEnv = process.env): PreviewBridgeConfig {
  const secret = env.DRAMA_PREVIEW_CATALOG_SECRET?.trim() || ''
  const target = env.DRAMA_PREVIEW_CATALOG_TARGET?.trim() || ''
  if (!secret && !target) return {}
  if (!['production', 'staging'].includes(mode) || !/^[a-f0-9]{64}$/i.test(secret) ||
      (target && (mode !== 'production' || target !== PREVIEW_TARGET))) {
    throw Error('官方预览内容分发需独立64位十六进制密钥；仅production能配置固定本机5315接收地址')
  }
  return { secret, ...(target ? { target } : {}) }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k =>
    `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value)
}
export const previewHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
export const previewSignature = (packet: PreviewPacket, secret: string) =>
  createHmac('sha256', Buffer.from(secret, 'hex')).update(canonical(packet)).digest('hex')
export function validatePacket(input: unknown, signature: string | undefined, secret: string): PreviewPacket {
  const p = body(input)
  if (Object.keys(p).some(k => !['kind', 'issuedAt', 'releaseId', 'manifest'].includes(k)) ||
      !['publish', 'status'].includes(String(p.kind)) || typeof p.issuedAt !== 'number' ||
      !Number.isSafeInteger(p.issuedAt) || Math.abs(Date.now() - p.issuedAt) > 5 * 60_000 ||
      typeof p.releaseId !== 'string' || !/^[a-f0-9]{64}$/.test(p.releaseId) ||
      !signature || !/^[a-f0-9]{64}$/.test(signature)) {
    throw previewError(401, 'PREVIEW_AUTH_REQUIRED', '未通过内部内容发行认证')
  }
  const packet = p as unknown as PreviewPacket
  const expected = previewSignature(packet, secret)
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')) ||
      (packet.kind === 'publish' ? !packet.manifest || previewHash(packet.manifest) !== packet.releaseId : p.manifest !== undefined)) {
    throw previewError(401, 'PREVIEW_AUTH_REQUIRED', '未通过内部内容发行认证')
  }
  return packet
}
function only(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).some(k => !fields.includes(k))) throw previewError(400, 'PREVIEW_INVALID_FIELDS', '内容快照含不支持的字段')
}
function platformId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw previewError(400, 'PREVIEW_INVALID_ID', '平台ID必须为完整字符串')
  }
  return value
}
export function previewOffer(input: unknown, episodes: number): PreviewOffer {
  const v = body(input)
  only(v, ['freeEpisodes', 'episodePrice', 'bundlePrice'])
  return {
    freeEpisodes: integer(v.freeEpisodes, 'freeEpisodes', 0, episodes),
    episodePrice: integer(v.episodePrice, 'episodePrice', 1, 100000000),
    bundlePrice: integer(v.bundlePrice, 'bundlePrice', 1, 100000000),
  }
}
export function validateManifest(input: unknown, clientKey: string, region: string): PreviewManifest {
  const v = body(input)
  only(v, ['v', 'clientKey', 'sourceDramaId', 'sourceVersion', 'albumId', 'platformVersion', 'authorizedClientKey', 'drama', 'cover', 'episodes', 'offer'])
  if (v.v !== 1 || v.clientKey !== clientKey || v.authorizedClientKey !== clientKey) {
    throw previewError(409, 'PREVIEW_APP_MISMATCH', '内容快照不属于当前应用')
  }
  const d = body(v.drama), cover = body(v.cover)
  only(d, ['title', 'desc', 'category', 'language', 'regions', 'tags', 'localizations', 'delivery'])
  only(cover, ['mime', 'sha256', 'base64'])
  const regions = strings(d.regions, 'regions'), language = text(d.language, 'language', 20)
  if (!isContentLanguage(language) || !regions.includes(region) || regions.some(r => !/^[A-Z]{2}$/.test(r))) {
    throw previewError(409, 'PREVIEW_MARKET_MISMATCH', '内容原声或授权地区不适用于目标测试片库')
  }
  if (typeof cover.base64 !== 'string' || cover.base64.length > 800_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(cover.base64) ||
      typeof cover.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(cover.sha256) ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(String(cover.mime))) {
    throw previewError(400, 'PREVIEW_COVER_INVALID', '封面需为有效图片且不超过600KB')
  }
  if (!Array.isArray(v.episodes) || !v.episodes.length || v.episodes.length > 1000) {
    throw previewError(400, 'PREVIEW_EPISODES_INVALID', '发行快照需有1至1000个真实平台单集')
  }
  const ids = new Set<string>(), sourceIds = new Set<number>()
  const episodes = v.episodes.map((entry, index) => {
    const e = body(entry)
    only(e, ['sourceId', 'seq', 'title', 'durationSeconds', 'episodeId', 'vid'])
    const episodeId = platformId(e.episodeId), seq = integer(e.seq, 'seq', 1, 1000)
    const sourceId = integer(e.sourceId, 'sourceId', 1)
    const vid = text(e.vid, 'vid', 200)
    if (seq !== index + 1 || ids.has(episodeId) || sourceIds.has(sourceId) || !/^[A-Za-z0-9_-]+$/.test(vid)) {
      throw previewError(400, 'PREVIEW_EPISODES_INVALID', '平台单集ID需唯一、集号连续，不能填播放地址')
    }
    ids.add(episodeId); sourceIds.add(sourceId)
    return { sourceId, seq, episodeId, vid, title: text(e.title, 'title', 200), durationSeconds: number(e.durationSeconds, 'durationSeconds', 0, 86400) }
  })
  return {
    v: 1, clientKey, authorizedClientKey: clientKey,
    sourceDramaId: integer(v.sourceDramaId, 'sourceDramaId', 1), sourceVersion: integer(v.sourceVersion, 'sourceVersion', 1),
    albumId: platformId(v.albumId), platformVersion: integer(v.platformVersion, 'platformVersion', 1),
    drama: { title: text(d.title, 'title', 200), desc: text(d.desc, 'desc', 10000, true),
      category: text(d.category, 'category', 100), language, regions, tags: strings(d.tags, 'tags'),
      localizations: mergeDramaLocalizations('{}', d.localizations),
      ...(d.delivery !== undefined ? { delivery: mergeDelivery('{}', d.delivery, language) } : {}) },
    cover: { mime: String(cover.mime), sha256: cover.sha256, base64: cover.base64 },
    episodes, offer: previewOffer(v.offer, episodes.length),
  }
}
export async function deliverPreview(config: PreviewBridgeConfig, packet: PreviewPacket): Promise<PreviewReceipt | null> {
  if (!config.secret || config.target !== PREVIEW_TARGET) throw previewError(503, 'PREVIEW_UNCONFIGURED', '官方测试目标未配置')
  const response = await fetch(config.target, {
    method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(25_000),
    headers: { 'Content-Type': 'application/json', Origin: PREVIEW_ORIGIN, 'X-Requested-With': 'DramaVerseJP',
      [PREVIEW_SIGNATURE]: previewSignature(packet, config.secret) },
    body: canonical(packet),
  })
  if (!response.ok || response.redirected || !response.body) throw Error('PREVIEW_TARGET_UNAVAILABLE')
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength
    if (bytes > 64 * 1024) throw Error('PREVIEW_RESPONSE_TOO_LARGE')
    chunks.push(chunk)
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (data.receipt === null && packet.kind === 'status') return null
  const receipt = data.receipt as PreviewReceipt
  if (!receipt || receipt.releaseId !== packet.releaseId ||
      !['checking', 'published', 'failed', 'unknown'].includes(receipt.state)) throw Error('PREVIEW_INVALID_RECEIPT')
  return receipt
}
