<script setup lang="ts">
// Petdex 精灵图集渲染通道（整改 §5）：8 列 × 192×208 帧，v1 9 行 / v2 11 行。
// 行/帧数/时长为 petdex 规范常量（来源 crafter-station/petdex src/lib/pet-states.ts，MIT）。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

interface Props {
  /** spritesheet 的可访问 URL（asset:// 协议） */
  sheetUrl: string
  /** petdex 状态行 id（idle / running-right / ...） */
  row: string
  /** 显示高度（css px），宽度按 192:208 比例得出 */
  heightPx: number
}

const props = defineProps<Props>()

const SPRITE_COLUMNS = 8
const FRAME_W = 192
const FRAME_H = 208

/** petdex 规范状态行：row 从 0 起，frames 帧数，durationMs 整轮时长 */
const PET_ROWS: Record<string, { row: number; frames: number; durationMs: number }> = {
  idle: { row: 0, frames: 6, durationMs: 1100 },
  'running-right': { row: 1, frames: 8, durationMs: 1060 },
  'running-left': { row: 2, frames: 8, durationMs: 1060 },
  waving: { row: 3, frames: 4, durationMs: 700 },
  jumping: { row: 4, frames: 5, durationMs: 840 },
  failed: { row: 5, frames: 8, durationMs: 1220 },
  waiting: { row: 6, frames: 6, durationMs: 1010 },
  running: { row: 7, frames: 6, durationMs: 820 },
  review: { row: 8, frames: 6, durationMs: 1030 }
}

const canvasRef = ref<HTMLCanvasElement | null>(null)
const ready = ref(false)
const failed = ref(false)
const version = ref<9 | 11>(9)

const img = new Image()
let raf = 0
let last = 0
let clock = 0
let frameIdx = 0

function rowInfo() {
  return PET_ROWS[props.row] ?? PET_ROWS.idle
}

function draw(): void {
  const cv = canvasRef.value
  if (!cv || !img.complete || !img.naturalWidth) return
  const ctx = cv.getContext('2d')
  if (!ctx) return
  // v1/v2 由图集实际高度判定（允许整数倍缩放的图集）
  const rows = img.naturalHeight / FRAME_H
  version.value = rows >= 10 ? 11 : 9
  const info = rowInfo()
  const rowIdx = Math.min(info.row, version.value - 1)
  const sx = frameIdx * FRAME_W * (img.naturalWidth / (SPRITE_COLUMNS * FRAME_W))
  const sy = rowIdx * FRAME_H
  const sw = FRAME_W * (img.naturalWidth / (SPRITE_COLUMNS * FRAME_W))
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, cv.width, cv.height)
  ctx.drawImage(img, sx, sy, sw, FRAME_H, 0, 0, cv.width, cv.height)
}

function tick(ms: number): void {
  raf = requestAnimationFrame(tick)
  const dt = last ? Math.min((ms - last) / 1000, 0.064) : 0
  last = ms
  clock += dt
  const info = rowInfo()
  const frameDur = info.durationMs / 1000 / info.frames
  if (clock - frameIdx * frameDur >= frameDur) {
    frameIdx = Math.floor(clock / frameDur) % info.frames
  }
  draw()
}

function load(url: string): void {
  ready.value = false
  failed.value = false
  img.onload = () => {
    ready.value = true
    draw()
  }
  img.onerror = () => {
    failed.value = true
  }
  img.src = url
}

watch(
  () => props.sheetUrl,
  (url) => {
    if (url) load(url)
  },
  { immediate: true }
)

// 换行回到第 0 帧，避免从半截动作开始
watch(
  () => props.row,
  () => {
    clock = 0
    frameIdx = 0
  }
)

onMounted(() => {
  raf = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
})
</script>

<template>
  <span v-if="failed" class="atlas-fallback">⚫</span>
  <canvas
    v-show="ready"
    ref="canvasRef"
    class="atlas-canvas"
    :width="Math.round((props.heightPx * FRAME_W) / FRAME_H)"
    :height="props.heightPx"
  />
</template>

<style scoped>
.atlas-canvas {
  display: block;
  image-rendering: pixelated;
}
.atlas-fallback {
  font-size: 24px;
}
</style>
