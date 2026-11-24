<script setup lang="ts">
import mark from './aurora-mark.svg'
withDefaults(defineProps<{ size?: number; label?: string }>(), { size: 40, label: '' })
</script>

<template>
  <img class="aurora-mark" :src="mark" :width="size" :height="size" :alt="label" :aria-hidden="label ? undefined : true" />
</template>

<style scoped>
.aurora-mark { display: block; flex: none; object-fit: contain; }
</style>
