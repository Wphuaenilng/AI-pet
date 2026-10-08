// 行为权重表（附录 B7/B8）：pickRandomBehavior 的唯一可调源。
// 动机值直接调制权重——饿/困/无聊改变行为倾向，替代旧的硬编码概率区间。
import type { EmotionValues } from '../pet/PetState'

export type BehaviorKind =
  | 'wander'
  | 'sit'
  | 'lay'
  | 'sleep'
  | 'climb'
  | 'idle'
  | 'look'
  | 'selfTalk'
  | 'dance'

export interface BehaviorWeight {
  kind: BehaviorKind
  weight: number
}

export function behaviorWeights(v: EmotionValues): BehaviorWeight[] {
  const hungry = v.hunger < 25
  const sleepy = v.energy < 35
  return [
    // 无聊越多越想出去逛，饿着没心情逛
    { kind: 'wander', weight: 0.36 * (1 + v.boredom / 80) * (hungry ? 0.5 : 1) },
    { kind: 'sit', weight: 0.13 },
    { kind: 'lay', weight: 0.09 },
    // 困了优先睡：精力越低权重越高，饿着也睡不踏实
    {
      kind: 'sleep',
      weight:
        0.07 * (1 + (100 - v.energy) / 40) * (hungry ? 0.4 : 1) + (sleepy ? 0.22 : 0),
    },
    { kind: 'climb', weight: 0.12 * (1 + v.curiosity / 120) },
    { kind: 'idle', weight: 0.06 },
    { kind: 'look', weight: 0.06 * (1 + v.curiosity / 100) },
    { kind: 'selfTalk', weight: 0.06 },
    // 饿着没心情跳舞，开心了才爱跳
    { kind: 'dance', weight: 0.05 * (hungry ? 0.3 : 1) * (1 + v.happiness / 150) },
  ]
}

export function pickWeighted(list: BehaviorWeight[]): BehaviorWeight {
  const total = list.reduce((s, x) => s + x.weight, 0)
  let r = Math.random() * total
  for (const item of list) {
    r -= item.weight
    if (r <= 0) return item
  }
  return list[list.length - 1]
}
