<script setup lang="ts">
import { ref, watch } from 'vue'
import type { CatalogChannel } from '../../shared/catalog-channel'
import type { Drama } from '../../shared/contracts'
import type { AnalyticsCandidate, AnalyticsExperiment, CandidateMetric } from '../../shared/analytics-operations'
import { api, message } from '../api'
import Feedback from './Feedback.vue'
import PositionSelect from './PositionSelect.vue'
const props=defineProps<{channel:CatalogChannel;dramas:Drama[];disabled:boolean}>()
const emit=defineEmits<{apply:[value:AnalyticsCandidate]}>()
const expanded=ref(false),working=ref(false),error=ref(''),success=ref('')
const metric=ref<CandidateMetric>('plays'),candidates=ref<AnalyticsCandidate[]>([]),experiments=ref<AnalyticsExperiment[]>([])
const name=ref('栏目与剧目顺序对照'),percent=ref(20),ids=ref<number[]>([]),sections=ref<string[]>([]),confirmed=ref(false)
let generation=0,pendingCandidate:string|undefined,pendingExperiment:string|undefined
const endpoint=()=>`/${encodeURIComponent(props.channel.region)}/${encodeURIComponent(props.channel.locale)}`
const title=(id:number)=>props.dramas.find(d=>d.id===id)?.title??`#${id}`
function reset(){generation++;ids.value=[...props.channel.dramaIds];sections.value=(props.channel.sections??[]).map(s=>s.id);confirmed.value=false;pendingCandidate=undefined;pendingExperiment=undefined}
watch(()=>[props.channel.region,props.channel.locale,props.channel.version],()=>{reset();if(expanded.value)void read()},{immediate:true})
async function read(){
  const epoch=generation
  try{
    const [a,b]=await Promise.all([api<{candidates:AnalyticsCandidate[]}>(`/admin/analytics/candidates${endpoint()}`),api<{experiments:AnalyticsExperiment[]}>(`/admin/analytics/experiments${endpoint()}`)])
    if(epoch!==generation)return
    candidates.value=a.candidates;experiments.value=b.experiments
  }catch(e){if(epoch===generation)error.value=message(e)}
}
function toggle(event:Event){expanded.value=(event.currentTarget as HTMLDetailsElement).open;if(expanded.value)void read()}
function move(list:'ids'|'sections',index:number,next:number){
  if(next<0||next>=(list==='ids'?ids.value:sections.value).length)return
  if(list==='ids'){const [item]=ids.value.splice(index,1);ids.value.splice(next,0,item!)}
  else{const [item]=sections.value.splice(index,1);sections.value.splice(next,0,item!)}
  pendingExperiment=undefined
}
async function run(action:()=>Promise<void>){
  if(working.value||props.disabled)return
  working.value=true;error.value='';success.value=''
  try{await action()}catch(e){error.value=message(e)}finally{working.value=false}
}
async function candidate(){
  const epoch=generation
  await run(async()=>{
    pendingCandidate??=crypto.randomUUID()
    const result=await api<{candidate:AnalyticsCandidate}>(`/admin/analytics/candidates${endpoint()}`,{method:'POST',body:{
      version:props.channel.version,metric:metric.value,requestId:pendingCandidate,
    }})
    if(epoch!==generation)return
    pendingCandidate=undefined;await read();success.value='候选已存入统计库，当前线上主页没有改变。'
    if(result.candidate.channelVersion!==props.channel.version)throw Error('候选对应旧主页，请重新核对')
  })
}
async function createExperiment(){
  const epoch=generation
  await run(async()=>{
    pendingExperiment??=crypto.randomUUID()
    await api(`/admin/analytics/experiments${endpoint()}`,{method:'POST',body:{requestId:pendingExperiment,version:props.channel.version,
      name:name.value,dramaIds:ids.value,sectionIds:sections.value,exposurePercent:percent.value}})
    if(epoch!==generation)return
    pendingExperiment=undefined;await read();success.value='实验草稿已保存，尚未分流。明确启用之前，所有观众仍使用原主页。'
  })
}
async function operate(experiment:AnalyticsExperiment,action:'activate'|'pause'|'complete'){
  if(action==='activate'&&!confirmed.value)return
  await run(async()=>{
    await api(`/admin/analytics/experiments/${experiment.id}/actions/${action}`,{method:'POST',body:action==='activate'?{version:props.channel.version,confirmed:true}:{}})
    confirmed.value=false;await read();success.value=action==='activate'?'实验已按明确比例启用。只重排同一片单，不改变内容权限或价格。':'实验已停止分流，观众使用当前主页编排。'
  })
}
</script>
<template>
  <details class="operations" data-testid="analytics-operations" @toggle="toggle">
    <summary>数据辅助编排 · 候选排序与受控实验</summary>
    <div v-if="expanded" class="operations-body">
      <Feedback :loading="working" :error="error" :success="success" />
      <p v-if="!channel.configured" class="notice">请先保存一份主页编排，再为它生成候选或对照。不会自动替你保存。</p>
      <p v-else-if="disabled" class="notice">先保存或放弃当前主页的未保存改动，避免候选覆盖正在编辑的内容。</p>
      <fieldset :disabled="disabled||working||!channel.configured">
        <div class="candidate-controls"><label class="field"><span>候选依据</span><select v-model="metric" @change="pendingCandidate=undefined"><option value="plays">有效播放次数</option><option value="playRate">曝光后播放率</option><option value="paidRate">当前付费买家占比</option><option value="clickRate">点击率</option><option value="watchSeconds">实际观看时长</option></select></label>
          <button type="button" class="button" data-testid="candidate-create" @click="candidate">生成并保存候选</button></div>
        <p class="muted">只用当前地区与内容频道的成绩；未记录频道语言的旧数据不混入。至少100个曝光访次和30次有效播放才参与候选重排；样本不足的剧保留原位。生成候选不改变线上顺序。</p>
        <article v-for="item in candidates" :key="item.id" class="candidate-item">
          <strong>{{ item.metric }} · 原主页 v{{ item.channelVersion }} <span v-if="item.smallSample" class="badge">含小样本，原位保留</span></strong>
          <p class="muted" data-testid="candidate-data-scope">{{ item.baseline.channelLanguage ? `统计范围：${item.region}/${item.baseline.channelLanguage} 内容频道` : '历史候选使用地区汇总，未记录独立频道范围；如需当前口径请重新生成，原候选不自动改写。' }}</p>
          <p>{{ item.dramaIds.map(title).join(' → ') }}</p>
          <button type="button" class="button small" data-testid="candidate-apply" :disabled="item.channelVersion!==channel.version"
            @click="emit('apply',item)">载入当前编辑表单（仍需保存主页）</button>
        </article>
        <h3>新建顺序对照</h3><p class="muted">A组为已保存主页；B组只调剧目和栏目顺序，不换成片、内容、名字或价格。先保存草稿，再明确启用。</p>
        <label class="field"><span>实验名称</span><input v-model="name" maxlength="80" @input="pendingExperiment=undefined" /></label>
        <label class="field"><span>进入实验的访次比例（%）</span><input v-model.number="percent" type="number" min="1" max="100" @input="pendingExperiment=undefined" /><small>参与者稳定随机分为A/B；其余使用原主页。不追踪的访问不进实验。</small></label>
        <div class="variant-orders"><div><h4>B组剧目顺序</h4><div v-for="(id,i) in ids" :key="id" class="order-row"><span>{{ title(id) }}</span><PositionSelect :label="`B组剧目第${i+1}项位置`" :index="i" :total="ids.length" @move="move('ids',i,$event)" /></div></div>
          <div><h4>B组栏目顺序</h4><div v-for="(id,i) in sections" :key="id" class="order-row" data-testid="variant-section-row"><span>{{ channel.sections?.find(s=>s.id===id)?.title }}</span><PositionSelect :label="`B组栏目第${i+1}项位置`" :index="i" :total="sections.length" @move="move('sections',i,$event)" /></div></div></div>
        <button type="button" class="button" data-testid="experiment-create" @click="createExperiment">保存实验草稿（不启用）</button>
        <label v-if="experiments.some(e=>e.state!=='complete')" class="checkbox"><input v-model="confirmed" type="checkbox" data-testid="experiment-confirm" />我确认将按上述已存比例影响一部分观众的顺序；不改价格、权限或原视频。</label>
        <article v-for="item in experiments" :key="item.id" class="candidate-item">
          <strong>{{ item.name }} · {{ item.state }} · {{ item.exposurePercent }}% · 原主页 v{{ item.channelVersion }}</strong>
          <p v-if="item.channelVersion!==channel.version" class="muted">主页版本已改变：旧实验不再应用，重新准备对照。</p>
          <div class="inline wrap">
            <button v-if="item.state!=='active'&&item.state!=='complete'" type="button" class="button small" data-testid="experiment-activate" :disabled="!confirmed||item.channelVersion!==channel.version" @click="operate(item,'activate')">明确启用</button>
            <button v-if="item.state==='active'" type="button" class="button small" data-testid="experiment-pause" @click="operate(item,'pause')">暂停分流</button>
            <button v-if="item.state!=='complete'" type="button" class="button small" @click="operate(item,'complete')">结束实验</button>
          </div>
        </article>
      </fieldset>
    </div>
  </details>
</template>
<style scoped>
.operations{border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0;}
summary{cursor:pointer;font-size: 1rem;min-height:36px;display:flex;align-items:center;}
.operations-body,fieldset{display:grid;gap:16px;min-width:0;}
.candidate-controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap;}.candidate-controls .field{margin:0;flex:1;}
.candidate-item{border-top:1px solid var(--line);padding-top:14px;display:grid;gap:12px;overflow-wrap:anywhere;font-size: 1rem;}
.variant-orders{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;}.order-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:10px;}.order-row > span{flex:1;min-width:100px;overflow-wrap:anywhere;}
.badge{white-space:normal;}.checkbox{align-items:start;}
@media(max-width:700px){.variant-orders{grid-template-columns:1fr;}.candidate-item .button{white-space:normal;}}
</style>
