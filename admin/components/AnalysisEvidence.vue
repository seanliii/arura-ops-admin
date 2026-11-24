<script setup lang="ts">
import { evidenceScope, type AnalysisEvidence } from '../operations-context'
defineProps<{ evidence: AnalysisEvidence }>()
defineEmits<{ back: [] }>()
</script>
<template>
  <aside class="analysis-evidence" data-testid="analysis-evidence" aria-label="本次操作的分析依据">
    <details>
      <summary>查看分析依据</summary>
      <div><strong>来自运营数据 · {{ evidence.title }}</strong>
        <p>{{ evidenceScope(evidence.filters) }}</p>
        <small>这是阅读依据，不会替你保存、送审或改变权限；实际写入范围以下方操作为准。</small>
      </div>
    </details>
    <button type="button" class="button" @click="$emit('back')">返回运营数据</button>
  </aside>
</template>
<style scoped>
.analysis-evidence { display: flex; flex-wrap: wrap; gap: 8px 12px; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.analysis-evidence details { flex: 1 1 0; min-width: 0; }
.analysis-evidence details[open] { flex-basis: 100%; }
.analysis-evidence summary { color: var(--accent); min-height: 44px; white-space: nowrap; }
.analysis-evidence details > div { min-width: 0; overflow-wrap: anywhere; background: var(--surface-subtle); border-radius: 8px; padding: 14px; margin-top: 8px; }
.analysis-evidence p { margin: 8px 0; font-size: .875rem; }
.analysis-evidence button { flex-shrink: 0; }
</style>
