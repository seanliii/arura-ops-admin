// Regenerate only the legal documents. No server, API, browser or build dependency.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const check = process.argv.includes('--check')
const languages = ['en', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'ar', 'pt-BR', 'es-419', 'ms']
const pages = ['terms', 'privacy']
const company = 'UYING MEDIA LIMITED'
const email = 'baize16618855@163.com'
const dates = { terms: '2026-10-17', privacy: '2026-10-21' }
const about = {
  en: 'About aurora', ja: 'auroraについて', 'zh-Hans': '关于 aurora', 'zh-Hant': '關於 aurora',
  es: 'Acerca de aurora', fr: 'À propos d’aurora', ar: 'عن aurora',
  'pt-BR': 'Sobre a aurora', 'es-419': 'Acerca de aurora', ms: 'Tentang aurora',
}
const origin = 'https://auroradrama.app'
const url = (page, language) => `${origin}/${page}.html?lang=${language}`
const escape = text => String(text).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])
const bodyText = text => escape(text)
  .replaceAll('{company}', `<bdi>${company}</bdi>`)
  .replaceAll('{email}', `<a href="mailto:${email}"><bdi>${email}</bdi></a>`)
const content = Object.fromEntries(languages.map(language => [
  language, JSON.parse(readFileSync(join(root, 'content', `${language}.json`), 'utf8')),
]))
const manifest = {
  defaultLanguage: 'en',
  aliases: { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' },
  languages: Object.fromEntries(languages.map(language => [language, Object.fromEntries(
    pages.map(page => [page, language === 'en' ? `${page}.html` : `locales/${language}/${page}.html`]),
  )])),
}
const css = `
    :root { color-scheme: light; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f3f4f7; color: #252836; font-size: 1rem; line-height: 1.85; }
    a { color: #244d86; text-underline-offset: .22em; overflow-wrap: anywhere; }
    a:focus-visible, summary:focus-visible { outline: 3px solid #476cd1; outline-offset: 4px; }
    .masthead { background: #111119; color: #f4f4f8; border-bottom: 1px solid #33333e; }
    .header-inner, main { width: min(calc(100% - 2rem), 52rem); margin-inline: auto; }
    .header-inner { padding-block: 1.5rem; }
    .brand { display: inline-flex; align-items: center; min-height: 44px; color: #fff; font-size: 1.6rem; font-weight: 750; letter-spacing: -.04em; text-decoration: none; }
    .brand::before { content: ""; width: .55rem; height: .55rem; margin-inline-end: .65rem; border-radius: 50%; background: #ff8297; }
    .masthead a:focus-visible, .masthead summary:focus-visible { outline-color: #ffc1cc; }
    nav[data-documents] { display: flex; flex-wrap: wrap; gap: .25rem 1.25rem; margin-block: .5rem 1rem; }
    nav[data-documents] a { display: inline-flex; align-items: center; min-height: 44px; color: #c8c8d7; font-size: .875rem; }
    nav[data-documents] a[aria-current="page"] { color: #fff; font-weight: 650; text-decoration-thickness: 2px; }
    details { border: 1px solid #41414e; border-radius: 10px; max-width: 100%; background: #1d1d28; }
    summary { padding: .6rem .9rem; min-height: 44px; cursor: pointer; overflow-wrap: anywhere; }
    summary bdi { margin-inline-start: .6rem; color: #c8c8d7; font-size: .875rem; }
    nav[data-language-selector] { display: flex; flex-wrap: wrap; gap: .5rem; padding: .25rem .75rem .75rem; }
    nav[data-language-selector] a { display: flex; align-items: center; flex: 1 1 10rem; min-width: 0; min-height: 44px; padding: .4rem .7rem; border: 1px solid #41414e; border-radius: 7px; color: #eeeef6; font-size: .875rem; text-decoration: none; }
    nav[data-language-selector] a[aria-current="true"] { border-color: #ffb4c3; background: #31303e; text-decoration: underline; text-decoration-thickness: 2px; }
    main { margin-block: 1.5rem 3rem; padding: clamp(1.2rem, 4vw, 3rem); background: #fff; border: 1px solid #e0e2e9; border-radius: 14px; }
    h1 { margin: 0 0 .5rem; color: #181b29; font-size: clamp(1.55rem, 4vw, 2.2rem); line-height: 1.35; letter-spacing: -.02em; }
    h2 { margin-block: 2rem .6rem; color: #242737; font-size: 1.1rem; line-height: 1.6; }
    h1, h2, p, li { overflow-wrap: anywhere; }
    p { margin-block: .8rem; }
    .updated { margin-block: .6rem 1.8rem; color: #606777; font-size: .875rem; }
    ul { padding-inline-start: 1.35rem; }
    li + li { margin-top: .75rem; }
    .operator { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid #e0e2e9; color: #606777; font-size: .875rem; }
    .skip { position: absolute; inset-block-start: -10rem; inset-inline-start: 1rem; z-index: 1; padding: .6rem 1rem; background: #fff; }
    .skip:focus { inset-block-start: .5rem; }
    @media print { .masthead, .skip { display: none; } body, main { background: #fff; } main { width: 100%; margin: 0; border: 0; padding: 0; } }
`

function validate(language) {
  const value = content[language]
  const nonempty = text => typeof text === 'string' && text.trim().length > 0
  if (!nonempty(value.name) || ['documents', 'language', 'skip', 'updated', 'operator', ...pages]
    .some(key => !nonempty(value.ui?.[key]))) throw new Error(`Missing navigation translation: ${language}`)
  for (const page of pages) {
    const doc = value[page]
    const listIndices = page === 'terms' ? [2] : [0, 1]
    if (!doc || !nonempty(doc.title) || !nonempty(doc.date) || !nonempty(doc.intro) ||
      doc.sections?.length !== (page === 'terms' ? 9 : 7)) throw new Error(`Incomplete document: ${language}/${page}`)
    doc.sections.forEach(([title, body], index) => {
      const validBody = listIndices.includes(index)
        ? Array.isArray(body) && body.length === 4 && body.every(nonempty)
        : nonempty(body)
      if (!nonempty(title) || !validBody) throw new Error(`Incomplete section: ${language}/${page}/${index + 1}`)
    })
    if (!doc.intro.includes('{company}') || !doc.sections.at(-1)[1].includes('{email}')) {
      throw new Error(`Missing company/contact: ${language}/${page}`)
    }
  }
}

function render(language, page) {
  const value = content[language]
  const doc = value[page]
  const links = languages.map(target => `          <a href="${url(page, target)}" lang="${target}" hreflang="${target}"${target === language ? ' aria-current="true"' : ''}><bdi>${escape(content[target].name)}</bdi></a>`).join('\n')
  const sections = doc.sections.map(([title, body]) => `      <h2>${escape(title)}</h2>\n${Array.isArray(body)
    ? `      <ul>\n${body.map(item => `        <li>${bodyText(item)}</li>`).join('\n')}\n      </ul>`
    : `      <p>${bodyText(body)}</p>`}`).join('\n\n')
  return `<!doctype html>
<!-- Generated by legal/generate.mjs from legal/content; edit the source, then regenerate. -->
<html lang="${language}" dir="${language === 'ar' ? 'rtl' : 'ltr'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(value.ui[page])} | aurora</title>
  <style>${css}  </style>
</head>
<body>
  <a class="skip" href="#legal-content">${escape(value.ui.skip)}</a>
  <header class="masthead">
    <div class="header-inner">
      <a class="brand" href="${url('about', language)}"><bdi>aurora</bdi></a>
      <nav data-documents aria-label="${escape(value.ui.documents)}">
        <a href="${url('about', language)}">${escape(about[language])}</a>
${pages.map(target => `        <a href="${url(target, language)}"${page === target ? ' aria-current="page"' : ''}>${escape(value.ui[target])}</a>`).join('\n')}
      </nav>
      <details>
        <summary>${escape(value.ui.language)}<bdi>${escape(value.name)}</bdi></summary>
        <nav data-language-selector aria-label="${escape(value.ui.language)}">
${links}
        </nav>
      </details>
    </div>
  </header>
  <main>
    <article id="legal-content" tabindex="-1" aria-labelledby="page-title">
      <h1 id="page-title">${escape(doc.title)}</h1>
      <p class="updated">${escape(value.ui.updated)}<time datetime="${dates[page]}">${escape(doc.date)}</time></p>
      <p>${bodyText(doc.intro)}</p>

${sections}
      <p class="operator">${escape(value.ui.operator)}<bdi>${company}</bdi></p>
    </article>
  </main>
</body>
</html>
`
}

const outputs = new Map()
for (const language of languages) {
  validate(language)
  for (const page of pages) outputs.set(manifest.languages[language][page], render(language, page))
}
outputs.set('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
let stale = false
for (const [file, html] of outputs) {
  const path = join(root, file)
  if (check) {
    let current
    try { current = readFileSync(path, 'utf8') } catch { /* Report a missing generated file below. */ }
    if (current !== html) { console.error(`Out of date: legal/${file}`); stale = true }
  } else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, html)
  }
}
if (stale) process.exitCode = 1
else console.log(`${check ? 'Verified' : 'Generated'} 20 legal HTML files and manifest.json.`)
