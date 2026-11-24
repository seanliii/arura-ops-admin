import { Client, Command } from '@byteplus/sdk-core'
import { isIP } from 'node:net'
import { fixedEndpointTransport } from './byteplus-upload-client.js'
import { ApiError, type ServerConfig } from './types.js'

export type WebPlaybackConfig = NonNullable<ServerConfig['webPlayback']>
export const webVideoFailure = () => new ApiError(502, 'WEB_VIDEO_UNAVAILABLE', '视频服务暂时不可用，请重试')

export function loadWebPlaybackConfig(override?: WebPlaybackConfig): WebPlaybackConfig | undefined {
  const names = ['DRAMA_WEB_PLAYBACK_ORIGIN', 'BYTEPLUS_WEB_REGION', 'BYTEPLUS_WEB_ACCESS_KEY_ID', 'BYTEPLUS_WEB_SECRET_ACCESS_KEY']
  if (!override && !names.some(name => process.env[name])) return undefined
  const [origin, region, accessKeyId, secretAccessKey] = names.map(name => process.env[name]?.trim() ?? '')
  const value = override ?? { origin, region, accessKeyId, secretAccessKey }
  const fail = () => { throw new Error('网页视频配置不完整：需要精确HTTPS视频域名、区域与专用只读密钥') }
  try {
    const u = new URL(value.origin)
    if (u.protocol !== 'https:' || u.origin !== value.origin || u.username || u.password || u.port
      || isIP(u.hostname) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(u.hostname)
      || u.hostname.endsWith('.localhost') || !['ap-southeast-1', 'ap-singapore-1'].includes(value.region)
      || [value.accessKeyId, value.secretAccessKey].some(s => !s || s.length > 1024 || /\s/.test(s))) fail()
  } catch { fail() }
  return { ...value }
}

/** The signed URL stays in server memory. Only an opaque, free-episode grant reaches the viewer. */
export async function getWebVideo(config: WebPlaybackConfig, vid: string): Promise<{ url: string; size: number }> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(vid)) throw webVideoFailure()
  try {
    const client = new Client({
      accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey,
      region: config.region, host: 'vod.byteplusapi.com', protocol: 'https',
      autoRetry: false, maxRetries: 0, debugOptions: { debug: false },
      requestHandler: fixedEndpointTransport('vod.byteplusapi.com'),
    })
    const command = new Command<Record<string, string>, unknown>({
      Vid: vid, Ssl: '1', Format: 'mp4', Domain: new URL(config.origin).hostname,
    })
    command.requestConfig = {
      method: 'GET', serviceName: 'vod', pathname: '/', contentType: 'application/json',
      params: { Action: 'GetPlayInfo', Version: '2023-01-01' },
    }
    const response = await client.send(command) as {
      ResponseMetadata?: { Error?: unknown }
      Result?: { Vid?: string; PlayInfoList?: { MainPlayUrl?: string; Format?: string; Codec?: string; Size?: number }[] }
    }
    if (response.ResponseMetadata?.Error || response.Result?.Vid !== vid || !Array.isArray(response.Result.PlayInfoList)) throw webVideoFailure()
    const candidates = response.Result.PlayInfoList.filter(p => typeof p.Format === 'string' && p.Format.toLowerCase() === 'mp4'
      && typeof p.Codec === 'string' && ['h264', 'avc'].includes(p.Codec.toLowerCase()))
    for (const p of candidates) {
      let url: URL
      try { url = new URL(p.MainPlayUrl ?? '') } catch { continue }
      if (url.origin !== config.origin || url.username || url.password || url.hash || !url.searchParams.get('auth_key')
        || !Number.isSafeInteger(p.Size) || p.Size! <= 0 || p.Size! > 20_000_000_000) continue
      return { url: url.href, size: p.Size! }
    }
    throw webVideoFailure()
  } catch {
    // SDK exceptions may contain credentials, signed URLs and upstream bodies.
    throw webVideoFailure()
  }
}
