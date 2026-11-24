# Legal page integration

## Public routes and language selection

Keep `https://auroradrama.app/terms.html` and `/privacy.html`. The server reads
`manifest.json` and serves the selected **complete HTML document**:

- Canonical languages: `en`, `ja`, `zh-Hans`, `zh-Hant`, `es`, `fr`, `ar`,
  `pt-BR`, `es-419`, `ms`.
- `?lang=zh-CN` aliases `zh-Hans`; `?lang=zh-TW` aliases `zh-Hant`.
- Missing, unknown or non-string/multiple `lang` values fall back to English.
  Do not use `Accept-Language`, cookies or a browser preference to change this default.
- Look up an own property in `manifest.languages` (after the alias lookup);
  never use a request value directly in a filesystem path.
- `manifest.languages[language].terms` and `.privacy` are relative to this
  `legal` directory. English uses `terms.html`/`privacy.html`; other languages use
  `locales/<canonical-language>/<page>.html`.
- Return `text/html; charset=utf-8` and the canonical `Content-Language`.
  Any response cache must retain the query string or otherwise key by the resolved
  language; a cache keyed only by pathname would mix languages.
- Existing `/terms` and `/privacy` aliases may use the same lookup.
  The whole legal source directory should not be exposed as static files.

The page uses native `<details>` and ordinary links: no JavaScript, translation
fetch or new runtime dependency. `nav[data-documents]` and the brand link point
to `/about.html?lang=<current-language>` for the brand website; the legal links
preserve that language. No viewer `/#/` route is replaced.

A static host must provide equivalent query-aware routing; simply serving the
English file for all query strings does **not** implement language selection.
The server integration and deployment are owned by the main thread.

## Content and generation

Edit `content/<language>.json`, then run from the app directory:

```sh
node legal/generate.mjs
node legal/generate.mjs --check
npm run test:unit -- tests/unit/legal-pages.test.ts
```

The generator uses Node built-ins only, writes only the 20 legal HTML files and
`manifest.json`, and does not remove unrelated files. `--check` writes nothing
and reports missing/stale output, so it can be used before deployment.

The original Japanese article text is preserved and pinned by independent
paragraph/list-item SHA-256 tests. Other languages are full translations of that
text, not revised legal terms. Company, email and ISO dates are fixed in the
generator: **UYING MEDIA LIMITED**, **baize16618855@163.com**; terms
**2026-10-17**, privacy **2026-10-21**. The translated text retains the
subscription-in-preparation and no-test-charge statements; privacy retains
page-lifetime random identifiers, account-linked signed-in playback, no device
fingerprints/advertising identifiers for the stated statistics, the latest
30 days of events, expired-record deletion upon new events, and Do Not Track.
No language-precedence clause or additional legal guarantee has been added.
