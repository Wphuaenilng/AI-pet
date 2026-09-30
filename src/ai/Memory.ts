// 记忆系统：短期对话 + 用户信息 + 宠物记忆（JSON 持久化，不依赖向量库）
import { DEFAULT_MEMORY, type MemoryData } from '../lib/tauri'
import { loadMemory, saveMemory } from '../store'
import type { MemorySnapshot } from './PromptBuilder'

const MAX_SHORT_TERM = 20
const MAX_FACTS = 50
const MAX_PET_MEMORY = 30

export class MemoryStore {
  data: MemoryData = structuredClone(DEFAULT_MEMORY)

  static async load(): Promise<MemoryStore> {
    const m = new MemoryStore()
    m.data = await loadMemory()
    return m
  }

  addMessage(role: 'user' | 'assistant', content: string): void {
    this.data.shortTerm.push({ role, content, t: Date.now() })
    if (this.data.shortTerm.length > MAX_SHORT_TERM) {
      this.data.shortTerm = this.data.shortTerm.slice(-MAX_SHORT_TERM)
    }
  }

  /** 最近 N 轮对话，用于上下文 */
  recentMessages(n: number): { role: 'user' | 'assistant'; content: string }[] {
    return this.data.shortTerm.slice(-n).map((m) => ({ role: m.role, content: m.content }))
  }

  addFact(fact: string): void {
    const f = fact.trim()
    if (!f) return
    if (this.data.userInfo.facts.includes(f)) return
    this.data.userInfo.facts.push(f)
    if (this.data.userInfo.facts.length > MAX_FACTS) {
      this.data.userInfo.facts = this.data.userInfo.facts.slice(-MAX_FACTS)
    }
  }

  setNickname(nickname: string): void {
    this.data.userInfo.nickname = nickname.trim().slice(0, 20)
  }

  addPetMemory(text: string): void {
    this.data.petMemory.push({ t: Date.now(), text })
    if (this.data.petMemory.length > MAX_PET_MEMORY) {
      this.data.petMemory = this.data.petMemory.slice(-MAX_PET_MEMORY)
    }
  }

  markInteraction(): void {
    this.data.stats.lastInteraction = Date.now()
    this.data.stats.totalChats += 1
  }

  snapshot(): MemorySnapshot {
    const dayAgo = Date.now() - 24 * 3600 * 1000
    return {
      nickname: this.data.userInfo.nickname,
      facts: this.data.userInfo.facts,
      recentPetMemory: this.data.petMemory.filter((m) => m.t > dayAgo).map((m) => m.text),
    }
  }

  async save(): Promise<void> {
    await saveMemory(this.data)
  }
}
