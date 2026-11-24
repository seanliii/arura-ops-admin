import { ApiError } from './types.js'
export function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_BODY', '请求必须为JSON对象')
  return value as Record<string, unknown>
}
export function text(value: unknown, field: string, max = 200, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /\u0000/.test(value)) throw new ApiError(400, 'INVALID_INPUT', `${field}格式错误`)
  return value.trim()
}
export function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ApiError(400, 'INVALID_INPUT', `${field}必须是有效整数`)
  return value
}
export function number(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new ApiError(400, 'INVALID_INPUT', `${field}数值无效`)
  return value
}
export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', `${field}必须是布尔值`)
  return value
}
export function id(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new ApiError(400, 'INVALID_ID', '无效的ID')
  return integer(Number(value), 'id', 1)
}
export function strings(value: unknown, field: string, max = 20): string[] {
  if (!Array.isArray(value) || value.length > max) throw new ApiError(400, 'INVALID_INPUT', `${field}格式错误`)
  return [...new Set(value.map(v => text(v, field, 100)))]
}
