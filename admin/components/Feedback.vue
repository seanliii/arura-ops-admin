<script setup lang="ts">
defineProps<{ error?: string; success?: string; loading?: boolean; retry?: boolean }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="error" class="notice error" role="alert">
    <span>{{ error }}</span>
    <button v-if="retry" class="button small" type="button" :disabled="loading" @click="$emit('retry')">重试</button>
  </div>
  <p v-if="success" class="notice success" role="status">{{ success }}</p>
  <p v-if="loading" class="loading" role="status">正在读取服务器数据…</p>
</template>
