<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { aiChat, offlineReply, type ChatMsg } from '../ai/AIClient'
import { buildSystemPrompt, parseAiReply } from '../ai/PromptBuilder'
import { MemoryStore } from '../ai/Memory'
import { KnowledgeIndex, embedConfigOf } from '../ai/rag'
import { PERSONALITIES, speciesLabel } from '../ai/Personality'
import {
  DEFAULT_SETTINGS,
  emitAll,
  getLabel,
  isTauri,
  listen,
  type EmotionPayload,
  type Settings,
} from '../lib/tauri'
import type { ExprKind } from '../pet/PetState'
import { loadSettings, saveSettings } from '../store'

interface ChatItem {
  role: 'user' | 'assistant' | 'error'
  content: string
  /** RAG 命中的来源文档名（M7）：有检索命中时展示在气泡下方 */
  sources?: string[]
}

const settings = ref<Settings | null>(null)
const memory = ref<MemoryStore | null>(null)
const kb = ref<KnowledgeIndex | null>(null)
const messages = ref<ChatItem[]>([])
const input = ref('')
const thinking = ref(false)
const ttsOn = ref(false)
const listRef = ref<HTMLDivElement | null>(null)

// 宠物窗口每 2 秒广播的真实情绪（pet://emotion），聊天时喂给 AI
const lastEmotion = ref<EmotionPayload | null>(null)
const unlistens: (() => void)[] = []

// 宠物窗口离线/未启动时的兜底值
const FALLBACK_EMOTION = { happiness: 65, energy: 80, curiosity: 55, affection: 45, boredom: 20 }

const avatar = computed(() => '')
const speciesEmoji = computed(() => '⚫')

onMounted(async () => {
  try {
    settings.value = await loadSettings()
  } catch (e) {
    console.warn('设置加载失败，使用默认值', e)
    settings.value = { ...DEFAULT_SETTINGS }
  }
  ttsOn.value = settings.value.ttsEnabled
  try {
    memory.value = await MemoryStore.load()
  } catch (e) {
    console.warn('记忆加载失败，使用空记忆', e)
    memory.value = new MemoryStore()
  }
  try {
    kb.value = await KnowledgeIndex.load()
    await syncKbMemory()
  } catch (e) {
    console.warn('知识库加载失败，检索停用', e)
  }
  unlistens.push(
    await listen<EmotionPayload>('pet://emotion', (p) => (lastEmotion.value = p)),
    // 宠物窗口的自动记忆事件（被摸/被拎/主动关心）→ 记入宠物记忆并持久化
    await listen<string>('pet://memory-event', (text) => {
      const m = memory.value
      if (!m || !text) return
      // "和用户聊了天"与聊天侧已写入的"和用户聊天"是同一件事，跳过避免重复
      if (text === '和用户聊了天') return
      // 同一句话 5 分钟内只记一次（连续摸摸/拎起不刷屏）
      if (m.data.petMemory.some((x) => x.text === text && Date.now() - x.t < 5 * 60_000)) return
      m.addPetMemory(text)
      void m.save().catch(() => {})
    }),
    // 设置窗改动后同步（含"清空记忆"）：重载记忆，避免本窗旧内存把空存档覆盖回去
    await listen<Settings>('settings://updated', (s) => {
      settings.value = s
      ttsOn.value = s.ttsEnabled
      MemoryStore.load()
        .then((m) => (memory.value = m))
        .catch((e) => console.warn('记忆重载失败', e))
      // 知识库先重载再同步记忆：syncKbMemory 必须作用于最新副本，
      // 并行加载时旧副本可能把设置窗刚导入的文档整文件覆盖回去
      reloadKb(true)
    }),
    // 其他窗口（设置窗导入/删除/重建）落盘知识库后重载，保持检索数据一致
    await listen<{ label: string }>('kb://updated', (p) => {
      if (p?.label === getLabel()) return
      reloadKb(false)
    }),
    // 存档损坏提示（Rust 端已自动备份为 .bak）
    await listen<string>('store://corrupted', (name) => {
      messages.value.push({
        role: 'error',
        content: `本地存档 ${name}.json 损坏，已自动备份为 ${name}.json.bak 并重置。`,
      })
      void nextTick(scrollBottom)
    }),
  )
  if (!settings.value.apiBaseUrl || !settings.value.model) {
    messages.value.push({
      role: 'error',
      content: '还没有配置 AI（API Base URL / Model），我先离线陪聊。点击右上角「设置」配置后更聪明～',
    })
  }
  await nextTick(scrollBottom)
})

onBeforeUnmount(() => {
  unlistens.forEach((u) => u())
})

function scrollBottom() {
  const el = listRef.value
  if (el) el.scrollTop = el.scrollHeight
}

async function toggleTts() {
  if (!settings.value) return
  ttsOn.value = !ttsOn.value
  settings.value.ttsEnabled = ttsOn.value
  await saveSettings(settings.value)
}

function closeWindow() {
  if (isTauri) void import('../lib/tauri').then(({ invoke }) => invoke('hide_window', { label: 'chat' }))
}

/** RAG mem 集合与 memory.md 对齐（向量按文本缓存，仅新行请求 embedding） */
async function syncKbMemory() {
  const m = memory.value
  const idx = kb.value
  if (!m || !idx || !settings.value) return
  await m.snapshot() // 触发 memory.md 磁盘重读
  await idx.syncMemory(m.allLines(), embedConfigOf(settings.value))
}

/** 重载知识库；序号防止并发加载乱序落地时旧结果盖掉新结果。
 *  syncAfter=true 用于 settings://updated：重载完成后顺带对齐记忆集合 */
let kbLoadSeq = 0
function reloadKb(syncAfter: boolean) {
  const seq = ++kbLoadSeq
  KnowledgeIndex.load()
    .then(async (idx) => {
      if (seq !== kbLoadSeq) return
      kb.value = idx
      if (syncAfter) await syncKbMemory()
    })
    .catch((e) => console.warn('知识库重载失败', e))
}

async function send() {
  const text = input.value.trim()
  if (!text || thinking.value || !settings.value || !memory.value) return
  input.value = ''
  messages.value.push({ role: 'user', content: text })
  memory.value.addMessage('user', text)
  memory.value.markInteraction()
  thinking.value = true
  await nextTick(scrollBottom)

  try {
    let reply: string
    let emotion = 'neutral'
    let action = 'none'
    let sources: string[] = []
    try {
      const emo = lastEmotion.value
      // RAG 混合检索（向量语义 + bigram 字面，未配 embedding 自动降级），永不抛错
      const hits = kb.value
        ? await kb.value.search(text, 5, embedConfigOf(settings.value))
        : []
      sources = [...new Set(hits.filter((h) => h.source !== '记忆').map((h) => h.source))]
      const sys = buildSystemPrompt({
        settings: settings.value,
        emotion: emo?.values ?? FALLBACK_EMOTION,
        expr: (emo?.expr as ExprKind) ?? 'neutral',
        state: emo?.state ?? 'TALK',
        memory: await memory.value.snapshot(text),
        knowledge: hits,
      })
      const history: ChatMsg[] = [
        { role: 'system', content: sys },
        ...memory.value.recentMessages(10),
      ]
      const raw = await aiChat(settings.value, history)
      const parsed = parseAiReply(raw)
      reply = parsed.reply
      emotion = parsed.emotion
      action = parsed.action
      // 注入防线：本轮有检索命中时不落盘长期记忆——资料内容可能诱导模型伪造 memory 字段，
      // 画像写回只信无资料介入的对话（memory.md 仍可由用户手改）
      if (parsed.memory && !hits.length) memory.value.addFact(parsed.memory)
      if (/叫我|称呼我|我是/.test(text) && text.length < 30) {
        // 排除"我是说/叫我怎么办"这类误伤句式
        const m = text.match(
          /(?:叫我|称呼我|我是(?!说|不是|不|怎么|干嘛|啥|什么))\s*([\u4e00-\u9fa5A-Za-z0-9]{1,12})/,
        )
        if (m) {
          memory.value.setNickname(m[1])
          messages.value.push({
            role: 'assistant',
            content: `好嘞，以后就叫你「${m[1]}」！（说"叫我XX"可以改）`,
          })
        }
      }
    } catch (e) {
      console.warn('AI 请求失败，使用离线回复', e)
      reply = offlineReply(text, settings.value.personality)
      sources = [] // 罐头回复没用到资料，不能挂来源标注
      messages.value.push({
        role: 'error',
        content: `AI 暂时不可用（${e instanceof Error ? e.message.slice(0, 60) : '请求失败'}），已切换离线回复`,
      })
    }

    messages.value.push({ role: 'assistant', content: reply, sources })
    memory.value.addMessage('assistant', reply)
    memory.value.addPetMemory('和用户聊天')
    await memory.value.save()
    await emitAll('pet://say', { text: reply, emotion, action, fromChat: true })
  } finally {
    // 无论 AI 失败还是落盘失败，输入框都不能永久禁用
    thinking.value = false
  }
  await nextTick(scrollBottom)
}
</script>

<template>
  <div class="chat-page">
    <header class="chat-head drag-region" data-tauri-drag-region>
      <img v-if="avatar" class="avatar" :src="avatar" alt="pet" />
      <span v-else class="avatar emoji-avatar">{{ speciesEmoji }}</span>
      <div class="head-text" data-tauri-drag-region>
        <div class="pet-name">{{ settings?.petName ?? '宠物' }}</div>
        <div class="pet-sub">
          {{ speciesLabel(settings?.species ?? 'dot') }} ·
          {{ PERSONALITIES[settings?.personality ?? 'gentle'].label }}
          <span v-if="!settings?.apiBaseUrl" class="offline-chip">离线陪聊</span>
        </div>
      </div>
      <button class="win-btn no-drag" :title="ttsOn ? '关闭语音播报' : '开启语音播报'" @click="toggleTts">
        {{ ttsOn ? '🔊' : '🔇' }}
      </button>
      <button class="win-btn close-btn no-drag" title="关闭" @click="closeWindow">×</button>
    </header>

    <div ref="listRef" class="chat-list">
      <div
        v-for="(m, i) in messages"
        :key="i"
        class="msg-row"
        :class="{ mine: m.role === 'user', error: m.role === 'error' }"
      >
        <div class="msg">
          {{ m.content }}
          <span v-if="m.sources?.length" class="msg-sources">📚 {{ m.sources.join('、') }}</span>
        </div>
      </div>
      <div v-if="thinking" class="msg-row">
        <div class="msg thinking"><span></span><span></span><span></span></div>
      </div>
    </div>

    <footer class="chat-input">
      <input
        v-model="input"
        type="text"
        placeholder="和它说点什么……"
        maxlength="500"
        @keydown.enter="send"
      />
      <button class="send-btn" :disabled="thinking || !input.trim()" @click="send">发送</button>
    </footer>
  </div>
</template>

<style scoped>
.chat-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f2f3f5;
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
}
.chat-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: #fff;
  border-bottom: 1px solid #ececee;
}
.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}
.emoji-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #1f2329;
  font-size: 22px;
}
.head-text {
  flex: 1;
  min-width: 0;
}
.pet-name {
  font-size: 15px;
  font-weight: 700;
  color: #1f2329;
}
.pet-sub {
  font-size: 11px;
  color: #747d87;
  display: flex;
  align-items: center;
  gap: 6px;
}
.offline-chip {
  color: #e8890c;
  font-size: 11px;
  font-weight: 600;
}
.win-btn {
  border: none;
  background: #f2f3f5;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 13px;
  color: #4b525c;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.win-btn:hover {
  background: #e9ebee;
}
.close-btn {
  color: #747d87;
}
.close-btn:hover {
  background: #e3e6ea;
  color: #1f2329;
}
.chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.msg-row {
  display: flex;
}
.msg-row.mine {
  justify-content: flex-end;
}
.msg {
  max-width: 78%;
  padding: 10px 13px;
  border-radius: 16px;
  font-size: 13.5px;
  line-height: 1.55;
  color: #1f2329;
  background: #fff;
  border: 1px solid #ececee;
  word-break: break-word;
}
.msg-row.mine .msg {
  background: #0b6ef0;
  color: #fff;
  border: none;
}
.msg-row.error .msg {
  background: #fff8e6;
  border: 1px solid #f2e3b3;
  color: #a16207;
  font-size: 12.5px;
  max-width: 96%;
}
/* RAG 命中来源：次要信息收小一号，别抢台词的视觉权重 */
.msg-sources {
  display: block;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed #ececee;
  font-size: 10.5px;
  color: #9aa1aa;
}
.thinking span {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin: 0 2px;
  border-radius: 50%;
  background: #c2c9d1;
  animation: blink 1s infinite;
}
.thinking span:nth-child(2) {
  animation-delay: 0.2s;
}
.thinking span:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes blink {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}
.chat-input {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  background: #fff;
  border-top: 1px solid #ececee;
}
.chat-input input {
  flex: 1;
  border: 1.5px solid #e3e6ea;
  border-radius: 14px;
  padding: 9px 12px;
  font-size: 13.5px;
  outline: none;
  color: #1f2329;
  background: #fff;
}
.chat-input input:focus {
  border-color: #0b6ef0;
}
.send-btn {
  border: none;
  background: #0b6ef0;
  color: #fff;
  border-radius: 14px;
  padding: 0 18px;
  font-size: 13.5px;
  cursor: pointer;
}
.send-btn:hover:not(:disabled) {
  background: #0a5fd0;
}
.send-btn:disabled {
  background: #e5e7eb;
  color: #9aa1aa;
  cursor: default;
}
</style>
