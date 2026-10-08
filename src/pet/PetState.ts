// 情绪系统：五维状态值 + 瞬时表情，驱动表情与行为倾向
import type { PetFsmState } from '../behavior/StateMachine'

export type ExprKind =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'sleepy'
  | 'concern'

export interface EmotionValues {
  happiness: number
  energy: number
  curiosity: number
  affection: number
  boredom: number
  /** 饱食度 0-100（100=饱）：随时间衰减，投喂恢复，驱动讨食/行为权重（附录 A.2） */
  hunger: number
}

const clamp = (x: number) => Math.max(0, Math.min(100, x))

export class EmotionSystem {
  v: EmotionValues = { happiness: 65, energy: 82, curiosity: 55, affection: 40, boredom: 18, hunger: 72 }
  transient: { kind: ExprKind; until: number } | null = null
  lastInteraction = Date.now()
  private pokeTimes: number[] = []

  setTransient(kind: ExprKind, ms: number, now: number): void {
    this.transient = { kind, until: now + ms }
  }

  tick(dt: number, ctx: { state: PetFsmState; cursorActive: boolean }): void {
    const v = this.v
    if (ctx.state === 'SLEEP') {
      v.energy = clamp(v.energy + 1.3 * dt)
      v.boredom = clamp(v.boredom - 0.25 * dt)
      v.hunger = clamp(v.hunger - 0.02 * dt)
    } else if (ctx.state === 'WALK' || ctx.state === 'RUN' || ctx.state === 'PLAY') {
      v.energy = clamp(v.energy - 0.05 * dt)
      v.boredom = clamp(v.boredom - 0.12 * dt)
      v.curiosity = clamp(v.curiosity + 0.02 * dt)
      v.hunger = clamp(v.hunger - 0.09 * dt)
    } else {
      v.boredom = clamp(v.boredom + (ctx.cursorActive ? -0.1 : 0.055) * dt)
      v.energy = clamp(v.energy + 0.015 * dt)
      v.hunger = clamp(v.hunger - 0.05 * dt)
    }
    v.happiness = clamp(v.happiness + (62 - v.happiness) * 0.004 * dt)
    v.affection = clamp(v.affection + (45 - v.affection) * 0.002 * dt)
    if (this.transient && Date.now() > this.transient.until) this.transient = null
  }

  /** 投喂（附录 A.2）：饱食度大幅恢复，心情与无聊同步反馈 */
  feed(): void {
    this.lastInteraction = Date.now()
    this.v.hunger = clamp(this.v.hunger + 38)
    this.v.happiness = clamp(this.v.happiness + 6)
    this.v.boredom = clamp(this.v.boredom - 10)
  }

  /** 摸摸/点击，短时间戳太密集会生气 */
  onPet(now: number): 'ok' | 'angry' {
    this.lastInteraction = Date.now()
    this.v.affection = clamp(this.v.affection + 2.5)
    this.v.happiness = clamp(this.v.happiness + 3)
    this.v.boredom = clamp(this.v.boredom - 8)
    this.v.curiosity = clamp(this.v.curiosity + 2)
    const t = Date.now()
    this.pokeTimes = this.pokeTimes.filter((x) => t - x < 4000)
    this.pokeTimes.push(t)
    if (this.pokeTimes.length >= 6) {
      this.pokeTimes = []
      this.setTransient('angry', 2200, now)
      return 'angry'
    }
    this.setTransient('happy', 1400, now)
    return 'ok'
  }

  onDragStart(now: number): void {
    this.lastInteraction = Date.now()
    this.setTransient('surprised', 1600, now)
  }

  onDragEnd(): void {
    this.lastInteraction = Date.now()
    this.v.happiness = clamp(this.v.happiness - 2)
    this.v.affection = clamp(this.v.affection - 1)
  }

  onPlay(): void {
    this.lastInteraction = Date.now()
    this.v.happiness = clamp(this.v.happiness + 6)
    this.v.boredom = clamp(this.v.boredom - 16)
  }

  onChat(emotion: string): void {
    this.lastInteraction = Date.now()
    this.v.affection = clamp(this.v.affection + 5)
    this.v.boredom = clamp(this.v.boredom - 15)
    if (emotion === 'happy') this.v.happiness = clamp(this.v.happiness + 8)
    else if (emotion === 'sad') this.v.happiness = clamp(this.v.happiness - 5)
    else if (emotion === 'concern') this.v.affection = clamp(this.v.affection + 3)
    else if (emotion === 'angry') this.v.happiness = clamp(this.v.happiness - 3)
  }

  /**
   * 用户文字情绪（M4 双通道本地侧）：关键词估计的结果只调心情，
   * 不动好感——好感仍由 AI 结构化输出（onChat）结算，避免双重加分。
   */
  onUserText(emotion: string): void {
    this.lastInteraction = Date.now()
    if (emotion === 'happy') this.v.happiness = clamp(this.v.happiness + 3)
    else if (emotion === 'sad') this.v.happiness = clamp(this.v.happiness - 3)
    else if (emotion === 'angry') this.v.happiness = clamp(this.v.happiness - 2)
    else if (emotion === 'surprised') this.v.curiosity = clamp(this.v.curiosity + 2)
  }

  expr(): ExprKind {
    if (this.transient) return this.transient.kind
    if (this.v.energy < 14) return 'sleepy'
    if (this.v.happiness > 78) return 'happy'
    if (this.v.boredom > 85) return 'sad'
    return 'neutral'
  }
}
