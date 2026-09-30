// 宠物状态机：所有行为必须经过这里约束（AI 也只能提出意图）
export type PetFsmState =
  | 'IDLE'
  | 'WALK'
  | 'RUN'
  | 'SIT'
  | 'LAY'
  | 'SLEEP'
  | 'LOOK'
  | 'PLAY'
  | 'DRAG'
  | 'HAPPY'
  | 'ANGRY'
  | 'SURPRISED'
  | 'TALK'
  | 'ENTER'
  | 'JUMP'
  | 'FALL'

const ALLOWED: Record<PetFsmState, PetFsmState[]> = {
  IDLE: ['WALK', 'RUN', 'SIT', 'LAY', 'SLEEP', 'LOOK', 'PLAY', 'HAPPY', 'ANGRY', 'ENTER', 'TALK', 'SURPRISED'],
  WALK: ['RUN', 'IDLE', 'SIT', 'LAY', 'SLEEP', 'JUMP', 'LOOK', 'PLAY', 'TALK', 'SURPRISED', 'ENTER', 'HAPPY'],
  RUN: ['WALK', 'IDLE', 'SIT', 'LAY', 'SLEEP', 'JUMP', 'TALK', 'SURPRISED'],
  SIT: ['IDLE', 'LAY', 'SLEEP', 'TALK', 'SURPRISED', 'HAPPY', 'WALK'],
  LAY: ['IDLE', 'SLEEP', 'SIT', 'TALK', 'SURPRISED', 'WALK'],
  SLEEP: ['IDLE', 'TALK', 'SURPRISED', 'WALK'],
  LOOK: ['IDLE', 'WALK', 'PLAY', 'TALK', 'SURPRISED', 'SIT'],
  PLAY: ['IDLE', 'WALK', 'RUN', 'TALK', 'SURPRISED', 'HAPPY'],
  HAPPY: ['IDLE', 'PLAY', 'TALK', 'SURPRISED', 'WALK', 'JUMP'],
  ANGRY: ['IDLE', 'TALK'],
  SURPRISED: ['IDLE', 'LOOK', 'TALK', 'HAPPY', 'WALK'],
  TALK: ['IDLE', 'LOOK', 'SIT', 'HAPPY', 'SURPRISED', 'WALK', 'SLEEP'],
  ENTER: ['IDLE', 'WALK', 'HAPPY', 'TALK'],
  JUMP: ['IDLE', 'SIT', 'WALK', 'SURPRISED', 'PLAY', 'FALL'],
  FALL: ['IDLE', 'SURPRISED', 'SIT', 'JUMP'],
  DRAG: ['IDLE', 'FALL', 'JUMP', 'SURPRISED'],
}

export class StateMachine {
  current: PetFsmState = 'ENTER'
  since = 0
  onChange?: (s: PetFsmState, prev: PetFsmState) => void

  set(to: PetFsmState, now: number): boolean {
    if (to === this.current) return true
    const ok = to === 'DRAG' || (ALLOWED[this.current] ?? []).includes(to)
    if (!ok) return false
    const prev = this.current
    this.current = to
    this.since = now
    this.onChange?.(to, prev)
    return true
  }

  /** 跳过约束强制切换（拖拽抢占等物理场景） */
  force(to: PetFsmState, now: number): void {
    if (to === this.current) return
    const prev = this.current
    this.current = to
    this.since = now
    this.onChange?.(to, prev)
  }

  timeIn(now: number): number {
    return now - this.since
  }
}
