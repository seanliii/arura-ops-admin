/** User's launch targets, not evidence of TikTok approval or geolocation. */
export const LAUNCH_MARKETS = ['JP', 'KR', 'VN', 'TH', 'ID', 'BR', 'MX', 'TW', 'MY'] as const
export const MARKET_LABELS: Record<string, string> = {
  JP: '日本', KR: '韩国', SG: '新加坡', MY: '马来西亚', TH: '泰国', VN: '越南', ID: '印度尼西亚',
  PH: '菲律宾', BN: '文莱', KH: '柬埔寨', LA: '老挝', MM: '缅甸', TL: '东帝汶',
  BR: '巴西', MX: '墨西哥', TW: '台湾',
}
