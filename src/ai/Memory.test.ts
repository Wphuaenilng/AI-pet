// 记忆系统单测（M5）：memory.md 解析/序列化、bigram 召回、滚动摘要
import { describe, expect, it } from 'vitest'
import { MemoryStore, bigrams, relevanceScore } from './Memory'
import { parseMemoryMd, serializeMemoryMd, type MemorySections } from './memoryMd'
import { DEFAULT_MEMORY } from '../lib/tauri'

function freshStore(): MemoryStore {
  const m = new MemoryStore()
  m.data = structuredClone(DEFAULT_MEMORY)
  return m
}

function sectionsOf(m: MemoryStore): MemorySections {
  return (m as unknown as { sections: MemorySections }).sections
}

describe('bigram 相关性', () => {
  it('覆盖中文双字', () => {
    expect(bigrams('奶茶').has('奶茶')).toBe(true)
  })
  it('相关命中、无关为零', () => {
    expect(relevanceScore('我喜欢喝奶茶', '用户喜欢喝奶茶')).toBeGreaterThan(0)
    expect(relevanceScore('量子物理', '我喜欢喝奶茶')).toBe(0)
  })
})

describe('memory.md 解析/序列化', () => {
  it('按 ## 分段收集 "- " 条目', () => {
    const s = parseMemoryMd(
      '# 记忆\n\n## 用户画像\n\n- 用户喜欢喝奶茶\n- 用户在深圳工作\n\n## 宠物记忆\n\n- 10/7 被投喂\n\n## 对话摘要\n\n- 【10/7】聊了 3 句\n',
    )
    expect(s.profile).toEqual(['用户喜欢喝奶茶', '用户在深圳工作'])
    expect(s.events).toEqual(['10/7 被投喂'])
    expect(s.digests).toEqual(['【10/7】聊了 3 句'])
  })
  it('序列化可完整往返，空段落写入提示注释', () => {
    const s: MemorySections = { profile: ['a'], events: ['b', 'c'], digests: [] }
    expect(parseMemoryMd(serializeMemoryMd(s))).toEqual(s)
    expect(serializeMemoryMd(s)).toContain('<!--')
  })
})

describe('快照召回（基于 memory.md 段落）', () => {
  function stocked(): MemoryStore {
    const m = freshStore()
    sectionsOf(m).profile = ['用户喜欢喝奶茶', '用户养了一只猫', '用户在深圳工作']
    sectionsOf(m).events = ['聊过奶茶品牌偏好', '聊过猫的日常']
    return m
  }
  it('按相关性取回相关事实与记忆', async () => {
    const m = stocked()
    const snap = await m.snapshot('今天想喝奶茶')
    expect(snap.facts[0]).toBe('用户喜欢喝奶茶')
    expect(snap.recentPetMemory).toContain('聊过奶茶品牌偏好')
  })
  it('无命中回落到最新条目，不为空', async () => {
    const m = stocked()
    const snap = await m.snapshot('量子力学是什么')
    expect(snap.facts.length).toBeGreaterThan(0)
    expect(snap.recentPetMemory.length).toBeGreaterThan(0)
  })
})

describe('滚动摘要压缩（附录 A.3）', () => {
  it('最旧对话压成话题行进 md，原文只留最近几条', async () => {
    const m = freshStore()
    for (let i = 0; i < 21; i++) m.addMessage('user', `话题${i}的内容`)
    // 第 21 条自动触发异步压缩，等它落盘完成再断言
    await new Promise((r) => setTimeout(r, 10))
    expect(m.data.shortTerm.length).toBe(10)
    const digests = sectionsOf(m).digests
    expect(digests.length).toBe(1)
    expect(digests[0]).toContain('聊了 11 句')
    expect(digests[0]).toContain('话题0')
  })
})
