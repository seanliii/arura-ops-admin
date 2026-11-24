/** 管理后台可分步保存的发行资料，不是已提交平台的快照或审核结果。 */
export interface RegistrationMetadata {
  releaseStatus: 'unreleased' | 'released' | null
  /** 未发行时为计划首发年份；已发行时为首次发行年份。不默认填当前年。 */
  year: number | null
  dramaType: 1 | 2 | 3 | 4 | null
  albumStatus: 2 | 3 | null
  /** 预计/全剧总集数，和实际已上传集数分开；连载中允许未知。 */
  totalEpisodes: number | null
  tagList: number[]
}
export function emptyRegistrationMetadata(): RegistrationMetadata {
  return { releaseStatus: null, year: null, dramaType: null, albumStatus: null, totalEpisodes: null, tagList: [] }
}
