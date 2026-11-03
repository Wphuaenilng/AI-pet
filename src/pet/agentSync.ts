// M6 聊天感知：ZCode 编码代理事件 → 宠物视觉/台词决策（纯逻辑层，可单测）
// 设计约束见整改计划 §9.3：同 kind 1s 内合并、状态最短保持、气泡只在跃迁时发一次。

export type AgentKind =
  | 'agent-session'
  | 'agent-thinking'
  | 'agent-working'
  | 'agent-tool-ok'
  | 'agent-failed'
  | 'agent-done'

export const AGENT_KINDS: readonly AgentKind[] = [
  'agent-session',
  'agent-thinking',
  'agent-working',
  'agent-tool-ok',
  'agent-failed',
  'agent-done',
]

export function isAgentKind(kind: string): kind is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(kind)
}

export type AgentSource = 'zcode' | 'claude'

/** 气泡来源标签；旧钩子/直注事件未带 source 时按最初的 ZCode 适配兼容。 */
export function agentSourceLabel(source?: string): string {
  return source?.toLowerCase() === 'claude' ? 'Claude' : 'ZCode'
}

export interface AgentVisual {
  /** bloub 引擎状态 id（stateFor 返回值的覆盖） */
  bloub: string
  /** Petdex 图集状态行 id（petRowFor 返回值的覆盖） */
  row: string
}

/** kind → 视觉映射（整改计划 §9.2 映射表；tool-ok 与 working 同为轻量工作视觉） */
export const AGENT_VISUALS: Record<AgentKind, AgentVisual> = {
  'agent-session': { bloub: 'notify', row: 'waving' },
  'agent-thinking': { bloub: 'thinking', row: 'waiting' },
  'agent-working': { bloub: 'comet', row: 'review' },
  'agent-tool-ok': { bloub: 'comet', row: 'review' },
  'agent-failed': { bloub: 'hexagon', row: 'failed' },
  'agent-done': { bloub: 'orbit', row: 'waving' },
}

/** 覆盖层保持（秒）：thinking 等不到后续事件时也不能几秒就消失；10 分钟是 Stop 丢失时的兜底。 */
const MIN_HOLD_S: Record<AgentKind, number> = {
  'agent-session': 4,
  'agent-thinking': 600,
  'agent-working': 2,
  'agent-tool-ok': 2,
  'agent-failed': 4,
  'agent-done': 5,
}

/** 同一 kind 的气泡冷却（秒）：连续失败/重复完成不刷气泡 */
const BUBBLE_COOLDOWN_S = 8

/** 同 kind 合并窗口（秒，§9.3-2 同一 kind 1s 内合并） */
const MERGE_WINDOW_S = 1

/** M6-P2 PostToolUse 低频摘要：每累计这么多次连续工具成功才允许一次摘要气泡 */
const TOOL_OK_SUMMARY_EVERY = 3
/** 摘要气泡自身冷却（秒）：高频工具流里摘要也不能刷屏 */
const TOOL_OK_SUMMARY_COOLDOWN_S = 30

export interface AgentDecision {
  kind: AgentKind
  visual: AgentVisual
  /** 覆盖层到期时刻（ms） */
  until: number
  /** 本次是否状态跃迁（false = 同 kind 合并续期；气泡只在跃迁时发） */
  transitioned: boolean
  /** 本次跃迁是否允许配气泡（同 kind 8s 冷却；working 恒 false；tool-ok 走摘要规则） */
  bubble: boolean
  /** M6-P2：仅 agent-tool-ok 摘要气泡时携带——本次摘要的连续工具成功次数 */
  summary?: number
}

export class AgentLayer {
  private current: { kind: AgentKind; until: number } | null = null
  private lastKind: AgentKind | null = null
  private lastEventAt = 0
  private lastBubbleAt: Partial<Record<AgentKind, number>> = {}
  /** 连续工具成功计数（任何非 tool-ok 事件都会打断） */
  private toolOkStreak = 0

  /** 摄入一个 agent-* 事件；返回 null 表示未知 kind（调用方先过滤） */
  ingest(kind: AgentKind, now: number): AgentDecision {
    const hold = MIN_HOLD_S[kind] * 1000
    const merged =
      this.lastKind === kind && now - this.lastEventAt < MERGE_WINDOW_S * 1000
    this.lastKind = kind
    this.lastEventAt = now
    this.toolOkStreak = kind === 'agent-tool-ok' ? this.toolOkStreak + 1 : 0
    let transitioned = true
    if (merged && this.current && this.current.kind === kind) {
      this.current.until = Math.max(this.current.until, now + hold)
      transitioned = false
    } else {
      this.current = { kind, until: now + hold }
    }
    let bubble = false
    let summary: number | undefined
    if (kind === 'agent-tool-ok') {
      // M6-P2 低频摘要：每满 3 次连续成功且过 30s 冷却才泡一次，与跃迁/合并无关
      const last = this.lastBubbleAt[kind] ?? -Infinity
      if (
        this.toolOkStreak % TOOL_OK_SUMMARY_EVERY === 0 &&
        now - last >= TOOL_OK_SUMMARY_COOLDOWN_S * 1000
      ) {
        bubble = true
        summary = this.toolOkStreak
        this.lastBubbleAt[kind] = now
      }
    } else if (transitioned && kind !== 'agent-working') {
      const last = this.lastBubbleAt[kind] ?? -Infinity
      if (now - last >= BUBBLE_COOLDOWN_S * 1000) {
        bubble = true
        this.lastBubbleAt[kind] = now
      }
    }
    return { kind, visual: AGENT_VISUALS[kind], until: now + hold, transitioned, bubble, summary }
  }

  /** 当前生效的覆盖视觉；已过期或未摄入返回 null */
  active(now: number): AgentDecision | null {
    if (!this.current || now > this.current.until) return null
    const { kind } = this.current
    return {
      kind,
      visual: AGENT_VISUALS[kind],
      until: this.current.until,
      transitioned: false,
      bubble: false,
    }
  }

  reset(): void {
    this.current = null
    this.lastKind = null
    this.lastEventAt = 0
    this.lastBubbleAt = {}
    this.toolOkStreak = 0
  }
}
