<script setup lang="ts">
defineProps<{ label: string; index: number; total: number; disabled?: boolean }>()
const emit = defineEmits<{ move: [index: number] }>()
</script>
<template>
  <label class="position-control"><span>移动到</span><select :value="index" :aria-label="label" :disabled="disabled || total < 2" @change="emit('move', Number(($event.target as HTMLSelectElement).value))"><option v-for="n in total" :key="n" :value="n - 1">第 {{ n }} 位</option></select></label>
</template>
<style scoped>
.position-control { display: flex; align-items: center; gap: 8px; white-space: nowrap; font-size: .875rem; color: var(--muted); }
.position-control select { width: 104px; flex: 0 0 104px; }
</style>
