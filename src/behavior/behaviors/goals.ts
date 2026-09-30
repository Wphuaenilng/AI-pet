// 行为目标：每个目标驱动宠物完成一件小事，由行为树挑选
import type { OSWindow } from '../../lib/tauri'
import type { PetBrain } from '../../pet/PetBrain'

export interface Goal {
  readonly label: string
  start(): void
  update(dt: number): 'running' | 'done'
  /** 空中（airborne）时由主循环调用的纠偏钩子：PetBrain 只在地面调 update */
  updateAir?(dt: number): void
  onAbort?(): void
}

let uid = 0
function nid(prefix: string): string {
  return `${prefix}#${uid++}`
}

export class WalkGoal implements Goal {
  readonly label = nid('walk')
  private t = 0
  private blockedT = 0
  constructor(
    private brain: PetBrain,
    private targetX: number,
    private opts: { speed?: number; timeout?: number; run?: boolean } = {},
  ) {}
  start(): void {
    this.t = 0
    this.blockedT = 0
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    const r = this.brain.walkStep(dt, this.targetX, this.opts.speed ?? 75, this.opts.run ?? false)
    if (r === 'arrived') return 'done'
    if (r === 'blocked') {
      this.blockedT += dt
      if (this.blockedT > 0.5) return 'done'
    } else {
      this.blockedT = 0
    }
    if (this.t > (this.opts.timeout ?? 12)) return 'done'
    return 'running'
  }
}

export class RunGoal implements Goal {
  readonly label = nid('run')
  private inner: Goal
  constructor(
    private brain: PetBrain,
    targetX: number,
  ) {
    this.inner = new WalkGoal(brain, targetX, { speed: 235, run: true, timeout: 8 })
  }
  start(): void {
    this.inner.start()
  }
  update(dt: number): 'running' | 'done' {
    return this.inner.update(dt)
  }
  onAbort(): void {
    this.inner.onAbort?.()
  }
}

export class WanderGoal implements Goal {
  readonly label = nid('wander')
  private inner: Goal | null = null
  constructor(private brain: PetBrain) {}
  start(): void {
    const m = this.brain.world.monitorAt(this.brain.pet.x)
    const u = this.brain.u
    const minX = (m?.wx ?? 0) + 60 * u
    const maxX = (m ? m.wx + m.ww : 1920 * u) - 60 * u
    const target = minX + Math.random() * Math.max(1, maxX - minX)
    this.inner = new WalkGoal(this.brain, target, { speed: 60 + Math.random() * 40 })
    this.inner.start()
  }
  update(dt: number): 'running' | 'done' {
    if (!this.inner) return 'done'
    return this.inner.update(dt)
  }
  onAbort(): void {
    this.inner?.onAbort?.()
  }
}

export class IdleGoal implements Goal {
  readonly label = nid('idle')
  private t = 0
  constructor(private brain: PetBrain, private dur: number) {}
  start(): void {
    this.t = 0
    this.brain.setPose('IDLE')
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    this.brain.trackCursorEyes()
    return this.t >= this.dur ? 'done' : 'running'
  }
}

export class SitGoal implements Goal {
  readonly label = nid('sit')
  private t = 0
  constructor(private brain: PetBrain, private dur: number) {}
  start(): void {
    this.t = 0
    this.brain.setPose('SIT')
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    this.brain.trackCursorEyes()
    return this.t >= this.dur ? 'done' : 'running'
  }
}

export class LayGoal implements Goal {
  readonly label = nid('lay')
  private t = 0
  constructor(private brain: PetBrain, private dur: number) {}
  start(): void {
    this.t = 0
    this.brain.setPose('LAY')
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    return this.t >= this.dur ? 'done' : 'running'
  }
}

export class SleepGoal implements Goal {
  readonly label = nid('sleep')
  private t = 0
  private yawned = false
  constructor(private brain: PetBrain, private dur: number) {}
  start(): void {
    this.t = 0
    this.yawned = false
    this.brain.setPose('SIT')
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    // 两段式入睡：先坐下说句犯困台词，气泡结束后再睡——
    // 睡着后弹气泡会立刻把自己"吵醒"（showNextBubble 会打断 SLEEP）
    if (!this.yawned) {
      if (this.t < 0.4) return 'running'
      this.yawned = true
      this.brain.say(this.brain.pickCanned('sleepy'))
      return 'running'
    }
    if (this.brain.bubble.visible) return 'running'
    this.brain.setPose('SLEEP')
    if (this.brain.fsm.current !== 'SLEEP') return 'done' // 被打断（说话/拖拽）
    return this.t >= this.dur ? 'done' : 'running'
  }
  onAbort(): void {
    this.brain.setPose('IDLE')
  }
}

export class LookGoal implements Goal {
  readonly label = nid('look')
  private t = 0
  constructor(private brain: PetBrain, private dur: number) {}
  start(): void {
    this.t = 0
    this.brain.setPose('LOOK')
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    this.brain.trackCursorEyes()
    return this.t >= this.dur ? 'done' : 'running'
  }
}

export class HappyGoal implements Goal {
  readonly label = nid('happy')
  private t = 0
  constructor(private brain: PetBrain, private dur: number) {}
  start(): void {
    this.t = 0
    this.brain.setPose('HAPPY')
    this.brain.anim.burst('heart', 4)
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    this.brain.trackCursorEyes()
    return this.t >= this.dur ? 'done' : 'running'
  }
}

export class DanceGoal implements Goal {
  readonly label = nid('dance')
  private t = 0
  private hopCd = 0.1
  constructor(private brain: PetBrain, private dur = 3.2) {}
  start(): void {
    this.t = 0
    this.hopCd = 0.1
    this.brain.setPose('HAPPY')
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    this.hopCd -= dt
    if (this.hopCd <= 0 && !this.brain.pet.airborne) {
      this.brain.pounce()
      this.brain.anim.burst('heart', 2)
      this.hopCd = 0.75
    }
    return this.t >= this.dur ? 'done' : 'running'
  }
}

export class ChaseGoal implements Goal {
  readonly label = nid('chase')
  private t = 0
  private pounceCd = 1.5
  private lastCursorX = 0
  private still = 0
  constructor(
    private brain: PetBrain,
    private dur: number,
  ) {}
  start(): void {
    this.t = 0
    this.pounceCd = 1.5
    this.lastCursorX = this.brain.world.cursor.x
    this.still = 0
    this.brain.setPose('PLAY')
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    this.pounceCd -= dt
    const cur = this.brain.world.cursor.x
    if (Math.abs(cur - this.lastCursorX) < 4 * this.brain.u) this.still += dt
    else this.still = 0
    this.lastCursorX = cur
    if (this.still > 0.9 && this.pounceCd <= 0 && !this.brain.pet.airborne) {
      this.brain.pounce()
      this.brain.emotion.onPlay()
      this.pounceCd = 2.5
    }
    const r = this.brain.walkStep(dt, cur, 170, false)
    if (this.t > this.dur || r === 'blocked') {
      this.brain.setPose('IDLE')
      // 尽兴而归才说"好玩"，被挡住打断就不说
      if (this.t > this.dur) this.brain.say(this.brain.pickCanned('playHappy'))
      return 'done'
    }
    return 'running'
  }
}

export class ClimbGoal implements Goal {
  readonly label = nid('climb')
  private phase: 'approach' | 'jump' = 'approach'
  private t = 0
  private blockedT = 0
  constructor(
    private brain: PetBrain,
    private win: OSWindow,
  ) {}
  start(): void {
    this.phase = 'approach'
    this.t = 0
    this.blockedT = 0
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    if (this.t > 14) return 'done'
    const w = this.brain.world.windowById(this.win.id)
    if (!w) return 'done'
    if (this.phase === 'approach') {
      const u = this.brain.u
      const targetX = w.x + w.w / 2
      const r = this.brain.walkStep(dt, targetX, 90, false)
      if (r === 'blocked') {
        this.blockedT += dt
        if (this.blockedT > 3) return 'done'
      }
      const underSpan = this.brain.pet.x > w.x + 16 * u && this.brain.pet.x < w.x + w.w - 16 * u
      if (underSpan) {
        const dy = this.brain.pet.feetY - w.y
        if (dy > 50 && dy < 640) {
          this.brain.jumpWithVelocity((dy + 60) / u)
          this.phase = 'jump'
        } else if (dy <= 50) {
          return 'done'
        }
      }
      return 'running'
    }
    // 跳跃中：update 不再被调用（空中），落点纠偏移到 updateAir
    if (!this.brain.pet.airborne) return 'done'
    return 'running'
  }
  updateAir(dt: number): void {
    if (this.phase !== 'jump') return
    const w = this.brain.world.windowById(this.win.id)
    if (!w) return
    const u = this.brain.u
    if (this.brain.pet.x < w.x + 12 * u) this.brain.pet.x += 150 * u * dt
    else if (this.brain.pet.x > w.x + w.w - 12 * u) this.brain.pet.x -= 150 * u * dt
    this.brain.markPosDirty()
  }
}

export class ApproachAndSpeakGoal implements Goal {
  readonly label = nid('approachSpeak')
  private t = 0
  private said = false
  private settle = 0
  private side: 1 | -1 = 1
  constructor(
    private brain: PetBrain,
    private line: string,
  ) {}
  start(): void {
    this.t = 0
    this.said = false
    this.settle = 0
    // 绕行侧在开始时固定，避免每帧重掷导致在光标两侧左右震荡
    this.side = Math.random() < 0.5 ? -1 : 1
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    if (this.t > 10) return 'done'
    if (!this.said) {
      const u = this.brain.u
      const target = this.brain.world.cursor.x + this.side * 130 * u
      const r = this.brain.walkStep(dt, target, 95, false)
      const near = Math.abs(this.brain.pet.x - target) < 30 * u
      if (near || r === 'blocked' || this.t > 8) {
        this.said = true
        this.brain.say(this.line)
      }
      return 'running'
    }
    this.settle += dt
    this.brain.trackCursorEyes()
    return this.settle > 2.2 ? 'done' : 'running'
  }
}

export class EnterGoal implements Goal {
  readonly label = nid('enter')
  private t = 0
  private greeted = false
  private settle = 0
  constructor(private brain: PetBrain) {}
  start(): void {
    this.t = 0
    this.greeted = false
    this.settle = 0
    this.brain.setPose('WALK')
  }
  update(dt: number): 'running' | 'done' {
    this.t += dt
    if (this.t > 18) return 'done'
    if (!this.greeted) {
      const m = this.brain.world.monitorAt(this.brain.pet.x)
      const u = this.brain.u
      const target = (m ? m.wx + m.ww : 1920 * u) - 260 * u
      const r = this.brain.walkStep(dt, target, 85, false)
      const arrived = r === 'arrived' || this.t > 14
      if (arrived) {
        this.greeted = true
        this.brain.setPose('HAPPY')
        this.brain.anim.burst('heart', 5)
        this.brain.say(this.brain.pickCanned('welcome'))
      }
      return 'running'
    }
    this.settle += dt
    return this.settle > 1.6 ? 'done' : 'running'
  }
}
