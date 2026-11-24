/** 仅服务端配置。2026-10-20有限实测确认日语字符串ja；仍须显式配置，不转换旧数字或提供默认值。 */
export interface MediaRegistrationConfig {
  publicOrigin: string
  japaneseLanguageCode: 'ja'
}

export type MediaRegistrationPhase = 'cover' | 'create' | 'update' | 'verify' | 'done'
export type MediaRegistrationStatus = 'ready' | 'running' | 'failed' | 'unknown' | 'stale' | 'registered' | 'superseded'
export interface MediaRegistrationJob {
  id: string
  dramaId: number
  localVersion: number
  phase: MediaRegistrationPhase
  status: MediaRegistrationStatus
  albumId: string | null
  platformVersion: number | null
  episodeCount: number
  year: number
  dramaType: 1 | 2 | 3 | 4
  albumStatus: 2 | 3
  /** 调用方明确选择；非空、最多20项、每项为正安全整数。运行时由服务端验证，不默认填101。 */
  tagList: number[]
  errorCode: string | null
  message: string
  createdAt: number
  updatedAt: number
}
export interface MediaRegistrationState {
  ownerId: string
  dramaId: number
  localVersion: number
  configured: boolean
  ready: boolean
  reasons: string[]
  japaneseLanguageCode: 'ja' | null
  episodeCount: number
  job: MediaRegistrationJob | null
  /** 仅保存管理员提供且空版本查询通过的回执，不等于完整剧目登记或审核通过。 */
  recovery?: {
    albumId: string
    localVersion: number
    coverReady: boolean
    recoveredAt: number
  } | null
  recoveryAvailable?: boolean
}

// GET /api/admin/dramas/:id/platform-registration -> MediaRegistrationState
// POST same {requestId:UUID,version,year,dramaType,albumStatus,tagList,confirmed:true}
//      -> MediaRegistrationState. 仅保存本次登记快照，不发起平台写入。
// POST /api/admin/dramas/:id/platform-registration/:jobId/run {confirmed:true}
//      -> MediaRegistrationState. 持久记录每步，明确确认后进行封面/建剧/编辑/查询。
// POST .../:jobId/reconcile {} -> MediaRegistrationState. 仅查询已知album，绝不重放未知写请求。
// POST .../recover-receipts {version,albumId,coverPicId,confirmed:true} -> MediaRegistrationState
// 无需日语值；只查询已有空Album并保存回执，后续准备快照复用ID。非空版本须走映射核对，禁止覆盖。
