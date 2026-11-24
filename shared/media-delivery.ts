export type MediaDeliveryStatus =
  | 'queued' | 'waiting_uploads' | 'registering_videos' | 'registering_drama' | 'syncing'
  | 'awaiting_review' | 'ready_to_publish' | 'publishing' | 'complete'
  | 'needs_input' | 'needs_attention' | 'retrying' | 'rejected' | 'paused' | 'cancelled'
export const DELIVERY_STATUS_LABELS: Record<MediaDeliveryStatus, string> = {
  queued: '已安排', waiting_uploads: '等待本批视频上传完成', registering_videos: '登记视频并导入单集',
  registering_drama: '同步剧目资料与全部单集', syncing: '核对TikTok剧目版本',
  awaiting_review: 'TikTok审核中，服务器会继续查询', ready_to_publish: '审核已通过，等待确认上架',
  publishing: '正在授权、上架并核对片库', complete: '交付完成，已进入本应用片库',
  needs_input: '需要补齐或重新确认资料', needs_attention: '原请求结果待核对，未重复发送',
  retrying: '暂时失败，已安排稍后核对', rejected: 'TikTok审核退回，需要修改内容',
  paused: '已暂停自动处理', cancelled: '已取消后续自动处理',
}
export interface MediaDeliveryJob {
  id: string
  dramaId: number
  expectedEpisodes: number
  autoPublish: boolean
  status: MediaDeliveryStatus
  phase: string
  message: string
  errorCode: string | null
  albumId: string | null
  platformVersion: number | null
  registrationJobId: string | null
  nextRunAt: number | null
  canPause: boolean
  canResume: boolean
  owner: boolean
  createdAt: number
  updatedAt: number
}
export interface MediaDeliveryState {
  dramaId: number
  localVersion: number
  configured: boolean
  reasons: string[]
  uploadedEpisodes: number
  knownUploadSlots: number[]
  job: MediaDeliveryJob | null
}
