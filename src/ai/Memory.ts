// 记忆系统（M5 重构）：
// - 短期对话/昵称/统计 → memory.json（机器管理）
// - 长期记忆 → memory.md（可编辑 Markdown，用户与 AI 共同读写，附录 A.4）
// 召回仍用 bigram 相关性——不依赖向量库，离线可用。
import { DEFAULT_MEMORY, invoke, isTauri, type MemoryData } from '../lib/tauri'
import { loadMemory, saveMemory } from '../store'
import type { MemorySnapshot } from './PromptBuilder'
import { MEMORY_FILE, parseMemoryMd, serializeMemoryMd, type MemorySections } from './memoryMd'

const MAX_SHORT_TERM = 20
const COMPRESS_KEEP = 10 // 触发压缩后保留的最近条数
const MAX_PROFILE = 50
const MAX_EVENTS = 50
const MAX_DIGESTS = 6

/** 字符 bigram 集合：中文无分词，双字覆盖是廉价且够用的相似度基底 */
export function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, '')
  const out = new Set<string>()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

/** 相关性：query 的 bigram 在 text 中的覆盖率（0..1） */
export function relevanceScore(query: string, text: string): number {
  const a = bigrams(query)
  const b = bigrams(text)
  if (!a.size || !b.size) return 0
  let hit = 0
  for (const g of a) if (b.has(g)) hit++
  return hit / a.size
}

export class MemoryStore {
  /** 短期对话/昵称/统计（机器管理，JSON） */
  data: MemoryData = structuredClone(DEFAULT_MEMORY)
  /** 长期记忆（memory.md 的内存镜像；每次读写前都会从磁盘重读，手改立即生效） */
  private sections: MemorySections = { profile: [], events: [], digests: [] }

  static async load(): Promise<MemoryStore> {
    const m = new MemoryStore()
    m.data = await loadMemory()
    await m.reloadSections()
    return m
  }

  /** 从磁盘重读 memory.md；文件不存在（或为空）时从旧 JSON 记忆迁移生成（历史版本升级路径） */
  private async reloadSections(): Promise<void> {
    if (!isTauri) return
    try {
      const text = await invoke<string | null>('read_text', { name: MEMORY_FILE })
      if (text == null || text.trim() === '') {
        const legacy =
          this.data.userInfo.facts.length +
          this.data.petMemory.length +
          this.data.digests.length
        if (legacy > 0) {
          const seed: MemorySections = {
            profile: this.data.userInfo.facts,
            events: this.data.petMemory.map((m) => m.text),
            digests: this.data.digests.map((d) => d.text),
          }
          this.sections = seed
          await invoke('write_text', { name: MEMORY_FILE, content: serializeMemoryMd(seed) })
        } else if (text == null) {
          await invoke('write_text', { name: MEMORY_FILE, content: serializeMemoryMd(this.sections) })
        }
        // 旧 JSON 长期记忆已迁移：清掉，防止"用户清空 md"后被旧数据复活
        if (legacy > 0) {
          this.data.userInfo.facts = []
          this.data.petMemory = []
          this.data.digests = []
          await this.save()
        }
        return
      }
      this.sections = parseMemoryMd(text)
    } catch {
      /* 读失败按当前缓存继续 */
    }
  }

  private async saveSections(): Promise<void> {
    if (!isTauri) return
    await invoke('write_text', { name: MEMORY_FILE, content: serializeMemoryMd(this.sections) })
  }

  addMessage(role: 'user' | 'assistant', content: string): void {
    this.data.shortTerm.push({ role, content, t: Date.now() })
    if (this.data.shortTerm.length > MAX_SHORT_TERM) {
      // 滚动摘要压缩（附录 A.3）：最旧的压成话题行进 md，原文只留最近几条
      void this.compressShortTerm()
    }
  }

  private async compressShortTerm(): Promise<void> {
    const overflow = this.data.shortTerm.slice(0, this.data.shortTerm.length - COMPRESS_KEEP)
    if (!overflow.length) return
    const topics = overflow
      .filter((m) => m.role === 'user')
      .map((m) => m.content.replace(/[\s\p{P}]+/gu, '').slice(0, 12))
      .filter(Boolean)
      .slice(0, 5)
    const d = new Date()
    await this.reloadSections()
    this.sections.digests.push(
      `【${d.getMonth() + 1}/${d.getDate()}】聊了 ${overflow.length} 句${
        topics.length ? `，话题：${topics.join(' / ')}` : ''
      }`,
    )
    if (this.sections.digests.length > MAX_DIGESTS) {
      this.sections.digests = this.sections.digests.slice(-MAX_DIGESTS)
    }
    this.data.shortTerm = this.data.shortTerm.slice(-COMPRESS_KEEP)
    await this.saveSections()
  }

  /** 最近 N 轮对话，用于上下文 */
  recentMessages(n: number): { role: 'user' | 'assistant'; content: string }[] {
    return this.data.shortTerm.slice(-n).map((m) => ({ role: m.role, content: m.content }))
  }

  /** AI 得知的用户信息 → memory.md 用户画像段 */
  async addFact(fact: string): Promise<void> {
    const f = fact.trim()
    if (!f) return
    await this.reloadSections()
    if (this.sections.profile.includes(f)) return
    this.sections.profile.push(f)
    if (this.sections.profile.length > MAX_PROFILE) {
      this.sections.profile = this.sections.profile.slice(-MAX_PROFILE)
    }
    await this.saveSections()
  }

  /** 发生的事件 → memory.md 宠物记忆段 */
  async addPetMemory(text: string): Promise<void> {
    const t = text.trim()
    if (!t) return
    await this.reloadSections()
    this.sections.events.push(t)
    if (this.sections.events.length > MAX_EVENTS) {
      this.sections.events = this.sections.events.slice(-MAX_EVENTS)
    }
    await this.saveSections()
  }

  setNickname(nickname: string): void {
    this.data.userInfo.nickname = nickname.trim().slice(0, 20)
  }

  markInteraction(): void {
    this.data.stats.lastInteraction = Date.now()
    this.data.stats.totalChats += 1
  }

  /**
   * 记忆快照：query 传入用户消息时按相关性召回（bigram 覆盖率），
   * 召回不足回落到最新条目——prompt 拿到的是"相关的记忆"。
   */
  async snapshot(query = ''): Promise<MemorySnapshot> {
    await this.reloadSections()
    const recentEvents = this.sections.events

    let facts: string[]
    const scored = this.sections.profile
      .map((f) => ({ f, s: relevanceScore(query, f) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 6)
      .map((x) => x.f)
    if (query && scored.length >= 3) {
      facts = scored
    } else if (query) {
      const tail = this.sections.profile.slice(-6).filter((f) => !scored.includes(f))
      facts = [...scored, ...tail].slice(0, 6)
    } else {
      facts = this.sections.profile.slice(-6)
    }

    let petMem: string[]
    const scoredMem = recentEvents
      .map((m) => ({ m, s: relevanceScore(query, m) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
      .map((x) => x.m)
    if (query && scoredMem.some((m) => relevanceScore(query, m) > 0)) {
      petMem = scoredMem
    } else {
      petMem = recentEvents.slice(-5)
    }

    return {
      nickname: this.data.userInfo.nickname,
      facts,
      recentPetMemory: petMem,
      digests: this.sections.digests.slice(-2),
    }
  }

  /** 重置长期记忆文件（重置记忆按钮） */
  async resetFile(): Promise<void> {
    this.sections = { profile: [], events: [], digests: [] }
    await this.saveSections()
  }

  async save(): Promise<void> {
    await saveMemory(this.data)
  }
}
