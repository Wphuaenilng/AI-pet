// 极简行为树：Selector / Sequence / Condition / Action
import type { Goal } from './behaviors/goals'

export type BtStatus = 'success' | 'failure'
export type BtResult = BtStatus | Goal

/* eslint-disable @typescript-eslint/no-explicit-any */
export abstract class BtNode {
  abstract tick(ctx: any): BtResult
}

export class Selector extends BtNode {
  constructor(private children: BtNode[]) {
    super()
  }
  tick(ctx: any): BtResult {
    for (const c of this.children) {
      const r = c.tick(ctx)
      // Sequence 返回 'success' 表示条件满足但内部未产出 Goal，
      // 继续看后续分支，不要把 'success' 冒泡给外层 Selector
      if (r === 'failure' || r === 'success') continue
      return r
    }
    return 'failure'
  }
}

export class Sequence extends BtNode {
  constructor(private children: BtNode[]) {
    super()
  }
  tick(ctx: any): BtResult {
    for (const c of this.children) {
      const r = c.tick(ctx)
      if (r === 'failure') return 'failure'
    }
    return 'success'
  }
}

export class Cond extends BtNode {
  constructor(private fn: (ctx: any) => boolean) {
    super()
  }
  tick(ctx: any): BtStatus {
    return this.fn(ctx) ? 'success' : 'failure'
  }
}

export class Act extends BtNode {
  constructor(private fn: (ctx: any) => Goal | null) {
    super()
  }
  tick(ctx: any): BtResult {
    const g = this.fn(ctx)
    return g ?? 'failure'
  }
}
