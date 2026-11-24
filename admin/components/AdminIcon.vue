<script setup lang="ts">
defineProps<{ name: string }>()
const paths: Record<string, string> = {
  dramas: 'M4 5h16v15H4z M4 10h16 M9 5v5 M15 5v5 M9 2v3 M15 2v3',
  home: 'M4 4h6v7H4z M14 4h6v4h-6z M14 12h6v8h-6z M4 15h6v5H4z',
  analytics: 'M4 4v16h16 M8 15v-4 M12 15V7 M16 15v-6',
  media: 'M12 16V3 M7 8l5-5 5 5 M4 14v6h16v-6',
  orders: 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',
  users: 'M15.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0 M5 21v-3a7 7 0 0 1 14 0v3',
  audit: 'M8 4H5v17h14V4h-3 M9 3h6v4H9z M9 12h6 M9 16h6',
  integrations: 'M8 3v5 M16 3v5 M6 8h12v3a6 6 0 0 1-12 0z M12 17v4',
  preview: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  settings: 'M4 7h16 M4 17h16 M9 4v6 M15 14v6',
  plus: 'M12 5v14 M5 12h14',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M15 15l5 5',
}
</script>

<template>
  <svg class="admin-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path :d="paths[name] || paths.dramas" /></svg>
</template>
