import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

/**
 * 协议依据：artifacts/media-integration-20261015/{api-reference,management,player}.txt。
 * 原文差异 / 尚未确认的部分：
 * - client_key 在参数表、body、client-key header 示例中不一致。GET 用 query；
 *   POST 编辑、字幕上传/绑定、上下架以参数表为准带 body key，视频上传按 body 示例。
 *   兼容保留业务 URL 的 query key，但不把 query-only 或冗余传参当成已验证的线上契约。
 * - 创建参数表为空，curl 实际发送 {}；这里遵循示例，仍须真实 sandbox 确认。
 * - token 的 token_type 表述是 Bearer，但示例值写成 client_credentials；只接受 Bearer。
 * - 字幕示例漏了参数表必填的 space_name；以参数表为准。
 * - AlbumInfo / EpisodeInfo / SubtitleInfo 的返回定义不完整：未知元信息保留为 Record，
 *   剧集验证 episode_id / seq / byteplus_vid。2026-10-20有限实测确认language为字符串ja；
 *   其他语言码仅作规范格式校验，不宣称已获平台支持，标签也没有默认值。
 * - online_version “empty” 未定义编码；接受缺失或 null，不猜测成 0，也不把字符串当版本。
 * 本文件的 mock 合同测试不是线上可用性认证，不能据此声称全部接口已在真实环境可用。
 */

export interface MediaClientConfig { clientKey: string; clientSecret: string }

export interface MediaEpisodeInfo extends Record<string, unknown> {
  episode_id: string
  seq: number
  byteplus_vid: string
}
export interface MediaAlbumVersionInfo extends Record<string, unknown> {
  album_id: string
  version: number
  album_info?: Record<string, unknown>
  episode_info_list?: MediaEpisodeInfo[]
  current_version?: number
  online_version?: number | null
  publish_status?: number
  review_status?: number
}
export interface MediaAlbumQueryResult { album_version_list: MediaAlbumVersionInfo[] }

// 内嵌字段的 Required 列未给出，不把本地业务表单的必填规则冒充官方协议。
export interface MediaAlbumInfoInput {
  language?: string
  title?: string
  seqNum?: number
  coverList?: string[]
  year?: number
  albumStatus?: 1 | 2 | 3
  desp?: string
  dramaType?: 1 | 2 | 3 | 4
  tagList?: number[]
  publishStatus?: 0 | 1 | 2
}
export interface MediaEpisodeInput {
  episodeId?: string
  title?: string
  seq: number
  coverList?: string[]
  byteplusVid: string
}
export type MediaUpdateAlbumInput = { albumId: string; version?: number } & (
  | { operationType?: 1; albumInfo?: MediaAlbumInfoInput; episodeInfoList: MediaEpisodeInput[] }
  | { operationType: 2; albumStatus: 1 | 2 | 3 }
)
export interface MediaAlbumCreatedResult { albumId: string; version: number | null }
export interface MediaAlbumUpdatedResult {
  albumId: string
  version: number
  episodeIdMap?: Record<string, string>
  albumStatus?: 1 | 2 | 3
  publishStatus?: 0 | 1 | 2
}
export interface MediaImageResult { openPicId: string; tiktokPicUrl: string | null }
export interface MediaVideoUploadInput {
  url: string
  title: string
  spaceName: string
  byteplusAccountId: string
}
export interface MediaExistingVideoInput {
  vid: string
  title: string
  spaceName: string
  byteplusAccountId: string
  byteplusRegion: 'ap-southeast-1'
}
export interface MediaExistingVideoResult { byteplusVid: string }
export type MediaVideoUploadResult =
  | { resultType: 2; status: 'processing'; jobId: string }
  | { resultType: 1; status: 'succeeded'; byteplusVid: string; jobId?: string }
export interface MediaAssetQueryInput { jobId?: string; vid?: string; byteplusAccountId: string }
type MediaUploadProgress =
  | { uploadStatus: 1; status: 'processing' }
  | { uploadStatus: 2; status: 'succeeded' }
  | { uploadStatus: 3; status: 'failed' }
export type MediaVideoQueryResult = {
  jobId?: string; title?: string; durationMs?: number; coverUrl?: string
} & (
  | { uploadStatus: 1; status: 'processing'; vid?: string }
  | { uploadStatus: 2; status: 'succeeded'; vid: string }
  | { uploadStatus: 3; status: 'failed'; vid?: string }
)
export interface MediaSubtitleUploadInput {
  subtitleUrl: string; language: string; spaceName: string; byteplusAccountId: string
}
export interface MediaSubtitleUploadResult { jobId: string }
export type MediaSubtitleQueryResult = { jobId?: string; vid?: string } & (
  | { uploadStatus: 1; status: 'processing'; subtitleInfoList?: Record<string, unknown>[] }
  | { uploadStatus: 2; status: 'succeeded'; subtitleInfoList: Record<string, unknown>[] }
  | { uploadStatus: 3; status: 'failed'; subtitleInfoList?: Record<string, unknown>[] }
)
export interface MediaSubtitleBindInput { vid: string; subtitleId: string }
export interface MediaSubtitleBindResult { vid: string; subtitleId: string }
export interface MediaAuthorizationResult { clientKey: string; authStatus: 1 }
export interface MediaReviewResult { resultType: 1; reviewId: string }
export interface MediaOnlineVersionResult { albumId: string; onlineVersion: number }
export interface MediaAlbumStatusResult { albumId: string; status: 1 | 2 }
export interface MediaPlayTokenResult { playAuthToken: string }

export interface MediaClient {
  queryAlbum(albumId: string, version?: number): Promise<MediaAlbumQueryResult>
  getPlayToken(episodeId: string): Promise<MediaPlayTokenResult>
  createAlbum(): Promise<MediaAlbumCreatedResult>
  updateAlbum(input: MediaUpdateAlbumInput): Promise<MediaAlbumUpdatedResult>
  createImage(imageUrl: string): Promise<MediaImageResult>
  uploadVideo(input: MediaVideoUploadInput): Promise<MediaVideoUploadResult>
  registerExistingVideo?(input: MediaExistingVideoInput): Promise<MediaExistingVideoResult>
  queryVideo(input: MediaAssetQueryInput): Promise<MediaVideoQueryResult>
  uploadSubtitle(input: MediaSubtitleUploadInput): Promise<MediaSubtitleUploadResult>
  querySubtitle(input: MediaAssetQueryInput): Promise<MediaSubtitleQueryResult>
  bindSubtitle(input: MediaSubtitleBindInput): Promise<MediaSubtitleBindResult>
  authorizeAlbum(albumId: string): Promise<MediaAuthorizationResult>
  submitReview(albumId: string, version: number, priority?: 1 | 2): Promise<MediaReviewResult>
  setOnlineVersion(albumId: string, version: number): Promise<MediaOnlineVersionResult>
  setAlbumStatus(albumId: string, status: 1 | 2): Promise<MediaAlbumStatusResult>
}

const ERRORS = {
  MEDIA_INVALID_INPUT: [400, '媒资请求参数无效，或文件地址不是可接受的公共 HTTPS 地址'],
  MEDIA_RUNTIME_UNSUPPORTED: [503, '当前运行时不支持无损 JSON 读写'],
  MEDIA_TOKEN_UNAVAILABLE: [502, '无法取得有效的媒资客户端授权，未发送本次业务请求'],
  MEDIA_REQUEST_FAILED: [502, '媒资查询请求失败'],
  MEDIA_RESPONSE_INVALID: [502, '媒资响应不符合已确认的协议'],
  MEDIA_REJECTED: [502, '平台明确拒绝了本次媒资请求'],
  MEDIA_VIDEO_NOT_FOUND: [404, '平台明确表示该视频尚未登记'],
  MEDIA_PARTIAL_SUCCESS: [502, '平台报告部分成功；请先查询确认，不能按全部成功处理或直接重放'],
  MEDIA_MUTATION_UNKNOWN: [502, '媒资变更结果不明；请先查询确认，不要直接重放请求'],
} as const
export type MediaErrorCode = keyof typeof ERRORS

/** 只保存本地固定错误码和文案；不附带上游 body、URL、异常 cause 或授权信息。 */
export class MediaClientError extends Error {
  readonly code: MediaErrorCode
  readonly status: number
  constructor(code: MediaErrorCode) {
    super(ERRORS[code][1])
    this.name = 'MediaClientError'
    this.code = code
    this.status = ERRORS[code][0]
  }
}
export class MediaMutationUnknownError extends MediaClientError {
  constructor() { super('MEDIA_MUTATION_UNKNOWN'); this.name = 'MediaMutationUnknownError' }
}
export class MediaPartialSuccessError extends MediaClientError {
  constructor() { super('MEDIA_PARTIAL_SUCCESS'); this.name = 'MediaPartialSuccessError' }
}

const ORIGIN = 'https://open.tiktokapis.com'
const TOKEN_URL = `${ORIGIN}/v2/oauth/token/`
const PATHS = {
  image: '/v2/sg/shortdrama/image',
  video: '/v2/sg/shortdrama/video',
  create: '/v2/sg/shortdrama/album/create/',
  update: '/v2/sg/shortdrama/album/update/',
  query: '/v2/sg/shortdrama/album/query/',
  subtitle: '/v2/sg/shortdrama/subtitle/',
  bind: '/v2/sg/shortdrama/subtitle/bind/',
  authorize: '/v2/sg/shortdrama/album/authorize/',
  review: '/v2/sg/shortdrama/album/review/submit/',
  online: '/v2/sg/shortdrama/album/online_version/',
  status: '/v2/sg/shortdrama/album/status/',
  playToken: '/v2/sg/shortdrama/play_token/',
} as const
type MediaPath = typeof PATHS[keyof typeof PATHS]
const bodyClientKeyPaths = new Set<MediaPath>([PATHS.update, PATHS.video, PATHS.subtitle, PATHS.bind, PATHS.status])

class InvalidShape extends Error {}
function ensure(condition: unknown): asserts condition { if (!condition) throw new InvalidShape() }
function record(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function text(value: unknown, allowEmpty = false): string {
  ensure(typeof value === 'string' && (allowEmpty || value.trim().length > 0))
  return value
}
function languageCode(value: unknown): string {
  const code = text(value)
  // 不转换数字或自动改写大小写；仅接受安全、规范形式的语言码。
  ensure(code.length <= 64 && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(code))
  ensure(Intl.getCanonicalLocales(code)[0] === code)
  return code
}
function integer(value: unknown, minimum = 0): number {
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum)
  return value
}
function oneOf<T extends number>(value: unknown, allowed: readonly T[]): T {
  ensure(typeof value === 'number' && allowed.includes(value as T))
  return value as T
}
function id(value: unknown): string {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  ensure(typeof result === 'string' && /^[1-9]\d{0,18}$/.test(result))
  ensure(BigInt(result) <= 9223372036854775807n)
  return result
}
function inputId(value: unknown): string { ensure(typeof value === 'string'); return id(value) }
function list<T>(value: unknown, convert: (item: unknown) => T): T[] {
  ensure(Array.isArray(value))
  return Array.from(value, convert)
}
function input<T>(validate: () => T): T {
  try { return validate() } catch { throw new MediaClientError('MEDIA_INVALID_INPUT') }
}
function responseInvalid(mutation: boolean): MediaClientError {
  return mutation ? new MediaMutationUnknownError() : new MediaClientError('MEDIA_RESPONSE_INVALID')
}

// ES2022 项目配置尚无这两个 API 的声明；局部描述原生能力，不改共享 types 或 lib。
interface SourceJSON {
  parse(source: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown): unknown
  rawJSON(source: string): unknown
}
function nativeJSON(): SourceJSON { return JSON as unknown as SourceJSON }
function checkRuntime(): void {
  try {
    const runtime = nativeJSON()
    ensure(typeof runtime.rawJSON === 'function')
    const probe = runtime.parse('{"id":9223372036854775807}', (key, value, context) => key === 'id' ? context?.source : value)
    ensure(record(probe).id === '9223372036854775807')
    ensure(JSON.stringify({ id: runtime.rawJSON('9223372036854775807') }) === '{"id":9223372036854775807}')
  } catch { throw new MediaClientError('MEDIA_RUNTIME_UNSUPPORTED') }
}
function parseResponse(source: string): unknown {
  return nativeJSON().parse(source, (key, value, context) => {
    if (typeof value === 'number') {
      ensure(typeof context?.source === 'string')
      if (
        key === 'album_id' || key === 'episode_id' || key === 'review_id' ||
        !Number.isFinite(value) || (Number.isInteger(value) && (
          !Number.isSafeInteger(value) || !/^-?(0|[1-9]\d*)$/.test(context.source)
        ))
      ) {
        // 使用原文 token 而非已舍入的 number；小数/指数写法也不能借舍入冒充整数。
        return context.source
      }
    }
    return value
  })
}
function wireId(value: unknown): unknown { return nativeJSON().rawJSON(inputId(value)) }

async function deadline<T>(work: (signal: AbortSignal) => Promise<T>, milliseconds = 15_000): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new InvalidShape()) }, milliseconds)
      }),
    ])
  } finally { clearTimeout(timer) }
}

const nonPublic = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublic.addSubnet(address, prefix, 'ipv4')
nonPublic.addAddress('168.63.129.16', 'ipv4') // Azure 平台虚拟 IP，不是公共媒资主机。
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20],
] as const) nonPublic.addSubnet(address, prefix, 'ipv6')
const globalIPv6 = new BlockList()
globalIPv6.addSubnet('2000::', 3, 'ipv6')
function publicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !nonPublic.check(address, 'ipv4')
  // 不接受 IPv4-mapped、NAT64、6to4 等绕行表示；公共 IPv4 可以使用原始 IPv4 地址。
  return family === 6 && globalIPv6.check(address, 'ipv6') && !nonPublic.check(address, 'ipv6')
}
function httpsURL(value: unknown): URL {
  const source = text(value)
  ensure(/^https:\/\//i.test(source) && !/[\s\\#]/.test(source))
  const url = new URL(source)
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.hash)
  ensure(!source.slice(source.indexOf('//') + 2).split(/[/?]/, 1)[0].includes('@'))
  return url
}
async function fileURL(value: unknown): Promise<string> {
  try {
    const url = httpsURL(value)
    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
    if (isIP(hostname)) ensure(publicAddress(hostname))
    else {
      ensure(hostname.includes('.'))
      ensure(hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
      const localNames = ['localhost', 'local', 'internal', 'localdomain', 'lan', 'home', 'home.arpa', 'test', 'invalid', 'example', 'onion']
      ensure(!localNames.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)))
      const addresses = await deadline(() => lookup(hostname, { all: true, verbatim: true }), 5_000)
      ensure(addresses.length > 0 && addresses.every(item => isIP(item.address) === item.family && publicAddress(item.address)))
    }
    // 仅做 DNS 检查，不下载文件，也不跟随素材 URL 的重定向。平台的 DNS 重绑定与
    // 后续重定向必须由平台抓取器自行防护；本地检查不能保证另一台机器稍后的解析结果。
    return value as string
  } catch { throw new MediaClientError('MEDIA_INVALID_INPUT') }
}

function businessData(root: Record<string, unknown>, mutation: boolean, asyncUpload: boolean): Record<string, unknown> {
  const data = root.data === undefined ? root : record(root.data)
  const containers = data === root ? [root] : [root, data]
  let succeeded = false
  let rejected = false
  for (const item of containers) {
    // 原文只提及 Error 但未定义其格式，不能把无法识别的错误包装忽略成成功。
    ensure(!('Error' in item))
    if ('error' in item) {
      const error = record(item.error)
      // 真实回执的纯log_id只是追踪元数据，不是成功标志；业务字段仍由各接口验证。
      const logOnly = Object.keys(error).length === 1 &&
        typeof error.log_id === 'string' && error.log_id.trim().length > 0
      if (!logOnly) {
        const code = error.code
        ensure((typeof code === 'string' && code.length > 0) || (typeof code === 'number' && Number.isSafeInteger(code) && code !== 0))
        if (code === 'ok') succeeded = true
        else rejected = true
      }
    }
    if ('BaseResp' in item) {
      const code = integer(record(item.BaseResp).StatusCode, Number.MIN_SAFE_INTEGER)
      if (code === 0) succeeded = true
      else rejected = true
    }
  }
  if (rejected) {
    const hasReceipt = containers.some(item =>
      ['album_id', 'open_pic_id', 'job_id', 'vid', 'byteplus_vid', 'review_id', 'subtitle_id', 'client_key_result_list'].some(key => key in item) ||
      item.result_type === 1 || item.result_type === 2)
    if (mutation && (succeeded || hasReceipt)) throw new MediaMutationUnknownError()
    throw new MediaClientError('MEDIA_REJECTED')
  }
  for (const item of containers) if ('result_type' in item) {
    const resultType = oneOf(item.result_type, [1, 2, 3])
    if (resultType === 3) throw new MediaClientError('MEDIA_REJECTED')
    if (resultType === 2 && !asyncUpload) throw new MediaPartialSuccessError()
  }
  // 统一包装缺失时并不直接成功；调用者仍须验证每个接口的具体业务字段。
  return data
}

function optionalText(data: Record<string, unknown>, key: string): string | undefined {
  if (data[key] === undefined || data[key] === '') return undefined
  return text(data[key])
}
function progress(value: unknown): MediaUploadProgress {
  switch (oneOf(value, [1, 2, 3])) {
    case 1: return { uploadStatus: 1, status: 'processing' }
    case 2: return { uploadStatus: 2, status: 'succeeded' }
    default: return { uploadStatus: 3, status: 'failed' }
  }
}
function queryInput(value: MediaAssetQueryInput): Record<string, string> {
  const source = record(value)
  const result: Record<string, string> = { byteplus_account_id: text(source.byteplusAccountId) }
  if (source.jobId !== undefined) result.job_id = text(source.jobId)
  if (source.vid !== undefined) result.vid = text(source.vid)
  ensure(result.job_id || result.vid)
  return result
}
function queryIdentity(data: Record<string, unknown>, query: Record<string, string>) {
  const jobId = optionalText(data, 'job_id')
  const vid = optionalText(data, 'vid')
  if (jobId && query.job_id) ensure(jobId === query.job_id)
  if (vid && query.vid) ensure(vid === query.vid)
  ensure(jobId || vid)
  return { ...(jobId ? { jobId } : {}), ...(vid ? { vid } : {}) }
}
function albumInfoInput(value: unknown): Record<string, unknown> {
  const source = record(value)
  const result: Record<string, unknown> = {}
  const fields: [keyof MediaAlbumInfoInput, string, (value: unknown) => unknown][] = [
    ['language', 'language', languageCode],
    ['title', 'title', value => text(value)],
    ['seqNum', 'seq_num', value => integer(value, 1)],
    ['coverList', 'cover_list', value => list(value, item => text(item))],
    ['year', 'year', value => integer(value, 1)],
    ['albumStatus', 'album_status', value => oneOf(value, [1, 2, 3])],
    ['desp', 'desp', value => text(value, true)],
    ['dramaType', 'drama_type', value => oneOf(value, [1, 2, 3, 4])],
    ['tagList', 'tag_list', value => list(value, item => integer(item))],
    ['publishStatus', 'publish_status', value => oneOf(value, [0, 1, 2])],
  ]
  for (const [camel, wire, validate] of fields) if (source[camel] !== undefined) result[wire] = validate(source[camel])
  return result
}
function updateBody(value: MediaUpdateAlbumInput): Record<string, unknown> {
  const source = record(value)
  const operation = source.operationType === undefined ? 1 : oneOf(source.operationType, [1, 2])
  const result: Record<string, unknown> = { album_id: wireId(source.albumId), operation_type: operation }
  if (source.version !== undefined) result.version = integer(source.version, 1)
  if (operation === 2) result.album_status = oneOf(source.albumStatus, [1, 2, 3])
  else {
    // 首次补充信息时 album_info 必填；是否首次由平台状态决定，SDK 不凭空猜测。
    if (source.albumInfo !== undefined) result.album_info = albumInfoInput(source.albumInfo)
    result.episode_info_list = list(source.episodeInfoList, value => {
      const episode = record(value)
      const result: Record<string, unknown> = {}
      if (episode.episodeId !== undefined) result.episode_id = inputId(episode.episodeId) // 原文明示 string。
      if (episode.title !== undefined) result.title = text(episode.title)
      result.seq = integer(episode.seq, 1)
      if (episode.coverList !== undefined) result.cover_list = list(episode.coverList, item => text(item))
      result.byteplus_vid = text(episode.byteplusVid)
      return result
    })
  }
  return result
}

export function createMediaClient(config: MediaClientConfig): MediaClient {
  const { clientKey, clientSecret } = input(() => {
    const source = record(config)
    return { clientKey: text(source.clientKey), clientSecret: text(source.clientSecret) }
  })
  checkRuntime()
  let cached: { token: string; expiresAt: number } | undefined
  let pendingToken: Promise<string> | undefined

  async function exchange(url: string, init: RequestInit, mutation: boolean, asyncUpload = false) {
    let response: { ok: boolean; status: number; body: string }
    try {
      response = await deadline(async signal => {
        // 禁止官方 HTTP 重定向，避免凭据或非幂等 body 被转发到其他 origin/path。
        const result = await fetch(url, { ...init, redirect: 'error', signal })
        return { ok: result.ok, status: result.status, body: await result.text() }
      })
    } catch {
      throw mutation ? new MediaMutationUnknownError() : new MediaClientError('MEDIA_REQUEST_FAILED')
    }
    if (response.status === 401) cached = undefined
    if (mutation && (response.status >= 500 || response.status === 408 || (response.status >= 300 && response.status < 400))) {
      throw new MediaMutationUnknownError()
    }
    try {
      const root = record(parseResponse(response.body))
      // 仅将已实测的视频GET错误2+准确文案识别为“不存在”。其他权限/传输/格式错误
      // 不得触发新写入；含业务数据的矛盾回包仍按原严格路径处理。
      const error = root.error
      if (!mutation && response.ok && new URL(url).pathname === PATHS.video && root.data === undefined &&
        error !== null && typeof error === 'object' && !Array.isArray(error)) {
        const value = error as Record<string, unknown>
        if ((value.code === '2' || value.code === 2) && value.message === 'video not found' &&
          Object.keys(root).every(key => key === 'error') &&
          Object.keys(value).every(key => ['code', 'message', 'http_status_code', 'log_id'].includes(key)) &&
          (value.http_status_code === undefined || value.http_status_code === 200)) {
          throw new MediaClientError('MEDIA_VIDEO_NOT_FOUND')
        }
      }
      const data = businessData(root, mutation, asyncUpload)
      if (!response.ok) throw mutation ? new MediaMutationUnknownError() : new MediaClientError('MEDIA_REQUEST_FAILED')
      return data
    } catch (error) {
      if (error instanceof MediaClientError) throw error
      throw responseInvalid(mutation)
    }
  }

  async function acquireToken(): Promise<string> {
    try {
      const startedAt = Date.now()
      const data = await exchange(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
        body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'client_credentials' }),
      }, false)
      const token = text(data.access_token)
      // 平台实际 client_credentials 令牌包含 *；作为不透明令牌原样发送，仍拒绝空白和控制符。
      ensure(/^[A-Za-z0-9._~+/*-]+=*$/.test(token) && data.token_type === 'Bearer')
      // 文档写 string，标准 token 响应也可能为 number；只接受完整的正整数字面量。
      let seconds = data.expires_in
      if (typeof seconds === 'string') { ensure(/^[1-9]\d*$/.test(seconds)); seconds = Number(seconds) }
      const lifetime = integer(seconds, 1) * 1000
      const expiresAt = startedAt + lifetime - Math.min(30_000, Math.floor(lifetime / 10))
      ensure(Number.isSafeInteger(lifetime) && Number.isSafeInteger(expiresAt) && expiresAt > Date.now())
      cached = { token, expiresAt }
      return token
    } catch { throw new MediaClientError('MEDIA_TOKEN_UNAVAILABLE') }
  }
  async function token(): Promise<string> {
    if (cached && Date.now() < cached.expiresAt) return cached.token
    if (pendingToken) return pendingToken
    pendingToken = acquireToken()
    try { return await pendingToken } finally { pendingToken = undefined }
  }
  async function request<T>(
    path: MediaPath, method: 'GET' | 'POST', decode: (data: Record<string, unknown>) => T,
    body?: Record<string, unknown>, query: Record<string, string> = {}, asyncUpload = false,
  ): Promise<T> {
    const url = new URL(path, ORIGIN)
    url.searchParams.set('client_key', clientKey)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const serialized = body === undefined ? undefined : input(() => JSON.stringify(
      method === 'POST' && bodyClientKeyPaths.has(path) ? { ...body, client_key: clientKey } : body,
    ))
    // token 和参数检查发生在变更提交之前，失败不能被误报成“剧目可能已经创建”。
    const bearer = await token()
    const mutation = method === 'POST'
    const temporaryCredential = path === PATHS.playToken
    const data = await exchange(url.href, {
      method, headers: {
        Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json',
        ...(temporaryCredential ? { 'Cache-Control': 'no-store' } : {}),
      },
      ...(temporaryCredential ? { cache: 'no-store' as const } : {}),
      ...(serialized === undefined ? {} : { body: serialized }),
    }, mutation, asyncUpload)
    try { return decode(data) } catch (error) {
      if (error instanceof MediaClientError) throw error
      throw responseInvalid(mutation)
    }
  }

  return {
    async getPlayToken(episodeId) {
      // player.txt明示string；沿用queryAlbum已验证的episode_id格式，不接收/舍入Number。
      const query = input(() => ({ episode_id: inputId(episodeId) }))
      // 播放凭证只返回给本次调用，不进入客户端授权缓存，也不记录原始响应。
      return request(PATHS.playToken, 'GET', data => ({ playAuthToken: text(data.play_auth_token) }), undefined, query)
    },

    async queryAlbum(albumId, version) {
      const query = input(() => ({
        album_id: inputId(albumId),
        ...(version === undefined ? {} : { version: String(integer(version, 1)) }),
      }))
      return request(PATHS.query, 'GET', data => ({
        album_version_list: list(data.album_version_list, value => {
          const item = record(value)
          const result: MediaAlbumVersionInfo = { ...item, album_id: id(item.album_id), version: integer(item.version, 1) }
          ensure(result.album_id === albumId && (version === undefined || result.version === version))
          if (item.album_info !== undefined) {
            result.album_info = record(item.album_info)
            if (result.album_info.language !== undefined) languageCode(result.album_info.language)
          }
          if (item.episode_info_list !== undefined) result.episode_info_list = list(item.episode_info_list, value => {
            const episode = record(value)
            return { ...episode, episode_id: id(episode.episode_id), seq: integer(episode.seq, 1), byteplus_vid: text(episode.byteplus_vid) }
          })
          if (item.current_version !== undefined) result.current_version = integer(item.current_version)
          if (item.online_version !== undefined) result.online_version = item.online_version === null ? null : integer(item.online_version)
          if (item.publish_status !== undefined) result.publish_status = integer(item.publish_status)
          if (item.review_status !== undefined) result.review_status = integer(item.review_status)
          return result
        }),
      }), undefined, query)
    },

    async createAlbum() {
      // 真实创建回执可仅含 album_id；立即交付已知ID，不靠额外查询猜初始版本。
      return request(PATHS.create, 'POST', data => {
        if (data.result_type !== undefined) ensure(data.result_type === 1)
        return { albumId: id(data.album_id), version: data.version === undefined ? null : integer(data.version, 1) }
      }, {})
    },

    async updateAlbum(value) {
      const body = input(() => updateBody(value))
      const requestedAlbumId = value.albumId
      return request(PATHS.update, 'POST', data => {
        const albumId = id(data.album_id)
        ensure(albumId === requestedAlbumId)
        const result: MediaAlbumUpdatedResult = { albumId, version: integer(data.version, 1) }
        if (body.operation_type === 1 || data.episode_id_map !== undefined) {
          result.episodeIdMap = Object.fromEntries(Object.entries(record(data.episode_id_map)).map(([key, value]) => [key, id(value)]))
        }
        if (data.album_status !== undefined) result.albumStatus = oneOf(data.album_status, [1, 2, 3] as const)
        if (data.publish_status !== undefined) result.publishStatus = oneOf(data.publish_status, [0, 1, 2] as const)
        return result
      }, body)
    },

    async createImage(imageUrl) {
      const image = await fileURL(imageUrl)
      return request(PATHS.image, 'POST', data => {
        const openPicId = text(data.open_pic_id)
        // 预览地址不是已创建封面的必要回执；提供了地址时仍执行原HTTPS检查。
        const tiktokPicUrl = data.tiktok_pic_url == null ? null : text(data.tiktok_pic_url)
        if (tiktokPicUrl !== null) httpsURL(tiktokPicUrl)
        return { openPicId, tiktokPicUrl }
      }, { image_url: image })
    },

    async uploadVideo(value) {
      const body = input(() => {
        const source = record(value)
        return { url: text(source.url), title: text(source.title), space_name: text(source.spaceName), byteplus_account_id: text(source.byteplusAccountId) }
      })
      body.url = await fileURL(body.url)
      return request<MediaVideoUploadResult>(PATHS.video, 'POST', data => {
        if (data.result_type === 2) return { resultType: 2, status: 'processing', jobId: text(data.job_id) }
        ensure(data.result_type === 1)
        const jobId = optionalText(data, 'job_id')
        return { resultType: 1, status: 'succeeded', byteplusVid: text(data.byteplus_vid), ...(jobId ? { jobId } : {}) }
      }, body, {}, true)
    },

    async registerExistingVideo(value) {
      const body = input(() => {
        const source = record(value)
        ensure(Object.keys(source).every(key => ['vid', 'title', 'spaceName', 'byteplusAccountId', 'byteplusRegion'].includes(key)))
        // 只开放本轮已实证的登记地域，不把VOD SDK地域别名自动当作此接口的取值。
        ensure(source.byteplusRegion === 'ap-southeast-1')
        const vid = text(source.vid)
        ensure(/^[A-Za-z0-9_-]{1,200}$/.test(vid))
        return { vid, title: text(source.title), space_name: text(source.spaceName),
          byteplus_account_id: text(source.byteplusAccountId), byteplus_region: source.byteplusRegion }
      })
      return request(PATHS.video, 'POST', data => {
        const byteplusVid = text(data.byteplus_vid)
        ensure(byteplusVid === body.vid)
        return { byteplusVid }
      }, body)
    },

    async queryVideo(value) {
      const query = input(() => queryInput(value))
      return request(PATHS.video, 'GET', data => {
        const state = progress(data.upload_status)
        const identity = queryIdentity(data, query)
        if (state.uploadStatus === 2) ensure(identity.vid)
        const result = { ...state, ...identity } as MediaVideoQueryResult
        if (data.title !== undefined) result.title = text(data.title, true)
        if (data.duration_ms !== undefined) result.durationMs = integer(data.duration_ms)
        const cover = optionalText(data, 'cover_url')
        if (cover) { httpsURL(cover); result.coverUrl = cover }
        // 明确挑选输出字段；byteplus_url / raw_video_info_json 不进入业务返回值或错误。
        return result
      }, undefined, query)
    },

    async uploadSubtitle(value) {
      const body = input(() => {
        const source = record(value)
        return { subtitle_url: text(source.subtitleUrl), language: text(source.language), space_name: text(source.spaceName), byteplus_account_id: text(source.byteplusAccountId) }
      })
      body.subtitle_url = await fileURL(body.subtitle_url)
      return request(PATHS.subtitle, 'POST', data => ({ jobId: text(data.job_id) }), body)
    },

    async querySubtitle(value) {
      const query = input(() => queryInput(value))
      return request(PATHS.subtitle, 'GET', data => {
        const state = progress(data.upload_status)
        const identity = queryIdentity(data, query)
        const subtitleInfoList = data.subtitle_info_list === undefined ? undefined : list(data.subtitle_info_list, record)
        if (state.uploadStatus === 2) ensure(subtitleInfoList !== undefined)
        return { ...state, ...identity, ...(subtitleInfoList === undefined ? {} : { subtitleInfoList }) } as MediaSubtitleQueryResult
      }, undefined, query)
    },

    async bindSubtitle(value) {
      const body = input(() => {
        const source = record(value)
        return { vid: text(source.vid), subtitle_id: text(source.subtitleId) }
      })
      return request(PATHS.bind, 'POST', data => {
        ensure(data.vid === body.vid && data.subtitle_id === body.subtitle_id)
        return { vid: text(data.vid), subtitleId: text(data.subtitle_id) }
      }, body)
    },

    async authorizeAlbum(albumId) {
      const body = input(() => ({ album_id: wireId(albumId), operate_type: 1, target_client_key_list: [clientKey] }))
      return request(PATHS.authorize, 'POST', data => {
        const results = list(data.client_key_result_list, record)
        ensure(results.length === 1)
        const result = results[0]
        ensure(result.client_key === clientKey && result.auth_status === 1)
        if (result.error_code !== undefined) ensure(integer(result.error_code) === 0)
        return { clientKey, authStatus: 1 }
      }, body)
    },

    async submitReview(albumId, version, priority) {
      const body = input(() => ({
        album_id: wireId(albumId), version: integer(version, 1),
        ...(priority === undefined ? {} : { priority_score: oneOf(priority, [1, 2]) }),
      }))
      return request(PATHS.review, 'POST', data => {
        ensure(data.result_type === 1)
        return { resultType: 1, reviewId: id(data.review_id) }
      }, body)
    },

    async setOnlineVersion(albumId, version) {
      const body = input(() => ({ album_id: wireId(albumId), version: integer(version, 1) }))
      return request(PATHS.online, 'POST', data => {
        const result = { albumId: id(data.album_id), onlineVersion: integer(data.online_version, 1) }
        ensure(result.albumId === albumId && result.onlineVersion === version)
        return result
      }, body)
    },

    async setAlbumStatus(albumId, status) {
      const body = input(() => ({ album_id: wireId(albumId), status: oneOf(status, [1, 2]) }))
      return request(PATHS.status, 'POST', data => {
        const result = { albumId: id(data.album_id), status: oneOf(data.status, [1, 2] as const) }
        ensure(result.albumId === albumId && result.status === status)
        return result
      }, body)
    },
  }
}
