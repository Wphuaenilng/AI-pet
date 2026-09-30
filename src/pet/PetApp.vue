<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { PetBrain, type BubbleState } from './PetBrain'
import { getLabel, isTauri } from '../lib/tauri'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const bubble = ref<BubbleState>({ visible: false, text: '' })
const brain = ref<PetBrain | null>(null)
const preview = !isTauri
const mockWindow = ref<{ x: number; y: number; w: number; h: number } | null>(null)

onMounted(() => {
  if (!canvasRef.value) return
  // 只有宠物窗口（或浏览器预览）才启动大脑，防止 settings/chat 窗口重复启动
  if (isTauri && getLabel() !== 'pet') return
  const b = new PetBrain(canvasRef.value, (s) => (bubble.value = { ...s }))
  brain.value = b
  // 调试入口（仅预览/开发模式暴露，不进生产包）
  if (preview || import.meta.env.DEV) {
    ;(window as unknown as { __petBrain?: PetBrain }).__petBrain = b
  }
  b.start()
    .then(() => {
      const w = b.world.windows[0]
      if (w && preview) mockWindow.value = { x: w.x, y: w.y, w: w.w, h: w.h }
    })
    .catch((e) => console.error('PetBrain 启动失败', e))
})

function dbg(name: 'sleep' | 'wander' | 'climb' | 'dance' | 'pat') {
  brain.value?.debug[name]()
}
function sayHi() {
  brain.value?.say('你好呀！我是住在你桌面上的小家伙～')
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
    <canvas ref="canvasRef" class="pet-canvas" />
    <transition name="bubble-pop">
      <div v-if="bubble.visible" class="bubble">{{ bubble.text }}</div>
    </transition>

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
.pet-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
  user-select: none;
  -webkit-user-drag: none;
}
.bubble {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 236px;
  padding: 9px 13px;
  background: #fff;
  border: 1.5px solid rgba(255, 122, 89, 0.35);
  border-radius: 14px;
  box-shadow: 0 4px 14px rgba(90, 60, 40, 0.18);
  color: #3d2e26;
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
  word-break: break-word;
}
.bubble::after {
  content: '';
  position: absolute;
  bottom: -6px;
  left: 50%;
  transform: translateX(-50%) rotate(45deg);
  width: 10px;
  height: 10px;
  background: #fff;
  border-right: 1.5px solid rgba(255, 122, 89, 0.35);
  border-bottom: 1.5px solid rgba(255, 122, 89, 0.35);
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
