import { describe, expect, it } from 'vitest'
import { DRAG_FEEDBACK_TAG, shouldPeekMiniForOverlay, type MiniOverlayState } from './miniEdge'

function state(overrides: Partial<MiniOverlayState> = {}): MiniOverlayState {
  return {
    approvalVisible: false,
    streaming: false,
    bubbleVisible: false,
    bubbleTag: null,
    agentMessageCount: 0,
    ...overrides,
  }
}

describe('贴边 Mini 的消息探出规则', () => {
  it('拖拽反馈不触发探出，松手后可以保持贴边', () => {
    expect(
      shouldPeekMiniForOverlay(
        state({ bubbleVisible: true, bubbleTag: DRAG_FEEDBACK_TAG }),
      ),
    ).toBe(false)
  })

  it('普通消息、流式聊天、Agent 消息和审批仍触发探出', () => {
    expect(shouldPeekMiniForOverlay(state({ bubbleVisible: true }))).toBe(true)
    expect(shouldPeekMiniForOverlay(state({ streaming: true }))).toBe(true)
    expect(shouldPeekMiniForOverlay(state({ agentMessageCount: 1 }))).toBe(true)
    expect(shouldPeekMiniForOverlay(state({ approvalVisible: true }))).toBe(true)
  })

  it('没有覆盖层时保持缩起', () => {
    expect(shouldPeekMiniForOverlay(state())).toBe(false)
  })
})
