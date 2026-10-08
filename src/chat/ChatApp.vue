<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { aiChat, offlineReply, type ChatMsg } from '../ai/AIClient'
import { buildSystemPrompt, parseAiReply } from '../ai/PromptBuilder'
import { MemoryStore } from '../ai/Memory'
import { speciesLabel } from '../ai/Personality'
import {
  DEFAULT_SETTINGS,
  emitAll,
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
}

const settings = ref<Settings | null>(null)
const memory = ref<MemoryStore | null>(null)
const messages = ref<ChatItem[]>([])
const input = ref('')
const thinking = ref(false)
const ttsOn = ref(false)
const listRef = ref<HTMLDivElement | null>(null)

// 宠物窗口每 2 秒广播的真实情绪（pet://emotion），聊天时喂给 AI
const lastEmotion = ref<EmotionPayload | null>(null)
const unlistens: (() => void)[] = []

// 宠物窗口离线/未启动时的兜底值
const FALLBACK_EMOTION = { happiness: 65, energy: 80, curiosity: 55, affection: 45, boredom: 20, hunger: 70 }

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
    try {
      const emo = lastEmotion.value
      const sys = buildSystemPrompt({
        settings: settings.value,
        emotion: emo?.values ?? FALLBACK_EMOTION,
        expr: (emo?.expr as ExprKind) ?? 'neutral',
        state: emo?.state ?? 'TALK',
        memory: await memory.value.snapshot(),
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
      if (parsed.memory) memory.value.addFact(parsed.memory)
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
      messages.value.push({
        role: 'error',
        content: `AI 暂时不可用（${e instanceof Error ? e.message.slice(0, 60) : '请求失败'}），已切换离线回复`,
      })
    }

    messages.value.push({ role: 'assistant', content: reply })
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
    <header class="chat-head drag-region">
      <img v-if="avatar" class="avatar" :src="avatar" alt="pet" />
      <span v-else class="avatar emoji-avatar">{{ speciesEmoji }}</span>
      <div class="head-text">
        <div class="pet-name">{{ settings?.petName ?? '宠物' }}</div>
        <div class="pet-sub">
          {{ speciesLabel(settings?.species ?? 'dot') }}
          <span v-if="!settings?.apiBaseUrl" class="offline-chip">离线陪聊</span>
        </div>
      </div>
      <button class="win-btn no-drag" title="语音播报" @click="toggleTts">
        {{ ttsOn ? '🔊' : '🔇' }}
      </button>
      <button class="win-btn no-drag close-btn" title="关闭" @click="closeWindow">×</button>
    </header>

    <div ref="listRef" class="chat-list">
      <div
        v-for="(m, i) in messages"
        :key="i"
        class="msg-row"
        :class="{ mine: m.role === 'user', error: m.role === 'error' }"
      >
        <div class="msg">{{ m.content }}</div>
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
  background: #fff7f2;
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
}
.chat-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: #fff;
  border-bottom: 1px solid #f3e4da;
}
.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid #ffd9cf;
}
.emoji-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #ffe9e1;
  font-size: 22px;
}
.head-text {
  flex: 1;
  min-width: 0;
}
.pet-name {
  font-size: 15px;
  font-weight: 700;
  color: #3d2e26;
}
.pet-sub {
  font-size: 11px;
  color: #8c7a6e;
  display: flex;
  align-items: center;
  gap: 6px;
}
.offline-chip {
  background: #fde8de;
  color: #ff7a59;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 10px;
}
.win-btn {
  border: 1px solid #f0e0d6;
  background: #fff;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  color: #6f5d50;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.win-btn.on {
  background: #ff7a59;
  border-color: #ff7a59;
  color: #fff;
}
.close-btn {
  color: #b3a294;
}
.close-btn:hover {
  background: #ff7a59;
  border-color: #ff7a59;
  color: #fff;
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
  padding: 9px 12px;
  border-radius: 14px;
  font-size: 13.5px;
  line-height: 1.55;
  color: #3d2e26;
  background: #fff;
  border: 1px solid #f3e4da;
  border-bottom-left-radius: 4px;
  word-break: break-word;
}
.msg-row.mine .msg {
  background: #ff7a59;
  color: #fff;
  border: none;
  border-bottom-right-radius: 4px;
}
.msg-row.error .msg {
  background: #fff4e0;
  border-color: #ffe3b3;
  color: #9c6b1f;
  font-size: 12px;
}
.thinking span {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin: 0 2px;
  border-radius: 50%;
  background: #d8b7a8;
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
  border-top: 1px solid #f3e4da;
}
.chat-input input {
  flex: 1;
  border: 1.5px solid #f0e0d6;
  border-radius: 12px;
  padding: 9px 12px;
  font-size: 13.5px;
  outline: none;
  color: #3d2e26;
  background: #fffdfb;
}
.chat-input input:focus {
  border-color: #ff7a59;
}
.send-btn {
  border: none;
  background: #ff7a59;
  color: #fff;
  border-radius: 12px;
  padding: 0 16px;
  font-size: 13.5px;
  cursor: pointer;
}
.send-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
