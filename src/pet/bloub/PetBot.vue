<script setup lang="ts">
// 由上游 bloub 的 BloubBot.vue 裁剪而来（MIT，见同目录 LICENSE）：
// 保留引擎驱动与 SVG 渲染，去掉时间线/播放器/指针跟随——
// 桌宠的状态由 PetBrain 行为树驱动，视线由全局光标（Rust 事件）经 setGaze 注入。
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef, watch } from 'vue'
import { NOTIF_BLUE } from './decor'
import { BotEngine, type BotFrame } from './engine'
import { clamp, easings } from './math'
import { lookTarget, TURN_TIME } from './gaze'
import { DEFAULT_EXPRESSION, EXPRESSION_BY_ID } from './expressions'
import { COLOR_BY_ID, DEFAULT_COLOR, DEFAULT_SHAPE, SHAPE_BY_ID, mixHex } from './skins'
import { STATE_BY_ID, type StateId } from './states'
import { DEMI_VIEWBOX, RAYON } from './repere'

const props = withDefaults(
  defineProps<{
    size?: number
    shape?: string
    color?: string
    expression?: string
    /** 眼睛镂空处透出的颜色（桌面上用近白，让眼睛读作亮色） */
    paper?: string
  }>(),
  {
    size: 320,
    shape: DEFAULT_SHAPE,
    color: DEFAULT_COLOR,
    expression: DEFAULT_EXPRESSION,
    paper: '#ffffff'
  }
)

/** 行为树驱动的当前状态（v-model:state） */
const state = defineModel<StateId>('state', { default: 'idle' })

const R = RAYON
const VB = DEMI_VIEWBOX

const shapeRadii = computed(() => SHAPE_BY_ID.get(props.shape)?.radii ?? null)
const ink = computed(() => COLOR_BY_ID.get(props.color)?.hex ?? '#0a0a0c')
const expression = computed(() => EXPRESSION_BY_ID.get(props.expression) ?? null)

const engine = new BotEngine(R, state.value, shapeRadii.value, expression.value)
const frame = shallowRef<BotFrame>(engine.sample(0))
const uid = Math.random().toString(36).slice(2, 8)
const maskId = `bot-mask-${uid}`

let raf = 0
let last = 0
let clock = 0

function tick(ms: number) {
  raf = requestAnimationFrame(tick)
  // 场景时钟限幅：窗口被 WebView2 节流后恢复时不跳帧
  const dt = last ? Math.min((ms - last) / 1000, 0.064) : 0
  last = ms
  clock += dt
  frame.value = engine.sample(clock)
  triggerRef(frame)
}

/* ------------------------------------------------- 外部注入的视线 */

const svg = ref<SVGSVGElement | null>(null)

let aiming = false
let turnSince = 0

/**
 * PetBrain 每帧调用：nx/ny 为归一化视线目标（-1..1）。
 * 只在" resting face"状态生效（与上游 aim() 同一规则）：
 * 其余状态的眼睛姿态本身就是动画，叠加会互相干扰。
 */
function setGaze(nx: number, ny: number, pointer: boolean) {
  if (!STATE_BY_ID.get(state.value)?.baseFace) {
    release()
    return
  }
  const box = svg.value?.getBoundingClientRect()
  // 无面积的盒子会产生 NaN 并永久污染引擎的视线状态（上游注释同样警告）
  if (!box || box.width === 0 || box.height === 0) return
  if (!aiming) turnSince = clock
  engine.setLook(
    lookTarget({
      nx: clamp(nx, -1, 1),
      ny: clamp(ny, -1, 1),
      tour: easings.easeOutQuint(clamp((clock - turnSince) / TURN_TIME)),
      pointer
    }),
    clock
  )
  aiming = true
}

function release() {
  if (!aiming) return
  engine.setLook(null, clock)
  aiming = false
}

defineExpose({ setGaze })

/* ------------------------------------------------- 属性变化 */

watch(state, (id) => {
  if (engine.state === id) return
  engine.setState(id, clock)
})

watch(shapeRadii, (radii) => {
  engine.setShape(radii, clock)
})

watch(expression, (expr) => {
  engine.setExpression(expr, clock)
})

onMounted(() => {
  raf = requestAnimationFrame(tick)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
})

function dotAttrs(dot: BotFrame['dots'][number]) {
  const fill =
    dot.color ?? (dot.depth === undefined ? ink.value : mixHex(props.paper, ink.value, dot.depth))
  const common = { fill, opacity: dot.opacity }
  return dot.d
    ? {
        ...common,
        d: dot.d,
        transform: `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${R})`
      }
    : { ...common, cx: dot.x, cy: dot.y, r: dot.r }
}
</script>

<template>
  <svg
    ref="svg"
    :width="props.size"
    :height="props.size"
    :viewBox="`${-VB} ${-VB} ${VB * 2} ${VB * 2}`"
    role="img"
    aria-label="桌宠小黑点"
  >
    <defs>
      <!-- 眼睛是身体上的真镂空（与 x.ai 一致），滑动到轮廓边缘时自动被裁 -->
      <mask
        :id="maskId"
        maskUnits="userSpaceOnUse"
        :x="-VB"
        :y="-VB"
        :width="VB * 2"
        :height="VB * 2"
      >
        <path :d="frame.bodyPath" fill="#fff" />
        <path
          v-for="(eye, i) in frame.eyes"
          :key="i"
          :d="eye.d"
          :transform="eye.matrix"
          :opacity="eye.alpha"
          fill="#000"
        />
        <circle
          v-if="frame.notch"
          :cx="frame.notch.x"
          :cy="frame.notch.y"
          :r="frame.notch.r"
          fill="#000"
        />
      </mask>

      <linearGradient
        v-for="arc in frame.arcs"
        :id="`${uid}-${arc.id}`"
        :key="arc.id"
        gradientUnits="userSpaceOnUse"
        :x1="arc.grad.x1"
        :y1="arc.grad.y1"
        :x2="arc.grad.x2"
        :y2="arc.grad.y2"
      >
        <stop
          v-for="(c, i) in arc.grad.stops"
          :key="i"
          :offset="i / (arc.grad.stops.length - 1)"
          :stop-color="c"
        />
      </linearGradient>
    </defs>

    <!-- 轨道的后半段：先画，被身体遮挡 -->
    <g fill="none" stroke-linecap="round">
      <path
        v-for="arc in frame.arcs"
        :key="`b${arc.id}`"
        :d="arc.back"
        :stroke="`url(#${uid}-${arc.id})`"
        :stroke-width="arc.width"
        :opacity="arc.opacity"
      />
    </g>

    <!-- 爆散粒子：位于核心之后 -->
    <g v-if="frame.dotsBehind">
      <component
        :is="dot.d ? 'path' : 'circle'"
        v-for="(dot, i) in frame.dots"
        :key="`pb${i}`"
        v-bind="dotAttrs(dot)"
      />
    </g>

    <g :opacity="frame.bodyAlpha">
      <!-- 身体轮廓的不透明底（paper 色）：眼睛镂空透出的就是它 -->
      <path :d="frame.bodyPath" :fill="props.paper" />
      <g :mask="`url(#${maskId})`">
        <rect :x="-VB" :y="-VB" :width="VB * 2" :height="VB * 2" :fill="ink" />
      </g>
    </g>

    <g v-if="!frame.dotsBehind">
      <component
        :is="dot.d ? 'path' : 'circle'"
        v-for="(dot, i) in frame.dots"
        :key="`pf${i}`"
        v-bind="dotAttrs(dot)"
      />
    </g>

    <circle
      v-if="frame.notif"
      :cx="frame.notif.x"
      :cy="frame.notif.y"
      :r="frame.notif.r"
      :fill="NOTIF_BLUE"
    />

    <!-- 轨道的前半段 -->
    <g fill="none" stroke-linecap="round">
      <path
        v-for="arc in frame.arcs"
        :key="`f${arc.id}`"
        :d="arc.front"
        :stroke="`url(#${uid}-${arc.id})`"
        :stroke-width="arc.width"
        :opacity="arc.opacity"
      />
    </g>
  </svg>
</template>
