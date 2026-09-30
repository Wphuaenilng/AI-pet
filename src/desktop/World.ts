// 桌面世界：显示器 / 可见窗口 / 全局鼠标的轮询与查询
import {
  invoke,
  isTauri,
  type CursorInfo,
  type DesktopInfo,
  type MonitorInfo,
  type OSWindow,
  type Rect,
} from '../lib/tauri'

export interface Surface {
  kind: 'floor' | 'window'
  id: number
  top: number
  left: number
  right: number
}

export class World {
  monitors: MonitorInfo[] = []
  windows: OSWindow[] = []
  taskbar: Rect | null = null
  cursor = { x: 0, y: 0 }
  cursorLeftDown = false
  cursorMovedAt = 0
  private timer = 0
  private cursorTimer = 0
  private previewOffs: (() => void)[] = []
  private onCursorMove?: (x: number, y: number) => void

  constructor(private preview: boolean) {}

  async start(onCursorMove?: (x: number, y: number) => void): Promise<void> {
    this.onCursorMove = onCursorMove
    if (!isTauri || this.preview) {
      // 浏览器预览用的假世界（跟随视口大小）
      const vw = window.innerWidth
      const vh = window.innerHeight
      this.monitors = [
        { id: 0, x: 0, y: 0, w: vw, h: vh, wx: 0, wy: 0, ww: vw, wh: vh - 40, primary: true },
      ]
      this.windows = [
        { id: 101, title: 'VS Code — desktop-ai-pet', x: vw * 0.1, y: vh * 0.14, w: vw * 0.45, h: vh - 40 - vh * 0.14 },
        { id: 102, title: 'Chrome — AI 宠物设计文档', x: vw * 0.6, y: vh * 0.2, w: vw * 0.32, h: (vh - 40 - vh * 0.2) * 0.8 },
      ]
      this.taskbar = { x: 0, y: vh - 40, w: vw, h: 40 }
      this.cursor = { x: vw * 0.8, y: vh * 0.72 }
      const onMouseMove = (e: MouseEvent) => {
        const moved = e.clientX !== this.cursor.x || e.clientY !== this.cursor.y
        this.cursor = { x: e.clientX, y: e.clientY }
        if (moved) {
          this.cursorMovedAt = performance.now()
          this.onCursorMove?.(this.cursor.x, this.cursor.y)
        }
      }
      const onMouseDown = () => (this.cursorLeftDown = true)
      const onMouseUp = () => (this.cursorLeftDown = false)
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mousedown', onMouseDown)
      window.addEventListener('mouseup', onMouseUp)
      this.previewOffs.push(
        () => window.removeEventListener('mousemove', onMouseMove),
        () => window.removeEventListener('mousedown', onMouseDown),
        () => window.removeEventListener('mouseup', onMouseUp),
      )
      return
    }
    await this.refresh()
    this.timer = window.setInterval(() => {
      this.refresh().catch(() => {})
    }, 600)
    this.cursorTimer = window.setInterval(() => {
      invoke<CursorInfo>('get_cursor_pos')
        .then((c) => {
          if (!c) return
          const moved = c.x !== this.cursor.x || c.y !== this.cursor.y
          this.cursor = { x: c.x, y: c.y }
          this.cursorLeftDown = c.left_down
          if (moved) {
            this.cursorMovedAt = performance.now()
            this.onCursorMove?.(c.x, c.y)
          }
        })
        .catch(() => {})
    }, 32)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.cursorTimer) clearInterval(this.cursorTimer)
    this.timer = 0
    this.cursorTimer = 0
    for (const off of this.previewOffs) off()
    this.previewOffs = []
  }

  async refresh(): Promise<void> {
    const info = await invoke<DesktopInfo>('get_desktop_info')
    if (!info) return
    if (info.monitors.length) this.monitors = info.monitors
    this.windows = info.windows
    this.taskbar = info.taskbar
  }

  monitorAt(x: number): MonitorInfo | null {
    let best: MonitorInfo | null = null
    let bestDist = Infinity
    for (const m of this.monitors) {
      if (x >= m.x && x < m.x + m.w) return m
      const d = Math.min(Math.abs(x - m.x), Math.abs(x - (m.x + m.w)))
      if (d < bestDist) {
        bestDist = d
        best = m
      }
    }
    return best
  }

  floorOf(m: MonitorInfo): number {
    return m.wy + m.wh
  }

  /** 脚底 (x, feetY) 处正踩着的表面 */
  surfaceAt(x: number, feetY: number, tol = 4): Surface | null {
    for (const w of this.windows) {
      if (x >= w.x + 6 && x <= w.x + w.w - 6 && Math.abs(feetY - w.y) <= tol) {
        return { kind: 'window', id: w.id, top: w.y, left: w.x, right: w.x + w.w }
      }
    }
    const m = this.monitorAt(x)
    if (m && Math.abs(feetY - this.floorOf(m)) <= tol) {
      const fy = this.floorOf(m)
      return { kind: 'floor', id: m.id, top: fy, left: m.wx, right: m.wx + m.ww }
    }
    return null
  }

  /** 下落时脚底从 prevY 到 newY 之间最先接触的表面 */
  landingSurface(x: number, prevY: number, newY: number): Surface | null {
    let best: Surface | null = null
    for (const w of this.windows) {
      if (x >= w.x + 6 && x <= w.x + w.w - 6 && w.y >= prevY - 1 && w.y <= newY + 1) {
        if (!best || w.y < best.top) {
          best = { kind: 'window', id: w.id, top: w.y, left: w.x, right: w.x + w.w }
        }
      }
    }
    const m = this.monitorAt(x)
    if (m) {
      const fy = this.floorOf(m)
      if (fy >= prevY - 1 && fy <= newY + 1 && (!best || fy < best.top)) {
        best = { kind: 'floor', id: m.id, top: fy, left: m.wx, right: m.wx + m.ww }
      }
    }
    return best
  }

  /** (x, yMin..yMax) 附近最高的窗口顶，用于小台阶 / 跳跃目标 */
  windowTopNear(x: number, yMin: number, yMax: number): Surface | null {
    let best: Surface | null = null
    for (const w of this.windows) {
      if (x >= w.x + 6 && x <= w.x + w.w - 6 && w.y >= yMin && w.y <= yMax) {
        if (!best || w.y > best.top) {
          best = { kind: 'window', id: w.id, top: w.y, left: w.x, right: w.x + w.w }
        }
      }
    }
    return best
  }

  windowById(id: number): OSWindow | null {
    return this.windows.find((w) => w.id === id) ?? null
  }

  /** 宠物附近可以跳上去的窗口 */
  bestWindowNear(x: number, feetY: number): OSWindow | null {
    let best: OSWindow | null = null
    let bestScore = Infinity
    for (const w of this.windows) {
      const cx = w.x + w.w / 2
      const dx = Math.abs(cx - x)
      const dy = feetY - w.y
      if (dy < 20 || dy > 700) continue
      if (dx > 1000) continue
      const score = dx + dy
      if (score < bestScore) {
        bestScore = score
        best = w
      }
    }
    return best
  }

  cursorMovedRecently(withinMs: number): boolean {
    return performance.now() - this.cursorMovedAt < withinMs
  }
}
