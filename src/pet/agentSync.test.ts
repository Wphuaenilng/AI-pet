// M6 聊天感知覆盖层单测（整改计划 §9.3-2 滞回与去抖规则）
import { describe, expect, it } from 'vitest'
import {
  AgentLayer,
  AgentMessageCenter,
  AGENT_VISUALS,
  agentSourceLabel,
  inwardOffset,
  isAgentKind,
} from './agentSync'

describe('isAgentKind', () => {
  it('识别 6 个 agent-* kind，拒绝其他', () => {
    expect(isAgentKind('agent-session')).toBe(true)
    expect(isAgentKind('agent-thinking')).toBe(true)
    expect(isAgentKind('agent-working')).toBe(true)
    expect(isAgentKind('agent-tool-ok')).toBe(true)
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

  it('thinking 长思考不消失，10 分钟兜底过期', () => {
    const l = new AgentLayer()
    l.ingest('agent-thinking', 1000)
    expect(l.active(1000)?.kind).toBe('agent-thinking')
    expect(l.active(18_000)?.kind).toBe('agent-thinking') // 截图中的 17s 场景
    expect(l.active(601_000)?.kind).toBe('agent-thinking')
    expect(l.active(601_001)).toBeNull()
  })

  it('消息来源显示 Claude / ZCode，兼容未带 source 的旧钩子', () => {
    expect(agentSourceLabel('claude')).toBe('Claude')
    expect(agentSourceLabel('zcode')).toBe('ZCode')
    expect(agentSourceLabel(undefined)).toBe('ZCode')
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

describe('M6-P2 PostToolUse 低频摘要', () => {
  it('tool-ok 视觉复用 working 轻量映射', () => {
    expect(AGENT_VISUALS['agent-tool-ok']).toEqual({ bloub: 'comet', row: 'review' })
  })

  it('连续 3 次成功才泡第一次摘要，带次数', () => {
    const l = new AgentLayer()
    expect(l.ingest('agent-tool-ok', 1000).bubble).toBe(false)
    expect(l.ingest('agent-tool-ok', 2000).bubble).toBe(false)
    const third = l.ingest('agent-tool-ok', 3000)
    expect(third.bubble).toBe(true)
    expect(third.summary).toBe(3)
  })

  it('摘要与合并窗口无关：1s 内连续成功也按节奏泡', () => {
    const l = new AgentLayer()
    l.ingest('agent-tool-ok', 1000)
    l.ingest('agent-tool-ok', 1500)
    const third = l.ingest('agent-tool-ok', 2000)
    expect(third.transitioned).toBe(false) // 合并续期
    expect(third.bubble).toBe(true) // 摘要照发
  })

  it('摘要 30s 冷却：第 6 次在冷却内不泡，冷却后的倍数节点再泡', () => {
    const l = new AgentLayer()
    l.ingest('agent-tool-ok', 1000)
    l.ingest('agent-tool-ok', 2000)
    l.ingest('agent-tool-ok', 3000) // 首次摘要 @3000
    l.ingest('agent-tool-ok', 4000)
    l.ingest('agent-tool-ok', 5000)
    expect(l.ingest('agent-tool-ok', 6000).bubble).toBe(false) // 倍数但冷却内
    expect(l.ingest('agent-tool-ok', 40_000).bubble).toBe(false) // 第 7 次非倍数
    expect(l.ingest('agent-tool-ok', 41_000).bubble).toBe(false) // 第 8 次非倍数
    const ninth = l.ingest('agent-tool-ok', 42_000)
    expect(ninth.bubble).toBe(true)
    expect(ninth.summary).toBe(9)
  })

  it('失败/完成等其他事件打断连续计数', () => {
    const l = new AgentLayer()
    l.ingest('agent-tool-ok', 1000)
    l.ingest('agent-tool-ok', 2000)
    l.ingest('agent-failed', 3000)
    expect(l.ingest('agent-tool-ok', 4000).bubble).toBe(false) // 重新计 1
    expect(l.ingest('agent-tool-ok', 5000).bubble).toBe(false) // 重新计 2
    const d = l.ingest('agent-tool-ok', 6000)
    expect(d.bubble).toBe(true) // 重新计 3
    expect(d.summary).toBe(3)
  })

  it('reset 同时清空连续计数', () => {
    const l = new AgentLayer()
    l.ingest('agent-tool-ok', 1000)
    l.ingest('agent-tool-ok', 2000)
    l.reset()
    expect(l.ingest('agent-tool-ok', 3000).bubble).toBe(false)
  })
})

describe('AgentMessageCenter 并发消息', () => {
  it('ZCode 与 Claude 思考消息并存，同来源连续提问也保留', () => {
    const c = new AgentMessageCenter()
    c.add('agent-thinking', 'zcode', 'ZCode：第一个问题', 1000)
    c.add('agent-thinking', 'zcode', 'ZCode：第二个问题', 1100)
    c.add('agent-thinking', 'claude', 'Claude：也在思考', 1200)
    expect(c.list().map((m) => m.text)).toEqual([
      'ZCode：第一个问题',
      'ZCode：第二个问题',
      'Claude：也在思考',
    ])
  })

  it('状态切换只清理对应来源的思考消息', () => {
    const c = new AgentMessageCenter()
    c.add('agent-thinking', 'zcode', 'ZCode：思考中', 1000)
    c.add('agent-thinking', 'claude', 'Claude：思考中', 1100)
    expect(c.clearThinking('zcode')).toBe(true)
    expect(c.list().map((m) => m.source)).toEqual(['claude'])
    expect(c.clearThinking('zcode')).toBe(false)
  })

  it('气泡决策按来源隔离，同 kind 不互相冷却', () => {
    const c = new AgentMessageCenter()
    expect(c.ingest('agent-thinking', 'zcode', 1000).bubble).toBe(true)
    expect(c.ingest('agent-thinking', 'claude', 1100).bubble).toBe(true)
  })

  it('普通消息按阅读时长过期，思考消息有长兜底', () => {
    const c = new AgentMessageCenter()
    c.add('agent-done', 'zcode', '完成', 1000)
    c.add('agent-thinking', 'claude', '思考中', 1000)
    expect(c.expire(5000)).toBe(true)
    expect(c.list().map((m) => m.kind)).toEqual(['agent-thinking'])
    expect(c.expire(601_001)).toBe(true)
    expect(c.size).toBe(0)
  })
})

describe('屏幕边缘内移', () => {
  it('中间不偏移，左缘向右、右缘向左', () => {
    expect(inwardOffset(1000, 0, 2560, 300)).toBe(0)
    expect(inwardOffset(60, 0, 2560, 300)).toBe(98)
    expect(inwardOffset(2500, 0, 2560, 300)).toBe(-98)
  })
})
