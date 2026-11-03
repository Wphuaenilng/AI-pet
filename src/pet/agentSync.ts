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

/** 归一化来源键：消息列表/冷却按来源隔离，旧事件缺省为 ZCode。 */
export function agentSourceId(source?: string): AgentSource {
  return source?.toLowerCase() === 'claude' ? 'claude' : 'zcode'
}

/** 气泡来源标签；旧钩子/直注事件未带 source 时按最初的 ZCode 适配兼容。 */
export function agentSourceLabel(source?: string): string {
  return agentSourceId(source) === 'claude' ? 'Claude' : 'ZCode'
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

export const AGENT_THINKING_HOLD_MS = 600_000

/** 覆盖层保持（秒）：thinking 等不到后续事件时也不能几秒就消失；10 分钟是 Stop 丢失时的兜底。 */
const MIN_HOLD_S: Record<AgentKind, number> = {
  'agent-session': 4,
  'agent-thinking': AGENT_THINKING_HOLD_MS / 1000,
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

/** 将窗口中心的内容钳回屏幕可见范围；返回物理像素偏移，左右边缘对称。 */
export function inwardOffset(
  windowCenter: number,
  monitorStart: number,
  monitorEnd: number,
  contentWidth: number,
  margin = 8,
): number {
  const minCenter = monitorStart + margin + contentWidth / 2
  const maxCenter = monitorEnd - margin - contentWidth / 2
  if (minCenter > maxCenter) return (monitorStart + monitorEnd) / 2 - windowCenter
  return Math.max(minCenter, Math.min(maxCenter, windowCenter)) - windowCenter
}

export interface AgentMessage {
  id: number
  source: AgentSource
  kind: AgentKind
  text: string
  /** thinking 使用 10 分钟状态兜底；普通消息按阅读时长过期 */
  until: number
}

/** 并发代理消息中心：每个来源独立的决策层 + 可并存的消息列表（纯逻辑，可单测）。 */
export class AgentMessageCenter {
  private layers: Record<AgentSource, AgentLayer> = {
    zcode: new AgentLayer(),
    claude: new AgentLayer(),
  }
  private items: AgentMessage[] = []
  private nextId = 1

  get size(): number {
    return this.items.length
  }

  ingest(kind: AgentKind, source: AgentSource, now: number): AgentDecision {
    return this.layers[source].ingest(kind, now)
  }

  add(kind: AgentKind, source: AgentSource, text: string, now: number): void {
    const duration =
      kind === 'agent-thinking'
        ? AGENT_THINKING_HOLD_MS
        : Math.max(2400, Math.min(9000, 1500 + text.length * 170))
    this.items.push({ id: this.nextId++, source, kind, text, until: now + duration })
    // 窗口最多舒适容纳 6 条；超出时丢弃最旧的一条，折叠按钮始终保留计数视图。
    if (this.items.length > 6) this.items.shift()
  }

  /** 只清理同一来源的思考消息，另一个代理不受影响。 */
  clearThinking(source: AgentSource): boolean {
    const before = this.items.length
    this.items = this.items.filter((m) => m.source !== source || m.kind !== 'agent-thinking')
    return this.items.length !== before
  }

  expire(now: number): boolean {
    const before = this.items.length
    this.items = this.items.filter((m) => now <= m.until)
    return this.items.length !== before
  }

  list(): AgentMessage[] {
    return this.items.map((m) => ({ ...m }))
  }

  reset(): void {
    this.layers.zcode.reset()
    this.layers.claude.reset()
    this.items = []
  }
}
