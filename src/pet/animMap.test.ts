import { describe, expect, it } from 'vitest'
import {
  AGENT_SLOT_BY_KIND,
  ANIM_OPTIONS,
  ANIM_SLOTS,
  DEFAULT_ANIMS,
  effectiveAnimMap,
} from './animMap'
import { AGENT_KINDS } from './agentSync'

describe('动画选择库', () => {
  it('默认映射与原硬编码行为一致（§4.3 / §9.2）', () => {
    expect(DEFAULT_ANIMS.idle).toBe('idle')
    expect(DEFAULT_ANIMS.move).toBe('move')
    expect(DEFAULT_ANIMS.sit).toBe('hexagon')
    expect(DEFAULT_ANIMS.lie).toBe('egg')
    expect(DEFAULT_ANIMS.sleep).toBe('sleep')
    expect(DEFAULT_ANIMS.look).toBe('wide')
    expect(DEFAULT_ANIMS.play).toBe('comet')
    expect(DEFAULT_ANIMS.happy).toBe('wink')
    expect(DEFAULT_ANIMS.dance).toBe('orbit')
    expect(DEFAULT_ANIMS.angry).toBe('hexagon')
    expect(DEFAULT_ANIMS.surprised).toBe('alert')
    expect(DEFAULT_ANIMS.think).toBe('thinking')
    expect(DEFAULT_ANIMS.jump).toBe('exclaim')
    expect(DEFAULT_ANIMS.fall).toBe('alert')
    expect(DEFAULT_ANIMS.drag).toBe('egg')
    expect(DEFAULT_ANIMS.crash).toBe('burst')
    expect(DEFAULT_ANIMS.agentSession).toBe('notify')
    expect(DEFAULT_ANIMS.agentThinking).toBe('thinking')
    expect(DEFAULT_ANIMS.agentWorking).toBe('comet')
    expect(DEFAULT_ANIMS.agentFailed).toBe('hexagon')
    expect(DEFAULT_ANIMS.agentDone).toBe('orbit')
  })

  it('场景数与分组：16 行为场景 + 5 聊天感知', () => {
    expect(ANIM_SLOTS).toHaveLength(21)
    expect(ANIM_SLOTS.filter((s) => s.group === 'act')).toHaveLength(16)
    expect(ANIM_SLOTS.filter((s) => s.group === 'agent')).toHaveLength(5)
  })

  it('动画选项 = bloub 目录去掉 peek 本地姿态', () => {
    const ids = ANIM_OPTIONS.map((o) => o.id)
    expect(ids).not.toContain('peek-left')
    expect(ids).not.toContain('peek-right')
    expect(ids).toContain('thinking')
    expect(ids).toContain('swirl')
  })

  it('每个场景默认值都在可选项里', () => {
    const ids = new Set(ANIM_OPTIONS.map((o) => o.id))
    for (const s of ANIM_SLOTS) expect(ids.has(s.def), s.id).toBe(true)
  })

  it('effectiveAnimMap：丢弃未知场景/动画，缺省回落默认', () => {
    const map = effectiveAnimMap({
      think: 'comet',
      bogusSlot: 'idle',
      idle: 'not-a-state',
      sleep: 'sleep',
    })
    expect(map.think).toBe('comet')
    expect(map.idle).toBe(DEFAULT_ANIMS.idle)
    expect(map.sleep).toBe('sleep')
    expect(map.agentDone).toBe('orbit')
  })

  it('effectiveAnimMap(null) 即全默认', () => {
    expect(effectiveAnimMap(null)).toEqual(DEFAULT_ANIMS)
  })

  it('effectiveAnimMap 拒绝 peek 本地姿态（不在可选库内，手改存档也不生效）', () => {
    const map = effectiveAnimMap({ idle: 'peek-left', sit: 'peek-right' })
    expect(map.idle).toBe(DEFAULT_ANIMS.idle)
    expect(map.sit).toBe(DEFAULT_ANIMS.sit)
  })

  it('AGENT_SLOT_BY_KIND 覆盖全部 kind，tool-ok 与 working 同场景', () => {
    expect(AGENT_KINDS.every((k) => k in AGENT_SLOT_BY_KIND)).toBe(true)
    expect(AGENT_SLOT_BY_KIND['agent-tool-ok']).toBe(AGENT_SLOT_BY_KIND['agent-working'])
    expect(AGENT_SLOT_BY_KIND['agent-session']).toBe('agentSession')
  })
})
