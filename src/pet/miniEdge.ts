/** 拖拽过程中的即时反馈不应抵消用户刚刚执行的贴边操作。 */
export const DRAG_FEEDBACK_TAG = 'drag-feedback'

export interface MiniOverlayState {
  approvalVisible: boolean
  streaming: boolean
  bubbleVisible: boolean
  bubbleTag: string | null
  agentMessageCount: number
}

/** 新消息、Agent 消息和审批需要探出；拖拽反馈允许宠物保持贴边。 */
export function shouldPeekMiniForOverlay(state: MiniOverlayState): boolean {
  return Boolean(
    state.approvalVisible ||
      state.streaming ||
      (state.bubbleVisible && state.bubbleTag !== DRAG_FEEDBACK_TAG) ||
      state.agentMessageCount > 0,
  )
}
