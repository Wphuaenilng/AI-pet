// 提示词构建 + AI 结构化回复解析
import { PERSONALITIES, speciesLabel } from './Personality'
import type { EmotionValues, ExprKind } from '../pet/PetState'
import type { PersonalityId, Settings } from '../lib/tauri'

export interface MemorySnapshot {
  nickname: string
  facts: string[]
  recentPetMemory: string[]
}

export function buildSystemPrompt(input: {
  settings: Settings
  emotion: EmotionValues
  expr: ExprKind
  state: string
  memory: MemorySnapshot
}): string {
  const persona = PERSONALITIES[input.settings.personality]
  const { warmth, practicality, initiative, talkativeness } = persona.params
  const species = speciesLabel(input.settings.species)
  const e = input.emotion

  const facts = input.memory.facts.slice(-8)
  const petMem = input.memory.recentPetMemory.slice(-5)

  // 显式按段落组织，不再依赖事后 filter（此前会把所有空行连同哨兵一起删掉）
  const lines: string[] = [
    `你是桌面 AI 宠物「${input.settings.petName}」，一只${species}，直接生活在用户的 Windows 桌面上。`,
    `性格：${persona.label} —— ${persona.desc}。`,
    `性格参数：warmth=${warmth}，practicality=${practicality}，initiative=${initiative}，talkativeness=${talkativeness}。`,
    `说话规则：口语化、自然、符合性格；一次回复尽量不超过 40 个字；不要使用 Markdown 和表情符号以外的格式。默认用中文。`,
    '',
    '用户画像与记忆：',
    input.memory.nickname ? `- 用户希望被称呼为「${input.memory.nickname}」` : '- 用户还没告诉你怎么称呼 TA',
    ...facts.map((f) => `- ${f}`),
  ]
  if (petMem.length) {
    lines.push('最近发生：', ...petMem.map((m) => `- ${m}`))
  }
  lines.push(
    '',
    `当前状态：心情 ${input.expr}；happiness=${Math.round(e.happiness)}/100，energy=${Math.round(e.energy)}/100，affection=${Math.round(e.affection)}/100，boredom=${Math.round(e.boredom)}/100；正在「${input.state}」。`,
    '',
    '你必须只输出一个 JSON 对象（不要输出 JSON 以外的任何内容），格式：',
    '{"reply":"给用户说的话","emotion":"happy|neutral|sad|angry|surprised|sleepy|concern","action":"none|approach_user|jump_on_window|sit|sleep|play|dance","memory":""}',
    'emotion 是你说完这句话的心情；action 是你想让身体做的小动作（本地系统会决定是否执行）；memory 仅当你得知值得长期记住的用户信息时填写一句话，否则留空字符串。',
  )
  return lines.join('\n')
}

const EMOTIONS = new Set(['happy', 'neutral', 'sad', 'angry', 'surprised', 'sleepy', 'concern'])
const ACTIONS = new Set(['none', 'approach_user', 'jump_on_window', 'sit', 'sleep', 'play', 'dance'])

export interface AiReply {
  reply: string
  emotion: string
  action: string
  memory: string
}

export function parseAiReply(raw: string): AiReply {
  let text = raw.trim()
  // 剥掉 ```json ... ``` 围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
      // 缺 reply 时绝不能把原始 JSON 串当台词念出来，走与"无 JSON"相同的兜底
      const reply = typeof obj.reply === 'string' && obj.reply.trim() ? obj.reply : '……'
      const emotion = typeof obj.emotion === 'string' && EMOTIONS.has(obj.emotion) ? obj.emotion : 'neutral'
      const action = typeof obj.action === 'string' && ACTIONS.has(obj.action) ? obj.action : 'none'
      const memory = typeof obj.memory === 'string' ? obj.memory.trim().slice(0, 80) : ''
      return { reply, emotion, action, memory }
    } catch {
      /* fallthrough */
    }
  }
  return { reply: text || '……', emotion: 'neutral', action: 'none', memory: '' }
}

export function personalityLabel(id: PersonalityId): string {
  return PERSONALITIES[id].label
}
