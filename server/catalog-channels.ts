import type { Request, Router } from 'express'
import type { Drama } from '../shared/contracts.js'
import { CATALOG_SORTS, type CatalogChannel, type CatalogMetrics, type CatalogSection, type CatalogSort } from '../shared/catalog-channel.js'
import { DRAMA_TEXT_LOCALES, type DramaTextLocale } from '../shared/drama-localizations.js'
import { ApiError, type AppContext } from './types.js'
import { body, integer } from './validation.js'
import { transaction } from './db.js'
import { audienceLanguage } from '../shared/content-delivery.js'
import { cachedCatalogMetrics, registerCatalogMetrics, sortCatalog } from './catalog-metrics.js'
import { experimentChannel } from './catalog-experiments.js'
import { operationsSnapshot, recordOperationsChange } from './operations-changes.js'

export function channelLocale(value: unknown): DramaTextLocale {
  if (typeof value !== 'string' || !DRAMA_TEXT_LOCALES.includes(value as DramaTextLocale)) {
    throw new ApiError(400, 'INVALID_CATALOG_LOCALE', '请选择支持的内容语言')
  }
  return value as DramaTextLocale
}
export function channelRegion(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)) throw new ApiError(400, 'INVALID_CATALOG_REGION', '地区必须为大写双字母代码')
  return value
}
export function channel(ctx: AppContext, region: string, locale: DramaTextLocale): CatalogChannel {
  const row = ctx.db.prepare('SELECT * FROM catalog_channels WHERE region=? AND locale=?').get(region, locale)
  return { region, locale, version: Number(row?.version ?? 0), configured: !!row && row.enabled === 1,
    fallback: row?.enabled === 1 && row.fallback === 'original' ? 'original' : 'strict',
    dramaIds: row ? JSON.parse(String(row.drama_ids)) : [],
    sort: row?.enabled === 1 ? String(row.sort_mode ?? 'manual') as CatalogSort : 'manual',
    sections: row?.enabled === 1 ? JSON.parse(String(row.sections_json ?? '[]')) : [] }
}
export function selectChannel(dramas: Drama[], config: CatalogChannel, metrics: Record<string, CatalogMetrics> = {}): Drama[] {
  const byId = new Map(dramas.map(d => [d.id, d]))
  const candidates = config.configured ? config.dramaIds.map(id => byId.get(id)).filter((d): d is Drama => !!d) : dramas
  // Never substitute a work's sibling edition. A curated item is an exact deliverable with its own rights.
  return sortCatalog(candidates.filter(d => audienceLanguage(d) === config.locale || (config.configured && config.fallback === 'original')), config.sort, metrics)
    .map(d => ({ ...d, catalogSelection: { requestedLocale: config.locale,
      contentLanguage: audienceLanguage(d) ?? d.language, fallback: audienceLanguage(d) !== config.locale,
      channelVersion:config.version,...(config.experiment?{experiment:config.experiment}:{}) } }))
}
function publicSections(config: CatalogChannel, selected: Drama[]): CatalogSection[] {
  const ids = new Set(selected.filter(d => !d.catalogSelection?.fallback).map(d => d.id))
  return (config.sections ?? []).map(section => {
    const chosen = section.dramaIds.length ? section.dramaIds.filter(id => ids.has(id)) : [...ids]
    return { ...section, dramaIds: config.sort && config.sort !== 'manual' ? [...ids].filter(id => chosen.includes(id)) : chosen }
  })
}
export function catalogResult(ctx: AppContext, dramas: Drama[], req: Request) {
  if (Object.keys(req.query).some(key => key !== 'locale')) throw new ApiError(400, 'INVALID_CATALOG_QUERY', '市场由服务器配置，不接受客户端改写')
  const region = ctx.config.catalogRegion ?? 'JP'
  if (req.query.locale !== undefined) {
    const config = experimentChannel(ctx,channel(ctx, region, channelLocale(req.query.locale)),req)
    const selected = selectChannel(dramas, config, cachedCatalogMetrics(ctx,region,config.locale))
    const matches = selected.filter(d => !d.catalogSelection!.fallback), others = selected.filter(d => d.catalogSelection!.fallback)
    return { dramas: matches, recommendations: others,
      channel: { ...config, sections: publicSections(config, selected), dramaIds: matches.map(d => d.id), recommendationIds: others.map(d => d.id) } }
  }
  // One response prefetches only IDs for seven shelves, not seven copies of videos.
  // Changing UI language need not refetch identities/rights or disturb a playing detail.
  const channels = Object.fromEntries(DRAMA_TEXT_LOCALES.map(locale => {
    const config = experimentChannel(ctx,channel(ctx, region, locale),req)
    const selected = selectChannel(dramas, config, cachedCatalogMetrics(ctx,region,locale))
    return [locale, { ...config, sections: publicSections(config, selected), dramaIds: selected.filter(d => !d.catalogSelection!.fallback).map(d => d.id),
      recommendationIds: selected.filter(d => d.catalogSelection!.fallback).map(d => d.id) }]
  }))
  return { dramas, channels, region }
}
export function registerCatalogChannels(router: Router, ctx: AppContext) {
  registerCatalogMetrics(router, ctx)
  router.get('/api/admin/catalog-channels/:region/:locale', (req, res) => {
    ctx.requireAdmin(req)
    res.json({ channel: channel(ctx, channelRegion(req.params.region), channelLocale(req.params.locale)) })
  })
  router.put('/api/admin/catalog-channels/:region/:locale', (req, res) => {
    const user = ctx.requireAdmin(req), region = channelRegion(req.params.region), locale = channelLocale(req.params.locale)
    const input = body(req.body)
    if (Object.keys(input).some(k => !['version', 'fallback', 'dramaIds', 'sort', 'sections', 'operationContext'].includes(k))) throw new ApiError(400, 'INVALID_CATALOG_CHANNEL', '主页配置包含未知字段')
    const version = integer(input.version, 'version', 0)
    if (typeof input.fallback !== 'string' || !['strict', 'original'].includes(input.fallback) || !Array.isArray(input.dramaIds) || input.dramaIds.length > 100) {
      throw new ApiError(400, 'INVALID_CATALOG_CHANNEL', '主页最多100部，须明确语言回退方式')
    }
    const ids = input.dramaIds.map(value => integer(value, 'dramaId', 1))
    const previous = channel(ctx, region, locale)
    const sort = input.sort ?? previous.sort ?? 'manual'
    const rawSections = input.sections ?? previous.sections ?? []
    if (!CATALOG_SORTS.includes(sort as CatalogSort) || !Array.isArray(rawSections) || rawSections.length > 12) throw new ApiError(400, 'INVALID_CATALOG_CHANNEL', '请选择排序方式，频道最多12个')
    const sectionIds = new Set<string>()
    const sections = rawSections.map(raw => {
      const section = body(raw)
      if (Object.keys(section).some(k => !['id', 'title', 'dramaIds'].includes(k)) ||
        typeof section.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(section.id) || sectionIds.has(section.id) ||
        typeof section.title !== 'string' || !section.title.trim() || section.title.length > 50 ||
        !Array.isArray(section.dramaIds) || section.dramaIds.length > 100 ||
        section.dramaIds.some(id => !ids.includes(id)) || new Set(section.dramaIds).size !== section.dramaIds.length) {
        throw new ApiError(400, 'INVALID_CATALOG_CHANNEL', '频道须有独立编号、名称，且只选择当前片单中的剧目')
      }
      sectionIds.add(section.id)
      return { id: section.id, title: section.title.trim(), dramaIds: section.dramaIds as number[] }
    })
    transaction(ctx.db, () => {
      if (channel(ctx, region, locale).version !== version) throw new ApiError(409, 'VERSION_CONFLICT', '主页已修改，请刷新后重试')
      const before = operationsSnapshot(ctx, 'catalog', `${region}/${locale}`)
      const seen = new Set<number>()
      for (const id of ids) {
        const d = ctx.db.prepare('SELECT id,work_id,regions FROM dramas WHERE id=?').get(id)
        if (!d || !JSON.parse(String(d.regions)).includes(region)) throw new ApiError(400, 'INVALID_CATALOG_CHANNEL', '该版本不存在或不在所选发行地区')
        if (seen.has(id)) throw new ApiError(400, 'INVALID_CATALOG_CHANNEL', '同一成片不能在主页重复出现')
        seen.add(id)
      }
      ctx.db.prepare(`INSERT INTO catalog_channels(region,locale,version,fallback,drama_ids,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(region,locale) DO UPDATE SET version=excluded.version,
        enabled=1,fallback=excluded.fallback,drama_ids=excluded.drama_ids,updated_at=excluded.updated_at`)
        .run(region, locale, version + 1, String(input.fallback), JSON.stringify(ids), Date.now())
      ctx.db.prepare('UPDATE catalog_channels SET sort_mode=?,sections_json=? WHERE region=? AND locale=?')
        .run(String(sort), JSON.stringify(sections), region, locale)
      ctx.audit(user.id, 'catalog.channel.save', 'catalog', `${region}/${locale}`, { version: version + 1, dramaIds: ids })
      recordOperationsChange(ctx, user.id, 'catalog', `${region}/${locale}`, before, input.operationContext)
    })
    res.json({ channel: channel(ctx, region, locale) })
  })
  router.delete('/api/admin/catalog-channels/:region/:locale', (req, res) => {
    const user = ctx.requireAdmin(req), region = channelRegion(req.params.region), locale = channelLocale(req.params.locale)
    transaction(ctx.db, () => {
      if (integer(req.body?.version, 'version', 1) !== channel(ctx, region, locale).version) throw new ApiError(409, 'VERSION_CONFLICT', '主页已修改，请刷新')
      const before = operationsSnapshot(ctx, 'catalog', `${region}/${locale}`)
      // Retain the revision even when returning to automatic selection (no stale-write ABA).
      ctx.db.prepare("UPDATE catalog_channels SET enabled=0,version=version+1,drama_ids='[]',fallback='strict',updated_at=? WHERE region=? AND locale=?")
        .run(Date.now(), region, locale)
      ctx.audit(user.id, 'catalog.channel.reset', 'catalog', `${region}/${locale}`)
      recordOperationsChange(ctx, user.id, 'catalog', `${region}/${locale}`, before, req.body?.operationContext)
    })
    res.json({ channel: channel(ctx, region, locale) })
  })
}
