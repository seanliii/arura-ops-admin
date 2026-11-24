import { emptyRegistrationMetadata, type RegistrationMetadata } from '../shared/registration-metadata.js'
import { ApiError } from './types.js'
import { body, integer } from './validation.js'

export function readRegistrationMetadata(raw: unknown): RegistrationMetadata {
  return { ...emptyRegistrationMetadata(), ...JSON.parse(String(raw ?? '{}')) }
}
export function hasRegistrationMetadata(raw: unknown): boolean {
  return Object.keys(JSON.parse(String(raw ?? '{}'))).length > 0
}
export function mergeRegistrationMetadata(raw: unknown, input: unknown, uploadedEpisodes: number): RegistrationMetadata {
  const value = body(input), allowed = Object.keys(emptyRegistrationMetadata())
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ApiError(400, 'REGISTRATION_METADATA_INVALID', '发行资料含不支持的字段')
  }
  const result = readRegistrationMetadata(raw)
  if (value.releaseStatus !== undefined) {
    if (value.releaseStatus !== null && (typeof value.releaseStatus !== 'string' || !['unreleased', 'released'].includes(value.releaseStatus))) {
      throw new ApiError(400, 'REGISTRATION_METADATA_INVALID', '请选择尚未发行或已发行，不等同平台上架状态')
    }
    result.releaseStatus = value.releaseStatus as RegistrationMetadata['releaseStatus']
  }
  for (const [key, min, max] of [['year', 1900, 2200], ['dramaType', 1, 4], ['albumStatus', 2, 3], ['totalEpisodes', 1, 10000]] as const) {
    if (value[key] !== undefined) {
      const validated = value[key] === null ? null : integer(value[key], key, min, max)
      Object.assign(result, { [key]: validated })
    }
  }
  if (value.tagList !== undefined) {
    if (!Array.isArray(value.tagList) || value.tagList.length > 20 ||
      value.tagList.some(tag => typeof tag !== 'number' || !Number.isSafeInteger(tag) || tag < 1 || tag > 2147483647) ||
      new Set(value.tagList).size !== value.tagList.length) {
      throw new ApiError(400, 'REGISTRATION_METADATA_INVALID', '平台标签须为最多20个不同正整数；尚未确认时可留空，不默认填示例')
    }
    result.tagList = [...value.tagList].sort((a, b) => a - b)
  }
  if (result.totalEpisodes !== null && result.totalEpisodes < uploadedEpisodes) {
    throw new ApiError(400, 'REGISTRATION_METADATA_INVALID', '预计总集数不能少于已经上传的集数，可留空表示尚未确定')
  }
  return result
}

/** 仅平台登记前要求资料齐全，上传和草稿保存不能被这些缺项挡住。 */
export function registrationMetadataProblems(value: RegistrationMetadata, uploadedEpisodes: number): string[] {
  const reasons: string[] = []
  if (!value.releaseStatus) reasons.push('请确认是否曾经发行')
  if (!value.year) reasons.push(value.releaseStatus === 'unreleased' ? '平台登记前请填写计划首发年份（不是已经发行）' : '平台登记前请填写首次发行年份')
  if (!value.dramaType) reasons.push('请确认制作类型')
  if (!value.albumStatus) reasons.push('请确认连载中或已完结')
  if (!value.tagList.length) reasons.push('平台题材编号尚未填写；草稿已可保存，登记前须使用真实平台编号')
  if (value.albumStatus === 3 && (value.totalEpisodes === null || value.totalEpisodes !== uploadedEpisodes)) {
    reasons.push('已完结作品须确认全剧总集数，并上传全部单集；未完结可暂不填写总集数')
  }
  if (value.totalEpisodes !== null && value.totalEpisodes < uploadedEpisodes) reasons.push('已上传集数超过预计总集数，请核对发行资料')
  return reasons
}
