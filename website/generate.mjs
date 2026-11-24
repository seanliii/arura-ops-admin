import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { languages } from './content.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
for (const [code, text] of Object.entries(languages)) {
  const url = path => `https://auroradrama.app/${path}?lang=${code}`
  const html = `<!doctype html>
<html lang="${code}" dir="${code === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${escape(text.intro)}">
<meta name="color-scheme" content="dark">
<title>${escape(text.home)}</title>
<style>
*{box-sizing:border-box}html{background:#111115;color:#f5f3f1;font-family:Arial,"Noto Sans",sans-serif}body{margin:0}a{color:inherit;text-decoration:none}a:focus-visible,summary:focus-visible{outline:3px solid #ffb9a8;outline-offset:5px}a,summary{-webkit-tap-highlight-color:transparent}header,main,footer{width:min(1120px,100%);margin-inline:auto;padding-inline:clamp(20px,5vw,64px)}header{min-height:100px;display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid #333139}.brand{font-size:19px;font-weight:800;letter-spacing:-.5px}.brand span{color:#ff7e68}.skip{position:absolute;inset-inline-start:16px;top:-100px;background:#fff;color:#111;padding:14px;z-index:5}.skip:focus{top:12px}details{position:relative;flex-shrink:0}summary{cursor:pointer;min-height:44px;display:list-item;list-style-position:inside;padding:12px;color:#d0cbd0;font-size:14px}nav.languages{position:absolute;inset-inline-end:0;top:50px;z-index:2;width:min(276px,calc(100vw - 40px));padding:8px;background:#232128;border:1px solid #514651;border-radius:12px;box-shadow:0 16px 40px #0007}nav.languages a{display:flex;align-items:center;min-height:44px;padding:10px 12px;border-radius:7px;font-size:14px}nav.languages a:hover,nav.languages a[aria-current=true]{background:#403138;color:#ffc4b6}.hero{padding-block:clamp(64px,9vw,112px) 64px;max-width:850px}.eyebrow{margin:0 0 24px;color:#ff9b86;letter-spacing:2px;font-size:11px;line-height:1.6;font-weight:700}h1{font-size:clamp(36px,6.6vw,76px);line-height:1.04;letter-spacing:-.045em;margin:0;overflow-wrap:anywhere;font-weight:750}html[dir=rtl] h1{letter-spacing:normal;line-height:1.3}.intro{max-width:580px;font-size:clamp(17px,2vw,20px);line-height:1.7;color:#c7c1c6;margin:28px 0}.watch{display:inline-flex;gap:24px;align-items:center;min-height:52px;padding:14px 24px;background:#ff705b;color:#1c1010;font-size:16px;font-weight:750;border-radius:6px}.watch:hover{background:#ff9b86}section.features{border-top:1px solid #333139;padding-block:36px 60px}h2{font-size:22px;letter-spacing:-.02em;margin:0 0 28px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:32px}.number{color:#aa9290;font-size:12px;letter-spacing:1px}h3{font-size:17px;line-height:1.5;margin:14px 0 10px}.grid p{font-size:14px;line-height:1.8;color:#aaa4ab;margin:0}.note{font-size:12px;line-height:1.9;color:#9d969e;max-width:780px;margin:0 0 40px}footer{border-top:1px solid #333139;padding-block:24px 32px;display:flex;gap:20px;align-items:center;justify-content:space-between;flex-wrap:wrap}footer p{margin:0;color:#98929b;font-size:11px}footer nav{display:flex;flex-wrap:wrap;gap:8px 24px}footer a{display:inline-flex;min-height:44px;align-items:center;font-size:12px;color:#c7c1c6;text-decoration:underline;text-underline-offset:4px}@media(max-width:640px){header{min-height:80px}.brand{font-size:17px}summary{max-width:158px;font-size:12px}.hero{padding-block:60px 48px}.grid{grid-template-columns:1fr;gap:28px}.grid article{padding-inline-start:18px;border-inline-start:1px solid #51404a}h3{margin-top:8px}section.features{padding-bottom:36px}}@media(prefers-reduced-motion:no-preference){a{transition:background .15s ease,color .15s ease}}
</style>
</head>
<body>
<a class="skip" href="#content">${escape(text.back)}</a>
<header><a class="brand" href="${url('about.html')}" aria-label="Aurora Drama">aurora<span>drama</span></a><details><summary aria-label="${escape(text.language)}">${escape(text.name)}</summary><nav class="languages" aria-label="${escape(text.language)}">${Object.entries(languages).map(([lang, row]) => `<a href="https://auroradrama.app/about.html?lang=${lang}" lang="${lang}" hreflang="${lang}"${code === lang ? ' aria-current="true"' : ''}>${escape(row.name)}</a>`).join('')}</nav></details></header>
<main id="content"><section class="hero"><p class="eyebrow">${escape(text.eyebrow)}</p><h1>${escape(text.title)}</h1><p class="intro">${escape(text.intro)}</p><a class="watch" href="https://auroradrama.app/#/">${escape(text.watch)} <span aria-hidden="true">↗</span></a></section>
<section class="features"><h2>${escape(text.learn)}</h2><div class="grid">${text.features.map(([title, description], index) => `<article><span class="number" aria-hidden="true">0${index + 1}</span><h3>${escape(title)}</h3><p>${escape(description)}</p></article>`).join('')}</div></section><p class="note">${escape(text.note)}</p></main>
<footer><p>© 2026 Aurora Drama · UYING MEDIA LIMITED</p><nav aria-label="${escape(text.home)}"><a href="${url('terms.html')}">${escape(text.terms)}</a><a href="${url('privacy.html')}">${escape(text.privacy)}</a><a href="mailto:baize16618855@163.com">${escape(text.contact)}</a></nav></footer>
</body></html>
`
  const file = join(root, code === 'en' ? 'about.html' : `locales/${code}/about.html`)
  if (process.argv.includes('--check')) {
    if (await readFile(file, 'utf8') !== html) throw new Error(`Stale website HTML: ${file}`)
  } else {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, html)
  }
}
