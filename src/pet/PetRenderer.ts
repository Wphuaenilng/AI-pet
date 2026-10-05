// 宠物渲染器：纯 Canvas 程序化绘制，无外部素材依赖
// Species 唯一定义在 lib/tauri.ts，此处转出供旧引用（PetAnimation）继续使用
import type { Species } from '../lib/tauri'
export type { Species }
export type PoseKind = 'stand' | 'walk' | 'sit' | 'lay' | 'sleep' | 'hang' | 'jump'
export type EyeState = 'open' | 'happy' | 'closed' | 'surprised' | 'angry' | 'sad' | 'sleepy' | 'wink'
export type MouthKind = 'smile' | 'cat' | 'open' | 'o' | 'frown' | 'flat'

export interface Face {
  eyes: EyeState
  eyeDX: number // -1..1
  eyeDY: number
  pupilDX: number // 滞后一阶的眼珠偏移，dot 靠它做"慢半拍"的呆萌感
  pupilDY: number
  mouth: MouthKind
  blush: number // 0..1
  talk: number // 说话张嘴 0..1
}

export interface Particle {
  kind: 'zzz' | 'heart' | 'sweat' | 'note' | 'sparkle'
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  size: number
}

export interface Pose {
  species: Species
  u: number // 设备像素/逻辑像素 比例（含缩放）
  cx: number // 画布内水平中心（设备像素）
  feetY: number // 画布内脚底（设备像素）
  facing: 1 | -1
  pose: PoseKind
  walkPhase: number
  breathe: number
  tailPhase: number
  headTilt: number
  face: Face
  squash: number // 落地挤压 0..1
  particles: Particle[]
  eyeClosed: number // 眨眼程度 0..1
}

interface Palette {
  fur: string
  furDark: string
  outline: string
  belly: string
  ear: string
  cheek: string
  nose: string
}

const DOT_WHITE = '#FFFFFF'
const DOT_TEAR = '#9BD4FF'

const PAL: Record<Species, Palette> = {
  cat: { fur: '#FFB05C', furDark: '#E8903A', outline: '#8A5522', belly: '#FFE9C4', ear: '#FFB3C1', cheek: '#FFC7CF', nose: '#F27D9B' },
  bunny: { fur: '#F1ECFA', furDark: '#D5C9EE', outline: '#7A6B9E', belly: '#FFFFFF', ear: '#FFC9D6', cheek: '#FFCBD4', nose: '#F27D9B' },
  fox: { fur: '#FF9A4D', furDark: '#E07B2E', outline: '#7C4218', belly: '#FFF3E0', ear: '#FFD9C2', cheek: '#FFC0A8', nose: '#8A5522' },
  // dot：fur 是球体本色，outline 反过来用作亮色 rim（深色壁纸上纯黑轮廓会消失），belly 是顶部高光
  dot: { fur: '#16181D', furDark: '#0B0C0F', outline: 'rgba(255,255,255,0.16)', belly: '#2B3038', ear: '#000000', cheek: '#FF8AA0', nose: '#FFFFFF' },
}

export class PetRenderer {
  private ctx: CanvasRenderingContext2D

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d unavailable')
    this.ctx = ctx
  }

  resize(w: number, h: number): void {
    this.canvas.width = Math.max(1, Math.round(w))
    this.canvas.height = Math.max(1, Math.round(h))
  }

  render(p: Pose): void {
    const ctx = this.ctx
    const W = this.canvas.width
    const H = this.canvas.height
    ctx.clearRect(0, 0, W, H)
    const u = p.u
    const s = p.facing
    const pal = PAL[p.species]

    // 黑点是一颗没有耳/尾/四肢的球，几何与三种动物完全不同，单独成一条渲染路径
    if (p.species === 'dot') {
      this.drawDot(p, pal)
      this.drawParticles(p)
      return
    }

    // 落地挤压的整体形变
    ctx.save()
    if (p.squash > 0.01) {
      const sq = Math.min(1, p.squash)
      ctx.translate(p.cx, p.feetY)
      ctx.scale(1 + 0.18 * sq, 1 - 0.22 * sq)
      ctx.translate(-p.cx, -p.feetY)
    }

    // 各姿态的几何
    let bodyRx = 44 * u
    let bodyRy = 36 * u
    let legH = 13 * u
    let by = 0 // 身体中心 y
    let hx = p.cx // 头中心
    let hy = 0
    let bob = 0

    switch (p.pose) {
      case 'walk': {
        bob = -Math.abs(Math.sin(p.walkPhase)) * 3.2 * u
        by = p.feetY - legH - bodyRy + bob
        hy = by - bodyRy - 40 * u + 15 * u + bob * 0.4
        break
      }
      case 'sit': {
        bodyRx = 40 * u
        bodyRy = 44 * u
        by = p.feetY - 38 * u
        hy = by - bodyRy + 8 * u
        hx = p.cx + s * 2 * u
        break
      }
      case 'lay':
      case 'sleep': {
        bodyRx = 54 * u
        bodyRy = 23 * u
        by = p.feetY - 20 * u
        hx = p.cx + s * 30 * u
        hy = p.feetY - 34 * u
        break
      }
      case 'hang': {
        bodyRx = 35 * u
        bodyRy = 45 * u
        legH = 0
        by = p.feetY - 108 * u
        hy = by - bodyRy + 6 * u
        break
      }
      case 'jump': {
        legH = 6 * u
        by = p.feetY - legH - bodyRy
        hy = by - bodyRy - 40 * u + 14 * u
        break
      }
      default: {
        // stand
        by = p.feetY - legH - bodyRy + Math.sin(p.breathe) * 1.2 * u
        hy = by - bodyRy - 40 * u + 15 * u
      }
    }

    const breathe = 1 + 0.025 * Math.sin(p.breathe)

    // 尾巴（身体后面）
    this.drawTail(p, pal, by, bodyRx, bodyRy)

    if (p.pose === 'sit') {
      // 后腿/臀部
      ctx.fillStyle = pal.furDark
      this.ellipse(p.cx - s * 14 * u, p.feetY - 16 * u, 21 * u, 17 * u)
    }

    // 身体
    ctx.fillStyle = pal.fur
    ctx.strokeStyle = pal.outline
    ctx.lineWidth = 2 * u
    ctx.globalAlpha = 1
    this.ellipse(p.cx, by, bodyRx, bodyRy * breathe, true, true)

    // 肚皮
    ctx.fillStyle = pal.belly
    if (p.pose === 'lay' || p.pose === 'sleep') {
      this.ellipse(p.cx + s * 6 * u, by + 6 * u, bodyRx * 0.55, bodyRy * 0.5)
    } else {
      this.ellipse(p.cx + s * 4 * u, by + bodyRy * 0.25, bodyRx * 0.52, bodyRy * 0.55)
    }

    // 腿/爪
    ctx.fillStyle = pal.fur
    if (p.pose === 'walk' || p.pose === 'stand' || p.pose === 'jump' || p.pose === 'hang') {
      if (p.pose === 'walk') {
        const swing = Math.sin(p.walkPhase) * 9 * u
        this.paw(p.cx - 13 * u + swing, p.feetY - 5 * u, 9 * u, pal)
        this.paw(p.cx + 13 * u - swing, p.feetY - 5 * u, 9 * u, pal)
      } else if (p.pose === 'hang') {
        const wig = Math.sin(p.tailPhase * 2.2) * 5 * u
        this.paw(p.cx - 15 * u + wig, p.feetY - 8 * u, 8.5 * u, pal)
        this.paw(p.cx + 15 * u - wig, p.feetY - 8 * u, 8.5 * u, pal)
      } else if (p.pose === 'jump') {
        this.paw(p.cx - 14 * u, p.feetY - 2 * u, 8 * u, pal)
        this.paw(p.cx + 14 * u, p.feetY - 2 * u, 8 * u, pal)
      } else {
        this.paw(p.cx - 13 * u, p.feetY - 5 * u, 9 * u, pal)
        this.paw(p.cx + 13 * u, p.feetY - 5 * u, 9 * u, pal)
      }
    } else if (p.pose === 'sit') {
      this.paw(p.cx - 10 * u, p.feetY - 6 * u, 8.5 * u, pal)
      this.paw(p.cx + 10 * u, p.feetY - 6 * u, 8.5 * u, pal)
    } else {
      // lay / sleep 前爪
      this.paw(p.cx + s * 42 * u, p.feetY - 7 * u, 8 * u, pal)
      this.paw(p.cx + s * 26 * u, p.feetY - 9 * u, 8 * u, pal)
    }

    // 头
    const tilt = p.headTilt
    ctx.save()
    ctx.translate(hx, hy)
    ctx.rotate(tilt)
    // 耳朵
    this.drawEars(p, pal, 0, 0)
    // 头圆
    ctx.fillStyle = pal.fur
    ctx.strokeStyle = pal.outline
    ctx.lineWidth = 2 * u
    this.ellipse(0, 0, 40 * u, 37 * u, true, true)
    // 脸
    this.drawFace(p, pal, 0, 0)
    ctx.restore()

    ctx.restore()

    // 粒子
    this.drawParticles(p)
  }

  private paw(x: number, y: number, r: number, pal: Palette): void {
    this.ellipse(x, y, r, r * 0.8, true, true, pal.fur, pal.outline)
  }

  /**
   * 小黑点：形变（squash & stretch）就是它的全部表演，五官随球体一起压扁。
   * 所有绘制都在"以脚底为锚点的缩放"内部完成，因此挤压时眼睛也会跟着变形。
   */
  private drawDot(p: Pose, pal: Palette): void {
    const ctx = this.ctx
    const u = p.u
    const R = 34 * u
    const sq = Math.min(1, p.squash)

    let sx = 1
    let lift = 0
    switch (p.pose) {
      case 'walk': {
        const hop = Math.abs(Math.sin(p.walkPhase))
        lift = -hop * 6 * u
        sx = 1 - hop * 0.07
        break
      }
      case 'sit':
        sx = 1.14
        break
      case 'lay':
      case 'sleep':
        sx = 1.34
        break
      case 'hang':
        sx = 0.82
        break
      case 'jump':
        sx = 0.87
        break
      default: {
        const br = Math.sin(p.breathe)
        sx = 1 - br * 0.018
        lift = -Math.abs(br) * 1.2 * u
      }
    }
    // 体积守恒：横向压多少纵向就涨多少，落地挤压再叠一层
    let sy = 1 / sx
    sx *= 1 + 0.18 * sq
    sy *= 1 - 0.22 * sq

    const cy = p.feetY - R + lift
    ctx.save()
    ctx.translate(p.cx, p.feetY)
    ctx.rotate(p.headTilt * 0.6 + (p.pose === 'walk' ? Math.sin(p.walkPhase) * 0.05 : 0))
    ctx.scale(sx, sy)
    ctx.translate(-p.cx, -p.feetY)

    ctx.beginPath()
    ctx.ellipse(p.cx, cy, R, R, 0, 0, Math.PI * 2)
    ctx.fillStyle = pal.fur
    ctx.fill()
    ctx.lineWidth = 1.6 * u
    ctx.strokeStyle = pal.outline
    ctx.stroke()

    // 顶部高光：让球体有体积，不至于看成一张黑纸片
    ctx.globalAlpha = 0.45
    ctx.fillStyle = pal.belly
    ctx.beginPath()
    ctx.ellipse(p.cx - R * 0.26, cy - R * 0.52, R * 0.36, R * 0.19, -0.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1

    this.drawDotFace(p, pal, cy, R)
    ctx.restore()
  }

  private drawDotFace(p: Pose, pal: Palette, cy: number, R: number): void {
    const ctx = this.ctx
    const u = p.u
    const f = p.face
    const shift = p.facing * 2 * u
    const cx = p.cx + shift
    const ex = 13 * u
    const ey = cy - 4 * u
    const erx = 8.5 * u
    const ery = 10.5 * u
    const pdx = f.pupilDX * 3.4 * u
    const pdy = f.pupilDY * 2.8 * u
    const blinking = p.eyeClosed > 0.82

    /** 上眼皮：用球体本色盖住眼睛上半，做出生气/困倦/垂眼的裁切（inner 指靠鼻子那侧） */
    const lid = (x: number, side: -1 | 1, innerY: number, outerY: number) => {
      const w = erx * 1.25
      const ix = x - side * w
      const ox = x + side * w
      ctx.fillStyle = pal.fur
      ctx.beginPath()
      ctx.moveTo(ix, ey - ery * 1.3)
      ctx.lineTo(ox, ey - ery * 1.3)
      ctx.lineTo(ox, outerY)
      ctx.lineTo(ix, innerY)
      ctx.closePath()
      ctx.fill()
    }

    const eye = (side: -1 | 1) => {
      const x = cx + side * ex
      const kind: EyeState = f.eyes === 'wink' ? (side === p.facing ? 'closed' : 'open') : f.eyes

      if (blinking && (kind === 'open' || kind === 'surprised' || kind === 'sad' || kind === 'sleepy')) {
        ctx.strokeStyle = DOT_WHITE
        ctx.lineWidth = 2.6 * u
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(x - erx * 0.8, ey)
        ctx.quadraticCurveTo(x, ey + ery * 0.5, x + erx * 0.8, ey)
        ctx.stroke()
        return
      }

      switch (kind) {
        case 'happy': {
          ctx.strokeStyle = DOT_WHITE
          ctx.lineWidth = 3.2 * u
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.arc(x, ey + 3.5 * u, erx * 0.95, Math.PI * 1.15, Math.PI * 1.85)
          ctx.stroke()
          return
        }
        case 'closed': {
          ctx.strokeStyle = DOT_WHITE
          ctx.lineWidth = 2.8 * u
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.arc(x, ey - 2.5 * u, erx * 0.95, Math.PI * 0.15, Math.PI * 0.85)
          ctx.stroke()
          return
        }
        case 'surprised': {
          ctx.fillStyle = DOT_WHITE
          ctx.beginPath()
          ctx.ellipse(x, ey, erx * 1.18, ery * 1.18, 0, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = pal.furDark
          ctx.beginPath()
          ctx.arc(x + pdx * 0.5, ey + pdy * 0.5, 2.6 * u, 0, Math.PI * 2)
          ctx.fill()
          return
        }
        case 'angry': {
          ctx.fillStyle = DOT_WHITE
          ctx.beginPath()
          ctx.ellipse(x, ey + 1 * u, erx * 0.95, ery * 0.8, 0, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = pal.furDark
          ctx.beginPath()
          ctx.arc(x + pdx, ey + 2 * u + pdy * 0.5, 3.2 * u, 0, Math.PI * 2)
          ctx.fill()
          // 内侧低、外侧高的斜眼皮 = 皱眉
          lid(x, side, ey - 1 * u, ey - 6.5 * u)
          return
        }
        case 'sad': {
          ctx.fillStyle = DOT_WHITE
          ctx.beginPath()
          ctx.ellipse(x, ey + 1.5 * u, erx * 0.9, ery * 0.95, 0, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = pal.furDark
          ctx.beginPath()
          ctx.arc(x + pdx * 0.6, ey + 3 * u + pdy * 0.6, 3.2 * u, 0, Math.PI * 2)
          ctx.fill()
          // 内侧高、外侧低 = 八字眉，比 sad 更"委屈"
          lid(x, side, ey - 7 * u, ey - 2.5 * u)
          ctx.fillStyle = DOT_TEAR
          ctx.beginPath()
          ctx.ellipse(x + side * erx * 0.9, ey + ery * 0.85, 2.2 * u, 3 * u, 0, 0, Math.PI * 2)
          ctx.fill()
          return
        }
        case 'sleepy': {
          ctx.fillStyle = DOT_WHITE
          ctx.beginPath()
          ctx.ellipse(x, ey + 2.5 * u, erx * 0.95, ery * 0.7, 0, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = pal.furDark
          ctx.beginPath()
          ctx.arc(x + pdx * 0.5, ey + 4 * u, 3 * u, 0, Math.PI * 2)
          ctx.fill()
          lid(x, side, ey - 1.5 * u, ey - 1.5 * u)
          return
        }
        default: {
          ctx.fillStyle = DOT_WHITE
          ctx.beginPath()
          ctx.ellipse(x, ey, erx, ery, 0, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = pal.furDark
          ctx.beginPath()
          ctx.arc(x + pdx, ey + pdy, 3.6 * u, 0, Math.PI * 2)
          ctx.fill()
          // 眼珠里点一颗反光，白眼黑瞳容易看成死鱼眼
          ctx.fillStyle = DOT_WHITE
          ctx.beginPath()
          ctx.arc(x + pdx - 1.1 * u, ey + pdy - 1.3 * u, 1.1 * u, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    eye(-1)
    eye(1)

    // 腮红
    if (f.blush > 0) {
      ctx.globalAlpha = 0.2 + f.blush * 0.35
      ctx.fillStyle = pal.cheek
      ctx.beginPath()
      ctx.ellipse(cx - 22 * u, cy + 7 * u, 6 * u, 3.6 * u, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.ellipse(cx + 22 * u, cy + 7 * u, 6 * u, 3.6 * u, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }

    // 嘴：黑底上用白色描线，空心比实心更透气
    const my = cy + R * 0.42
    ctx.strokeStyle = DOT_WHITE
    ctx.lineWidth = 2.4 * u
    ctx.lineCap = 'round'
    switch (f.mouth) {
      case 'open': {
        ctx.beginPath()
        ctx.ellipse(cx, my, 5.4 * u, (2.6 + (f.talk > 0.45 ? 4.4 : 1)) * u, 0, 0, Math.PI * 2)
        ctx.stroke()
        break
      }
      case 'o': {
        ctx.beginPath()
        ctx.arc(cx, my, 4.2 * u, 0, Math.PI * 2)
        ctx.stroke()
        break
      }
      case 'smile': {
        ctx.beginPath()
        ctx.arc(cx, my - 1.5 * u, 5.6 * u, Math.PI * 0.15, Math.PI * 0.85)
        ctx.stroke()
        break
      }
      case 'frown': {
        ctx.beginPath()
        ctx.arc(cx, my + 5 * u, 5.6 * u, Math.PI * 1.15, Math.PI * 1.85)
        ctx.stroke()
        break
      }
      case 'cat': {
        ctx.beginPath()
        ctx.arc(cx - 3.4 * u, my - 1 * u, 3.4 * u, Math.PI * 0.1, Math.PI * 0.9)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(cx + 3.4 * u, my - 1 * u, 3.4 * u, Math.PI * 0.1, Math.PI * 0.9)
        ctx.stroke()
        break
      }
      default: {
        ctx.beginPath()
        ctx.moveTo(cx - 4.6 * u, my)
        ctx.lineTo(cx + 4.6 * u, my)
        ctx.stroke()
      }
    }
  }

  private drawTail(p: Pose, pal: Palette, by: number, bodyRx: number, bodyRy: number): void {
    const ctx = this.ctx
    const s = p.facing
    const u = p.u
    const bx = p.cx - s * bodyRx * 0.72
    const baseY = by - bodyRy * 0.05
    const sway = Math.sin(p.tailPhase) * 14 * u
    ctx.strokeStyle = pal.fur
    ctx.lineWidth = 8 * u
    ctx.lineCap = 'round'
    if (p.species === 'bunny') {
      ctx.fillStyle = pal.belly
      ctx.beginPath()
      ctx.arc(bx, by + 6 * u, 10 * u, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    if (p.pose === 'sit') {
      // 卷尾
      ctx.beginPath()
      ctx.moveTo(bx, baseY)
      ctx.quadraticCurveTo(bx - s * 34 * u, baseY + 6 * u + sway * 0.3, bx - s * 20 * u, baseY - 30 * u - sway * 0.4)
      ctx.stroke()
      ctx.fillStyle = pal.furDark
      ctx.beginPath()
      ctx.arc(bx - s * 20 * u, baseY - 30 * u - sway * 0.4, 6.5 * u, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    if (p.pose === 'lay' || p.pose === 'sleep') {
      // 尾巴贴地铺在身旁
      ctx.beginPath()
      ctx.moveTo(bx, baseY + 10 * u)
      ctx.quadraticCurveTo(bx - s * 22 * u, baseY + 18 * u, bx - s * 38 * u, baseY + 12 * u)
      ctx.stroke()
      ctx.fillStyle = p.species === 'fox' ? '#FFFFFF' : pal.furDark
      ctx.beginPath()
      ctx.arc(bx - s * 38 * u, baseY + 12 * u, 6 * u, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    // 站立/走路：上扬摇摆尾
    ctx.beginPath()
    ctx.moveTo(bx, baseY)
    ctx.quadraticCurveTo(
      bx - s * 26 * u,
      baseY + 10 * u + sway * 0.4,
      bx - s * 34 * u,
      baseY - 44 * u + sway,
    )
    ctx.stroke()
    // 狐狸白尾尖
    ctx.fillStyle = p.species === 'fox' ? '#FFFFFF' : pal.furDark
    ctx.beginPath()
    ctx.arc(bx - s * 34 * u, baseY - 44 * u + sway, 6.5 * u, 0, Math.PI * 2)
    ctx.fill()
  }

  private drawEars(p: Pose, pal: Palette, hx: number, hy: number): void {
    const ctx = this.ctx
    const u = p.u
    const droop = p.pose === 'hang' ? 0.9 : p.pose === 'sleep' || p.pose === 'lay' ? 0.35 : 0
    ctx.fillStyle = pal.fur
    ctx.strokeStyle = pal.outline
    ctx.lineWidth = 2 * u
    if (p.species === 'bunny') {
      for (const side of [-1, 1]) {
        ctx.save()
        ctx.translate(side * 17 * u, -28 * u)
        ctx.rotate(side * (0.12 + droop * 0.7))
        this.ellipse(0, 0, 10 * u, 30 * u, true, true)
        ctx.fillStyle = pal.ear
        this.ellipse(0, 2 * u, 5 * u, 21 * u)
        ctx.fillStyle = pal.fur
        ctx.restore()
      }
      return
    }
    // 猫 / 狐狸：三角耳
    const spread = p.species === 'fox' ? 1.15 : 1
    const height = (p.species === 'fox' ? 40 : 32) * u * (1 - droop * 0.55)
    for (const side of [-1, 1]) {
      const x0 = side * 15 * u
      const y0 = -26 * u
      const x1 = side * 30 * u * spread
      const y1 = -26 * u + 4 * u + droop * 14 * u
      const x2 = side * 34 * u * spread
      const y2 = -26 * u - height
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.quadraticCurveTo(x2 * 0.7, y2 * 0.9, x2, y2)
      ctx.quadraticCurveTo(x2 * 0.8, y2 * 0.5, x1, y1)
      ctx.closePath()
      ctx.fill()
      // 内耳
      ctx.fillStyle = pal.ear
      ctx.beginPath()
      const mx = (x0 + x2 * 0.85) / 2
      const my = (y0 + y2 * 0.85) / 2
      ctx.moveTo(mx + 2 * u, my + 3 * u)
      ctx.lineTo(x2 * 0.86, y2 * 0.82)
      ctx.lineTo(x2 * 0.62, my + 8 * u)
      ctx.closePath()
      ctx.fill()
      ctx.fillStyle = pal.fur
    }
    void hx
    void hy
  }

  private drawFace(p: Pose, pal: Palette, hx: number, hy: number): void {
    const ctx = this.ctx
    const u = p.u
    const f = p.face
    const ex = 14 * u
    const ey = -3 * u
    const er = 7.2 * u
    const pdx = f.eyeDX * 3.2 * u
    const pdy = f.eyeDY * 2.6 * u

    const drawOpenEye = (x: number, r = er) => {
      ctx.fillStyle = '#3B2B20'
      ctx.beginPath()
      ctx.ellipse(x, ey, r, r * 1.12, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#FFFFFF'
      ctx.beginPath()
      ctx.arc(x - 2 * u + pdx * 0.4, ey - 2.6 * u + pdy * 0.4, r * 0.32, 0, Math.PI * 2)
      ctx.fill()
    }
    const drawArcEye = (x: number, up = true) => {
      ctx.strokeStyle = '#3B2B20'
      ctx.lineWidth = 3 * u
      ctx.lineCap = 'round'
      ctx.beginPath()
      if (up) ctx.arc(x, ey + 3 * u, er * 0.95, Math.PI * 1.12, Math.PI * 1.88)
      else ctx.arc(x, ey - 2 * u, er * 0.95, Math.PI * 0.12, Math.PI * 0.88)
      ctx.stroke()
    }
    const drawClosedEye = (x: number) => {
      ctx.strokeStyle = '#3B2B20'
      ctx.lineWidth = 2.6 * u
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x - er * 0.8, ey)
      ctx.quadraticCurveTo(x, ey + er * 0.55, x + er * 0.8, ey)
      ctx.stroke()
    }

    const blinking = p.eyeClosed > 0.82
    for (const side of [-1, 1]) {
      const x = side * ex
      const eye: EyeState =
        f.eyes === 'wink' ? (side === p.facing ? 'closed' : 'open') : f.eyes
      if (blinking && (eye === 'open' || eye === 'surprised' || eye === 'sad')) {
        drawClosedEye(x)
        continue
      }
      switch (eye) {
        case 'happy':
          drawArcEye(x, true)
          break
        case 'closed':
          drawClosedEye(x)
          break
        case 'surprised': {
          ctx.strokeStyle = '#3B2B20'
          ctx.lineWidth = 2 * u
          ctx.fillStyle = '#FFFFFF'
          ctx.beginPath()
          ctx.arc(x, ey, er * 1.18, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
          ctx.fillStyle = '#3B2B20'
          ctx.beginPath()
          ctx.arc(x + pdx, ey + pdy, er * 0.42, 0, Math.PI * 2)
          ctx.fill()
          break
        }
        case 'angry': {
          drawOpenEye(x)
          ctx.strokeStyle = '#3B2B20'
          ctx.lineWidth = 2.8 * u
          ctx.beginPath()
          ctx.moveTo(x - side * 6 * u - 5 * u, ey - 12 * u)
          ctx.lineTo(x - side * 6 * u + 5 * u, ey - 8 * u)
          ctx.stroke()
          break
        }
        case 'sad': {
          drawOpenEye(x, er * 0.95)
          ctx.strokeStyle = '#3B2B20'
          ctx.lineWidth = 2.2 * u
          ctx.beginPath()
          ctx.moveTo(x - 6 * u, ey - 9 * u)
          ctx.quadraticCurveTo(x, ey - 12 * u, x + 6 * u, ey - 8 * u)
          ctx.stroke()
          break
        }
        case 'sleepy': {
          ctx.strokeStyle = '#3B2B20'
          ctx.lineWidth = 2.6 * u
          ctx.beginPath()
          ctx.moveTo(x - er, ey - 2 * u)
          ctx.lineTo(x + er, ey - 2 * u)
          ctx.stroke()
          ctx.fillStyle = '#3B2B20'
          ctx.beginPath()
          ctx.arc(x + pdx * 0.5, ey + 2.5 * u, er * 0.55, 0, Math.PI, true)
          ctx.fill()
          break
        }
        default:
          drawOpenEye(x)
      }
    }

    // 鼻子
    ctx.fillStyle = pal.nose
    ctx.beginPath()
    ctx.moveTo(0, 6 * u)
    ctx.lineTo(-3.2 * u, 3.4 * u)
    ctx.quadraticCurveTo(0, 2 * u, 3.2 * u, 3.4 * u)
    ctx.closePath()
    ctx.fill()

    // 嘴
    const my = 9.5 * u
    ctx.strokeStyle = '#5C4030'
    ctx.lineWidth = 2 * u
    ctx.lineCap = 'round'
    const talkOpen = f.talk > 0.45
    switch (f.mouth) {
      case 'open': {
        ctx.fillStyle = '#A14A4A'
        ctx.beginPath()
        ctx.ellipse(0, my + 3 * u, 5.5 * u, (3.5 + (talkOpen ? 3.5 : 0.5)) * u, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#F08080'
        ctx.beginPath()
        ctx.ellipse(0, my + 5.5 * u, 3 * u, 1.8 * u, 0, 0, Math.PI * 2)
        ctx.fill()
        break
      }
      case 'o': {
        ctx.beginPath()
        ctx.arc(0, my + 2 * u, 4 * u, 0, Math.PI * 2)
        ctx.stroke()
        break
      }
      case 'smile': {
        ctx.beginPath()
        ctx.arc(0, my - 1 * u, 5.5 * u, Math.PI * 0.15, Math.PI * 0.85)
        ctx.stroke()
        break
      }
      case 'frown': {
        ctx.beginPath()
        ctx.arc(0, my + 5 * u, 5.5 * u, Math.PI * 1.15, Math.PI * 1.85)
        ctx.stroke()
        break
      }
      case 'flat': {
        ctx.beginPath()
        ctx.moveTo(-4 * u, my + 1.5 * u)
        ctx.lineTo(4 * u, my + 1.5 * u)
        ctx.stroke()
        break
      }
      default: {
        // 猫嘴 ω
        ctx.beginPath()
        ctx.arc(-3.4 * u, my - 1 * u, 3.4 * u, Math.PI * 0.1, Math.PI * 0.9)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(3.4 * u, my - 1 * u, 3.4 * u, Math.PI * 0.1, Math.PI * 0.9)
        ctx.stroke()
      }
    }

    // 腮红
    const blushA = 0.28 + f.blush * 0.4
    ctx.fillStyle = pal.cheek
    ctx.globalAlpha = blushA
    this.ellipse(-23 * u, 6 * u, 7 * u, 4.2 * u)
    this.ellipse(23 * u, 6 * u, 7 * u, 4.2 * u)
    ctx.globalAlpha = 1

    // 胡须（猫和狐狸）
    if (p.species !== 'bunny') {
      ctx.strokeStyle = pal.outline
      ctx.globalAlpha = 0.45
      ctx.lineWidth = 1.4 * u
      for (const side of [-1, 1]) {
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath()
          ctx.moveTo(side * 20 * u, 5 * u + i * 3 * u)
          ctx.lineTo(side * 34 * u, 3 * u + i * 6 * u)
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
    }
    void hx
    void hy
  }

  private drawParticles(p: Pose): void {
    const ctx = this.ctx
    for (const pt of p.particles) {
      const a = Math.max(0, Math.min(1, pt.life / pt.max))
      ctx.globalAlpha = a
      const size = pt.size * p.u
      if (pt.kind === 'zzz') {
        ctx.fillStyle = '#7A6B9E'
        ctx.font = `${size}px "Segoe UI", sans-serif`
        ctx.fillText('Z', pt.x, pt.y)
      } else if (pt.kind === 'heart') {
        ctx.fillStyle = '#FF7A9E'
        ctx.font = `${size}px "Segoe UI Emoji", "Segoe UI", sans-serif`
        ctx.fillText('♥', pt.x, pt.y)
      } else if (pt.kind === 'note') {
        ctx.fillStyle = '#6C8CFF'
        ctx.font = `${size}px "Segoe UI", sans-serif`
        ctx.fillText('♪', pt.x, pt.y)
      } else if (pt.kind === 'sparkle') {
        ctx.fillStyle = '#FFE066'
        ctx.font = `${size}px "Segoe UI", sans-serif`
        ctx.fillText('✦', pt.x, pt.y)
      } else {
        // sweat 汗滴
        ctx.fillStyle = '#7EC8F5'
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, size * 0.42, 0, Math.PI * 2)
        ctx.fill()
        ctx.beginPath()
        ctx.moveTo(pt.x, pt.y - size * 0.95)
        ctx.lineTo(pt.x - size * 0.34, pt.y - size * 0.1)
        ctx.lineTo(pt.x + size * 0.34, pt.y - size * 0.1)
        ctx.closePath()
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
  }

  private ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    fill = true,
    stroke = false,
    fillColor?: string,
    strokeColor?: string,
  ): void {
    const ctx = this.ctx
    ctx.beginPath()
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
    if (fill) {
      if (fillColor) ctx.fillStyle = fillColor
      ctx.fill()
    }
    if (stroke) {
      if (strokeColor) ctx.strokeStyle = strokeColor
      ctx.stroke()
    }
  }
}
