<script setup lang="ts">
import { computed, ref } from 'vue'
import { shiftDay } from '../operations-context'
type Point = { day: string; qualifiedAttempts: number; watchSeconds: number }
const props = defineProps<{ points: Point[]; from: string; to: string; comparison?: Point[]; comparisonFrom?: string }>()
const metric = ref<'qualifiedAttempts' | 'watchSeconds'>('qualifiedAttempts')
const days = computed(() => {
  const count = Math.min(367, Math.max(0, Math.round((Date.parse(props.to) - Date.parse(props.from)) / 86400000) + 1))
  return Array.from({ length: count }, (_, i) => shiftDay(props.from, i))
})
const values = computed(() => days.value.map(day => props.points.find(p => p.day === day)?.[metric.value] ?? null))
const prior = computed(() => days.value.map((_, i) => props.comparisonFrom
  ? props.comparison?.find(p => p.day === shiftDay(props.comparisonFrom!, i))?.[metric.value] ?? null : null))
const max = computed(() => Math.max(1, ...values.value.map(v => v ?? 0), ...prior.value.map(v => v ?? 0)))
const x = (i: number) => 22 + i / Math.max(1, days.value.length - 1) * 656
const y = (n: number) => 156 - n / max.value * 132
function segments(data: (number | null)[]) {
  const groups: string[] = []; let current: string[] = []
  for (const [i, value] of data.entries()) {
    if (value === null) { if (current.length) groups.push(current.join(' ')); current = [] }
    else current.push(`${x(i)},${y(value)}`)
  }
  if (current.length) groups.push(current.join(' '))
  return groups
}
</script>
<template>
  <section class="panel trend">
    <div class="section-heading">
      <h3>观看趋势</h3>
      <label class="field"><span class="sr-only">趋势指标</span><select v-model="metric">
        <option value="qualifiedAttempts">有效播放次数</option><option value="watchSeconds">实际观看秒数</option>
      </select></label>
    </div>
    <p class="muted small-text">只画一个指标；无记录日期留空，不补成0。次数不等于观看访次或人数。</p>
    <svg v-if="values.some(v => v !== null)" viewBox="0 0 700 178" role="img" :aria-label="`${metric === 'qualifiedAttempts' ? '有效播放次数' : '实际观看秒数'}曲线，无记录日期断开`">
      <path d="M22 156H678 M22 90H678 M22 24H678" class="grid" />
      <polyline v-for="(line, i) in segments(values)" :key="`now-${i}`" :points="line" class="line" />
      <polyline v-for="(line, i) in segments(prior)" :key="`prior-${i}`" :points="line" class="line prior" />
      <template v-for="(value, i) in values" :key="i"><circle v-if="value !== null" :cx="x(i)" :cy="y(value)" r="3.5"><title>{{ days[i] }}：{{ value }}</title></circle></template>
    </svg>
    <p v-else class="empty-state compact">暂无可绘制记录</p>
    <div class="axis"><span>{{ from }}</span><span>{{ to }}</span></div>
    <p v-if="comparison" class="muted small-text">实线为本期，虚线为等长前期；不是改动导致提升的证明。</p>
    <details><summary>查看每日数值与缺测</summary><ul class="daily-values">
      <li v-for="(date, i) in days" :key="date">{{ date }}：{{ values[i] ?? '无记录' }}<span v-if="comparison"> · 前期 {{ prior[i] ?? '无记录' }}</span></li>
    </ul></details>
  </section>
</template>
<style scoped>
.trend { min-width: 0; }.trend .field { margin: 0; min-width: 0; }.trend select { min-width: 0; max-width: 100%; }
svg { display: block; width: 100%; margin: 16px 0 4px; }.grid { stroke: var(--line); fill: none; }
.line { stroke: var(--chart); stroke-width: 2.5; fill: none; }.prior { stroke: var(--muted); stroke-dasharray: 6 4; }
circle { fill: var(--chart); }.axis { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: .875rem; }
details { margin-top: 16px; }summary { cursor: pointer; min-height: 44px; align-content: center; }
.daily-values { max-height: 260px; overflow: auto; padding-left: 22px; line-height: 1.8; }
@media(max-width:600px) { .section-heading { flex-direction: column; align-items: stretch; } }
</style>
