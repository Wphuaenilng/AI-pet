// M6 聊天感知：ZCode 编码代理事件 → 宠物视觉/台词决策（纯逻辑层，可单测）
// 设计约束见整改计划 §9.3：同 kind 1s 内合并、状态最短保持、气泡只在跃迁时发一次。

export type AgentKind = 'agent-session' | 'agent-thinking' | 'agent-working' | 'agent-failed' | 'agent-done'

export const AGENT_KINDS: readonly AgentKind[] = [
  'agent-session',
  'agent-thinking',
  'agent-working',
  'agent-failed',
  'agent-done',
]

export function isAgentKind(kind: string): kind is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(kind)
}

export interface AgentVisual {
  /** bloub 引擎状态 id（stateFor 返回值的覆盖） */
  bloub: string
  /** Petdex 图集状态行 id（petRowFor 返回值的覆盖） */
  row: string
}

/** kind → 视觉映射（整改计划 §9.2 映射表） */
export const AGENT_VISUALS: Record<AgentKind, AgentVisual> = {
  'agent-session': { bloub: 'notify', row: 'waving' },
  'agent-thinking': { bloub: 'thinking', row: 'waiting' },
  'agent-working': { bloub: 'comet', row: 'review' },
  'agent-failed': { bloub: 'hexagon', row: 'failed' },
  'agent-done': { bloub: 'orbit', row: 'waving' },
}

/** 覆盖层最短保持（秒，§9.3-2 状态最短保持）：此期间无新事件也不消失 */
const MIN_HOLD_S: Record<AgentKind, number> = {
  'agent-session': 4,
  'agent-thinking': 8,
  'agent-working': 2,
  'agent-failed': 4,
  'agent-done': 5,
}

/** 同一 kind 的气泡冷却（秒）：连续失败/重复完成不刷气泡 */
const BUBBLE_COOLDOWN_S = 8

/** 同 kind 合并窗口（秒，§9.3-2 同一 kind 1s 内合并） */
const MERGE_WINDOW_S = 1

export interface AgentDecision {
  kind: AgentKind
  visual: AgentVisual
  /** 覆盖层到期时刻（ms） */
  until: number
  /** 本次是否状态跃迁（false = 同 kind 合并续期；气泡只在跃迁时发） */
  transitioned: boolean
  /** 本次跃迁是否允许配气泡（同 kind 8s 冷却；working 恒 false，由调用方决定） */
  bubble: boolean
}

export class AgentLayer {
  private current: { kind: AgentKind; until: number } | null = null
  private lastKind: AgentKind | null = null
  private lastEventAt = 0
  private lastBubbleAt: Partial<Record<AgentKind, number>> = {}

  /** 摄入一个 agent-* 事件；返回 null 表示未知 kind（调用方先过滤） */
  ingest(kind: AgentKind, now: number): AgentDecision {
    const hold = MIN_HOLD_S[kind] * 1000
    const merged =
      this.lastKind === kind && now - this.lastEventAt < MERGE_WINDOW_S * 1000
    this.lastKind = kind
    this.lastEventAt = now
    let transitioned = true
    if (merged && this.current && this.current.kind === kind) {
      this.current.until = Math.max(this.current.until, now + hold)
      transitioned = false
    } else {
      this.current = { kind, until: now + hold }
    }
    let bubble = false
    if (transitioned && kind !== 'agent-working') {
      const last = this.lastBubbleAt[kind] ?? -Infinity
      if (now - last >= BUBBLE_COOLDOWN_S * 1000) {
        bubble = true
        this.lastBubbleAt[kind] = now
      }
    }
    return { kind, visual: AGENT_VISUALS[kind], until: now + hold, transitioned, bubble }
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
  }
}
