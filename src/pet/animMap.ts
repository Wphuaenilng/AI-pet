// 动画选择库（参照上游 bloub 的动画目录）：「使用场景 → bloub 动画」的可配置映射。
// 纯逻辑层，可单测：默认值单源（= 整改计划 §4.3 / §9.2 原硬编码映射）+ 存档归一化，
// PetBrain 与设置面板共用，设置稀疏存储、缺省回落默认值。

import type { StateId } from './bloub/states'
import type { AgentKind } from './agentSync'

/** 可挑选的动画：bloub 目录全部，减去贴边 Mini 的两个本地姿态（peek-* 由窗口几何决定） */
export interface AnimOption {
  id: StateId
  zh: string
}

export const ANIM_OPTIONS: AnimOption[] = [
  { id: 'idle', zh: '待机呼吸' },
  { id: 'thinking', zh: '思考泡泡' },
  { id: 'wink', zh: '眨眼' },
  { id: 'wide', zh: '瞪大眼' },
  { id: 'alert', zh: '惊叹号' },
  { id: 'notify', zh: '通知角标' },
  { id: 'exclaim', zh: '感叹号' },
  { id: 'sleep', zh: '睡觉弹跳' },
  { id: 'egg', zh: '蛋形' },
  { id: 'hexagon', zh: '六边形' },
  { id: 'move', zh: '左右挪动' },
  { id: 'play', zh: '旋转三角' },
  { id: 'orbit', zh: '光环旋转' },
  { id: 'burst', zh: '爆散重组' },
  { id: 'comet', zh: '彗星' },
  { id: 'swirl', zh: '转场旋环' },
]

const ANIM_SET = new Set<string>(ANIM_OPTIONS.map((o) => o.id))

/** 动画 id 中文标签；未知 id（如手改存档）原样返回 */
export function animOptionZh(id: string): string {
  return ANIM_OPTIONS.find((o) => o.id === id)?.zh ?? id
}

/** 使用场景：宠物在"什么时候"换动画，与 PetBrain.bloubStateFor / AGENT_VISUALS 一一对应 */
export type AnimGroupId = 'act' | 'agent'

export interface AnimSlotDef {
  id: string
  zh: string
  group: AnimGroupId
  /** 默认动画（整改计划 §4.3 / §9.2 映射表的原行为） */
  def: StateId
}

export const ANIM_SLOTS: AnimSlotDef[] = [
  // 行为场景
  { id: 'idle', zh: '闲置待机', group: 'act', def: 'idle' },
  { id: 'move', zh: '走动 / 奔跑', group: 'act', def: 'move' },
  { id: 'sit', zh: '坐下', group: 'act', def: 'hexagon' },
  { id: 'lie', zh: '趴下', group: 'act', def: 'egg' },
  { id: 'sleep', zh: '睡觉', group: 'act', def: 'sleep' },
  { id: 'look', zh: '观察窗口', group: 'act', def: 'wide' },
  { id: 'play', zh: '玩耍', group: 'act', def: 'comet' },
  { id: 'happy', zh: '开心', group: 'act', def: 'wink' },
  { id: 'dance', zh: '跳舞', group: 'act', def: 'orbit' },
  { id: 'angry', zh: '生气', group: 'act', def: 'hexagon' },
  { id: 'surprised', zh: '惊讶', group: 'act', def: 'alert' },
  { id: 'think', zh: '思考 / 说话', group: 'act', def: 'thinking' },
  { id: 'jump', zh: '跳跃', group: 'act', def: 'exclaim' },
  { id: 'fall', zh: '下落 / 受惊', group: 'act', def: 'alert' },
  { id: 'drag', zh: '被拖拽', group: 'act', def: 'egg' },
  { id: 'crash', zh: '重摔重组', group: 'act', def: 'burst' },
  // 聊天感知（M6）
  { id: 'agentSession', zh: '代理接入', group: 'agent', def: 'notify' },
  { id: 'agentThinking', zh: '代理思考中', group: 'agent', def: 'thinking' },
  { id: 'agentWorking', zh: '代理工作中', group: 'agent', def: 'comet' },
  { id: 'agentFailed', zh: '代理失败', group: 'agent', def: 'hexagon' },
  { id: 'agentDone', zh: '代理完成', group: 'agent', def: 'orbit' },
]

export type AnimSlotId = (typeof ANIM_SLOTS)[number]['id']

const SLOT_BY_ID = new Map<string, AnimSlotDef>(ANIM_SLOTS.map((s) => [s.id, s]))

/** 场景 id 中文标签 */
export function animSlotZh(id: string): string {
  return SLOT_BY_ID.get(id)?.zh ?? id
}

export const ANIM_GROUPS: { id: AnimGroupId; zh: string; desc: string }[] = [
  { id: 'act', zh: '行为场景', desc: '走路、睡觉、开心这些日常动作' },
  { id: 'agent', zh: '聊天感知', desc: 'ZCode / Claude 编码代理联动' },
]

/** 默认映射（全量）：设置里未自定义的场景都回落到这里 */
export const DEFAULT_ANIMS: Record<AnimSlotId, StateId> = Object.fromEntries(
  ANIM_SLOTS.map((s) => [s.id, s.def]),
) as Record<AnimSlotId, StateId>

/** M6 聊天感知 kind → 场景（PetBrain 覆盖 AGENT_VISUALS 的 bloub 字段时用；tool-ok 与 working 同场景） */
export const AGENT_SLOT_BY_KIND: Record<AgentKind, AnimSlotId> = {
  'agent-session': 'agentSession',
  'agent-thinking': 'agentThinking',
  'agent-working': 'agentWorking',
  'agent-tool-ok': 'agentWorking',
  'agent-failed': 'agentFailed',
  'agent-done': 'agentDone',
}

/**
 * 存档里的稀疏映射 → 生效映射（全量）：丢弃未知场景与不可选的动画 id（手改
 * settings.json 弄坏也不会让渲染崩溃），其余回落默认值。
 * 校验口径 = ANIM_OPTIONS（不含 peek-* 本地姿态），而非 bloub 全部状态。
 */
export function effectiveAnimMap(raw?: Record<string, string> | null): Record<AnimSlotId, StateId> {
  const map = { ...DEFAULT_ANIMS }
  if (raw) {
    for (const [slot, anim] of Object.entries(raw)) {
      if (SLOT_BY_ID.has(slot) && ANIM_SET.has(anim)) {
        map[slot as AnimSlotId] = anim as StateId
      }
    }
  }
  return map
}
