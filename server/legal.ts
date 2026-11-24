import type { Express, RequestHandler } from 'express'
import { join } from 'node:path'
import { projectDir } from './config.js'

const languages = ['en', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'ar', 'pt-BR', 'es-419', 'ms']
const languageLookup = new Map(languages.map(language => [language.toLowerCase(), language]))
languageLookup.set('zh-cn', 'zh-Hans')
languageLookup.set('zh-tw', 'zh-Hant')
// File paths come from this fixed table, never from a query string or user filename.
const pages = new Map<string, Map<string, string>>()
for (const name of ['terms', 'privacy', 'about']) {
  const directory = name === 'about' ? 'website' : 'legal'
  const files = new Map(languages.map(language => [language, join(projectDir, directory,
    language === 'en' ? `${name}.html` : `locales/${language}/${name}.html`)]))
  pages.set(`/${name}.html`, files)
  pages.set(`/${name}`, files)
}

const serveLegalPage: RequestHandler = (req, res, next) => {
  const files = pages.get(req.path)
  if (!files) return next()
  const language = typeof req.query.lang === 'string'
    ? languageLookup.get(req.query.lang.toLowerCase()) ?? 'en' : 'en'
  res.set({
    'Content-Language': language,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  })
  res.sendFile(files.get(language)!, { dotfiles: 'deny', maxAge: 0 })
}

export function registerLegalPages(app: Express) {
  // Exact, case-sensitive GET/HEAD paths; never mount the legal directory.
  app.route(/^\/(?:terms|privacy|about)(?:\.html)?$/).get(serveLegalPage).head(serveLegalPage)
}
