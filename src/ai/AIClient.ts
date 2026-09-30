// AI 客户端：OpenAI Compatible 调用 + 断网/未配置时的本地兜底回复
import { invoke } from '../lib/tauri'
import type { PersonalityId, Settings } from '../lib/tauri'

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export async function aiChat(
  settings: Settings,
  messages: ChatMsg[],
  temperature = 0.8,
): Promise<string> {
  const res = await invoke<string>('ai_chat', {
    config: {
      base_url: settings.apiBaseUrl,
      api_key: settings.apiKey,
      model: settings.model,
    },
    messages,
    temperature,
  })
  if (res == null) throw new Error('非 Tauri 环境')
  return res
}

export async function testConnection(settings: Settings): Promise<string> {
  return aiChat(settings, [{ role: 'user', content: '连接测试，请只回复：pong' }], 0.1)
}

/** AI 不可用时的本地兜底回复（保证离线也能聊） */
export function offlineReply(text: string, personality: PersonalityId): string {
  const t = text.toLowerCase()
  const gentle = personality === 'gentle'

  if (/你好|hi|hello|嗨|哈喽|在吗/.test(t)) {
    return gentle ? '你好呀～我在呢，今天过得怎么样？' : '在。说事。'
  }
  if (/名字|叫什么|你是谁/.test(t)) {
    return gentle
      ? '我是住在你桌面上的小家伙呀，你可以给我起个名字！'
      : '桌面宠物一枚。名字你定，功能我先报：陪聊、提醒、捣乱。'
  }
  if (/累|加班|辛苦|压力|烦/.test(t)) {
    return gentle
      ? '辛苦啦……要不要休息十分钟？我陪着你。'
      : '停下来十分钟，喝水，走两步。回来再干。'
  }
  if (/晚安|睡觉|困/.test(t)) {
    return gentle ? '晚安呀，做个好梦，我帮你看着电脑～' : '晚安。屏幕要不要顺手关了。'
  }
  if (/谢谢|感谢/.test(t)) {
    return gentle ? '嘿嘿，能帮到你就好～' : '不客气。'
  }
  if (/你能做什么|功能|帮助|help/.test(t)) {
    return gentle
      ? '我可以陪你聊天、在桌面上散步、趴在窗口上看你工作，还可以提醒你休息～'
      : '聊天、桌面活动、窗口互动、提醒休息。配置好 API 后更聪明。'
  }
  if (/天气|新闻/.test(t)) {
    return gentle
      ? '我看不到外面呀，不过你心情好的时候，哪里天气都好～'
      : '无网络浏览能力。请自行查看。'
  }
  return gentle
    ? '嗯嗯，我在听……（网络不太好，但我一直都在哦）'
    : '（离线模式）收到。回头聊细的。'
}
