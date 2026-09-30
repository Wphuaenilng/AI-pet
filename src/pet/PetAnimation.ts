// 动画层：把 FSM 状态 / 情绪 / 时间映射为每帧渲染参数
import type { ExprKind } from './PetState'
import type { Face, MouthKind, Particle, Pose, PoseKind, Species, EyeState } from './PetRenderer'
import type { PetFsmState } from '../behavior/StateMachine'

export class PetAnimation {
  walkPhase = 0
  tailPhase = 0
  breathe = 0
  talkT = 0
  squash = 0
  eyeClosed = 0
  headTilt = 0
  particles: Particle[] = []
  private blinkIn = 2 + Math.random() * 2
  private blinkT = 0
  private zzzCd = 0
  private winkCd = 3 + Math.random() * 4
  private winkT = 0

  burst(kind: Particle['kind'], n = 4): void {
    if (this.particles.length > 28) return
    for (let i = 0; i < n; i++) {
      this.particles.push({
        kind,
        x: (Math.random() - 0.5) * 60,
        y: -140 - Math.random() * 30,
        vx: (Math.random() - 0.5) * 22,
        vy: kind === 'zzz' ? -14 - Math.random() * 10 : -26 - Math.random() * 18,
        life: kind === 'zzz' ? 2.4 : 1.5,
        max: kind === 'zzz' ? 2.4 : 1.5,
        size: kind === 'zzz' ? 16 + Math.random() * 8 : 14 + Math.random() * 6,
      })
    }
  }

  poseFor(state: PetFsmState, airborne: boolean): PoseKind {
    if (airborne) return state === 'DRAG' ? 'hang' : 'jump'
    switch (state) {
      case 'WALK':
      case 'RUN':
      case 'ENTER':
        return 'walk'
      case 'SIT':
        return 'sit'
      case 'LAY':
        return 'lay'
      case 'SLEEP':
        return 'sleep'
      case 'DRAG':
        return 'hang'
      case 'JUMP':
        return 'jump'
      default:
        return 'stand'
    }
  }

  faceFor(input: {
    expr: ExprKind
    state: PetFsmState
    talking: boolean
    eyeDX: number
    eyeDY: number
  }): Face {
    let eyes: EyeState = 'open'
    let mouth: MouthKind = 'cat'
    let blush = 0

    if (input.state === 'SLEEP') {
      eyes = 'closed'
      mouth = 'flat'
    } else if (input.state === 'DRAG' || input.state === 'FALL') {
      eyes = 'surprised'
      mouth = 'o'
    } else if (input.state === 'ANGRY') {
      eyes = 'angry'
      mouth = 'flat'
    } else {
      switch (input.expr) {
        case 'happy':
          // 开心时偶尔眨单眼卖个萌
          eyes = this.winkT > 0 ? 'wink' : 'happy'
          mouth = 'cat'
          blush = 1
          break
        case 'sad':
          eyes = 'sad'
          mouth = 'frown'
          break
        case 'angry':
          eyes = 'angry'
          mouth = 'flat'
          break
        case 'surprised':
          eyes = 'surprised'
          mouth = 'o'
          break
        case 'sleepy':
          eyes = 'sleepy'
          mouth = 'flat'
          break
        case 'concern':
          // 担忧/关切：耷拉眼 + 抿嘴，与 sad 的区别是不撇嘴角
          eyes = 'sad'
          mouth = 'flat'
          break
        default:
          eyes = 'open'
          mouth = 'smile'
      }
      if (input.state === 'PLAY' || input.state === 'HAPPY') {
        eyes = 'happy'
        blush = 1
      }
      if (input.state === 'JUMP') mouth = 'o'
    }

    if (input.talking && input.state !== 'SLEEP' && input.state !== 'DRAG') {
      mouth = 'open'
    }

    return { eyes, eyeDX: input.eyeDX, eyeDY: input.eyeDY, mouth, blush, talk: input.talking ? 1 : 0 }
  }

  update(
    dt: number,
    input: {
      state: PetFsmState
      moving: boolean
      speed: number
      expr: ExprKind
      talking: boolean
      eyeDX: number
      eyeDY: number
      headTiltTarget: number
    },
  ): void {
    this.breathe += dt * 2.4
    this.tailPhase += dt * (input.state === 'HAPPY' || input.state === 'PLAY' ? 7 : 2.6)
    if (input.moving) this.walkPhase += dt * (input.speed > 150 ? 13 : 8.5)
    this.squash = Math.max(0, this.squash - dt * 3.2)
    this.headTilt += (input.headTiltTarget - this.headTilt) * Math.min(1, dt * 8)

    // 眨眼
    if (input.state === 'SLEEP') {
      this.eyeClosed = 1
    } else {
      this.blinkIn -= dt
      if (this.blinkIn <= 0) {
        this.blinkT = 0.14
        this.blinkIn = 2.2 + Math.random() * 2.8
      }
      if (this.blinkT > 0) {
        this.blinkT -= dt
        this.eyeClosed = Math.min(1, this.blinkT / 0.07)
      } else {
        this.eyeClosed = 0
      }
    }

    // 说话口型
    if (input.talking) this.talkT += dt * 9
    else this.talkT = 0

    // 开心时偶尔眨单眼（wink）
    if (input.expr === 'happy' && !input.moving) {
      this.winkCd -= dt
      if (this.winkCd <= 0) {
        this.winkT = 0.3
        this.winkCd = 4 + Math.random() * 5
      }
    }
    if (this.winkT > 0) this.winkT -= dt

    // 睡觉 Zzz
    if (input.state === 'SLEEP') {
      this.zzzCd -= dt
      if (this.zzzCd <= 0) {
        this.burst('zzz', 1)
        this.zzzCd = 1.1
      }
    }

    // 粒子更新
    for (const pt of this.particles) {
      pt.life -= dt
      pt.x += pt.vx * dt
      pt.y += pt.vy * dt
      pt.vx *= 1 - dt * 0.4
    }
    this.particles = this.particles.filter((pt) => pt.life > 0).slice(-28)
  }

  compose(arg: {
    state: PetFsmState
    pose: PoseKind
    species: Species
    u: number
    cx: number
    feetY: number
    facing: 1 | -1
    expr: ExprKind
    moving: boolean
    speed: number
    eyeDX: number
    eyeDY: number
  }): Pose {
    const talking = this.talkT > 0 && Math.sin(this.talkT) > 0
    return {
      species: arg.species,
      u: arg.u,
      cx: arg.cx,
      feetY: arg.feetY,
      facing: arg.facing,
      pose: arg.pose,
      walkPhase: this.walkPhase,
      breathe: this.breathe,
      tailPhase: this.tailPhase,
      headTilt: this.headTilt,
      face: this.faceFor({
        expr: arg.expr,
        state: arg.state,
        talking,
        eyeDX: arg.eyeDX,
        eyeDY: arg.eyeDY,
      }),
      squash: this.squash,
      particles: this.particles,
      eyeClosed: this.eyeClosed,
    }
  }
}
