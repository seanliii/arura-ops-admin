<script setup lang="ts">
import { operationMetrics, type OperationNote } from '../operations-history'
defineProps<{ modelValue: OperationNote; disabled?: boolean; hasEvidence?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: OperationNote] }>()
function update(note: OperationNote, patch: Partial<OperationNote>) { emit('update:modelValue', { ...note, ...patch }) }
</script>

<template>
  <details class="operation-note" data-testid="operation-note">
    <summary>记录这次调整（可选）</summary>
    <p class="muted">随这次内容修改一起保存。普通编辑可以不填；不会自动调序、公开或改变价格。</p>
    <p v-if="hasEvidence" class="muted">当前分析范围会作为依据保存，不会扩大本页的写入范围。</p>
    <fieldset :disabled="disabled" class="form-grid">
      <label class="field span-2"><span>这次调整的原因</span><textarea :value="modelValue.reason" aria-label="这次调整的原因" maxlength="500" rows="2"
        placeholder="例如：核对了封面，试着让标题更清楚" @input="update(modelValue, { reason: ($event.target as HTMLTextAreaElement).value })" /></label>
      <label class="field"><span>复查主指标</span><select :value="modelValue.primaryMetric" aria-label="复查主指标"
        @change="update(modelValue, { primaryMetric: ($event.target as HTMLSelectElement).value as OperationNote['primaryMetric'] })">
        <option v-for="(label, key) in operationMetrics" :key="key" :value="key">{{ label }}</option>
      </select></label>
      <label class="field"><span>观察天数</span><input :value="modelValue.observationDays" aria-label="观察天数" type="number" min="1" max="30" step="1"
        @input="update(modelValue, { observationDays: Number(($event.target as HTMLInputElement).value) })" /><small>排除修改当天，前后各取相同天数；迟到数据和回访另需成熟。</small></label>
    </fieldset>
  </details>
</template>

<style scoped>
.operation-note { border-top: 1px solid var(--line); margin-top: 18px; min-width: 0; }
.operation-note > summary { color: var(--muted); }
.operation-note > p { margin-bottom: 12px; font-size: .875rem; }
.operation-note .field { min-width: 0; }
.operation-note select { min-width: 0; }
</style>
