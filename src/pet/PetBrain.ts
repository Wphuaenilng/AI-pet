// 宠物大脑：主循环 / 物理 / 拖拽 / 气泡 / 行为调度 / 事件联动
import { invoke, emitAll, isTauri, listen, DEFAULT_SETTINGS, type MonitorInfo, type OSWindow, type PetSayPayload, type Settings } from '../lib/tauri'
import { Planner } from '../behavior/behaviors/planner'
import {
  ApproachAndSpeakGoal,
  ChaseGoal,
  ClimbGoal,
  DanceGoal,
  EnterGoal,
  Goal,
  HappyGoal,
  IdleGoal,
  LayGoal,
  LookGoal,
  RunGoal,
  SeekFoodGoal,
  SitGoal,
  SleepGoal,
  WanderGoal,
} from '../behavior/behaviors/goals'
import { behaviorWeights, pickWeighted } from '../behavior/weights'
import { StateMachine, type PetFsmState } from '../behavior/StateMachine'
import { World } from '../desktop/World'
import { pickCanned, type CannedKind } from '../ai/Personality'
import { PetAnimation } from './PetAnimation'
import { PetRenderer } from './PetRenderer'
import { EmotionSystem, type ExprKind } from './PetState'
import type { StateId } from './bloub/states'
import { ATLAS_H, DOT_R } from './metrics'

/** bloub 状态 id（附录 §4.3 映射）：身体动画由 vendored bloub 引擎渲染 */
const BLOUB_EXPR: Record<ExprKind, string> = {
  neutral: 'attentif',
  happy: 'heureux',
  sad: 'triste',
  angry: 'colere',
  surprised: 'surpris',
  sleepy: 'somnolent',
  concern: 'timide'
}

/** 通知 Vue 层的渲染通道快照（bloub 参数 + Petdex 包选择，附录 §5） */
export interface BloubPayload {
  state: StateId
  /** 情绪映射后的表情 id（neutral 使用用户定制的静止表情） */
  expr: string
  scale: number
  shape: string
  color: string
  /** Petdex 包目录（'' = 默认 bloub 通道） */
  pack: string
  /** Petdex spritesheet 绝对路径 */
  packSheet: string
  /** Petdex 状态行 id（pack 模式下使用） */
  row: string
}

export const PET_W = 560 // 加宽是为了给气泡留位置，见 pushBubble / .bubble 的 max-width
export const PET_H = 340
const PAD_BOTTOM = 8 // css px，脚底离窗口底部
const GRAVITY = 1750 // css px/s^2

interface PetBody {
  x: number // 桌面物理像素，水平中心
  feetY: number // 桌面物理像素，脚底
  facing: 1 | -1
  vy: number
  airborne: boolean
  support: { kind: 'floor' | 'window' | 'float'; id: number } | null
}

export interface BubbleState {
  visible: boolean
  text: string
  /** 气泡底边距窗口底边的 CSS 像素：贴着头顶，不随窗口大小固定在顶部 */
  bottom: number
}

/** 右键自定义菜单的显示位置（画布内 CSS 像素），null 表示关闭 */
export type PetMenuState = { x: number; y: number } | null

export class PetBrain {
  fsm = new StateMachine()
  emotion = new EmotionSystem()
  anim = new PetAnimation()
  world: World
  settings: Settings
  pet: PetBody = { x: 0, feetY: 0, facing: 1, vy: 0, airborne: false, support: null }

  bubble: BubbleState = { visible: false, text: '', bottom: 0 }
  paused = false

  private renderer: PetRenderer
  private planner: Planner
  private goal: Goal | null = null
  private bubbleQueue: PetSayPayload[] = []
  private bubbleUntil = 0
  private pendingIntent: string | null = null
  private raf = 0
  private watchdog = 0
  private lastT = 0
  private unlistens: (() => void)[] = []
  private timers: number[] = []
  private devHeartbeat = 0
  private stopped = false

  // 窗口几何（物理像素）
  private dpr = 1
  private winW = PET_W
  private winH = PET_H
  private winX = 0
  private winY = 0

  u = 1 // 设备像素 / css像素（含缩放）

  /** bloub 视线注入（PetApp 挂载后接到 PetBot.setGaze）；nx/ny ∈ [-1,1] */
  gazeTarget: ((nx: number, ny: number, pointer: boolean) => void) | null = null
  private lastBloub: BloubPayload | null = null

  // 拖拽
  private dragging = false
  private dragSaid = false
  private dragStart = { x: 0, y: 0, t: 0 }
  private dragOrigin = { x: 0, feetY: 0 }
  private grabOffset = { x: 0, y: 0 }
  private dragMoved = 0

  // 辅助状态
  private supportRect = { x: 0, y: 0, w: 0, h: 0 }
  private supportCheckT = 0
  private lastSent = { x: NaN, y: NaN }
  private lastPosSentT = 0
  private posDirty = false
  private posInFlight = false
  private interactive = true
  private menuOpen = false
  private proactiveT = 0
  private lastProactive = 0
  private emotionEmitT = 0
  private petStateT = 0
  private lastSavedPet = { x: NaN, y: NaN }
  // 投喂（附录 A.2）：食物实体（桌面物理坐标），落地后宠物自己走过去吃
  food: { x: number; y: number; vy: number; landed: boolean } | null = null
  private lastBeg = 0
  private hardLandUntil = 0
  private idleSleepT = 0
  private lastWinSig = ''
  private winChurn = 0
  /** 聊天流式输出中（附录 B13）：气泡跟字，最终文本由 pet://say 替换 */
  private streaming = false
  private cursorEye = { dx: 0, dy: 0 }
  private headTiltTarget = 0
  private speedNow = 0

  constructor(
    private canvas: HTMLCanvasElement,
    private onBubble: (b: BubbleState) => void,
    private onStateChange?: (s: PetFsmState) => void,
    private onMenu?: (m: PetMenuState) => void,
    /** bloub 渲染通道：状态/表情/外观变化时通知 Vue 层（PetApp） */
    private onBloub?: (p: BloubPayload) => void
  ) {
    this.renderer = new PetRenderer(canvas)
    this.world = new World(!isTauri)
    this.planner = new Planner(this)
    this.settings = structuredClone(DEFAULT_SETTINGS)
    this.fsm.onChange = (s) => this.onStateChange?.(s)
  }

  now(): number {
    return performance.now()
  }

  /** 可清理的 setTimeout：stop() 后不再触发（普通 setTimeout 泄漏进 stop 之后的生命周期） */
  private later(fn: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== id)
      if (!this.stopped) fn()
    }, ms)
    this.timers.push(id)
  }

  get monitor(): MonitorInfo | null {
    return this.world.monitorAt(this.pet.x)
  }

  async start(): Promise<void> {
    this.log('start begin')
    // 1. 读取设置
    try {
      const { loadSettings } = await import('../store')
      this.settings = await loadSettings()
    } catch (e) {
      this.log(`settings load failed: ${e}`)
    }
    this.log(`settings ok, scale=${this.settings.scale} species=${this.settings.species}`)

    // 2. 同步窗口几何（失败不能让整个大脑起不来，退回默认几何继续运行）
    if (isTauri) {
      try {
        const info = await invoke<{ x: number; y: number; w: number; h: number; scale: number }>(
          'get_window_info',
          { label: 'pet' },
        )
        if (info) {
          this.winX = info.x
          this.winY = info.y
          this.winW = info.w
          this.winH = info.h
          this.dpr = info.scale || window.devicePixelRatio || 1
        }
        if (Math.abs(this.settings.scale - 1) > 0.01) {
          await invoke('set_pet_scale', { scale: this.settings.scale })
          const info2 = await invoke<{ x: number; y: number; w: number; h: number; scale: number }>(
            'get_window_info',
            { label: 'pet' },
          )
          if (info2) {
            this.winX = info2.x
            this.winY = info2.y
            this.winW = info2.w
            this.winH = info2.h
          }
        }
      } catch (e) {
        this.log(`window geometry failed: ${e}`)
      }
      void invoke('set_pet_ignore_cursor_events', { ignore: false }).catch(() => {})
    } else {
      this.dpr = 1
      // 预览：画布即视口，宠物直接摆在假桌面上
      const vw = window.innerWidth
      const vh = window.innerHeight
      this.winW = vw
      this.winH = vh
      this.pet.x = Math.round(vw * 0.72)
      this.pet.feetY = Math.round(vh - 40)
      this.markPosDirty()
      const onResize = () => {
        this.winW = window.innerWidth
        this.winH = window.innerHeight
        this.renderer.resize(this.winW, this.winH)
        this.pet.feetY = Math.round(window.innerHeight - 40)
        this.pet.x = Math.min(this.pet.x, window.innerWidth - 80)
        // 视口变了，窗口几何重算后要同步一次
        this.markPosDirty()
      }
      window.addEventListener('resize', onResize)
      this.unlistens.push(() => window.removeEventListener('resize', onResize))
    }
    this.u = this.dpr * this.settings.scale
    this.renderer.resize(this.winW, this.winH)
    if (isTauri) {
      this.pet.x = this.winX + this.winW / 2
      this.pet.feetY = this.winY + this.winH - PAD_BOTTOM * this.u
      // 初始几何只是起点：本轮 tick 末尾的 syncWindowPos 会按真实脚底重算，
      // 防止窗口初始 y 偏差让猫悬空/陷地（曾导致预览模式渲染与实际不同步）
      this.markPosDirty()
    }

    // 3. 世界 + 事件（先拿显示器数据，用于脚底吸附）
    await this.world.start()
    this.log(
      `world started monitors=${this.world.monitors.length} windows=${this.world.windows.length}`,
    )
    if (isTauri) {
      const m = this.world.monitorAt(this.pet.x)
      if (m) {
        const floor = this.world.floorOf(m)
        // 初始脚底吸附到地板（容差 100px），防止窗口初始偏移导致永远下坠
        if (this.pet.feetY > floor - 100 * this.u) this.pet.feetY = floor
        this.pet.support = { kind: 'floor', id: m.id }
      }
      // 位置记忆（附录 A.1）：恢复上次所在位置；无效（不在任何屏内/悬空异常）则忽略走默认入场
      try {
        const st = await invoke<{
          x?: number
          feetY?: number
          hunger?: number
          affection?: number
        } | null>('read_data', { name: 'petstate' })
        // 动机持久化（附录 A.2）：饱食度/好感跨会话恢复
        if (st) {
          if (Number.isFinite(st.hunger)) {
            this.emotion.v.hunger = Math.max(0, Math.min(100, st.hunger as number))
          }
          if (Number.isFinite(st.affection)) {
            this.emotion.v.affection = Math.max(0, Math.min(100, st.affection as number))
          }
        }
        if (st && Number.isFinite(st.x) && Number.isFinite(st.feetY)) {
          const sm = this.world.monitorAt(st.x as number)
          if (sm) {
            const x = st.x as number
            const fy = st.feetY as number
            const floor = this.world.floorOf(sm)
            if (x >= sm.x && x < sm.x + sm.w && fy > sm.y - 40 && fy <= floor + 40) {
              this.pet.x = x
              this.pet.feetY = fy
              this.pet.airborne = false
              this.pet.vy = 0
              this.pet.support = { kind: 'floor', id: sm.id }
              this.lastSavedPet = { x: Math.round(x), y: Math.round(fy) }
              this.markPosDirty()
              this.log(`petstate restored: ${x},${fy}`)
            }
          }
        }
      } catch (e) {
        this.log(`petstate load failed: ${e}`)
      }
    }
    this.unlistens.push(
      await listen<boolean>('tray://pause', (p) => {
        this.paused = p
        if (p) this.setPose('SIT')
        else this.setPose('IDLE')
      }),
      await listen('tray://summon', () => this.summon()),
      await listen('tray://feed', () => this.dropFood()),
      await listen<PetSayPayload>('pet://say', (p) => this.say(p.text, p)),
      await listen<Settings>('settings://updated', (s) => this.applySettings(s)),
      // 全局热键 Ctrl+Shift+U（附录 A.1）：切换强制鼠标穿透
      await listen('hotkey://toggle-clickthrough', () => this.toggleClickThrough()),
      // M4 双通道本地侧：聊天窗对用户文字的关键词情绪估计
      await listen<string>('pet://user-emotion', (k) => this.emotion.onUserText(k)),
      // M5 生态：MCP/HTTP 桥的意图与外部事件
      await listen<{ action: string }>('pet://intent', (p) => {
        this.pendingIntent = p.action
        const g = this.takePendingIntent()
        if (g) this.setGoal(g)
      }),
      await listen<{ kind: string; message?: string }>('pet://external-event', (p) =>
        this.onExternalEvent(p.kind, p.message),
      ),
      // 聊天流式输出：气泡实时跟字（附录 B13）
      await listen<{ text: string }>('pet://say-stream', (p) => this.showStream(p.text)),
    )

    // 4. 画布鼠标事件（拖拽 / 点摸 / 双击聊天 / 右键自定义菜单）
    const onPointerDown = (e: PointerEvent) => this.onPointerDown(e)
    const onPointerUp = () => this.onPointerUp()
    const onDblClick = () => {
      if (isTauri) void invoke('show_window', { label: 'chat' }).catch(() => {})
    }
    // 拦掉 WebView2 自带菜单（"复制图像"那一套），换成宠物自己的菜单。
    // 挂在 window 上：气泡等 DOM 覆盖层也要被覆盖到，否则右键气泡仍弹原生菜单
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      this.openMenu(e.clientX, e.clientY)
    }
    this.canvas.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    this.canvas.addEventListener('dblclick', onDblClick)
    window.addEventListener('contextmenu', onContextMenu)
    this.unlistens.push(
      () => this.canvas.removeEventListener('pointerdown', onPointerDown),
      () => window.removeEventListener('pointerup', onPointerUp),
      () => this.canvas.removeEventListener('dblclick', onDblClick),
      () => window.removeEventListener('contextmenu', onContextMenu),
      () => this.onMenu?.(null),
    )

    // 5. 初始行为：从屏幕边走进来
    this.fsm.force('ENTER', this.now())
    this.goal = new EnterGoal(this)
    this.goal.start()

    // 6. 主循环（rAF + 看门狗：WebView2 对被遮挡/离屏窗口会节流 rAF，用定时器兜底）
    this.lastT = performance.now()
    const loop = (t: number) => {
      if (this.stopped) return
      this.raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, Math.max(0.001, (t - this.lastT) / 1000))
      this.lastT = t
      try {
        this.tick(dt, t)
      } catch (e) {
        console.error('pet tick error', e)
      }
    }
    this.raf = requestAnimationFrame(loop)
    this.watchdog = window.setInterval(() => {
      if (this.stopped) return
      const now = performance.now()
      if (now - this.lastT > 200) {
        const dt = Math.min(0.05, Math.max(0.001, (now - this.lastT) / 1000))
        this.lastT = now
        try {
          this.tick(dt, now)
        } catch {
          /* ignore */
        }
      }
    }, 120)
    // 调试心跳（仅开发模式）
    if (import.meta.env.DEV) {
      this.devHeartbeat = window.setInterval(() => {
        this.log(
          `hb state=${this.fsm.current} goal=${this.goal?.label ?? 'null'} x=${Math.round(this.pet.x)} feetY=${Math.round(this.pet.feetY)} air=${this.pet.airborne} u=${this.u.toFixed(2)} hidden=${document.hidden}`,
        )
      }, 3000)
    }
  }

  private log(msg: string): void {
    if (!isTauri) return
    void invoke('frontend_log', { level: 'brain', message: msg.slice(0, 400) }).catch(() => {})
  }

  stop(): void {
    this.stopped = true
    cancelAnimationFrame(this.raf)
    if (this.watchdog) clearInterval(this.watchdog)
    if (this.devHeartbeat) clearInterval(this.devHeartbeat)
    this.timers.forEach((t) => clearTimeout(t))
    this.timers = []
    this.world.stop()
    this.unlistens.forEach((u) => u())
    this.unlistens = []
  }

  // ---------- 每帧 ----------

  private tick(dt: number, t: number): void {
    if (document.hidden) return
    const p = this.pet

    if (this.dragging) {
      this.updateDrag()
    } else {
      this.physics(dt)
      this.checkSupport(dt)
      if (!p.airborne) this.updateGoal(dt)
      else this.goal?.updateAir?.(dt)
      this.maybeProactive(dt, t)
    }

    // 食物物理独立于宠物（拖拽中也会掉落）；待机入睡序列仅在非拖拽时推进
    this.updateFood(dt)
    this.maybeIdleSleep(dt)

    // 情绪
    this.emotion.tick(dt, {
      state: this.fsm.current,
      cursorActive: this.world.cursorMovedRecently(3000),
    })

    // 气泡队列
    if (this.bubble.visible && t > this.bubbleUntil) {
      this.bubble = { visible: false, text: '', bottom: 0 }
      this.streaming = false
      this.pushBubble()
      if (this.fsm.current === 'TALK') this.setPose('IDLE')
    }
    if (!this.bubble.visible && this.bubbleQueue.length > 0) {
      this.showNextBubble(t)
    }
    if (
      this.bubble.visible &&
      !this.paused &&
      !this.dragging &&
      !p.airborne &&
      this.fsm.current !== 'SLEEP' &&
      ['IDLE', 'SIT', 'LAY', 'LOOK', 'HAPPY', 'TALK', 'WALK'].includes(this.fsm.current)
    ) {
      this.setPose('TALK')
    }

    // 眼睛看向鼠标
    this.trackCursorEyes(dt)

    // 鼠标穿透判定
    this.updateHitTest()

    // 同步窗口位置
    this.syncWindowPos()

    // 位置记忆：每 10s 存一次落点（拖拽/空中不存，附录 A.1）
    this.maybeSavePetState(dt)

    // 定期广播情绪（设置面板可视化用）+ 上报桥接状态（M5 GET /status 数据源）
    this.emotionEmitT += dt
    if (this.emotionEmitT > 2) {
      this.emotionEmitT = 0
      const payload = {
        values: this.emotion.v,
        expr: this.emotion.expr(),
        state: this.fsm.current,
        name: this.settings.petName,
        species: this.settings.species,
        personality: this.settings.personality,
      }
      void emitAll('pet://emotion', payload)
      if (isTauri) {
        void invoke('report_status', {
          status: {
            state: payload.state,
            expr: payload.expr,
            name: payload.name,
            values: payload.values,
          },
        }).catch(() => {})
      }
    }

    // 推进动画（步态/呼吸/眨眼/口型/粒子/Zzz）——此前 update 从未被调用，动画整体冻结
    const expr = this.emotion.expr()
    const moving = this.speedNow > 5 * this.u
    this.anim.update(dt, {
      state: this.fsm.current,
      moving,
      speed: this.speedNow,
      expr,
      talking:
        this.bubble.visible &&
        this.fsm.current !== 'SLEEP' &&
        this.fsm.current !== 'DRAG' &&
        this.fsm.current !== 'FALL',
      eyeDX: this.cursorEye.dx,
      eyeDY: this.cursorEye.dy,
      headTiltTarget: this.headTiltTarget,
    })

    // bloub 渲染通道：状态/表情/外观变化时通知 Vue 层；视线每帧注入
    const bState = this.bloubStateFor(this.fsm.current)
    const bExpr =
      expr === 'neutral'
        ? this.settings.bloubExpression || 'attentif'
        : BLOUB_EXPR[expr] ?? 'attentif'
    const payload: BloubPayload = {
      state: bState,
      expr: bExpr,
      scale: this.settings.scale,
      shape: this.settings.bloubShape,
      color: this.settings.bloubColor,
      pack: this.settings.petPack,
      packSheet: this.settings.petPackSheet,
      row: this.petRowFor(this.fsm.current)
    }
    if (
      !this.lastBloub ||
      this.lastBloub.state !== payload.state ||
      this.lastBloub.expr !== payload.expr ||
      this.lastBloub.scale !== payload.scale ||
      this.lastBloub.shape !== payload.shape ||
      this.lastBloub.color !== payload.color ||
      this.lastBloub.pack !== payload.pack ||
      this.lastBloub.row !== payload.row
    ) {
      this.lastBloub = payload
      this.onBloub?.(payload)
    }
    this.gazeTarget?.(this.cursorEye.dx, this.cursorEye.dy, true)

    // 渲染
    const pose = this.anim.poseFor(this.fsm.current, p.airborne || this.dragging)
    const render = this.anim.compose({
      state: this.fsm.current,
      pose,
      species: this.settings.species,
      u: this.u,
      cx: this.winW / 2,
      feetY: this.winH - PAD_BOTTOM * this.u,
      facing: p.facing,
      expr,
      moving,
      speed: this.speedNow,
      eyeDX: this.cursorEye.dx,
      eyeDY: this.cursorEye.dy,
      food: this.food
        ? { dx: this.food.x - p.x, dy: p.feetY - this.food.y }
        : null,
    })
    this.renderer.render(render)
  }

  // ---------- 物理 ----------

  private physics(dt: number): void {
    const p = this.pet
    if (!p.airborne) return
    p.vy += GRAVITY * this.u * dt
    const prev = p.feetY
    p.feetY += p.vy * dt
    if (p.vy > 0) {
      const land = this.world.landingSurface(p.x, prev, p.feetY + 6)
      if (land) {
        const impact = p.vy
        p.feetY = land.top
        // 抛掷手感（附录 A.2）：仅自由落体（FALL）反弹；重摔触发 burst 重组彩蛋。
        // 攀爬跳跃（JUMP）落地不弹，否则会从窗口顶上弹下去
        if (this.fsm.current === 'FALL' && impact > 1600 * this.u) {
          p.vy = -impact * 0.32
          this.anim.squash = 1
          this.anim.burst('sparkle', 8)
          this.hardLandUntil = this.now() + 900
          this.fsm.force('SURPRISED', this.now())
        } else if (this.fsm.current === 'FALL' && impact > 850 * this.u) {
          p.vy = -impact * 0.3
          this.anim.squash = 1
        } else {
          p.vy = 0
          p.airborne = false
          p.support = { kind: land.kind, id: land.id }
          this.supportRect = { x: land.left, y: land.top, w: land.right - land.left, h: 0 }
          this.anim.squash = 1
          this.onLand()
        }
      } else {
        // 安全网：已经掉到地板以下（比如显示器切换），直接落到地板上
        const m = this.world.monitorAt(p.x)
        if (m && p.feetY > this.world.floorOf(m) + 40) {
          p.feetY = this.world.floorOf(m)
          p.vy = 0
          p.airborne = false
          p.support = { kind: 'floor', id: m.id }
          this.anim.squash = 1
          this.onLand()
        }
      }
    }
    this.markPosDirty()
  }

  private onLand(): void {
    if (this.fsm.current === 'FALL') {
      this.setPose('SURPRISED')
      this.anim.burst('sweat', 1)
      if (Math.random() < 0.5) this.say(pickCanned(this.settings.personality, 'landOops', this.settings.petName))
      this.later(() => {
        if (!this.dragging && this.fsm.current === 'SURPRISED') {
          this.setPose('IDLE')
          this.goal = null
        }
      }, 700)
    }
    // JUMP：ClimbGoal 自行处理落地
  }

  private startFall(): void {
    const p = this.pet
    if (p.airborne) return
    p.airborne = true
    p.vy = 0
    p.support = null
    this.fsm.force('FALL', this.now())
  }

  /** 松手即停在原地：把当前高度当立足点，不再自由落体回地板 */
  private settleHere(): void {
    const p = this.pet
    p.airborne = false
    p.vy = 0
    p.support = { kind: 'float', id: 0 }
    this.supportRect = { x: p.x, y: p.feetY, w: 0, h: 0 }
    this.fsm.set('IDLE', this.now()) || this.fsm.force('IDLE', this.now())
    this.markPosDirty()
  }

  private checkSupport(dt: number): void {
    const p = this.pet
    if (p.airborne) return
    if (p.support?.kind === 'float') {
      // 悬停不需要找表面；只有显示器/分辨率变了才重新掉一次找落脚处
      const m = this.world.monitorAt(p.x)
      if (!m || p.feetY > this.world.floorOf(m) + 4 || p.feetY < m.y - 4) this.startFall()
      return
    }
    if (p.support?.kind === 'window') {
      const w = this.world.windowById(p.support.id)
      if (!w) {
        this.startFall()
        return
      }
      const dx = w.x - this.supportRect.x
      const dy = w.y - this.supportRect.y
      if (dx !== 0 || dy !== 0) {
        // 跟随窗口移动（平滑）
        const f = Math.min(1, dt * 14)
        p.x += dx * f
        p.feetY += dy * f
        this.supportRect = { x: w.x, y: w.y, w: w.w, h: w.h }
        this.markPosDirty()
      }
      const u = this.u
      if (p.x < w.x - 30 * u || p.x > w.x + w.w + 30 * u || p.feetY < w.y - 40 || p.feetY > w.y + 120) {
        this.startFall()
      }
    } else {
      this.supportCheckT += dt
      if (this.supportCheckT > 0.5) {
        this.supportCheckT = 0
        if (!this.world.surfaceAt(p.x, p.feetY, 10 * this.u)) this.startFall()
      }
    }
  }

  // ---------- 移动 ----------

  walkStep(dt: number, targetX: number, speedCss: number, run: boolean): 'moving' | 'arrived' | 'blocked' {
    const p = this.pet
    const u = this.u
    if (Math.abs(targetX - p.x) < 8 * u) {
      this.speedNow = 0
      this.setPose('IDLE')
      return 'arrived'
    }
    const dir: 1 | -1 = targetX > p.x ? 1 : -1
    const m = this.world.monitorAt(p.x)
    // 终点也要钳在显示器工作区内，防止目标本身在屏外导致来回 blocked
    const minX = (m ? m.wx : 0) + 20 * u
    const maxX = (m ? m.wx + m.ww : 1920 * u) - 20 * u
    const clampedTarget = Math.max(minX, Math.min(maxX, targetX))
    if (Math.abs(clampedTarget - p.x) < 8 * u) {
      this.speedNow = 0
      this.setPose('IDLE')
      return 'arrived'
    }
    const step = speedCss * u * dt
    let nx = p.x + dir * step
    if (p.x >= minX && p.x <= maxX) {
      nx = Math.max(minX, Math.min(maxX, nx))
    }
    if (nx === p.x) {
      p.facing = (-dir as 1 | -1)
      this.speedNow = 0
      return 'blocked'
    }
    if (p.support?.kind === 'float') {
      // 悬停：当前高度就是立足点，不做表面探测（否则脚下无物会被判 blocked 走不动）
    } else {
      const sup = this.world.surfaceAt(nx, p.feetY, 6 * u)
      if (!sup) {
        // 尝试小台阶（≤34css 高的窗口顶）
        const stepUp = this.world.windowTopNear(nx, p.feetY - 34 * u, p.feetY - 4)
        if (stepUp) {
          p.feetY = stepUp.top
          p.support = { kind: stepUp.kind, id: stepUp.id }
          this.supportRect = { x: stepUp.left, y: stepUp.top, w: stepUp.right - stepUp.left, h: 0 }
        } else {
          p.facing = (-dir as 1 | -1)
          this.speedNow = 0
          return 'blocked'
        }
      } else {
        p.support = { kind: sup.kind, id: sup.id }
        if (sup.kind === 'window') {
          this.supportRect = { x: sup.left, y: sup.top, w: sup.right - sup.left, h: 0 }
        }
      }
    }
    p.x = nx
    p.facing = dir
    this.speedNow = step / Math.max(dt, 0.001)
    this.setPose(run ? 'RUN' : 'WALK')
    this.markPosDirty()
    return 'moving'
  }

  jumpWithVelocity(heightCss: number): void {
    const p = this.pet
    if (p.airborne) return
    const h = Math.max(20, heightCss) * this.u
    p.vy = -Math.sqrt(2 * GRAVITY * this.u * h)
    p.airborne = true
    p.support = null
    this.fsm.set('JUMP', this.now()) || this.fsm.force('JUMP', this.now())
    this.markPosDirty()
  }

  pounce(): void {
    const p = this.pet
    if (p.airborne) return
    p.vy = -Math.sqrt(2 * GRAVITY * this.u * 70 * this.u)
    p.airborne = true
    p.support = null
    this.fsm.set('JUMP', this.now()) || this.fsm.force('JUMP', this.now())
    this.markPosDirty()
  }

  /** FSM 状态 → bloub 状态 id（整改计划 §4.3 映射表） */
  private bloubStateFor(state: PetFsmState): StateId {
    // 重摔落地：爆散重组彩蛋优先于一切状态（附录 A.2）
    if (this.now() < this.hardLandUntil) return 'burst'
    if (this.dragging) return 'egg'
    switch (state) {
      case 'WALK':
      case 'RUN':
      case 'ENTER':
        return 'move'
      case 'SIT':
        return 'hexagon'
      case 'LAY':
        return 'egg'
      case 'SLEEP':
        return 'sleep'
      case 'LOOK':
        return 'wide'
      case 'PLAY':
        return 'comet'
      case 'HAPPY':
        return this.goal?.label.startsWith('dance') ? 'orbit' : 'wink'
      case 'ANGRY':
        return 'hexagon'
      case 'SURPRISED':
        return 'alert'
      case 'TALK':
        return 'thinking'
      case 'JUMP':
        return 'exclaim'
      case 'FALL':
        return 'alert'
      default:
        return 'idle'
    }
  }

  /** FSM 状态 → Petdex 状态行 id（整改计划 §5.2 映射；sleep 走 v2 自定义行前的兜底） */
  private petRowFor(state: PetFsmState): string {
    if (this.dragging) return 'jumping'
    switch (state) {
      case 'WALK':
      case 'RUN':
      case 'ENTER':
        return this.pet.facing === 1 ? 'running-right' : 'running-left'
      case 'SIT':
      case 'LAY':
      case 'TALK':
        return 'waiting'
      case 'SLEEP':
        return 'idle'
      case 'LOOK':
        return 'review'
      case 'PLAY':
        return 'running'
      case 'HAPPY':
        return 'waving'
      case 'ANGRY':
        return 'failed'
      case 'SURPRISED':
      case 'JUMP':
      case 'FALL':
        return 'jumping'
      default:
        return 'idle'
    }
  }

  // ---------- 目标与行为 ----------

  private updateGoal(dt: number): void {
    if (this.paused) {
      return
    }
    if (!this.goal) {
      // 新目标：重置速度/步态，防止上个 goal 的残留 speedNow 让动画层误判为移动
      this.speedNow = 0
      this.goal = this.planner.pick()
      this.goal.start()
    }
    const r = this.goal.update(dt)
    if (r === 'done') {
      this.goal = null
    }
  }

  setGoal(g: Goal): void {
    this.goal?.onAbort?.()
    this.goal = g
    g.start()
  }

  setPose(s: PetFsmState): void {
    this.fsm.set(s, this.now())
  }

  cursorNearPet(): number {
    const headY = this.pet.feetY - 120 * this.u
    const dx = this.world.cursor.x - this.pet.x
    const dy = this.world.cursor.y - headY
    return Math.sqrt(dx * dx + dy * dy)
  }

  trackCursorEyes(dt = 1 / 60): void {
    const c = this.world.cursor
    const headY = this.pet.feetY - 150 * this.u
    const dx = c.x - this.pet.x
    const dy = c.y - headY
    const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
    const near = d < 420 * this.u
    const tx = near ? Math.max(-1, Math.min(1, dx / (160 * this.u))) : 0
    const ty = near ? Math.max(-1, Math.min(1, dy / (160 * this.u))) : 0
    // 帧率无关的指数趋近（60fps 时系数 ≈ 0.12）：看门狗 120ms 兜底 tick 与
    // 120/144Hz 高刷屏下行为一致，不再随帧率变化（附录 B4）
    const f = 1 - Math.exp(-7.7 * dt)
    this.cursorEye.dx += (tx - this.cursorEye.dx) * f
    this.cursorEye.dy += (ty - this.cursorEye.dy) * f
    // 距离很近时头微歪（可爱）：朝光标一侧的小倾角，弧度值由 renderer 直接 rotate
    this.headTiltTarget = near ? Math.max(-0.2, Math.min(0.2, (dx / (420 * this.u)) * 0.2)) : 0
  }

  /** 行为池（附录 A.2/B7）：权重表驱动，动机值（饿/困/无聊/心情）直接调制行为倾向 */
  pickRandomBehavior(): Goal | null {
    const kind = pickWeighted(behaviorWeights(this.emotion.v)).kind
    const b = this
    switch (kind) {
      case 'wander':
        return new WanderGoal(b)
      case 'sit':
        return new SitGoal(b, 6 + Math.random() * 8)
      case 'lay':
        // 在窗口顶上就趴着
        return this.pet.support?.kind === 'window'
          ? new LayGoal(b, 6 + Math.random() * 8)
          : new LayGoal(b, 4 + Math.random() * 4)
      case 'sleep':
        return new SleepGoal(b, 6 + Math.random() * 8)
      case 'climb': {
        if (this.settings.windowInteract) {
          const w = this.world.bestWindowNear(this.pet.x, this.pet.feetY)
          if (w) return new ClimbGoal(b, w)
        }
        return new WanderGoal(b)
      }
      case 'idle':
        return new IdleGoal(b, 2 + Math.random() * 2)
      case 'look':
        return new LookGoal(b, 2 + Math.random() * 2)
      case 'selfTalk': {
        this.later(() => {
          if (!this.paused && !this.dragging) {
            this.say(this.pickCanned('selfTalk'))
            this.anim.burst('note', 2)
          }
        }, 400)
        return new IdleGoal(b, 3.5)
      }
      case 'dance':
        return new DanceGoal(b, 2.5 + Math.random() * 2)
    }
  }

  /** AI 行为意图 → 目标（26.2 约束：本地裁决） */
  takePendingIntent(): Goal | null {
    if (!this.pendingIntent) return null
    const action = this.pendingIntent
    this.pendingIntent = null
    const b = this
    switch (action) {
      case 'approach_user':
        return new ApproachAndSpeakGoal(b, '') // 已有气泡，只走近
      case 'jump_on_window': {
        if (!this.settings.windowInteract) return null
        const w = this.world.bestWindowNear(this.pet.x, this.pet.feetY)
        return w ? new ClimbGoal(b, w) : null
      }
      case 'sit':
        return new SitGoal(b, 12)
      case 'sleep':
        return new SleepGoal(b, 20)
      case 'play':
        return this.settings.trackMouse ? new ChaseGoal(b, 5) : null
      case 'dance':
        return new DanceGoal(b, 3)
      default:
        return null
    }
  }

  private maybeProactive(dt: number, t: number): void {
    this.proactiveT += dt
    if (this.proactiveT < 30) return
    this.proactiveT = 0
    // 事件源（M4 三源触发）：两次主动间隔内窗口签名变化次数（切窗口频繁 = 在忙/分心）
    const sig = this.world.windows.map((w) => w.id).join(',')
    if (sig !== this.lastWinSig) this.winChurn++
    this.lastWinSig = sig
    if (!this.settings.proactive || !this.settings.autoActivity || this.paused) return
    if (t - this.lastProactive < 240_000) return
    if (this.dragging || this.pet.airborne) return
    const idleMs = Date.now() - this.emotion.lastInteraction
    const busy = this.winChurn >= 3
    const want =
      busy || this.emotion.v.boredom > 70 || (idleMs > 8 * 60_000 && this.emotion.v.affection > 50)
    if (!want) return
    this.winChurn = 0
    this.lastProactive = t
    const line = busy
      ? pickCanned(this.settings.personality, 'busy', this.settings.petName)
      : pickCanned(this.settings.personality, 'bored', this.settings.petName)
    this.setGoal(new ApproachAndSpeakGoal(this, line))
    void emitAll('pet://memory-event', '主动关心了用户')
  }

  // ---------- 投喂（附录 A.2） ----------

  /** 投喂：食物从宠物侧上方掉落（桌面坐标），落地后宠物自己走过去吃 */
  dropFood(): void {
    if (this.food) return
    const m = this.world.monitorAt(this.pet.x) ?? this.world.monitors.find((x) => x.primary)
    if (!m) return
    const u = this.u
    const side = Math.random() < 0.5 ? -1 : 1
    const fx = Math.max(
      m.wx + 40 * u,
      Math.min(m.wx + m.ww - 40 * u, this.pet.x + side * (120 + Math.random() * 80) * u),
    )
    this.food = { x: fx, y: this.pet.feetY - 320 * u, vy: 0, landed: false }
    this.paused = false
    this.say(this.pickCanned('foodDrop'))
    this.setGoal(new SeekFoodGoal(this))
  }

  private updateFood(dt: number): void {
    const f = this.food
    if (!f || f.landed) return
    const prevY = f.y
    f.vy += GRAVITY * this.u * dt
    f.y += f.vy * dt
    const land = this.world.landingSurface(f.x, prevY, f.y + 4)
    if (land && f.vy > 0) {
      f.y = land.top
      f.vy = 0
      f.landed = true
    }
  }

  /** SeekFoodGoal 走到食物旁后调用：吃掉 + 数值反馈 */
  finishEat(): void {
    this.emotion.feed()
    this.anim.burst('heart', 4)
    this.anim.burst('sparkle', 3)
    this.say(this.pickCanned('eating'))
    this.food = null
    void emitAll('pet://memory-event', '被投喂了一顿')
  }

  /** 讨食冷却（planner 用）：90s 内不重复讨食 */
  canBeg(): boolean {
    return this.now() - this.lastBeg > 90_000
  }

  markBeg(): void {
    this.lastBeg = this.now()
  }

  // ---------- 外部事件总线（M5，附录 A.4） ----------

  /** 事件种类 → 行为/表情映射：构建结果、通知等外部事件即插即用 */
  onExternalEvent(kind: string, message?: string): void {
    const text = (message || '').trim()
    switch (kind) {
      case 'build-ok':
        this.setPose('HAPPY')
        this.anim.burst('sparkle', 5)
        this.say(text || '构建通过，干得漂亮！')
        this.setGoal(new HappyGoal(this, 1.6))
        break
      case 'build-fail':
        this.setPose('ANGRY')
        this.anim.burst('sweat', 2)
        this.say(text || '构建失败了，看看日志？')
        break
      case 'notify':
        this.setPose('SURPRISED')
        this.say(text || '有新通知！')
        break
      default:
        if (text) this.say(text)
        break
    }
  }

  // ---------- 待机序列（附录 A.2） ----------
  /** 60s 无互动且闲着 → 犯困入睡；睡着后鼠标在旁边移动 → 惊醒 */
  private maybeIdleSleep(dt: number): void {
    if (!this.settings.autoActivity || this.paused || this.dragging) return
    if (this.fsm.current === 'SLEEP') {
      if (this.world.cursorMovedRecently(1200) && this.cursorNearPet() < 320 * this.u) {
        this.setPose('SURPRISED')
        this.anim.burst('sweat', 1)
        this.emotion.lastInteraction = Date.now()
        this.setGoal(new IdleGoal(this, 1.5))
      }
      return
    }
    const idleLong = Date.now() - this.emotion.lastInteraction > 60_000
    const atRest =
      this.fsm.current === 'IDLE' && (!this.goal || this.goal.label.startsWith('idle'))
    if (idleLong && atRest) {
      this.idleSleepT += dt
      if (this.idleSleepT > 5) {
        this.idleSleepT = 0
        this.setGoal(new SleepGoal(this, 30 + Math.random() * 30))
      }
    } else {
      this.idleSleepT = 0
    }
  }

  // ---------- 气泡 / 说话 ----------

  say(text: string, opts: Partial<PetSayPayload> = {}): void {
    if (!text) return
    this.bubbleQueue.push({ text, emotion: opts.emotion, action: opts.action, fromChat: opts.fromChat })
    if (this.bubbleQueue.length > 2) this.bubbleQueue.shift()
  }

  /** 脚底到头顶的可视高度（css·scale）：bloub 是直径 68 的球，petdex 图集是 ATLAS_H 高 */
  private headRoom(): number {
    return (this.settings.petPack ? ATLAS_H : DOT_R * 2) * this.u
  }

  /** 气泡底边贴着头顶算：窗口几何是物理像素、DOM 是 CSS 像素，按 dpr 折算 */
  private pushBubble(): void {
    const dpr = this.dpr > 0 ? this.dpr : 1
    const bottom = Math.max(0, (PAD_BOTTOM * this.u + this.headRoom()) / dpr) + 24
    this.onBubble({ ...this.bubble, bottom })
  }

  private showNextBubble(t: number): void {
    const item = this.bubbleQueue.shift()
    if (!item) return
    // 流式刚结束：直接把流式气泡替换成最终台词，不再等它自然过期
    if (this.streaming && this.bubble.visible) {
      this.streaming = false
      this.bubble = { visible: true, text: item.text, bottom: 0 }
      this.bubbleUntil = t + Math.max(2400, Math.min(9000, 1500 + item.text.length * 170))
      this.pushBubble()
      this.applyBubbleEffects(item)
      return
    }
    this.bubble = { visible: true, text: item.text, bottom: 0 }
    this.bubbleUntil = t + Math.max(2400, Math.min(9000, 1500 + item.text.length * 170))
    this.pushBubble()
    this.applyBubbleEffects(item)
  }

  /** 气泡副作用统一出口：情绪结算、打断睡觉、TTS、记忆事件 */
  private applyBubbleEffects(item: PetSayPayload): void {
    if (item.fromChat) {
      this.emotion.onChat(item.emotion ?? 'neutral')
      // AI 表达关切时让表情可见（faceFor 的 concern 分支此前不可达）
      if (item.emotion === 'concern') this.emotion.setTransient('concern', 3600, this.now())
      if (item.emotion === 'happy') this.anim.burst('heart', 3)
      if (item.action) this.pendingIntent = item.action
    }
    // 打断睡觉
    if (this.fsm.current === 'SLEEP') this.setPose('IDLE')
    // 语音（M4：人格绑定音色/语速，style 传给 Rust 端选声）
    if (this.settings.ttsEnabled && isTauri) {
      void invoke('tts_speak', { text: item.text, style: this.settings.personality }).catch(() => {})
    }
    if (item.fromChat) {
      void emitAll('pet://memory-event', '和用户聊了天')
    }
  }

  /** 聊天流式输出：气泡实时跟字；每来一块就续命 3s，最终文本走 pet://say 替换 */
  showStream(text: string): void {
    if (!text) return
    this.streaming = true
    this.bubble = { visible: true, text, bottom: 0 }
    this.bubbleUntil = this.now() + 3000
    this.pushBubble()
  }

  pickCanned(kind: CannedKind): string {
    return pickCanned(this.settings.personality, kind, this.settings.petName)
  }

  // ---------- 鼠标交互 ----------

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return // 右键交给 contextmenu 处理，别误判成拖拽
    this.closeMenu()
    if (this.dragging) return
    const c = this.world.cursor
    this.dragging = true
    this.dragStart = { x: c.x, y: c.y, t: performance.now() }
    this.dragOrigin = { x: this.pet.x, feetY: this.pet.feetY }
    this.grabOffset = { x: c.x - this.winX, y: c.y - this.winY }
    this.dragMoved = 0
    this.dragSaid = false
    this.emotion.onDragStart(this.now())
    this.goal?.onAbort?.()
    this.goal = null
    this.fsm.force('DRAG', this.now())
    this.canvas.setPointerCapture?.(e.pointerId)
    try {
      this.canvas.style.cursor = 'grabbing'
    } catch {
      /* noop */
    }
  }

  private updateDrag(): void {
    const c = this.world.cursor
    this.dragMoved = Math.max(this.dragMoved, Math.hypot(c.x - this.dragStart.x, c.y - this.dragStart.y))
    // 真拖起来了（不是点摸）才喊"放我下来"
    if (!this.dragSaid && this.dragMoved > 26 * this.u) {
      this.dragSaid = true
      this.say(this.pickCanned('dragged'))
    }
    // 拖到哪停到哪：把脚底钳在本屏工作区内（可以拖到屏幕顶端，但不会拖出屏外）
    const m = this.world.monitorAt(c.x) ?? this.world.monitors.find((x) => x.primary) ?? null
    let px = c.x - this.grabOffset.x + this.winW / 2
    let py = c.y - this.grabOffset.y + this.winH - PAD_BOTTOM * this.u
    if (m) {
      const u = this.u
      // 用整块屏幕的矩形钳位（不是工作区），这样能拖到最顶端、也能压在任务栏上沿
      px = Math.max(m.x + 20 * u, Math.min(m.x + m.w - 20 * u, px))
      py = Math.max(m.y + 24 * u, Math.min(this.world.floorOf(m), py))
    }
    this.pet.x = px
    this.pet.feetY = py
    this.winX = px - this.winW / 2
    this.winY = py - this.winH + PAD_BOTTOM * this.u
    this.markPosDirty()
    // 松手检测（轮询兜底，防止 pointerup 丢失）
    if (isTauri && !this.world.cursorLeftDown && performance.now() - this.dragStart.t > 150) {
      this.onPointerUp()
    }
  }

  private onPointerUp(): void {
    if (!this.dragging) return
    this.dragging = false
    try {
      this.canvas.style.cursor = 'pointer'
    } catch {
      /* noop */
    }
    const quick = performance.now() - this.dragStart.t < 350 && this.dragMoved < 8 * this.u
    if (quick) {
      // 是"摸摸"不是拖拽：回到原位
      this.pet.x = this.dragOrigin.x
      this.pet.feetY = this.dragOrigin.feetY
      this.markPosDirty()
      this.onPatted()
      return
    }
    this.emotion.onDragEnd()
    this.say(this.pickCanned('dropped'))
    this.settleHere()
    void emitAll('pet://memory-event', '被用户拎起来又放下')
  }

  private onPatted(): void {
    const r = this.emotion.onPet(this.now())
    this.anim.burst('heart', r === 'angry' ? 0 : 3)
    this.setPose(r === 'angry' ? 'ANGRY' : 'HAPPY')
    this.say(this.pickCanned(r === 'angry' ? 'pettedAngry' : 'petted'))
    if (r === 'angry') {
      this.later(() => this.setPose('IDLE'), 1500)
    }
    this.goal = new IdleGoal(this, 1.6)
    this.goal.start()
    void emitAll('pet://memory-event', '被用户摸了摸')
  }

  /** 右键菜单：贴在宠物身侧弹出，不遮挡宠物；两侧都放不下才回退到光标处 */
  openMenu(x: number, y: number): void {
    const w = this.canvas.clientWidth || 200
    const h = this.canvas.clientHeight || 200
    this.menuOpen = true
    // 立刻把窗口从穿透态捞回来：菜单要能被点到，不能等下一帧的命中判定
    if (!this.interactive) {
      this.interactive = true
      if (isTauri) void invoke('set_pet_ignore_cursor_events', { ignore: false }).catch(() => {})
    }
    const MENU_W = 96
    const MENU_H = 70
    const b = this.petCssBounds(w, h)
    let mx = b.right + 8
    if (mx + MENU_W > w - 4) mx = b.left - MENU_W - 8
    if (mx < 4) mx = Math.max(4, Math.min(x, w - MENU_W - 4))
    const my = Math.max(4, Math.min(y, h - MENU_H - 4))
    this.onMenu?.({ x: mx, y: my })
  }

  /** 宠物可视边界（canvas 内 css px）：气泡锚点、右键菜单与命中判定共用 */
  private petCssBounds(w: number, h: number): { left: number; right: number; top: number } {
    const scale = this.settings.scale
    const isPack = !!this.settings.petPack
    const halfW = ((isPack ? (ATLAS_H * 192) / 208 : DOT_R * 2) / 2) * scale
    const height = (isPack ? ATLAS_H : DOT_R * 2) * scale
    const cx = w / 2
    const feet = h - PAD_BOTTOM * scale
    return { left: cx - halfW, right: cx + halfW, top: feet - height }
  }

  closeMenu(): void {
    if (!this.menuOpen) return
    this.menuOpen = false
    this.onMenu?.(null)
  }

  private updateHitTest(): void {
    if (!isTauri) return
    const c = this.world.cursor
    const lx = c.x - this.winX
    const ly = c.y - this.winY
    const u = this.u
    const cx = this.winW / 2
    const feet = this.winH - PAD_BOTTOM * u
    // dot 只有一颗球，命中框按球来算，别沿用动物形态那 90u 宽、185u 高
    const halfW = 40 * u // 黑点命中框：半径 34u 的球留一点容差
    const hit =
      this.dragging ||
      this.menuOpen ||
      (!this.settings.clickThrough &&
        lx > cx - halfW &&
        lx < cx + halfW &&
        ly > feet - this.headRoom() &&
        ly < feet + 6 * u)
    if (hit !== this.interactive) {
      this.interactive = hit
      void invoke('set_pet_ignore_cursor_events', { ignore: !hit }).catch(() => {})
    }
  }

  // ---------- 窗口同步 ----------

  markPosDirty(): void {
    this.posDirty = true
  }

  private syncWindowPos(): void {
    if (!isTauri) return
    const wx = this.pet.x - this.winW / 2
    const wy = this.pet.feetY - this.winH + PAD_BOTTOM * this.u
    this.winX = wx
    this.winY = wy
    if (Math.abs(wx - this.lastSent.x) < 0.5 && Math.abs(wy - this.lastSent.y) < 0.5) {
      this.posDirty = false
      return
    }
    if (!this.posDirty) return
    if (this.posInFlight) return
    // 高刷屏下 rAF 可达 120Hz+，位置 IPC 限到 ~60Hz（附录 B6）；
    // 节流时保留 posDirty，停步后的最终位置由后续 tick 补发，不会丢帧卡位
    if (performance.now() - this.lastPosSentT < 16) return
    this.posInFlight = true
    const send = async () => {
      // 整段 try/finally：一次失败也必须复位 posInFlight，否则位置同步从此永久卡死（B4）
      try {
        while (this.posDirty) {
          this.posDirty = false
          const x = this.pet.x - this.winW / 2
          const y = this.pet.feetY - this.winH + PAD_BOTTOM * this.u
          this.winX = x
          this.winY = y
          this.lastPosSentT = performance.now()
          await invoke('set_pet_position', { x: Math.round(x), y: Math.round(y) })
          this.lastSent = { x, y }
        }
      } catch (e) {
        this.log(`syncWindowPos failed: ${e}`)
      } finally {
        this.posInFlight = false
      }
    }
    void send()
  }

  // ---------- 外部事件 ----------

  /** 全局热键 Ctrl+Shift+U：翻转强制穿透并持久化 */
  private toggleClickThrough(): void {
    this.settings = { ...this.settings, clickThrough: !this.settings.clickThrough }
    void import('../store').then(({ saveSettings }) => saveSettings(this.settings))
    this.say(this.settings.clickThrough ? '开启穿透，我先隐身啦（Ctrl+Shift+U 喊我回来）' : '我回来啦！')
  }

  private maybeSavePetState(dt: number): void {
    if (!isTauri || this.dragging || this.pet.airborne) return
    this.petStateT += dt
    if (this.petStateT < 10) return
    this.petStateT = 0
    const x = Math.round(this.pet.x)
    const y = Math.round(this.pet.feetY)
    if (x === this.lastSavedPet.x && y === this.lastSavedPet.y) return
    this.lastSavedPet = { x, y }
    void invoke('write_data', {
      name: 'petstate',
      data: {
        x,
        feetY: y,
        hunger: Math.round(this.emotion.v.hunger),
        affection: Math.round(this.emotion.v.affection),
      },
    }).catch(() => {})
  }

  summon(): void {
    const m = this.world.monitorAt(this.world.cursor.x) ?? this.world.monitors.find((x) => x.primary) ?? null
    if (!m) return
    this.paused = false
    const u = this.u
    this.pet.x = m.wx + m.ww - 200 * u
    this.pet.feetY = m.wy + m.wh
    this.pet.airborne = false
    this.pet.vy = 0
    this.pet.support = { kind: 'floor', id: m.id }
    // 显式同步窗口：若 syncWindowPos 曾失败卡死，这里能兜底恢复
    this.winX = this.pet.x - this.winW / 2
    this.winY = this.pet.feetY - this.winH + PAD_BOTTOM * this.u
    this.lastSent = { x: NaN, y: NaN }
    this.markPosDirty()
    this.setPose('HAPPY')
    this.anim.burst('heart', 6)
    this.say(this.pickCanned('summoned'))
    this.setGoal(new HappyGoal(this, 1.6))
  }

  applySettings(s: Settings): void {
    const prevScale = this.settings.scale
    this.settings = s
    if (Math.abs(prevScale - s.scale) > 0.01 && isTauri) {
      void invoke('set_pet_scale', { scale: s.scale }).then(() =>
        invoke<{ x: number; y: number; w: number; h: number; scale: number }>('get_window_info', {
          label: 'pet',
        }).then((info) => {
          if (info) {
            this.winW = info.w
            this.winH = info.h
            this.dpr = info.scale || this.dpr
            this.u = this.dpr * s.scale
            this.renderer.resize(this.winW, this.winH)
            this.pet.feetY = info.y + info.h - PAD_BOTTOM * this.u
            this.pet.x = info.x + info.w / 2
            // 缩放后几何变了，强制下一次 syncWindowPos 发送
            this.lastSent = { x: NaN, y: NaN }
            this.markPosDirty()
          }
        }),
      )
    }
  }

  // 预览调试接口
  debug: {
    sleep: () => void
    wander: () => void
    climb: () => void
    dance: () => void
    pat: () => void
    feed: () => void
  } = {
    sleep: () => this.setGoal(new SleepGoal(this, 10)),
    wander: () => this.setGoal(new WanderGoal(this)),
    climb: () => {
      const w: OSWindow | null = this.world.bestWindowNear(this.pet.x, this.pet.feetY)
      if (w) this.setGoal(new ClimbGoal(this, w))
      else this.say('附近没有可以跳的窗口呀')
    },
    dance: () => this.setGoal(new DanceGoal(this, 3)),
    pat: () => this.onPatted(),
    feed: () => this.dropFood(),
  }
}
