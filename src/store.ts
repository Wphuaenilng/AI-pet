// 设置与记忆的加载 / 保存（经 Rust 端 JSON 文件持久化）
import {
  DEFAULT_MEMORY,
  DEFAULT_SETTINGS,
  emitAll,
  invoke,
  isTauri,
  type MemoryData,
  type Settings,
} from './lib/tauri'
import { emptyMd, MEMORY_FILE } from './ai/memoryMd'

export async function loadSettings(): Promise<Settings> {
  if (!isTauri) return { ...DEFAULT_SETTINGS }
  const raw = await invoke<Partial<Settings>>('read_data', { name: 'settings' })
  // 单宠物化迁移（整改 D2）：旧存档的 cat/bunny/fox 一律归一为 dot
  const merged = { ...DEFAULT_SETTINGS, ...(raw ?? {}), species: 'dot' as const }
  return { ...merged, scale: clampScale(raw?.scale ?? 1) }
}

// 缩放范围的唯一事实源（Rust 端 window.rs 的 clamp 保持一致：0.5–2.0）
export const SCALE_MIN = 0.5
export const SCALE_MAX = 2

export function clampScale(s: number): number {
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Number(s) || 1))
}

export async function saveSettings(s: Settings): Promise<void> {
  if (!isTauri) return
  await invoke('write_data', { name: 'settings', data: s })
  await emitAll('settings://updated', s)
}

export async function loadMemory(): Promise<MemoryData> {
  if (!isTauri) return structuredClone(DEFAULT_MEMORY)
  const raw = await invoke<Partial<MemoryData>>('read_data', { name: 'memory' })
  if (!raw) return structuredClone(DEFAULT_MEMORY)
  return {
    shortTerm: raw.shortTerm ?? [],
    userInfo: { ...DEFAULT_MEMORY.userInfo, ...(raw.userInfo ?? {}) },
    petMemory: raw.petMemory ?? [],
    digests: raw.digests ?? [],
    stats: { ...DEFAULT_MEMORY.stats, ...(raw.stats ?? {}) },
  }
}

export async function saveMemory(m: MemoryData): Promise<void> {
  if (!isTauri) return
  await invoke('write_data', { name: 'memory', data: m })
}

export async function resetMemory(): Promise<void> {
  if (!isTauri) return
  await invoke('write_data', { name: 'memory', data: DEFAULT_MEMORY })
  // 长期记忆文件（memory.md）一并清成空白模板（M5）
  await invoke('write_text', { name: MEMORY_FILE, content: emptyMd() })
}
