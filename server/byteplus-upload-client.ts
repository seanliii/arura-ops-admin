import { Client, Command, type ClientConfig } from '@byteplus/sdk-core'
import { AssumeRoleCommand, STSClient } from '@byteplus/sts'
import type { BytePlusUploadConfig, CloudMediaObservation, CloudUploadCredentials } from '../shared/cloud-upload.js'
import { ApiError } from './types.js'

const STS_HOST = 'sts.ap-southeast-1.byteplusapi.com'
const VOD_HOST = 'vod.byteplusapi.com'
const TIMEOUT_MS = 10_000
const RESPONSE_MAX_BYTES = 1_048_576
const CREDENTIAL_DURATION_SECONDS = 900
const CLOCK_SKEW_MS = 60_000

const upstreamFailure = () => new ApiError(502, 'BYTEPLUS_UPLOAD_FAILED', '云端视频服务暂时不可用，请稍后重试')
const invalidInput = () => new ApiError(400, 'CLOUD_UPLOAD_INPUT_INVALID', '云上传参数无效')

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function isSecret(value: unknown, maxLength: number): value is string {
  return isText(value, maxLength) && /^[\x21-\x7e]+$/.test(value)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw upstreamFailure()
  return value as Record<string, unknown>
}

function resultOf(value: unknown): Record<string, unknown> {
  const response = object(value)
  if (response.ResponseMetadata !== undefined) {
    const metadata = object(response.ResponseMetadata)
    if (metadata.Error !== undefined && metadata.Error !== null) throw upstreamFailure()
  }
  return object(response.Result)
}

async function readJSON(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length')
  if (!response.ok || response.redirected || !response.body
    || (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > RESPONSE_MAX_BYTES))) {
    void response.body?.cancel().catch(() => {})
    throw upstreamFailure()
  }

  // 不相信 Content-Length；按实际收到的字节限制，避免 chunked/压缩响应绕过。
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > RESPONSE_MAX_BYTES) throw upstreamFailure()
      chunks.push(value)
    }
  } catch {
    void reader.cancel().catch(() => {})
    throw upstreamFailure()
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown
}

type RequestHandler = NonNullable<ClientConfig['requestHandler']>
type SignedRequest = Parameters<RequestHandler['request']>[0]

export function fixedEndpointTransport(host: string): RequestHandler {
  return {
    async request<T>(request: SignedRequest) {
      const url = new URL(request.url)
      if (url.origin !== `https://${host}` || url.pathname !== '/' || url.username || url.password || url.hash
        || !['GET', 'POST'].includes(request.method ?? '')
        || (request.data !== undefined && typeof request.data !== 'string')) {
        throw upstreamFailure()
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        // 官方 SDK 已完成表单编码和 V4 签名。传输层不重新序列化或签名。
        // core 1.0.2 的默认 Axios handler 不透传 maxRedirects，故使用公开 requestHandler 接口。
        const response = await fetch(url, {
          method: request.method,
          headers: request.headers,
          body: request.data,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal,
        })
        const data = await readJSON(response)
        const headers: Record<string, string> = {}
        response.headers.forEach((value, name) => { headers[name] = value })
        return {
          status: response.status,
          statusText: response.statusText,
          headers,
          data: data as T,
        }
      } finally {
        // 必须读完响应体才结束超时保护，而不只是等到响应头。
        clearTimeout(timeout)
      }
    },
  }
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw upstreamFailure()
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw upstreamFailure()
  return parsed
}

function parseCredentials(response: unknown, accessKeyId: string, secretAccessKey: string): CloudUploadCredentials {
  const source = object(resultOf(response).Credentials)
  const { AccessKeyId, SecretAccessKey, SessionToken, CurrentTime, ExpiredTime } = source
  if (!isSecret(AccessKeyId, 256) || !isSecret(SecretAccessKey, 1024) || !isSecret(SessionToken, 16_384)
    || typeof CurrentTime !== 'string' || typeof ExpiredTime !== 'string') throw upstreamFailure()
  const issuedAt = timestamp(CurrentTime)
  const expiresAt = timestamp(ExpiredTime)
  const now = Date.now()
  if (Math.abs(issuedAt - now) > CLOCK_SKEW_MS || expiresAt <= now + 30_000 || expiresAt <= issuedAt
    || expiresAt - issuedAt > CREDENTIAL_DURATION_SECONDS * 1000) throw upstreamFailure()

  const credentials = { AccessKeyId, SecretAccessKey, SessionToken, CurrentTime, ExpiredTime }
  // 不复制未知字段，也不允许服务异常时把长期密钥装进临时字段。
  if (Object.values(credentials).some(value => value.includes(accessKeyId) || value.includes(secretAccessKey))) {
    throw upstreamFailure()
  }
  return credentials
}

function parseMedia(response: unknown, vid: string, spaceName: string): CloudMediaObservation {
  const result = resultOf(response)
  if (result.NotExistVids !== undefined
    && (!Array.isArray(result.NotExistVids) || result.NotExistVids.length !== 0)) throw upstreamFailure()
  if (!Array.isArray(result.MediaInfoList) || result.MediaInfoList.length !== 1) throw upstreamFailure()
  const media = object(result.MediaInfoList[0])
  const basic = object(media.BasicInfo)
  const source = object(media.SourceInfo)
  if (basic.Vid !== vid || basic.SpaceName !== spaceName || !isText(basic.Title, 1024)
    || (basic.PublishStatus !== 'Published' && basic.PublishStatus !== 'Unpublished')
    || typeof source.Size !== 'number' || !Number.isSafeInteger(source.Size) || source.Size <= 0
    || typeof source.Duration !== 'number' || !Number.isFinite(source.Duration)
    || source.Duration <= 0 || source.Duration > Number.MAX_SAFE_INTEGER
    || !isText(source.Format, 32) || (source.FileType !== 'video' && source.FileType !== 'audio')) {
    throw upstreamFailure()
  }
  // 原片地址、StoreUri、转码文件和其他第三方字段不离开此适配器。
  return {
    vid,
    spaceName,
    title: basic.Title,
    bytes: source.Size,
    durationSeconds: source.Duration,
    format: source.Format,
    fileType: source.FileType,
    publishStatus: basic.PublishStatus,
  }
}

export function createBytePlusUploadClient(config: BytePlusUploadConfig) {
  // 只取已声明配置并保存副本，不让配置对象后续变化串到已有上传任务。
  const { accountId, spaceName, roleTrn, vodRegion, stsRegion, accessKeyId, secretAccessKey } = { ...config }
  if (!isText(accountId, 32) || !/^\d+$/.test(accountId)
    || !isText(spaceName, 128) || !/^[A-Za-z0-9_-]+$/.test(spaceName)
    || !isText(roleTrn, 256) || !new RegExp(`^trn:iam::${accountId}:role/[A-Za-z0-9_+=,.@/-]+$`).test(roleTrn)
    || (vodRegion !== 'ap-singapore-1' && vodRegion !== 'ap-southeast-1') || stsRegion !== 'ap-southeast-1'
    || !isSecret(accessKeyId, 256) || !isSecret(secretAccessKey, 1024)) {
    throw new ApiError(503, 'CLOUD_UPLOAD_CONFIG_INVALID', '云上传服务配置无效')
  }
  const common: ClientConfig = {
    accessKeyId, secretAccessKey, protocol: 'https',
    autoRetry: false, maxRetries: 0, debugOptions: { debug: false },
    httpOptions: { timeout: TIMEOUT_MS },
  }
  let sts: STSClient
  let vod: Client
  try {
    sts = new STSClient({
      ...common, host: STS_HOST, region: 'ap-southeast-1', requestHandler: fixedEndpointTransport(STS_HOST),
    })
    vod = new Client({
      ...common, host: VOD_HOST, region: vodRegion, requestHandler: fixedEndpointTransport(VOD_HOST),
    })
  } catch {
    throw upstreamFailure()
  }
  const policy = JSON.stringify({
    Statement: [{
      Effect: 'Allow',
      Action: ['vod:ApplyUploadInfo', 'vod:CommitUploadInfo'],
      // VOD 按实际空间地域鉴权；省略地域仍可拿到 STS，但 ApplyUploadInfo 会拒绝。
      Resource: [`trn:vod:${vodRegion}:${accountId}:space/${spaceName}`],
    }],
  })

  return {
    async issueCredentials(sessionName: string): Promise<CloudUploadCredentials> {
      if (typeof sessionName !== 'string' || !/^[A-Za-z0-9_+=,.@-]{2,64}$/.test(sessionName)) throw invalidInput()
      try {
        const response = await sts.send(new AssumeRoleCommand({
          RoleTrn: roleTrn,
          RoleSessionName: sessionName,
          DurationSeconds: CREDENTIAL_DURATION_SECONDS,
          Policy: policy,
        }))
        return parseCredentials(response, accessKeyId, secretAccessKey)
      } catch {
        // SDK 错误会附带签名请求/原始响应；不得把它作为 cause 或诊断字段传出。
        throw upstreamFailure()
      }
    },
    async getMedia(vid: string): Promise<CloudMediaObservation> {
      if (typeof vid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(vid)) throw invalidInput()
      try {
        const command = new Command<{ Vids: string }, unknown>({ Vids: vid })
        command.requestConfig = {
          method: 'GET', serviceName: 'vod', pathname: '/',
          params: { Action: 'GetMediaInfos', Version: '2023-01-01' },
        }
        return parseMedia(await vod.send(command), vid, spaceName)
      } catch {
        throw upstreamFailure()
      }
    },
  }
}
