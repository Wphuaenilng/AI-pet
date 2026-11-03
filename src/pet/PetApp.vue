<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { PetBrain, type BloubPayload, type BubbleState, type PetMenuState } from './PetBrain'
import PetBot from './bloub/PetBot.vue'
import { DEMI_VIEWBOX, RAYON } from './bloub/repere'
import PetAtlas from './PetAtlas.vue'
import { ATLAS_H, DOT_R } from './metrics'
import { getLabel, invoke, isTauri, listen } from '../lib/tauri'
import type { AgentMessage } from './agentSync'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const bubble = ref<BubbleState>({ visible: false, text: '', bottom: 0 })
const menu = ref<PetMenuState>(null)
const brain = ref<PetBrain | null>(null)
const preview = !isTauri
const mockWindow = ref<{ x: number; y: number; w: number; h: number } | null>(null)
// M6 并发代理消息：独立列表，不与普通单气泡混用
const agentMessages = ref<AgentMessage[]>([])
const agentCollapsed = ref(false)
const bubbleHeight = ref(0)
// 数据仍分属普通聊天与代理中心，但视觉上共用一条纵向消息列，避免互相遮盖。
const agentBottom = computed(
  () => Math.max(bubble.value.bottom, 90) + (bubble.value.visible ? bubbleHeight.value + 8 : 0),
)
const contentOffset = computed(() => bubble.value.offsetX ?? 0)
const contentTransform = computed(
  () => `translateX(calc(-50% + ${contentOffset.value}px))`,
)
const agentControlSide = computed(() => bubble.value.controlSide ?? 'right')
// M5 审批横幅（Claude Code hooks / HTTP 桥发起，快捷键 Y/N 或按钮决策）
const approval = ref<{ id: string; title: string; detail?: string } | null>(null)
let approvalUnlisten: (() => void) | null = null

function decide(decision: 'allowed' | 'denied') {
  if (!approval.value) return
  void invoke('approval_decide', { id: approval.value.id, decision })
}

// 横幅显隐时把它的 css 矩形同步给 brain：窗口命中判定放行该区域，
// 否则横幅渲染在点击穿透的窗口上，按钮看得见点不着
watch(approval, async (v) => {
  if (!v) {
    brain.value?.setApprovalRect(null)
    return
  }
  await nextTick()
  const el = document.querySelector('.approval')
  if (!el) return
  const r = el.getBoundingClientRect()
  brain.value?.setApprovalRect({ x: r.x, y: r.y, w: r.width, h: r.height })
})

// 同步命中区域，并按内容实际高度让原生透明窗口向上扩展，而非裁掉顶部。
watch([agentMessages, agentCollapsed, bubble, agentBottom], async () => {
  await nextTick()
  const bubbleEl = document.querySelector('.bubble')
  const bubbleRect = bubbleEl && bubble.value.visible ? bubbleEl.getBoundingClientRect() : null
  const nextBubbleHeight = bubbleRect?.height ?? 0
  if (Math.abs(nextBubbleHeight - bubbleHeight.value) > 0.5) {
    bubbleHeight.value = nextBubbleHeight
  }
  const elements = document.querySelectorAll('.agent-center, .agent-toggle')
  if (!elements.length || agentMessages.value.length === 0) {
    brain.value?.setAgentRect(null)
  } else {
    const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
    elements.forEach((el) => {
      const r = el.getBoundingClientRect()
      bounds.left = Math.min(bounds.left, r.left)
      bounds.top = Math.min(bounds.top, r.top)
      bounds.right = Math.max(bounds.right, r.right)
      bounds.bottom = Math.max(bounds.bottom, r.bottom)
    })
    brain.value?.setAgentRect({
      x: bounds.left,
      y: bounds.top,
      w: bounds.right - bounds.left,
      h: bounds.bottom - bounds.top,
    })
  }
  let requiredWidth = 0
  let requiredHeight = 0
  const viewportCenter = window.innerWidth / 2
  const includeWidth = (el: Element) => {
    const r = el.getBoundingClientRect()
    // 以宠物水平中心对称扩窗，确保向屏幕内侧偏移后的内容仍在原生窗口内。
    requiredWidth = Math.max(
      requiredWidth,
      2 * Math.max(Math.abs(r.left - viewportCenter), Math.abs(r.right - viewportCenter)) + 16,
    )
  }
  const center = document.querySelector('.agent-center')
  if (center && !agentCollapsed.value) {
    includeWidth(center)
    requiredHeight = agentBottom.value + center.getBoundingClientRect().height + 8
  }
  // v-if 离场动画期间节点仍存在；不可见气泡不能阻止原生窗口恢复基础尺寸。
  if (bubbleEl && bubbleRect) {
    includeWidth(bubbleEl)
    requiredHeight = Math.max(requiredHeight, bubble.value.bottom + bubbleRect.height + 8)
  }
  brain.value?.setOverlaySize(requiredWidth, requiredHeight)
})

// 渲染通道（PetBrain 回调驱动）：bloub 程序化 SVG 或 Petdex 图集
const botRef = ref<InstanceType<typeof PetBot> | null>(null)
const bloub = ref<BloubPayload>({
  state: 'idle',
  expr: 'attentif',
  scale: 1,
  shape: 'cercle',
  color: 'encre',
  pack: '',
  packSheet: '',
  row: 'idle'
})
const agentToggleBottom = computed(
  () => 8 * bloub.value.scale + ((bloub.value.pack ? ATLAS_H : DOT_R * 2) * bloub.value.scale) / 2,
)
/** 黑点半径取 metrics.DOT_R；SVG 需容纳轨道环（DEMI_VIEWBOX/RAYON 倍） */
const botSize = computed(
  () => Math.round((2 * DEMI_VIEWBOX * DOT_R * bloub.value.scale) / RAYON)
)
const botBottom = computed(
  () => (8 - ((DEMI_VIEWBOX - RAYON) * DOT_R) / RAYON) * bloub.value.scale
)
/** Petdex 图集显示高度取 metrics.ATLAS_H（帧比例 192:208，竖版），脚底贴 PAD_BOTTOM */
const atlasWrap = computed(() => {
  const s = bloub.value.scale
  return {
    width: Math.round((ATLAS_H * s * 192) / 208) + 'px',
    height: Math.round(ATLAS_H * s) + 'px',
    bottom: Math.round(8 * s) + 'px'
  }
})
const botWrap = computed(() =>
  bloub.value.pack
    ? atlasWrap.value
    : {
        width: botSize.value + 'px',
        height: botSize.value + 'px',
        bottom: botBottom.value + 'px'
      }
)
// Petdex 没有专用趴边帧：缩起时把整只转向屏幕内侧，头部探出、身体藏在屏外。
// bloub 通道使用引擎自己的 peek-left/right 姿态，不叠加这个 CSS 动作。
const miniAtlasClass = computed(() => {
  if (!bloub.value.pack) return ''
  if (bloub.value.state === 'peek-left') return 'mini-peek-left'
  if (bloub.value.state === 'peek-right') return 'mini-peek-right'
  return ''
})
const atlasUrl = computed(() =>
  bloub.value.pack ? convertFileSrc(bloub.value.packSheet) : ''
)

// HMR 重跑 setup 时不会触发卸载钩子，而模块级变量又会随模块重建归零：
// 只有挂在 window 上的引用能跨过热更新看见上一个 brain，防止多 brain 抢同一个窗口
const host = window as unknown as { __petBrain?: PetBrain }

onMounted(() => {
  if (!canvasRef.value) return
  // 只有宠物窗口（或浏览器预览）才启动大脑，防止 settings/chat 窗口重复启动
  if (isTauri && getLabel() !== 'pet') return
  if (isTauri) {
    void listen<{ id: string; title: string; detail?: string } | null>(
      'pet://approval',
      (p) => (approval.value = p),
    ).then((un) => (approvalUnlisten = un))
  }
  host.__petBrain?.stop()
  const b = new PetBrain(
    canvasRef.value,
    (s) => (bubble.value = { ...s }),
    undefined,
    (m) => (menu.value = m),
    (p) => (bloub.value = p),
    (messages) => {
      agentMessages.value = messages
      if (messages.length === 0) agentCollapsed.value = false
    }
  )
  brain.value = b
  // 全局视线：PetBrain 每帧把光标方向注入 bloub 引擎
  b.gazeTarget = (nx, ny, pointer) => botRef.value?.setGaze(nx, ny, pointer)
  brain.value = b
  // 调试入口（仅预览/开发模式暴露，不进生产包）
  if (preview || import.meta.env.DEV) {
    host.__petBrain = b
  }
  b.start()
    .then(() => {
      const w = b.world.windows[0]
      if (w && preview) mockWindow.value = { x: w.x, y: w.y, w: w.w, h: w.h }
    })
    .catch((e) => console.error('PetBrain 启动失败', e))
})

// 热更新或窗口重建时旧 brain 的 rAF 与鼠标轮询不会自己停下：
// 多个 brain 同时驱动同一个 OS 窗口，表现为拖拽闪烁、行为开关"关不掉"
onBeforeUnmount(() => {
  brain.value?.stop()
  if (host.__petBrain === brain.value) host.__petBrain = undefined
  brain.value = null
  approvalUnlisten?.()
})

function dbg(name: 'sleep' | 'wander' | 'climb' | 'dance' | 'pat') {
  brain.value?.debug[name]()
}
function sayHi() {
  brain.value?.say('你好呀！我是住在你桌面上的小家伙～')
}
function menuSettings() {
  brain.value?.closeMenu()
  if (isTauri) void invoke('show_window', { label: 'settings' }).catch(() => {})
}
function menuHidePet() {
  brain.value?.closeMenu()
  // 只隐藏窗口：进程和情绪/位置/记忆都留在内存里，托盘「召唤」可原地唤回
  if (isTauri) void invoke('hide_window', { label: 'pet' }).catch(() => {})
}
</script>

<template>
  <div class="pet-root">
    <div
      v-if="preview && mockWindow"
      class="mock-window"
      :style="{ left: mockWindow.x + 'px', top: mockWindow.y + 'px', width: mockWindow.w + 'px', height: mockWindow.h + 'px' }"
    >
      <span>VS Code — 假窗口（演示用）</span>
    </div>
    <!-- 渲染通道：Petdex 图集（条件渲染）或 bloub 身体（SVG），垫在 Canvas 之下；Canvas 只画粒子 -->
    <div class="pet-bot" :class="miniAtlasClass" :style="botWrap">
      <PetAtlas
        v-if="bloub.pack"
        :sheet-url="atlasUrl"
        :row="bloub.row"
        :height-px="Math.round(ATLAS_H * bloub.scale)"
      />
      <PetBot
        v-else
        ref="botRef"
        :size="botSize"
        v-model:state="bloub.state"
        :shape="bloub.shape"
        :color="bloub.color"
        :expression="bloub.expr"
        paper="#ffffff"
      />
    </div>
    <canvas ref="canvasRef" class="pet-canvas" />
    <transition name="bubble-pop">
      <div
        v-if="bubble.visible"
        class="bubble"
        :style="{ bottom: bubble.bottom + 'px', transform: contentTransform }"
      >
        {{ bubble.text }}
      </div>
    </transition>

    <!-- 消息向上自然排列，最新一条最靠近宠物；圆钮始终留在宠物身侧。 -->
    <div
      v-if="agentMessages.length"
      class="agent-center"
      :style="{ bottom: agentBottom + 'px', transform: contentTransform }"
    >
      <div v-show="!agentCollapsed" class="agent-list">
        <div
          v-for="m in agentMessages"
          :key="m.id"
          class="agent-message"
          :class="m.source"
        >
          {{ m.text }}
        </div>
      </div>
    </div>
    <button
      v-if="agentMessages.length"
      type="button"
      class="agent-toggle"
      :class="agentControlSide"
      :style="{ bottom: agentToggleBottom + 'px' }"
      :aria-label="agentCollapsed ? '展开代理消息' : '收起代理消息'"
      @click="agentCollapsed = !agentCollapsed"
    >
      <span v-if="agentCollapsed" class="agent-count">{{ agentMessages.length }}</span>
      <span v-else class="agent-chevron">⌄</span>
    </button>

    <!-- M5 审批横幅：编码代理等待审批时弹出，快捷键 Y/N 或按钮决策 -->
    <div v-if="approval" class="approval">
      <div class="approval-title">{{ approval.title }}</div>
      <div v-if="approval.detail" class="approval-detail">{{ approval.detail }}</div>
      <div class="approval-actions">
        <button @click="decide('allowed')">允许 (Y)</button>
        <button @click="decide('denied')">拒绝 (N)</button>
      </div>
    </div>

    <!-- 右键自定义菜单：替代 WebView2 自带的"复制图像"菜单 -->
    <div v-if="menu" class="pet-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
      <button @click="menuSettings">进入设置</button>
      <button @click="menuHidePet">关闭</button>
    </div>

    <div v-if="preview" class="preview-bar">
      <span class="preview-title">预览模式</span>
      <button @click="sayHi">说话</button>
      <button @click="dbg('pat')">摸摸</button>
      <button @click="dbg('sleep')">睡觉</button>
      <button @click="dbg('wander')">走两步</button>
      <button @click="dbg('climb')">跳上窗口</button>
      <button @click="dbg('dance')">跳舞</button>
    </div>
  </div>
</template>

<style scoped>
.pet-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: transparent;
}
.pet-bot {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  transform-origin: 50% 50%;
  transition: transform 0.28s ease;
  pointer-events: none; /* 点击全部交给 Canvas 层 */
  z-index: 0;
}
/* 右缘头朝左、左缘头朝右；轻微缩小避免旋转后的图集越出宠物窗口 */
.pet-bot.mini-peek-right {
  transform: translateX(-50%) rotate(-90deg) scale(0.88);
}
.pet-bot.mini-peek-left {
  transform: translateX(-50%) rotate(90deg) scale(0.88);
}
.pet-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
  user-select: none;
  -webkit-user-drag: none;
  z-index: 1;
}
.bubble {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  /* 380 是目标宽度，但缩到 0.5x 时窗口只有 280 CSS px，
     不夹一下会被 .pet-root 的 overflow:hidden 裁掉 */
  max-width: min(380px, calc(100vw - 12px));
  padding: 5px 9px;
  background: #fff;
  border: 1.5px solid rgba(255, 122, 89, 0.35);
  border-radius: 14px;
  box-shadow: 0 4px 14px rgba(90, 60, 40, 0.18);
  color: #3d2e26;
  font-size: 12.5px;
  line-height: 1.5;
  text-align: center;
  word-break: break-word;
}
.agent-center {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  z-index: 25;
  width: min(360px, calc(100vw - 16px));
  pointer-events: auto;
}
.agent-toggle {
  position: absolute;
  z-index: 26;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid rgba(110, 100, 92, 0.18);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.97);
  box-shadow: 0 3px 10px rgba(60, 50, 45, 0.18);
  color: #746860;
  cursor: pointer;
  pointer-events: auto;
}
.agent-toggle.left {
  left: calc(50% - 88px);
}
.agent-toggle.right {
  left: calc(50% + 58px);
}
.agent-toggle:hover {
  border-color: #9b8578;
  background: #fff;
}
.agent-count {
  font-size: 12px;
  font-weight: 600;
}
.agent-chevron {
  margin-top: -4px;
  font-size: 22px;
  line-height: 1;
}
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: visible;
}
.agent-message {
  padding: 7px 11px;
  border: 1.5px solid;
  border-radius: 12px;
  box-shadow: 0 4px 12px rgba(60, 50, 45, 0.16);
  font-size: 12.5px;
  line-height: 1.45;
  text-align: left;
  word-break: break-word;
}
.agent-message.zcode {
  color: #24547d;
  background: rgba(235, 246, 255, 0.97);
  border-color: #77b5e8;
}
.agent-message.claude {
  color: #8a4a25;
  background: rgba(255, 243, 232, 0.97);
  border-color: #e8a16f;
}
.bubble-pop-enter-active,
.bubble-pop-leave-active {
  transition: all 0.18s ease;
}
.bubble-pop-enter-from,
.bubble-pop-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px) scale(0.94);
}
.pet-menu {
  position: absolute;
  z-index: 20;
  min-width: 92px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px;
  background: #fff;
  border: 1.5px solid rgba(255, 122, 89, 0.35);
  border-radius: 12px;
  box-shadow: 0 6px 20px rgba(90, 60, 40, 0.22);
}
.pet-menu button {
  border: none;
  background: transparent;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12.5px;
  color: #3d2e26;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.pet-menu button:hover {
  background: #ffefe8;
  color: #ff7a59;
}
.approval {
  position: absolute;
  z-index: 30;
  left: 50%;
  transform: translateX(-50%);
  top: 8px;
  min-width: 200px;
  padding: 8px 10px;
  background: #fff;
  border: 1.5px solid rgba(255, 122, 89, 0.55);
  border-radius: 12px;
  box-shadow: 0 6px 20px rgba(90, 60, 40, 0.25);
}
.approval-title {
  font-size: 12.5px;
  color: #3d2e26;
  word-break: break-word;
}
.approval-detail {
  margin-top: 2px;
  font-size: 11px;
  color: #8c7a6e;
  word-break: break-all;
}
.approval-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.approval-actions button {
  flex: 1;
  border: 1px solid #e8d9cf;
  background: #fff;
  border-radius: 8px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  color: #3d2e26;
}
.approval-actions button:hover {
  border-color: #ff7a59;
  color: #ff7a59;
}
.mock-window {
  position: absolute;
  background: rgba(255, 255, 255, 0.75);
  border: 1.5px solid #e3d5ca;
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(90, 60, 40, 0.12);
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding: 8px 12px;
  font-size: 12px;
  color: #b3a294;
  pointer-events: none;
}
.preview-bar {
  position: fixed;
  left: 12px;
  bottom: 12px;
  display: flex;
  gap: 6px;
  align-items: center;
  background: rgba(255, 255, 255, 0.92);
  padding: 8px 10px;
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  z-index: 10;
}
.preview-title {
  font-size: 12px;
  color: #8c7a6e;
  margin-right: 2px;
}
.preview-bar button {
  border: 1px solid #e8d9cf;
  background: #fff;
  border-radius: 8px;
  padding: 4px 9px;
  font-size: 12px;
  cursor: pointer;
}
.preview-bar button:hover {
  border-color: #ff7a59;
  color: #ff7a59;
}
</style>
