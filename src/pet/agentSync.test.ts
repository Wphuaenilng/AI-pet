// M6 聊天感知覆盖层单测（整改计划 §9.3-2 滞回与去抖规则）
import { describe, expect, it } from 'vitest'
import { AgentLayer, AGENT_VISUALS, isAgentKind } from './agentSync'

describe('isAgentKind', () => {
  it('识别 5 个 agent-* kind，拒绝其他', () => {
    expect(isAgentKind('agent-session')).toBe(true)
    expect(isAgentKind('agent-thinking')).toBe(true)
    expect(isAgentKind('agent-working')).toBe(true)
    expect(isAgentKind('agent-failed')).toBe(true)
    expect(isAgentKind('agent-done')).toBe(true)
    expect(isAgentKind('build-ok')).toBe(false)
    expect(isAgentKind('notify')).toBe(false)
    expect(isAgentKind('')).toBe(false)
  })
})

describe('视觉映射（§9.2 映射表）', () => {
  it('每个 kind 都有 bloub 与 Petdex 行映射', () => {
    expect(AGENT_VISUALS['agent-session']).toEqual({ bloub: 'notify', row: 'waving' })
    expect(AGENT_VISUALS['agent-thinking']).toEqual({ bloub: 'thinking', row: 'waiting' })
    expect(AGENT_VISUALS['agent-working']).toEqual({ bloub: 'comet', row: 'review' })
    expect(AGENT_VISUALS['agent-failed']).toEqual({ bloub: 'hexagon', row: 'failed' })
    expect(AGENT_VISUALS['agent-done']).toEqual({ bloub: 'orbit', row: 'waving' })
  })
})

describe('AgentLayer 滞回', () => {
  it('不同 kind 立即跃迁，气泡只在跃迁时发', () => {
    const l = new AgentLayer()
    const a = l.ingest('agent-thinking', 1000)
    expect(a.transitioned).toBe(true)
    expect(a.bubble).toBe(true)
    const b = l.ingest('agent-working', 2000)
    expect(b.transitioned).toBe(true)
    // working 恒不发泡（高频事件）
    expect(b.bubble).toBe(false)
  })

  it('同一 kind 1s 内合并：不跃迁、续期', () => {
    const l = new AgentLayer()
    const a = l.ingest('agent-working', 1000)
    expect(a.transitioned).toBe(true)
    const b = l.ingest('agent-working', 1500) // 500ms < 1s 合并窗口
    expect(b.transitioned).toBe(false)
    expect(b.until).toBeGreaterThan(a.until)
    const c = l.ingest('agent-working', 2500) // 1s 后重新跃迁
    expect(c.transitioned).toBe(true)
  })

  it('PreToolUse 高频流只把覆盖层续到最近一次事件之后', () => {
    const l = new AgentLayer()
    let until = 0
    for (let i = 0; i < 10; i++) {
      until = l.ingest('agent-working', 10_000 + i * 300).until
    }
    // working 最短保持 2s：最后一次事件 + 2000ms
    expect(until).toBe(10_000 + 9 * 300 + 2000)
  })

  it('同一 kind 气泡 8s 冷却（连续失败不刷屏）', () => {
    const l = new AgentLayer()
    expect(l.ingest('agent-failed', 1000).bubble).toBe(true)
    expect(l.ingest('agent-done', 3000).bubble).toBe(true)
    // 2s 后再次失败：已跃迁但处于 8s 冷却内
    const again = l.ingest('agent-failed', 5000)
    expect(again.transitioned).toBe(true)
    expect(again.bubble).toBe(false)
    // 冷却过后允许
    expect(l.ingest('agent-done', 20_000).bubble).toBe(true)
    expect(l.ingest('agent-failed', 21_000).bubble).toBe(true)
  })

  it('最短保持：thinking 覆盖 8s 后才过期', () => {
    const l = new AgentLayer()
    l.ingest('agent-thinking', 1000)
    expect(l.active(1000)?.kind).toBe('agent-thinking')
    expect(l.active(8000)?.kind).toBe('agent-thinking')
    expect(l.active(9001)).toBeNull() // 1000 + 8000 到期
  })

  it('reset 清空覆盖层', () => {
    const l = new AgentLayer()
    l.ingest('agent-done', 1000)
    l.reset()
    expect(l.active(1000)).toBeNull()
    const d = l.ingest('agent-done', 2000)
    expect(d.transitioned).toBe(true)
  })
})
