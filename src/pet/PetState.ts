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
}

const clamp = (x: number) => Math.max(0, Math.min(100, x))

export class EmotionSystem {
  v: EmotionValues = { happiness: 65, energy: 82, curiosity: 55, affection: 40, boredom: 18 }
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
    } else if (ctx.state === 'WALK' || ctx.state === 'RUN' || ctx.state === 'PLAY') {
      v.energy = clamp(v.energy - 0.05 * dt)
      v.boredom = clamp(v.boredom - 0.12 * dt)
      v.curiosity = clamp(v.curiosity + 0.02 * dt)
    } else {
      v.boredom = clamp(v.boredom + (ctx.cursorActive ? -0.1 : 0.055) * dt)
      v.energy = clamp(v.energy + 0.015 * dt)
    }
    v.happiness = clamp(v.happiness + (62 - v.happiness) * 0.004 * dt)
    v.affection = clamp(v.affection + (45 - v.affection) * 0.002 * dt)
    if (this.transient && Date.now() > this.transient.until) this.transient = null
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

  expr(): ExprKind {
    if (this.transient) return this.transient.kind
    if (this.v.energy < 14) return 'sleepy'
    if (this.v.happiness > 78) return 'happy'
    if (this.v.boredom > 85) return 'sad'
    return 'neutral'
  }
}
