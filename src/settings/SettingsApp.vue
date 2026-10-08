<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  DEFAULT_SETTINGS,
  emitAll,
  invoke,
  isTauri,
  type EmotionPayload,
  type PersonalityId,
} from '../lib/tauri'
import { listen } from '../lib/tauri'
import { PERSONALITIES } from '../ai/Personality'
import { SHAPES, COLORS } from '../pet/bloub/skins'
import { EXPRESSIONS } from '../pet/bloub/expressions'
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

// 应用内弹框：原生 alert/confirm 在 WebView2 里是灰底系统对话框，与设计语言不符
const dlg = ref<{ kind: 'alert' | 'confirm'; text: string } | null>(null)
let dlgResolve: ((ok: boolean) => void) | null = null

function showAlert(text: string): Promise<void> {
  return new Promise<void>((res) => {
    dlgResolve = () => res()
    dlg.value = { kind: 'alert', text }
  })
}

function askConfirm(text: string): Promise<boolean> {
  return new Promise<boolean>((res) => {
    dlgResolve = res
    dlg.value = { kind: 'confirm', text }
  })
}

function closeDlg(ok: boolean) {
  const r = dlgResolve
  dlg.value = null
  dlgResolve = null
  r?.(ok)
}
const emotion = ref<EmotionPayload | null>(null)
const firstRun = ref(false)
const autostart = ref(false)

// bloub 外观定制（id 与 zh 标签的映射，数据来自 vendored bloub 模块）
const SHAPE_ZH: Record<string, string> = {
  cercle: '圆形', galet: '鹅卵石', squircle: '方圆', capsule: '胶囊',
  triangle: '三角', hexagone: '六边', nuage: '云朵', goutte: '水滴'
}
const EXPR_ZH: Record<string, string> = {
  neutre: '平静', attentif: '专注', surpris: '惊讶', excite: '兴奋',
  heureux: '开心', hilare: '大笑', colere: '生气', triste: '难过',
  effraye: '害怕', mefiant: '怀疑', confus: '困惑', curieux: '好奇',
  fier: '得意', timide: '害羞', blase: '倦怠', somnolent: '犯困'
}
const BLOUB_SHAPES = SHAPES.map((x) => ({ id: x.id, zh: SHAPE_ZH[x.id] ?? x.id }))
const BLOUB_COLORS = COLORS.map((x) => ({ id: x.id, hex: x.hex, zh: x.id }))
const BLOUB_EXPRS = EXPRESSIONS.map((x) => ({ id: x.id, zh: EXPR_ZH[x.id] ?? x.id }))

function setBloub(key: 'bloubShape' | 'bloubColor' | 'bloubExpression', id: string) {
  s[key] = id
  scheduleSave()
}

// Petdex 宠物包（M2）：~/.petdex/pets 下的已安装列表
interface PetPackInfo {
  slug: string
  name: string
  dir: string
  sheet: string
}
const packs = ref<PetPackInfo[]>([])

function choosePack(p: PetPackInfo | '') {
  if (!p) {
    s.petPack = ''
    s.petPackSheet = ''
  } else {
    s.petPack = p.dir
    s.petPackSheet = p.sheet
  }
  scheduleSave()
}

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
      return '⚫'
  }
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
      void showAlert(`本地存档 ${name}.json 损坏，已自动备份为 ${name}.json.bak 并重置为默认值。`)
    }),
  )
  if (isTauri) {
    try {
      autostart.value = (await invoke<boolean>('autostart_status')) ?? false
    } catch (e) {
      console.warn('autostart_status failed:', e)
    }
    invoke<PetPackInfo[]>('petdex_list')
      .then((ps) => (packs.value = ps ?? []))
      .catch(() => {})
  }
})

/** 开机自启开关（Rust 命令封装 autostart 插件，失败时回滚 UI 状态） */
async function toggleAutostart() {
  try {
    await invoke('autostart_set', { enable: autostart.value })
    void showAlert(autostart.value ? '已开启开机自启' : '已关闭开机自启')
  } catch (e) {
    autostart.value = !autostart.value
    void showAlert('设置开机自启失败：' + String(e).slice(0, 60))
  }
}

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

async function clearMemory() {
  if (!(await askConfirm('确定要清空全部记忆吗？（对话、用户信息、宠物记忆都会重置）'))) return
  await resetMemory()
  // 广播一次设置更新，聊天窗收到后重载 MemoryStore；
  // 否则它内存里的旧记忆会在下次保存时把空存档覆盖回去（B16 的竞态）
  await saveSettings({ ...s })
  void showAlert('已重置记忆')
}

function openMemory() {
  if (isTauri) void invoke('open_text', { name: 'memory.md' })
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

</script>

<template>
  <div class="settings-page">
    <!-- 宠物状态卡 -->
    <section class="hero card drag-region">
      <span class="hero-avatar emoji-hero no-drag">⚫</span>
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
            { happiness: '开心', energy: '精力', curiosity: '好奇', affection: '亲密', boredom: '无聊', hunger: '饱食' }[k]
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

    <!-- 宠物外观 -->
    <section class="card">
      <div class="card-title">宠物外观</div>
      <label class="field">
        <span>形状</span>
        <div class="chip-row">
          <button
            v-for="sh in BLOUB_SHAPES"
            :key="sh.id"
            class="chip"
            :class="{ active: s.bloubShape === sh.id }"
            @click="setBloub('bloubShape', sh.id)"
          >
            {{ sh.zh }}
          </button>
        </div>
      </label>
      <label class="field">
        <span>颜色</span>
        <div class="chip-row">
          <button
            v-for="c in BLOUB_COLORS"
            :key="c.id"
            class="swatch"
            :class="{ active: s.bloubColor === c.id }"
            :style="{ background: c.hex }"
            :title="c.zh"
            @click="setBloub('bloubColor', c.id)"
          />
        </div>
      </label>
      <label class="field">
        <span>静止表情</span>
        <div class="chip-row">
          <button
            v-for="e in BLOUB_EXPRS"
            :key="e.id"
            class="chip"
            :class="{ active: s.bloubExpression === e.id }"
            @click="setBloub('bloubExpression', e.id)"
          >
            {{ e.zh }}
          </button>
        </div>
      </label>
      <label class="field">
        <span>Petdex 宠物包</span>
        <div class="chip-row">
          <button class="chip" :class="{ active: !s.petPack }" @click="choosePack('')">
            默认 · 小黑点
          </button>
          <button
            v-for="p in packs"
            :key="p.dir"
            class="chip"
            :class="{ active: s.petPack === p.dir }"
            @click="choosePack(p)"
          >
            {{ p.name }}
          </button>
        </div>
        <span v-if="isTauri && !packs.length" class="hint">
          未检测到已安装的 Petdex 宠物：运行 npx petdex install &lt;slug&gt; 后重新打开设置即可。
        </span>
      </label>
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
        <label class="switch" title="开启后点击会穿透宠物（全局热键 Ctrl+Shift+U 也可切换）"><input v-model="s.clickThrough" type="checkbox" @change="scheduleSave" /><i />鼠标穿透</label>
        <label class="switch" title="随系统启动自动运行"><input v-model="autostart" type="checkbox" @change="toggleAutostart" /><i />开机自启</label>
      </div>
    </section>

    <!-- 记忆 -->
    <section class="card">
      <div class="card-title">记忆</div>
      <p class="hint">
        长期记忆是一个可编辑的 <code>memory.md</code>，和设置文件放在同一目录——用记事本打开就能直接改，改完自动生效。
        AI 聊天时得知的信息会自动记入"用户画像"，发生的事记入"宠物记忆"。
      </p>
      <div class="mem-actions">
        <button class="ghost" @click="openMemory">打开记忆文件</button>
        <button class="danger" @click="clearMemory">重置记忆</button>
      </div>
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

    <!-- 应用内弹框：替代原生 alert / confirm -->
    <div v-if="dlg" class="dlg-mask" @click.self="closeDlg(false)">
      <div class="dlg-card">
        <p class="dlg-text">{{ dlg.text }}</p>
        <div class="dlg-btns">
          <button v-if="dlg.kind === 'confirm'" class="dlg-ghost" @click="closeDlg(false)">取消</button>
          <button class="primary" @click="closeDlg(true)">
            {{ dlg.kind === 'confirm' ? '确定清空' : '知道啦' }}
          </button>
        </div>
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
  flex-wrap: wrap;
  gap: 6px;
}
.hero-actions button {
  border: 1px solid #f0dcd2;
  background: #fff;
  border-radius: 999px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
  color: #3d2e26;
  /* 宽度不够时整颗按钮换行，而不是把「聊天」二字拆成两行 */
  flex: 0 0 auto;
  white-space: nowrap;
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
/* range 不该继承文本框的边框/内边距；轨道颜色必须自己画，
   否则 WebView2 按系统深色模式把未填充部分渲染成黑条 */
.field input[type='range'] {
  -webkit-appearance: none;
  appearance: none;
  border: none;
  background: transparent;
  padding: 0;
  height: 22px;
  width: 100%;
  cursor: pointer;
}
.field input[type='range']::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 999px;
  background: #f0e0d6;
}
.field input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  margin-top: -5px;
  border-radius: 50%;
  background: #ff7a59;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
.field input[type='range']::-moz-range-track {
  height: 6px;
  border-radius: 999px;
  background: #f0e0d6;
}
.field input[type='range']::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: #ff7a59;
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
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
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
.dlg-mask {
  position: fixed;
  inset: 0;
  background: rgba(61, 46, 38, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
  backdrop-filter: blur(2px);
}
.dlg-card {
  background: #fff;
  border-radius: 20px;
  padding: 20px 22px 16px;
  width: 300px;
  box-shadow: 0 10px 40px rgba(61, 46, 38, 0.3);
}
.dlg-text {
  font-size: 13.5px;
  color: #3d2e26;
  line-height: 1.7;
  margin: 0 0 16px;
}
.dlg-btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dlg-ghost {
  border: 1px solid #f0dcd2;
  background: #fff;
  color: #6f5d50;
  border-radius: 12px;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
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
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.mem-actions {
  display: flex;
  gap: 8px;
}
.mem-actions .ghost {
  border: 1px solid #e8d9cf;
  background: #fff;
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12px;
  color: #3d2e26;
  cursor: pointer;
}
.mem-actions .ghost:hover {
  border-color: #ff7a59;
  color: #ff7a59;
}
.chip {
  border: 1px solid #e8d9cf;
  background: #fff;
  border-radius: 8px;
  padding: 3px 8px;
  font-size: 12px;
  color: #3d2e26;
  cursor: pointer;
}
.chip.active {
  border-color: #ff7a59;
  color: #ff7a59;
  background: #fff4ef;
}
.swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px #e3d5ca;
  cursor: pointer;
}
.swatch.active {
  box-shadow: 0 0 0 2px #ff7a59;
}
</style>
