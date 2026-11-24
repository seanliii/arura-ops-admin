/** 后端安全配置，禁止序列化到管理端。 */
export interface BytePlusUploadConfig {
  accountId: string
  spaceName: string
  vodRegion: 'ap-singapore-1' | 'ap-southeast-1'
  vodAppId: number
  stsRegion: 'ap-southeast-1'
  roleTrn: string
  accessKeyId: string
  secretAccessKey: string
}

/** 只允许临时凭据。仅credentials接口返回，不存任务、日志或浏览器持久存储。 */
export interface CloudUploadCredentials {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
  CurrentTime: string
  ExpiredTime: string
}

export type CloudUploadStatus = 'created' | 'uploading' | 'awaiting_verification' | 'verifying' | 'verified' | 'cancelled'
/** 视频登记不等于剧集登记、审核通过或用户已购买。 */
export interface CloudVideoRegistration {
  status: 'checking' | 'sending' | 'registered' | 'failed' | 'unknown'
  confirmedAt: number | null
  errorCode: string | null
  message: string
  updatedAt: number
}
export interface CloudUploadTask {
  id: string
  dramaId: number
  seq: number
  title: string
  fileName: string
  fileBytes: number
  status: CloudUploadStatus
  candidateVid: string | null
  verifiedAt: number | null
  durationSeconds: number | null
  /** 本地草稿单集，不是TikTok episode_id；删除单集后保留importedAt。 */
  importedEpisodeId: number | null
  importedAt: number | null
  createdAt: number
  updatedAt: number
  errorCode: string | null
  message: string
  /** 旧任务没有登记记录；只能由服务器回查或登记后建立，不能从verified推断。 */
  videoRegistration?: CloudVideoRegistration | null
}
export interface CloudUploadImportResult {
  task: CloudUploadTask
  episodeId: number
  dramaVersion: number
}
export interface CloudUploadAvailability {
  configured: boolean
  reasons: string[]
  maxBytes: number
  spaceName: string | null
  region: string | null
}
export interface CloudUploadTicket {
  task: CloudUploadTask
  credentials: CloudUploadCredentials
  uploaderUserId: string
  vodAppId: number
  vodRegion: BytePlusUploadConfig['vodRegion']
  spaceName: string
  /** 设置为云端媒体标题，用于后端核对该任务；不是访问凭据。 */
  mediaMarker: string
}
export interface CloudMediaObservation {
  vid: string
  spaceName: string
  title: string
  bytes: number
  durationSeconds: number
  format: string
  fileType: string
  publishStatus: 'Published' | 'Unpublished'
}

// 管理端HTTP（均保留已有Cookie/来源检查）：
// GET  /api/admin/cloud-uploads/config -> CloudUploadAvailability & { ownerId: string }
// GET  /api/admin/cloud-uploads?dramaId=&cursor=&expectedOwnerId=
//      -> { ownerId: string, tasks: CloudUploadTask[], nextCursor: string | null }
// GET  /api/admin/cloud-uploads/:id -> { task: CloudUploadTask }
// POST /api/admin/cloud-uploads
//      { requestId: UUID, dramaId, seq, title, fileName, fileBytes, confirmed: true }
//      -> { task: CloudUploadTask }
// POST /api/admin/cloud-uploads/:id/credentials {} -> CloudUploadTicket
// POST /api/admin/cloud-uploads/:id/verify { vid: string } -> { task: CloudUploadTask }
// POST /api/admin/cloud-uploads/:id/register-video { confirmed: true } -> { task: CloudUploadTask }
// 先回查同VID；仅明确不存在且无未知写入时登记已有视频，不转传字节。未知结果只回查。
// POST /api/admin/cloud-uploads/:id/import-episode
//      { version: number, confirmed: true } -> CloudUploadImportResult
// POST /api/admin/cloud-uploads/:id/cancel {} -> { task: CloudUploadTask }
