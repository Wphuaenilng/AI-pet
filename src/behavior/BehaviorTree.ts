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
      // 只在拿到 Goal 时收手；'failure' 换下一个分支，
      // 'success'（纯条件 Sequence）也不产出目标，同样继续
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
      // 条件满足后子 Act 产出的 Goal 必须向上冒泡，
      // 否则会被下面的 return 'success' 吞掉（附录 B1：曾导致规划器所有
      // Sequence 分支的目标丢失，宠物退化成只会发呆）
      if (r !== 'success') return r
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
