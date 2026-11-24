<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Drama } from '../../shared/contracts'
import { csvPreview, exportEpisodeTitles, MAX_TITLE_CSV_BYTES, parseTitleCsv,
  type TitleCsvDocument, type TitleCsvMapping, type TitleCsvPreview } from '../episode-title-csv'
import Feedback from './Feedback.vue'

const props = defineProps<{ drama: Drama; disabled: boolean; staged: boolean; saved: boolean }>()
const emit = defineEmits<{ prepare: [preview: TitleCsvPreview]; dirty: [value: boolean]; busy: [value: boolean]; close: [] }>()
const doc = ref<TitleCsvDocument>(), preview = ref<TitleCsvPreview>(), filename = ref(''), error = ref(''), loading = ref(false)
const identityOpen = ref(false)
const map = reactive<TitleCsvMapping>({ dramaId: -1, key: -1, keyKind: 'seq', version: -1, title: -1, action: -1, mode: 'keep' })
const locked = computed(() => props.disabled || loading.value || props.staged)
const shownRows = computed(() => preview.value?.rows.filter(r => !props.staged || !['ready', 'unchanged', 'keep'].includes(r.code)) ?? [])
watch(map, () => { preview.value = undefined })
watch(() => !!doc.value && !props.staged, value => emit('dirty', value), { immediate: true })
watch(loading, value => emit('busy', value), { immediate: true })
onBeforeUnmount(() => { emit('dirty', false); emit('busy', false) })
async function choose(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (!file || locked.value) return
  loading.value = true; error.value = ''; preview.value = undefined; doc.value = undefined
  try {
    if (file.size > MAX_TITLE_CSV_BYTES) throw new Error('CSV文件不能超过512 KB。')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) }
    catch { throw new Error('无法读取UTF-8 CSV，请另存为UTF-8后重新选择。') }
    const parsed = parseTitleCsv(text)
    const column = (...names: string[]) => parsed.headers.findIndex(h => names.includes(h.toLowerCase()))
    Object.assign(map, { dramaId: column('作品id', '作品', 'dramaid', 'drama_id'), key: column('集数', '集号', 'seq'),
      keyKind: 'seq', version: column('作品版本', '版本', 'version'), title: -1, action: -1, mode: 'keep' })
    identityOpen.value = [map.dramaId, map.key, map.version].some(n => n < 0)
    doc.value = parsed; filename.value = file.name
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'CSV读取失败，请重新选择。' }
  finally { loading.value = false; input.value = '' }
}
function inspect() {
  if (!doc.value || locked.value) return
  error.value = ''
  try { preview.value = csvPreview(doc.value, map, props.drama) }
  catch (cause) { preview.value = undefined; error.value = cause instanceof Error ? cause.message : '请检查映射。' }
}
function prepare() {
  if (locked.value || !preview.value?.changes.length) return
  // Re-evaluate against the live prop before staging; a changed source version cannot silently slip through.
  inspect()
  if (preview.value?.changes.length) emit('prepare', preview.value)
}
function download() {
  const url = URL.createObjectURL(new Blob([exportEpisodeTitles(props.drama)], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = `drama-${props.drama.id}-titles.csv`; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <section class="csv-import" role="region" aria-label="CSV整理标题" :aria-busy="loading">
    <div class="section-heading"><h4>从表格整理集名</h4><button type="button" class="button quiet" :disabled="disabled || loading" @click="emit('close')">关闭CSV</button></div>
    <p class="muted small-text">只处理「{{ drama.title }}」的标题。作品、单集和版本只用于核对；视频、价格、权利和公开状态不变。</p>
    <div v-if="!staged" class="csv-source">
      <label class="field"><span>选择CSV · UTF-8，最多100行、512 KB</span><input type="file" accept=".csv,text/csv" aria-label="导入标题CSV" :disabled="locked" @change="choose" /></label>
      <button type="button" class="button" :disabled="disabled || loading" @click="download">下载当前集名模板</button>
    </div>
    <Feedback :loading="loading" :error="error" />
    <template v-if="doc && !staged">
      <p class="muted small-text">{{ filename }} · {{ doc.rows.length }} 行。先映射，再检查差异；现在还不会保存。</p>
      <fieldset class="csv-mapping" :disabled="locked">
        <label class="field"><span>标题列</span><select v-model.number="map.title" aria-label="标题列"><option :value="-1">不使用标题列</option><option v-for="(h, i) in doc.headers" :key="i" :value="i">{{ h }}</option></select></label>
        <label class="field"><span>标题操作</span><select v-model="map.mode" aria-label="标题操作"><option value="keep">不改（默认）</option><option value="set">设为标题列的值</option><option value="clear">清空（标题必填，将提示拒绝）</option></select></label>
        <details class="csv-extra" :open="identityOpen" @toggle="identityOpen = ($event.target as HTMLDetailsElement).open">
        <summary>匹配依据 · {{ doc.headers[map.dramaId] || '作品列待选' }} / {{ doc.headers[map.key] || '单集列待选' }} / {{ doc.headers[map.version] || '版本列待选' }}</summary>
        <div class="csv-mapping">
        <label class="field"><span>作品ID列</span><select v-model.number="map.dramaId" aria-label="作品ID列"><option :value="-1">请选择</option><option v-for="(h, i) in doc.headers" :key="i" :value="i">{{ h }}</option></select></label>
        <label class="field"><span>单集匹配方式</span><select v-model="map.keyKind" aria-label="单集匹配方式"><option value="seq">本作品集数</option><option value="episodeId">单集ID</option></select></label>
        <label class="field"><span>单集匹配列</span><select v-model.number="map.key" aria-label="单集匹配列"><option :value="-1">请选择</option><option v-for="(h, i) in doc.headers" :key="i" :value="i">{{ h }}</option></select></label>
        <label class="field"><span>源作品版本列</span><select v-model.number="map.version" aria-label="源作品版本列"><option :value="-1">请选择</option><option v-for="(h, i) in doc.headers" :key="i" :value="i">{{ h }}</option></select></label>
        </div></details>
        <details class="csv-extra"><summary>每行不同操作（可选）</summary><label class="field"><span>逐行动作列</span><select v-model.number="map.action" aria-label="逐行动作列"><option :value="-1">统一使用上方操作</option><option v-for="(h, i) in doc.headers" :key="i" :value="i">{{ h }}</option></select></label><small>接受keep/不改、set/设值、clear/清空；有动作列时，空动作表示不改。</small></details>
      </fieldset>
      <button type="button" class="button" :disabled="locked" @click="inspect">检查CSV差异</button>
    </template>
    <div v-if="preview" data-testid="csv-title-preview" class="csv-preview" aria-live="polite">
      <strong>可保存 {{ preview.counts.ready }} · 未改动 {{ preview.counts.unchanged }} · 待处理 {{ preview.counts.invalid }}</strong>
      <p v-if="staged" class="muted small-text">{{ saved ? '已返回有效行的保存回执。' : '有效行已载入下方标题差异，仍需明确确认保存。' }}以下待处理行未提交；修好文件后可另行导入。</p>
      <ul><li v-for="row in shownRows" :key="row.row"><div><strong>记录 {{ row.row }} · 第 {{ row.seq ?? '未知' }} 集</strong><span :class="['badge', row.code === 'ready' ? 'good' : 'neutral']">{{ row.message }}</span></div><span v-if="!staged">{{ row.oldTitle ?? '未匹配' }} → {{ row.title || '空值' }}</span></li></ul>
      <button v-if="preview.changes.length && !staged" type="button" class="button primary" :disabled="locked" @click="prepare">载入 {{ preview.counts.ready }} 条有效修改</button>
    </div>
    <details class="csv-help"><summary>CSV与表格安全说明</summary><p class="muted small-text">含逗号、双引号或换行的单元格须使用CSV引号。公式样式标题按普通文字预览，不执行。模板对公式样式文字加单引号保护；再次导入前请核对这个可见前缀，不会自动剥除。外部表格软件另存可能改变格式，不能据此保证任意软件、任意转存后仍安全。</p></details>
  </section>
</template>

<style scoped>
.csv-import { margin: 16px 0; padding: 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-subtle); min-width: 0; overflow-wrap: anywhere; }
.csv-import h4 { margin: 0; font-size: 1rem; }
.csv-source { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin: 14px 0; }
.csv-source .field { flex: 1 1 260px; }
.csv-mapping { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding: 0; border: 0; margin: 16px 0; }
.csv-import .field { min-width: 0; margin: 0; }
.csv-import input, .csv-import select { min-width: 0; max-width: 100%; width: 100%; }
.csv-extra { grid-column: 1 / -1; }
.csv-extra .field { margin: 10px 0; }
.csv-preview { margin-top: 18px; }
.csv-preview ul { padding: 0; list-style: none; }
.csv-preview li { display: grid; gap: 6px; padding: 12px 0; border-bottom: 1px solid var(--line); white-space: pre-wrap; }
.csv-preview li > div { display: flex; flex-wrap: wrap; gap: 8px; align-items: start; }
.csv-preview .badge { white-space: normal; }
.csv-help { margin-top: 16px; color: var(--muted); font-size: .875rem; }
@media(max-width:640px) { .csv-mapping { grid-template-columns: minmax(0, 1fr); } .csv-import { padding: 12px; } }
</style>
