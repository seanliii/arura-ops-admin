<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { Drama } from '../../shared/contracts'
import type { CatalogSection, CatalogSort } from '../../shared/catalog-channel'
import PositionSelect from './PositionSelect.vue'

const props = defineProps<{ modelValue: CatalogSection[]; dramas: Drama[]; sort?: CatalogSort }>()
const emit = defineEmits<{ 'update:modelValue': [sections: CatalogSection[]]; invalid: [value: boolean] }>()
const selectedId = ref('')
const modes = reactive<Record<string, 'all' | 'custom'>>({})
const titleField = ref<HTMLInputElement>()
const search = ref('')
const selected = computed(() => props.modelValue.find(section => section.id === selectedId.value))
const selectedIndex = computed(() => props.modelValue.findIndex(section => section.id === selectedId.value))
watch(() => props.modelValue, sections => {
  for (const section of sections) if (!modes[section.id]) modes[section.id] = section.dramaIds.length ? 'custom' : 'all'
  if (!sections.some(section => section.id === selectedId.value)) selectedId.value = sections[0]?.id ?? ''
}, { immediate: true })
const invalid = computed(() => props.modelValue.some(section => !section.title.trim() ||
  (modes[section.id] === 'custom' && !section.dramaIds.length)))
watch(invalid, value => emit('invalid', value), { immediate: true })
const choices = computed(() => props.dramas.filter(drama => drama.title.toLowerCase().includes(search.value.trim().toLowerCase())))
function update(id: string, fields: Partial<CatalogSection>) {
  emit('update:modelValue', props.modelValue.map(section => section.id === id ? { ...section, ...fields } : section))
}
async function add() {
  if (props.modelValue.length >= 12) return
  const id = crypto.randomUUID()
  modes[id] = 'all'; selectedId.value = id
  emit('update:modelValue', [...props.modelValue, { id, title: '', dramaIds: [] }])
  await nextTick(); titleField.value?.focus()
}
function move(from: number, to: number) {
  if (from < 0 || to < 0 || from >= props.modelValue.length || to >= props.modelValue.length) return
  const rows = [...props.modelValue]
  const [row] = rows.splice(from, 1); rows.splice(to, 0, row!)
  emit('update:modelValue', rows)
}
function setMode(mode: 'all' | 'custom') {
  if (!selected.value) return
  modes[selected.value.id] = mode
  update(selected.value.id, { dramaIds: mode === 'all' ? [] : props.dramas.map(drama => drama.id) })
}
function toggle(id: number) {
  if (!selected.value) return
  const ids = selected.value.dramaIds
  update(selected.value.id, { dramaIds: ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id] })
}
function moveDrama(from: number, to: number) {
  if (!selected.value || to < 0 || to >= selected.value.dramaIds.length) return
  const ids = [...selected.value.dramaIds]
  const [id] = ids.splice(from, 1); ids.splice(to, 0, id!)
  update(selected.value.id, { dramaIds: ids })
}
function remove() {
  if (!selected.value) return
  // 只移除尚未保存的栏目；放弃主页修改可以恢复，不删除作品。
  emit('update:modelValue', props.modelValue.filter(section => section.id !== selectedId.value))
}
</script>

<template>
  <section aria-label="首页栏目顺序" class="home-section-editor">
    <div class="section-heading"><h3>栏目 <span class="muted small-text">{{ modelValue.length }} / 12</span></h3><button type="button" class="button" :disabled="modelValue.length >= 12" @click="add">添加栏目</button></div>
    <div v-if="!modelValue.length" class="empty-state compact"><h3>目前没有自定义栏目</h3><p>首页会展示完整片单。需要分类展示时再添加，不必为了上架而填写。</p></div>
    <div v-else class="section-workbench">
      <ol class="section-list" aria-label="栏目列表">
        <li v-for="(section, i) in modelValue" :key="section.id" :class="{ selected: selectedId === section.id }">
          <button type="button" class="section-select" :aria-label="`编辑栏目 ${section.title || '未命名栏目'}`" :aria-pressed="selectedId === section.id" @click="selectedId = section.id; search = ''"><span class="position-number">{{ i + 1 }}</span><span><strong>{{ section.title || '未命名栏目' }}</strong><small>{{ modes[section.id] === 'all' ? '使用全部首页作品' : `自选 ${section.dramaIds.length} 部作品` }}</small></span></button>
          <PositionSelect :label="`栏目 ${section.title || '未命名栏目'} 的位置`" :index="i" :total="modelValue.length" @move="move(i, $event)" />
        </li>
      </ol>
      <div v-if="selected" class="section-detail">
        <p class="sr-only">正在编辑第 {{ selectedIndex + 1 }} 个栏目</p>
        <label class="field"><span>栏目名称</span><input ref="titleField" :value="selected.title" aria-label="栏目名称" maxlength="50" placeholder="使用观众能看懂的当前语言名称" @input="update(selected.id, { title: ($event.target as HTMLInputElement).value })" /></label>
        <p v-if="!selected.title.trim()" class="notice warning">请先填写栏目名称，观众将在首页看到这个名称。</p>
        <label class="field"><span>栏目里放哪些作品？</span><select :value="modes[selected.id]" aria-label="栏目选片方式" @change="setMode(($event.target as HTMLSelectElement).value as 'all' | 'custom')"><option value="all">使用全部首页作品</option><option value="custom">只放我选择的作品</option></select></label>
        <p v-if="modes[selected.id] === 'all'" class="muted small-text">自动跟随首页片单；以后加入的新作品也会显示。</p>
        <template v-else>
          <label class="field"><span>在首页作品中查找</span><input v-model="search" type="search" aria-label="查找栏目作品" placeholder="输入剧名" /></label>
          <div class="section-picks"><label v-for="drama in choices" :key="drama.id" class="checkbox"><input type="checkbox" :checked="selected.dramaIds.includes(drama.id)" :aria-label="`栏目选片 ${drama.title}`" @change="toggle(drama.id)" /><span>{{ drama.title }}</span></label></div>
          <p v-if="!choices.length" class="muted">没有匹配的首页作品；可先到“首页作品”里添加。</p>
          <p v-if="!selected.dramaIds.length" class="notice warning" role="alert">请为自选栏目至少选择一部作品，或改为使用全部首页作品。</p>
          <p v-else class="muted">{{ sort && sort !== 'manual' ? '作品按上方动态规则排列；这里选择作品，不设置手动位置。' : '已选作品的顺序如下，可直接移到指定位置。' }}</p>
          <ol v-if="!sort || sort === 'manual'" class="section-drama-order">
            <li v-for="(id, n) in selected.dramaIds" :key="id"><span>{{ n + 1 }}. {{ dramas.find(drama => drama.id === id)?.title || `作品 #${id}` }}</span><PositionSelect :label="`栏目作品 ${dramas.find(drama => drama.id === id)?.title || id} 的位置`" :index="n" :total="selected.dramaIds.length" @move="moveDrama(n, $event)" /></li>
          </ol>
        </template>
        <details class="section-more"><summary>栏目操作</summary><div class="section-remove"><button type="button" class="button danger" @click="remove">从首页移除此栏目</button><small>保存后生效，不会删除栏目里的作品。</small></div></details>
      </div>
    </div>
  </section>
</template>

<style scoped>
.home-section-editor { min-width: 0; }
.section-workbench { display: grid; grid-template-columns: minmax(220px, .7fr) minmax(0, 1.3fr); gap: 18px; align-items: start; }
.section-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.section-list li { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--panel); }
.section-list li.selected { border-color: var(--accent-border); background: var(--accent-soft); }
.section-select { border: 0; padding: 4px 0 10px; background: transparent; color: var(--text); text-align: left; display: flex; gap: 10px; width: 100%; min-height: 44px; }
.section-select strong, .section-select small { display: block; overflow-wrap: anywhere; }
.position-number { color: var(--muted); font-variant-numeric: tabular-nums; }
.section-list :deep(.position-control) { justify-content: flex-end; }
.section-detail { border: 1px solid var(--line); border-radius: 8px; padding: 18px; background: var(--surface-subtle); }
.section-detail .eyebrow { margin-bottom: 20px; }
.section-picks { max-height: 320px; overflow: auto; margin-bottom: 16px; }
.section-picks .checkbox { margin: 0; padding: 12px 2px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.section-drama-order { list-style: none; margin: 16px 0 0; padding: 0; }
.section-drama-order li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.section-drama-order li > span { flex: 1; min-width: 120px; overflow-wrap: anywhere; }
.section-more { margin-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: .875rem; }
.section-remove { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding-top: 8px; }
@media(max-width:850px) { .section-workbench { grid-template-columns: minmax(0, 1fr); } .section-detail { padding: 18px; } }
</style>
