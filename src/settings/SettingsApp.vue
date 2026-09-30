<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  DEFAULT_SETTINGS,
  emitAll,
  isTauri,
  type EmotionPayload,
  type PersonalityId,
  type Species,
} from '../lib/tauri'
import { listen } from '../lib/tauri'
import { PERSONALITIES, speciesLabel } from '../ai/Personality'
import { testConnection } from '../ai/AIClient'
import {
  SCALE_MAX,
  SCALE_MIN,
  clampScale,
  loadSettings,
  resetMemory,
  saveSettings,
} from '../store'
import type { Settings } from '../lib/tauri'

// 默认值单源：以 lib/tauri.ts 的 DEFAULT_SETTINGS 为准
const s = reactive<Settings>(structuredClone(DEFAULT_SETTINGS))

const showKey = ref(false)
const testState = ref<'idle' | 'testing' | 'ok' | 'fail'>('idle')
const testMsg = ref('')
const savedTip = ref(false)
const emotion = ref<EmotionPayload | null>(null)
const firstRun = ref(false)

let saveTimer = 0
let tipTimer = 0
const unlistens: (() => void)[] = []

const moodText = computed(() => {
  const e = emotion.value
  if (!e) return '……'
  switch (e.expr) {
    case 'happy':
      return '开心'
    case 'sad':
      return '有点无聊'
    case 'angry':
      return '生气了！'
    case 'surprised':
      return '吓一跳'
    case 'sleepy':
      return '犯困'
    case 'concern':
      return '关心你'
    default:
      return '平静'
  }
})

const moodEmoji = computed(() => {
  const e = emotion.value
  switch (e?.expr) {
    case 'happy':
      return '😄'
    case 'sad':
      return '🥺'
    case 'angry':
      return '😠'
    case 'surprised':
      return '😲'
    case 'sleepy':
      return '😴'
    case 'concern':
      return '😟'
    default:
      return '🐱'
  }
})

const avatar = computed(() => {
  if (s.species === 'fox') return 'avatars/pet-fox.png'
  if (s.species === 'cat') return 'avatars/pet-cream.png'
  return ''
})

onMounted(async () => {
  try {
    const loaded = await loadSettings()
    Object.assign(s, loaded)
    firstRun.value = !loaded.apiBaseUrl
  } catch (e) {
    console.warn('设置加载失败，使用默认值', e)
  }
  unlistens.push(
    await listen<EmotionPayload>('pet://emotion', (p) => (emotion.value = p)),
    // 存档损坏提示（Rust 端已自动备份为 .bak 并重置）
    await listen<string>('store://corrupted', (name) => {
      alert(`本地存档 ${name}.json 损坏，已自动备份为 ${name}.json.bak 并重置为默认值。`)
    }),
  )
})

onBeforeUnmount(() => {
  unlistens.forEach((u) => u())
  if (saveTimer) clearTimeout(saveTimer)
  if (tipTimer) clearTimeout(tipTimer)
})

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(async () => {
    s.scale = clampScale(s.scale)
    await saveSettings({ ...s })
    savedTip.value = true
    if (tipTimer) clearTimeout(tipTimer)
    tipTimer = window.setTimeout(() => (savedTip.value = false), 1500)
  }, 400)
}

async function runTest() {
  testState.value = 'testing'
  testMsg.value = ''
  try {
    const r = await testConnection({ ...s })
    testState.value = 'ok'
    testMsg.value = r.slice(0, 40)
    await saveSettings({ ...s })
  } catch (e) {
    testState.value = 'fail'
    testMsg.value = e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)
  }
}

function setPersonality(p: PersonalityId) {
  s.personality = p
  scheduleSave()
}

function setSpecies(sp: Species) {
  s.species = sp
  scheduleSave()
}

async function clearMemory() {
  if (!confirm('确定要清空全部记忆吗？（对话、用户信息、宠物记忆都会重置）')) return
  await resetMemory()
  alert('已重置记忆')
}

function openChat() {
  if (isTauri) void import('../lib/tauri').then(({ invoke }) => invoke('show_window', { label: 'chat' }))
}
function closeWindow() {
  if (isTauri) void import('../lib/tauri').then(({ invoke }) => invoke('hide_window', { label: 'settings' }))
}
function summon() {
  void emitAll('tray://summon')
}
function togglePause() {
  // 走 Rust 命令翻转，托盘菜单文字同步更新（以前的双向事件会导致两处状态不一致）
  void import('../lib/tauri').then(({ invoke }) => invoke<boolean>('toggle_paused'))
}

const PRESETS: { label: string; url: string; model: string }[] = [
  { label: 'DeepSeek', url: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Moonshot', url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: 'Ollama 本地', url: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
]

function applyPreset(p: { url: string; model: string }) {
  s.apiBaseUrl = p.url
  if (!s.model) s.model = p.model
  scheduleSave()
}

const SPECIES_CARDS: { id: Species; name: string; emoji: string; avatar: string }[] = [
  { id: 'cat', name: '奶糖 · 小橘猫', emoji: '🐱', avatar: 'avatars/pet-cream.png' },
  { id: 'bunny', name: '雪团 · 小白兔', emoji: '🐰', avatar: '' },
  { id: 'fox', name: '小狐 · 橙狐狸', emoji: '🦊', avatar: 'avatars/pet-fox.png' },
]
</script>

<template>
  <div class="settings-page">
    <!-- 宠物状态卡 -->
    <section class="hero card drag-region">
      <img v-if="avatar" class="hero-avatar no-drag" :src="avatar" alt="pet" />
      <span v-else class="hero-avatar emoji-hero no-drag">🐰</span>
      <div class="hero-info">
        <div class="hero-name">
          {{ s.petName || '团子' }}
          <span class="chip">{{ PERSONALITIES[s.personality].label }}</span>
        </div>
        <div class="hero-mood">{{ moodEmoji }} {{ emotion ? `现在${moodText}` : '等待宠物上线…' }}</div>
        <div class="hero-actions no-drag">
          <button @click="openChat">💬 聊天</button>
          <button @click="summon">🙌 召唤</button>
          <button @click="togglePause">⏯ 暂停/继续</button>
        </div>
      </div>
      <button class="win-close no-drag" title="关闭" @click="closeWindow">×</button>
    </section>

    <!-- 情绪五维 -->
    <section class="card">
      <div class="card-title">心情状态</div>
      <div class="emo-grid">
        <div v-for="(v, k) in emotion?.values ?? null" :key="k" class="emo-row">
          <span class="emo-label">{{
            { happiness: '开心', energy: '精力', curiosity: '好奇', affection: '亲密', boredom: '无聊' }[k]
          }}</span>
          <div class="emo-bar">
            <div class="emo-fill" :class="k" :style="{ width: v + '%' }" />
          </div>
          <span class="emo-val">{{ Math.round(v) }}</span>
        </div>
        <div v-if="!emotion" class="emo-empty">宠物窗口运行后这里会实时更新</div>
      </div>
    </section>

    <!-- AI 配置 -->
    <section class="card">
      <div class="card-title">AI 配置 <span class="sub">OpenAI Compatible · 密钥只存本地</span></div>
      <label class="field">
        <span>API Base URL</span>
        <input v-model="s.apiBaseUrl" placeholder="https://api.deepseek.com" @input="scheduleSave" />
      </label>
      <div class="presets">
        <button v-for="p in PRESETS" :key="p.label" @click="applyPreset(p)">{{ p.label }}</button>
      </div>
      <label class="field">
        <span>API Key</span>
        <div class="key-row">
          <input
            v-model="s.apiKey"
            :type="showKey ? 'text' : 'password'"
            placeholder="sk-..."
            autocomplete="off"
            @input="scheduleSave"
          />
          <button class="ghost" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
        </div>
      </label>
      <label class="field">
        <span>Model</span>
        <input v-model="s.model" placeholder="deepseek-chat / gpt-4o-mini / ..." @input="scheduleSave" />
      </label>
      <div class="test-row">
        <button class="primary" :disabled="testState === 'testing'" @click="runTest">
          {{ testState === 'testing' ? '测试中…' : '测试连接' }}
        </button>
        <span v-if="testState === 'ok'" class="test-ok">✓ 连接成功：{{ testMsg }}</span>
        <span v-else-if="testState === 'fail'" class="test-fail">✗ {{ testMsg }}</span>
      </div>
    </section>

    <!-- 人格 -->
    <section class="card">
      <div class="card-title">人格</div>
      <div class="persona-grid">
        <button
          v-for="p in PERSONALITIES"
          :key="p.id"
          class="persona-card"
          :class="{ active: s.personality === p.id }"
          @click="setPersonality(p.id)"
        >
          <div class="persona-head">{{ p.emoji }} {{ p.label }}</div>
          <div class="persona-desc">{{ p.desc }}</div>
        </button>
      </div>
    </section>

    <!-- 宠物图鉴 -->
    <section class="card">
      <div class="card-title">宠物图鉴</div>
      <div class="pets-grid">
        <button
          v-for="c in SPECIES_CARDS"
          :key="c.id"
          class="pet-card"
          :class="{ active: s.species === c.id }"
          @click="setSpecies(c.id)"
        >
          <img v-if="c.avatar" :src="c.avatar" alt="" />
          <span v-else class="pet-emoji">{{ c.emoji }}</span>
          <span class="pet-card-name">{{ c.name }}</span>
          <span v-if="s.species === c.id" class="using-chip">使用中</span>
        </button>
      </div>
    </section>

    <!-- 行为 -->
    <section class="card">
      <div class="card-title">行为与外观</div>
      <label class="field">
        <span>宠物名字</span>
        <input v-model="s.petName" maxlength="12" @input="scheduleSave" />
      </label>
      <label class="field">
        <span>大小 {{ s.scale.toFixed(1) }}x</span>
        <input v-model.number="s.scale" type="range" :min="SCALE_MIN" :max="SCALE_MAX" step="0.1" @input="scheduleSave" />
      </label>
      <div class="switch-row">
        <label class="switch"><input v-model="s.autoActivity" type="checkbox" @change="scheduleSave" /><i />自动活动</label>
        <label class="switch"><input v-model="s.trackMouse" type="checkbox" @change="scheduleSave" /><i />追踪鼠标</label>
        <label class="switch"><input v-model="s.windowInteract" type="checkbox" @change="scheduleSave" /><i />窗口互动</label>
        <label class="switch"><input v-model="s.ttsEnabled" type="checkbox" @change="scheduleSave" /><i />语音播报</label>
        <label class="switch"><input v-model="s.proactive" type="checkbox" @change="scheduleSave" /><i />主动说话</label>
      </div>
    </section>

    <!-- 记忆 -->
    <section class="card">
      <div class="card-title">记忆</div>
      <p class="hint">
        它会记住你聊过的内容和你们之间发生的事，全部保存在本机。AI 会自动挑选值得长期记住的信息。
      </p>
      <button class="danger" @click="clearMemory">重置记忆</button>
    </section>

    <footer class="foot">Desktop AI Pet v0.1 · 本地行为系统永远在线，AI 只是它的灵魂</footer>

    <div v-if="firstRun" class="onboard">
      <div class="onboard-card">
        <div class="onboard-title">👋 欢迎！三步开始</div>
        <ol>
          <li>选一个喜欢的宠物和人格（下面就能选）</li>
          <li>配置 AI（可跳过——没有 AI 它也能散步、睡觉、追鼠标）</li>
          <li>右下角托盘找到 🦊 图标：聊天 / 召唤 / 设置都在那里</li>
        </ol>
        <button class="primary" @click="firstRun = false">知道啦</button>
      </div>
    </div>

    <transition name="fade">
      <div v-if="savedTip" class="saved-tip">已保存 ✓</div>
    </transition>
  </div>
</template>

<style scoped>
.settings-page {
  min-height: 100vh;
  background: #fff7f2;
  padding: 14px 14px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  color: #3d2e26;
  position: relative;
}
.card {
  background: #fff;
  border: 1px solid #f3e4da;
  border-radius: 22px;
  padding: 14px 16px;
  box-shadow: 0 2px 10px rgba(140, 100, 80, 0.06);
}
.card-title {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 10px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.card-title .sub {
  font-size: 11px;
  color: #b3a294;
  font-weight: 400;
}
.hero {
  display: flex;
  gap: 14px;
  align-items: center;
  background: linear-gradient(135deg, #fff, #ffefe8);
}
.hero-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  object-fit: cover;
  border: 3px solid #ffd9cf;
}
.emoji-hero {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #ffe9e1;
  font-size: 34px;
}
.hero-info {
  flex: 1;
}
.hero-name {
  font-size: 18px;
  font-weight: 800;
  display: flex;
  align-items: center;
  gap: 8px;
}
.chip {
  font-size: 11px;
  background: #ff7a59;
  color: #fff;
  padding: 2px 9px;
  border-radius: 999px;
  font-weight: 500;
}
.hero-mood {
  font-size: 12.5px;
  color: #8c7a6e;
  margin: 4px 0 8px;
}
.hero-actions {
  display: flex;
  gap: 8px;
}
.hero-actions button {
  border: 1px solid #f0dcd2;
  background: #fff;
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  color: #3d2e26;
}
.hero-actions button:hover {
  border-color: #ff7a59;
  color: #ff7a59;
}
.emo-grid {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.emo-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.emo-label {
  width: 34px;
  font-size: 12px;
  color: #8c7a6e;
}
.emo-bar {
  flex: 1;
  height: 8px;
  border-radius: 999px;
  background: #f6ebe4;
  overflow: hidden;
}
.emo-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.6s ease;
  background: #34c77b;
}
.emo-fill.happiness {
  background: #ffc53d;
}
.emo-fill.energy {
  background: #34c77b;
}
.emo-fill.curiosity {
  background: #b47cff;
}
.emo-fill.affection {
  background: #ff7a59;
}
.emo-fill.boredom {
  background: #6c8cff;
}
.emo-val {
  width: 26px;
  text-align: right;
  font-size: 11px;
  color: #b3a294;
}
.emo-empty {
  font-size: 12px;
  color: #b3a294;
  padding: 4px 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 10px;
}
.field > span {
  font-size: 12px;
  color: #8c7a6e;
}
.field input {
  border: 1.5px solid #f0e0d6;
  border-radius: 12px;
  padding: 8px 11px;
  font-size: 13px;
  outline: none;
  background: #fffdfb;
  color: #3d2e26;
  width: 100%;
  box-sizing: border-box;
}
.field input:focus {
  border-color: #ff7a59;
}
.presets {
  display: flex;
  gap: 6px;
  margin: -4px 0 10px;
  flex-wrap: wrap;
}
.presets button {
  font-size: 11px;
  border: 1px solid #f0dcd2;
  background: #fff;
  color: #8c7a6e;
  border-radius: 999px;
  padding: 3px 10px;
  cursor: pointer;
}
.presets button:hover {
  color: #ff7a59;
  border-color: #ff7a59;
}
.key-row {
  display: flex;
  gap: 6px;
}
.ghost {
  border: 1px solid #f0dcd2;
  background: #fff;
  border-radius: 12px;
  padding: 0 12px;
  font-size: 12px;
  cursor: pointer;
  color: #8c7a6e;
  white-space: nowrap;
}
.test-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.primary {
  border: none;
  background: #ff7a59;
  color: #fff;
  border-radius: 12px;
  padding: 8px 18px;
  font-size: 13px;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.5;
}
.test-ok {
  font-size: 12px;
  color: #34a86b;
}
.test-fail {
  font-size: 12px;
  color: #e05555;
  word-break: break-all;
}
.persona-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.persona-card {
  text-align: left;
  border: 1.5px solid #f0e0d6;
  background: #fffdfb;
  border-radius: 16px;
  padding: 11px 12px;
  cursor: pointer;
}
.persona-card.active {
  border-color: #ff7a59;
  background: #fff3ee;
  box-shadow: 0 0 0 3px rgba(255, 122, 89, 0.14);
}
.persona-head {
  font-size: 13.5px;
  font-weight: 700;
  margin-bottom: 4px;
}
.persona-desc {
  font-size: 11.5px;
  color: #8c7a6e;
  line-height: 1.5;
}
.pets-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.pet-card {
  position: relative;
  border: 1.5px solid #f0e0d6;
  background: #fffdfb;
  border-radius: 16px;
  padding: 12px 8px 10px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.pet-card.active {
  border-color: #ff7a59;
  box-shadow: 0 0 0 3px rgba(255, 122, 89, 0.14);
}
.pet-card img {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  object-fit: cover;
}
.pet-emoji {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: #f3ede6;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
}
.pet-card-name {
  font-size: 11px;
  color: #3d2e26;
}
.using-chip {
  position: absolute;
  top: -8px;
  right: 6px;
  background: #ff7a59;
  color: #fff;
  font-size: 10px;
  border-radius: 999px;
  padding: 1px 7px;
}
.switch-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin-top: 4px;
}
.switch {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.switch input {
  display: none;
}
.switch i {
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background: #eaded4;
  position: relative;
  transition: background 0.15s;
}
.switch i::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}
.switch input:checked + i {
  background: #ff7a59;
}
.switch input:checked + i::after {
  left: 16px;
}
.hint {
  font-size: 12px;
  color: #8c7a6e;
  line-height: 1.6;
  margin: 0 0 10px;
}
.danger {
  border: 1px solid #f3c6c6;
  color: #d84f4f;
  background: #fff5f5;
  border-radius: 12px;
  padding: 7px 14px;
  font-size: 12.5px;
  cursor: pointer;
}
.foot {
  text-align: center;
  font-size: 11px;
  color: #c4b3a5;
  padding-top: 2px;
}
.win-close {
  align-self: flex-start;
  margin-left: 6px;
  border: 1px solid #f0dcd2;
  background: #fff;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 15px;
  color: #b3a294;
  line-height: 1;
  flex-shrink: 0;
}
.win-close:hover {
  background: #ff7a59;
  border-color: #ff7a59;
  color: #fff;
}
.onboard {
  position: fixed;
  inset: 0;
  background: rgba(61, 46, 38, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
  backdrop-filter: blur(2px);
}
.onboard-card {
  background: #fff;
  border-radius: 22px;
  padding: 20px 22px;
  width: 320px;
  box-shadow: 0 10px 40px rgba(61, 46, 38, 0.3);
}
.onboard-title {
  font-size: 16px;
  font-weight: 800;
  margin-bottom: 10px;
}
.onboard-card ol {
  margin: 0 0 14px;
  padding-left: 18px;
  font-size: 12.5px;
  color: #6f5d50;
  line-height: 1.9;
}
.saved-tip {
  position: fixed;
  top: 14px;
  right: 16px;
  background: #34c77b;
  color: #fff;
  font-size: 12px;
  padding: 6px 14px;
  border-radius: 999px;
  box-shadow: 0 4px 14px rgba(52, 199, 123, 0.4);
  z-index: 30;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
input[type='range'] {
  accent-color: #ff7a59;
}
</style>
