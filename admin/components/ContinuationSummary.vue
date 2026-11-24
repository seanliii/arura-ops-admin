<script setup lang="ts">
import { continuationValue, maturityLabel, type ContinuationResult } from '../operations-results'
defineProps<{ value?: ContinuationResult }>()
</script>

<template>
  <div v-if="value" class="continuation-summary" data-testid="continuation-summary">
    <p class="continuation-result"><strong>{{ continuationValue(value) }}</strong>
      <span>{{ value.rate.numerator }} / {{ value.rate.denominator }} 个可接续起点</span></p>
    <small class="muted">{{ maturityLabel(value.observation?.status) }}；供给不明 {{ value.exclusions.unknownSupply }}，关联不明 {{ value.associationUnknown }}。</small>
    <details>
      <summary>口径、供给与未接续原因</summary>
      <p>合格完成 {{ value.completeOrigins }}，可接续 {{ value.eligibleOrigins }}；下一集请求 {{ value.nextRequests }}，首帧 {{ value.nextFirstFrames }}，有效观看 {{ value.nextQualified }}。</p>
      <p>排除：本版本末集 {{ value.exclusions.versionEnd }}，缺后续集 {{ value.exclusions.missingSupply }}，不可用 {{ value.exclusions.unavailableSupply }}，供给未知 {{ value.exclusions.unknownSupply }}。</p>
      <p>未在窗口内出帧：收费未出帧 {{ value.outcomes.paidWithoutFrame }}，播放报错 {{ value.outcomes.playbackFailed }}，请求后未出帧 {{ value.outcomes.requestedWithoutFrame }}，稍后回来 {{ value.outcomes.laterReturn }}，尚未观察到 {{ value.outcomes.unobserved }}，仍在观察 {{ value.outcomes.observing }}。</p>
      <p>{{ value.autoPlayDisabled == null ? '此范围内没有可关联的连播选择，不能推断为观众主动关闭。' : `已观察到连播选择 ${value.autoPlayPreferenceObserved ?? '未知'} / ${value.eligibleOrigins} 个起点，其中最后选择关闭 ${value.autoPlayDisabled}。` }}关闭与手动接续可能同时发生，不代表未接续的原因；收费起点仍计入分母，不等于付款失败。</p>
      <p class="muted">{{ value.definition }}</p>
      <p class="muted">{{ value.supplyDefinition }}</p>
    </details>
  </div>
  <p v-else class="muted">接续待补关联；不拿相邻两集播放总数相除。</p>
</template>

<style scoped>
.continuation-summary { min-width:0; overflow-wrap:anywhere; }
.continuation-result { display:flex; align-items:baseline; flex-wrap:wrap; gap:6px 14px; margin:12px 0 6px; }
.continuation-result span { color:var(--muted); font-size:.875rem; }
summary { min-height:44px; display:list-item; align-content:center; cursor:pointer; color:var(--accent); }
details p { margin:10px 0; line-height:1.6; font-size:.875rem; }
</style>
