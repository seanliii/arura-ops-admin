import type { RequestHandler } from 'express'
import { ApiError, type ServerConfig } from './types.js'
import { cookieOnlyPath, requestPath } from './session-transport.js'

const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
const headers = new Set(['accept', 'content-type', 'x-requested-with', 'range', 'authorization', 'x-session-transport', 'x-aurora-visit', 'x-library-owner'])

/** Install before rate limits/parsers so approved clients can read errors too. */
export function corsResponseHeaders(config: ServerConfig): RequestHandler {
  return (req, res, next) => {
    // Also vary responses without Origin, so a cache cannot reuse the wrong policy.
    res.vary('Origin')
    const origin = req.get('Origin')
    if (origin && config.allowedOrigins.includes(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Retry-After',
      })
    }
    next()
  }
}

/** Install after the API rate limit, but before session checks and body parsing. */
export function corsRequests(config: ServerConfig): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('Origin')
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
      return next(new ApiError(403, 'ORIGIN_REJECTED', '请求来源不被允许'))
    }
    if (req.method !== 'OPTIONS') return next()
    res.vary('Access-Control-Request-Method')
    res.vary('Access-Control-Request-Headers')
    if (!origin) return next(new ApiError(403, 'ORIGIN_REJECTED', '预检必须提供合法来源'))
    const method = req.get('Access-Control-Request-Method')
    const requested = req.get('Access-Control-Request-Headers')
    const requestedHeaders = requested ? requested.split(',').map(header => header.trim().toLowerCase()) : []
    if (!method || !methods.has(method) || requestedHeaders.some(header => !headers.has(header))) {
      return next(new ApiError(403, 'CORS_PREFLIGHT_REJECTED', '预检方法或请求头不被允许'))
    }
    const path = requestPath(req)
    const bootstrap = method === 'POST' && path === '/api/auth/tiktok' &&
      requestedHeaders.includes('x-session-transport') && !requestedHeaders.includes('authorization')
    const bearer = requestedHeaders.includes('authorization') && !cookieOnlyPath(path) && path !== '/api/auth/tiktok'
    if ((requestedHeaders.includes('x-session-transport') && !bootstrap) ||
        (requestedHeaders.includes('authorization') && !bearer))
      return next(new ApiError(403, 'CORS_PREFLIGHT_REJECTED', '此路径不接受指定的会话传输方式'))
    if (method !== 'GET' && method !== 'HEAD') {
      // 预检没有实际令牌；这里只允许声明，实际写入由sessionSourcePolicy验证数据库。
      if (req.get('Sec-Fetch-Site') === 'cross-site' && config.cookieSameSite !== 'none' && !bootstrap && !bearer) {
        return next(new ApiError(403, 'ORIGIN_REJECTED', '不允许跨站写入'))
      }
      if (!requestedHeaders.includes('x-requested-with')) {
        return next(new ApiError(403, 'CSRF_REJECTED', '写入预检必须声明请求标记'))
      }
    }
    // Only validated names/methods are reflected; never issue a wildcard grant.
    res.set('Access-Control-Allow-Methods', method)
    if (requestedHeaders.length) res.set('Access-Control-Allow-Headers', [...new Set(requestedHeaders)].join(', '))
    res.status(204).end()
  }
}
