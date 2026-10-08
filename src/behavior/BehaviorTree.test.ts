// 行为树语义单测：锁死 Selector/Sequence 对 Goal 与状态值的传递规则。
// B1 回归：Sequence 曾把子 Act 产出的 Goal 吞成 'success'，规划器退化成只会发呆。
import { describe, expect, it } from 'vitest'
import { Act, Cond, Selector, Sequence } from './BehaviorTree'
import type { Goal } from './behaviors/goals'

function fakeGoal(label: string): Goal {
  return {
    label,
    start() {},
    update() {
      return 'done'
    },
  }
}

describe('BehaviorTree', () => {
  it('Sequence：条件满足时子 Act 的 Goal 向上冒泡（B1 回归）', () => {
    const goal = fakeGoal('sleep#1')
    const tree = new Sequence([new Cond(() => true), new Act(() => goal)])
    expect(tree.tick({})).toBe(goal)
  })

  it('Sequence：条件不满足返回 failure，不执行语义（Act 不会被求值到 Goal）', () => {
    const tree = new Sequence([new Cond(() => false), new Act(() => fakeGoal('x'))])
    expect(tree.tick({})).toBe('failure')
  })

  it('Sequence：Act 返回 null 视为 failure', () => {
    const tree = new Sequence([new Cond(() => true), new Act(() => null)])
    expect(tree.tick({})).toBe('failure')
  })

  it('Selector：跳过未命中分支，返回第一个产出 Goal 的分支', () => {
    const goal = fakeGoal('dance#1')
    const tree = new Selector([
      new Sequence([new Cond(() => false), new Act(() => fakeGoal('a'))]),
      new Sequence([new Cond(() => true), new Act(() => goal)]),
      new Act(() => fakeGoal('b')),
    ])
    expect(tree.tick({})).toBe(goal)
  })

  it('Selector：全部未命中返回 failure', () => {
    const tree = new Selector([new Cond(() => false), new Act(() => null)])
    expect(tree.tick({})).toBe('failure')
  })

  it('嵌套：Selector 包在 Sequence 里时，内层产出的 Goal 能穿过外层 Sequence', () => {
    const goal = fakeGoal('look#1')
    const tree = new Sequence([
      new Cond(() => true),
      new Selector([
        new Sequence([new Cond(() => false), new Act(() => fakeGoal('chase'))]),
        new Act(() => goal),
      ]),
    ])
    expect(tree.tick({})).toBe(goal)
  })
})
