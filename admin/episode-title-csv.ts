import type { Drama } from '../shared/contracts'

export const MAX_TITLE_CSV_BYTES = 512 * 1024
export interface TitleCsvDocument { headers: string[]; rows: string[][] }
export interface TitleCsvMapping {
  dramaId: number; key: number; keyKind: 'seq' | 'episodeId'; version: number
  title: number; action: number; mode: 'keep' | 'set' | 'clear'
}
export interface TitleCsvRow {
  row: number; episodeId: number | null; seq: number | null; oldTitle: string | null; title: string
  code: 'ready' | 'unchanged' | 'keep' | 'scope' | 'draft' | 'key' | 'duplicate' | 'unmatched' | 'version' | 'title' | 'clear' | 'action'
  message: string
}
export interface TitleCsvPreview {
  version: number; rows: TitleCsvRow[]; counts: { ready: number; invalid: number; unchanged: number }
  changes: { episodeId: number; title: string }[]
}

/** Bounded CSV, not a spreadsheet interpreter. Quoted commas/newlines/escaped quotes are preserved. */
export function parseTitleCsv(input: string): TitleCsvDocument {
  if (new TextEncoder().encode(input).byteLength > MAX_TITLE_CSV_BYTES) throw new Error('CSV文件不能超过512 KB。')
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(input)) throw new Error('CSV含不支持的控制字符。')
  if (input.includes('\uFFFD')) throw new Error('CSV编码无法确认，请另存为UTF-8。')
  const text = input.replace(/^\uFEFF/u, '')
  const records: string[][] = []
  let row: string[] = [], value = '', quoted = false, closed = false
  const cell = () => { row.push(value); value = ''; closed = false }
  const record = () => {
    cell()
    if (row.length > 30) throw new Error('最多映射30列，请移除不使用的列。')
    if (!(row.length === 1 && row[0] === '')) records.push(row)
    row = []
    if (records.length > 101) throw new Error('一次最多100行单集资料，请拆分文件。')
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { value += '"'; i++ } else { quoted = false; closed = true }
      } else value += char
    } else if (char === ',') cell()
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++
      record()
    } else if (char === '"' && !value && !closed) quoted = true
    else {
      if (closed || char === '"') throw new Error(`CSV第${records.length + 1}条记录的引号格式不正确。`)
      value += char
    }
  }
  if (quoted) throw new Error('CSV引号未闭合，请检查包含换行或逗号的单元格。')
  if (row.length || value || closed) record()
  const headers = records.shift()?.map(h => h.trim())
  if (!headers?.length || headers.some(h => !h)) throw new Error('首行须为非空列名。')
  if (new Set(headers.map(h => h.toLocaleLowerCase())).size !== headers.length) throw new Error('CSV列名重复，无法确认映射。')
  if (!records.length) throw new Error('CSV至少需要一行单集资料。')
  if (records.some(r => r.length !== headers.length)) throw new Error('CSV各行列数须与首行一致；含逗号或换行的内容请用双引号包围。')
  return { headers, rows: records }
}

function positive(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null
  const n = Number(value.trim())
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
export function csvPreview(doc: TitleCsvDocument, map: TitleCsvMapping, drama: Drama): TitleCsvPreview {
  for (const [name, index] of [['作品', map.dramaId], ['单集', map.key], ['源版本', map.version]] as const)
    if (!Number.isInteger(index) || index < 0 || index >= doc.headers.length) throw new Error(`请选择${name}列，不能猜测匹配依据。`)
  const indices = [map.dramaId, map.key, map.version, map.title, map.action].filter(n => n >= 0)
  if (new Set(indices).size !== indices.length) throw new Error('同一列不能重复用于不同字段。')
  if (indices.some(n => !Number.isInteger(n) || n >= doc.headers.length)) throw new Error('映射列已变化，请重新选择。')
  if (!['keep', 'set', 'clear'].includes(map.mode) || !['seq', 'episodeId'].includes(map.keyKind)) throw new Error('请选择支持的标题操作和匹配方式。')
  const keys = doc.rows.map(r => `${positive(r[map.dramaId])}:${positive(r[map.key])}`)
  const counts = new Map<string, number>()
  keys.forEach(k => counts.set(k, (counts.get(k) ?? 0) + 1))
  const rows: TitleCsvRow[] = doc.rows.map((source, i) => {
    const key = positive(source[map.key])
    const episode = drama.episodes.find(e => (map.keyKind === 'seq' ? e.seq : e.id) === key)
    const title = (source[map.title] ?? '').trim()
    const row: TitleCsvRow = { row: i + 2, episodeId: episode?.id ?? null, seq: episode?.seq ?? null,
      oldTitle: episode?.title ?? null, title, code: 'ready', message: '可保存' }
    const reject = (code: TitleCsvRow['code'], message: string) => ({ ...row, code, message })
    if (positive(source[map.dramaId]) !== drama.id) return reject('scope', '不属于当前作品；请在对应作品内另行确认。')
    if (drama.status !== 'draft') return reject('draft', '当前作品不是私有草稿，不能用CSV批改。')
    if (key === null) return reject('key', '单集匹配值须为正整数，不接受混合文本。')
    if ((counts.get(keys[i]!) ?? 0) > 1) return reject('duplicate', '重复匹配同一集，重复的各行均不提交。')
    if (!episode) return reject('unmatched', '在当前作品中未找到此集。')
    if (positive(source[map.version]) !== drama.version) return reject('version', `源版本不符：当前为${drama.version}，请核对后更新文件。`)
    const rawAction = map.action >= 0 ? source[map.action]!.trim().toLowerCase() : map.mode
    const action = ({ '不改': 'keep', '设值': 'set', '清空': 'clear', '': 'keep' } as Record<string, string>)[rawAction] ?? rawAction
    if (action === 'keep') return reject('keep', '不修改标题。')
    if (action === 'clear') return reject('clear', '标题是必填项，不能清空；本行不提交。')
    if (action !== 'set') return reject('action', '动作只接受keep/不改、set/设值、clear/清空。')
    if (map.title < 0 || !title || title.length > 200) return reject('title', '请映射1至200字的标题；空值不会自动清空。')
    if (title === episode.title) return reject('unchanged', '与原标题相同，不提交。')
    return row
  })
  const changes = rows.filter(r => r.code === 'ready').map(r => ({ episodeId: r.episodeId!, title: r.title }))
  const unchanged = rows.filter(r => ['keep', 'unchanged'].includes(r.code)).length
  return { version: drama.version, rows, changes, counts: { ready: changes.length, unchanged, invalid: rows.length - changes.length - unchanged } }
}

function spreadsheetCell(input: string | number): string {
  const value = String(input)
  // The apostrophe is a visible text-protection prefix, not part of an automatically re-imported title.
  const safe = /^[\s\uFEFF]*[=+\-@＝＋－＠]/u.test(value) || /^[\t\r\n]/u.test(value) ? `'${value}` : value
  return `"${safe.replace(/"/gu, '""')}"`
}
export function exportEpisodeTitles(drama: Drama): string {
  const rows: (string | number)[][] = [['作品ID', '集数', '作品版本', '标题'],
    ...[...drama.episodes].sort((a, b) => a.seq - b.seq).map(e => [drama.id, e.seq, drama.version, e.title])]
  return '\uFEFF' + rows.map(r => r.map(spreadsheetCell).join(',')).join('\r\n') + '\r\n'
}
