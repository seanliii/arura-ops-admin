import type { SessionInfo } from './contracts.js'

export const MINIS_TRANSPORT_HEADER = 'X-Session-Transport'
export const MINIS_TRANSPORT = 'minis-bearer' as const
export const MINIS_SESSION_TTL_MS = 15 * 60 * 1000

export interface BusinessSession {
  token: string
  tokenType: 'Bearer'
  expiresAt: number
}
export interface MinisLoginResponse extends SessionInfo {
  businessSession: BusinessSession
}
