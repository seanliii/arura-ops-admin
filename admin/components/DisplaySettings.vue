<script setup lang="ts">
import { reactive, watch } from 'vue'
const emit = defineEmits<{ change: [value: { theme: 'light' | 'dark'; font: 'standard' | 'large' }]; navigate: [page: 'dramas' | 'home' | 'media' | 'integrations'] }>()
const props = defineProps<{ theme: 'light' | 'dark'; font: 'standard' | 'large'; storageAvailable: boolean }>()
const form = reactive({ theme: props.theme, font: props.font })
watch(form, () => emit('change', { ...form }))
</script>

<template>
  <section class="panel display-settings" aria-label="后台显示设置">
    <div class="section-heading"><div><h2>让后台更适合你</h2><p class="muted">即时生效，只影响这台浏览器里的管理后台。</p></div></div>
    <div class="form-grid">
      <label class="field"><span>文字大小</span><select v-model="form.font" aria-label="文字大小"><option value="standard">标准 · 16px</option><option value="large">大字 · 18px</option></select></label>
      <label class="field"><span>界面外观</span><select v-model="form.theme" aria-label="界面外观"><option value="light">浅色 · 日常办公</option><option value="dark">深色 · 低光环境</option></select></label>
    </div>
    <div class="settings-preview"><h3>这是剧目标题</h3><p>清楚地看见作品、集数和下一步操作。</p><small>辅助说明也保持可读，不会因为屏幕变窄就缩小文字。</small></div>
    <p class="muted" role="status">{{ storageAvailable ? '显示偏好已保存在此浏览器，刷新后继续使用。' : '浏览器不允许保存偏好，本次打开期间仍然有效。' }}</p>
    <p class="muted small-text">不会修改观众语言、视频原声、首页片单、发行地区或其他运营人员的设置。</p>
  </section>
  <section class="panel display-settings" aria-label="其他设置在哪里">
    <h2>其他设置在哪里？</h2>
    <div class="settings-destination"><div><h3>作品资料与观看规则</h3><p class="muted">视频原声、字幕、免费集数、价格和发行范围，都在对应剧目里。</p></div><button class="button" @click="emit('navigate', 'dramas')">去管理剧目</button></div>
    <div class="settings-destination"><div><h3>各语言的首页</h3><p class="muted">选片、栏目名称与顺序，由“首页编排”统一保存。</p></div><button class="button" @click="emit('navigate', 'home')">去编排首页</button></div>
    <div class="settings-destination"><div><h3>平台与支付接入</h3><p class="muted">查看服务器实际状态；这里不修改凭据、不启用付款。</p></div><button class="button" @click="emit('navigate', 'integrations')">查看接入状态</button></div>
  </section>
</template>

<style scoped>
.display-settings { max-width: 900px; }
.settings-preview { display: grid; gap: 10px; padding: 24px; background: var(--surface-subtle); border: 1px solid var(--line); border-radius: 10px; margin: 8px 0 20px; }
.settings-destination { display: flex; align-items: center; justify-content: space-between; gap: 24px; border-top: 1px solid var(--line); padding: 24px 0; margin-top: 16px; }
.settings-destination p { margin-top: 8px; max-width: 54ch; }
@media(max-width:640px) { .settings-destination { align-items: flex-start; flex-direction: column; gap: 12px; } }
</style>
