// Canvas 渲染层：单宠物化（整改 M1）后身体与表情由 bloub SVG（PetBot.vue）渲染，
// 本文件只负责粒子（爱心/Zzz/汗滴/音符/星光）——叠加在 SVG 之上。
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
  /** 投喂食物（窗口相对偏移：dx 相对宠物中心，dy 相对脚底向上），null = 无 */
  food: { dx: number; dy: number } | null
  eyeClosed: number // 眨眼程度 0..1
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
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.drawParticles(p)
    if (p.food) {
      // 投喂食物：emoji 绘制（与粒子同一画风），锚在食物落点
      const size = 30 * p.u
      ctx.font = `${size}px "Segoe UI Emoji", "Segoe UI", sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText('🍡', p.cx + p.food.dx, p.feetY - p.food.dy)
      ctx.textAlign = 'start'
    }
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
}
