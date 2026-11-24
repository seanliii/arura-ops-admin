import { createHash } from 'node:crypto'
import type { BytePlusUploadConfig, CloudUploadAvailability } from '../shared/cloud-upload.js'
import type { ServerConfig } from './types.js'

export const DEFAULT_CLOUD_UPLOAD_BYTES = 200 * 1024 * 1024
export const MAX_CLOUD_UPLOAD_BYTES = 20_000_000_000
const fields = {
  accountId: 'BYTEPLUS_ACCOUNT_ID', spaceName: 'BYTEPLUS_SPACE_NAME', vodRegion: 'BYTEPLUS_VOD_REGION',
  vodAppId: 'BYTEPLUS_VOD_APP_ID', stsRegion: 'BYTEPLUS_STS_REGION', roleTrn: 'BYTEPLUS_UPLOAD_ROLE_TRN',
  accessKeyId: 'BYTEPLUS_ACCESS_KEY_ID', secretAccessKey: 'BYTEPLUS_SECRET_ACCESS_KEY',
} as const

/** 上传、导入和平台同步使用同一目标标识；凭据轮换不改变视频所属目标。 */
export function cloudUploadFingerprint(
  config: Pick<ServerConfig, 'mode' | 'tiktokClientKey'>,
  upload: BytePlusUploadConfig,
): string {
  return createHash('sha256').update(JSON.stringify([
    config.mode, config.tiktokClientKey, upload.accountId, upload.spaceName,
    upload.vodRegion, upload.vodAppId, upload.stsRegion, upload.roleTrn,
  ])).digest('hex')
}

export function loadCloudUploadConfig(
  override?: BytePlusUploadConfig, env: NodeJS.ProcessEnv = process.env,
): BytePlusUploadConfig | undefined {
  const entries = Object.entries(fields).map(([key, name]) => [key, env[name]?.trim() || ''])
  if (!override && !entries.some(([, value]) => value)) return undefined
  const raw = override ?? Object.fromEntries(entries)
  const fail = () => { throw new Error('BytePlus云上传配置不完整或格式无效；请核对账号、空间、region、VOD appId、角色与服务端密钥') }
  if (Object.keys(fields).some(key => typeof raw[key as keyof typeof raw] !== (key === 'vodAppId' && override ? 'number' : 'string'))) fail()
  const value = { ...raw, vodAppId: override ? override.vodAppId : Number(raw.vodAppId) } as BytePlusUploadConfig
  if (!/^[1-9]\d{0,39}$/.test(value.accountId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.spaceName)
    || !['ap-singapore-1', 'ap-southeast-1'].includes(value.vodRegion) || value.stsRegion !== 'ap-southeast-1'
    || !Number.isSafeInteger(value.vodAppId) || value.vodAppId <= 0
    || !new RegExp(`^trn:iam::${value.accountId}:role/[a-zA-Z0-9_+=,.@-]{1,128}$`).test(value.roleTrn)
    || !value.accessKeyId || !value.secretAccessKey
    || [value.accessKeyId, value.secretAccessKey].some(secret => secret.length > 4096 || /\s/.test(secret))) fail()
  return value
}

export function cloudUploadAvailability(config: ServerConfig): CloudUploadAvailability {
  const reasons: string[] = []
  if (!config.byteplusUpload) reasons.push('尚未配置BytePlus上传账号、空间、VOD appId、临时权限角色和服务端密钥')
  if (!config.tiktokClientKey || !config.tiktokClientSecret) reasons.push('尚未配置当前TikTok应用的服务端身份，无法核实云端视频是否可用')
  return {
    configured: reasons.length === 0, reasons, maxBytes: config.cloudUploadMaxBytes ?? DEFAULT_CLOUD_UPLOAD_BYTES,
    spaceName: config.byteplusUpload?.spaceName ?? null, region: config.byteplusUpload?.vodRegion ?? null,
  }
}
