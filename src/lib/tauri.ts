// Tauri IPC 封装：非 Tauri 环境（浏览器预览）自动降级为空实现
export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export function getLabel(): string {
  if (!isTauri) {
    return new URLSearchParams(location.search).get('win') ?? 'pet'
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (window as any).__TAURI_INTERNALS__?.metadata
  const label = meta?.currentWindow?.label ?? 'pet'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__petLabel = label
  return label
}

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauri) return null
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    console.warn(`invoke ${cmd} failed:`, e)
    throw e
  }
}

export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isTauri) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const un = await listen<T>(event, (ev) => handler(ev.payload))
  return un
}

export async function emitAll(event: string, payload?: unknown): Promise<void> {
  if (!isTauri) return
  const { emit } = await import('@tauri-apps/api/event')
  try {
    await emit(event, payload)
  } catch (e) {
    console.warn(`emit ${event} failed:`, e)
  }
}

// ---------- 共享类型 ----------

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface MonitorInfo {
  id: number
  x: number
  y: number
  w: number
  h: number
  wx: number
  wy: number
  ww: number
  wh: number
  primary: boolean
}

export interface OSWindow {
  id: number
  title: string
  x: number
  y: number
  w: number
  h: number
}

export interface DesktopInfo {
  monitors: MonitorInfo[]
  windows: OSWindow[]
  taskbar: Rect | null
}

export interface CursorInfo {
  x: number
  y: number
  left_down: boolean
}

export interface WindowInfo {
  x: number
  y: number
  w: number
  h: number
  scale: number
}

export type PersonalityId = 'gentle' | 'practical'
export type Species = 'cat' | 'bunny' | 'fox'

export interface Settings {
  apiBaseUrl: string
  apiKey: string
  model: string
  personality: PersonalityId
  petName: string
  species: Species
  scale: number
  autoActivity: boolean
  trackMouse: boolean
  windowInteract: boolean
  ttsEnabled: boolean
  proactive: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  apiBaseUrl: '',
  apiKey: '',
  model: '',
  personality: 'gentle',
  petName: '团子',
  species: 'cat',
  scale: 1,
  autoActivity: true,
  trackMouse: true,
  windowInteract: true,
  ttsEnabled: false,
  proactive: true,
}

export interface MemoryData {
  shortTerm: { role: 'user' | 'assistant'; content: string; t: number }[]
  userInfo: { nickname: string; facts: string[] }
  petMemory: { t: number; text: string }[]
  stats: { totalChats: number; lastInteraction: number }
}

export const DEFAULT_MEMORY: MemoryData = {
  shortTerm: [],
  userInfo: { nickname: '', facts: [] },
  petMemory: [],
  stats: { totalChats: 0, lastInteraction: 0 },
}

export interface PetSayPayload {
  text: string
  emotion?: string
  action?: string
  fromChat?: boolean
}

export interface EmotionPayload {
  values: {
    happiness: number
    energy: number
    curiosity: number
    affection: number
    boredom: number
  }
  expr: string
  state: string
  name: string
  species: Species
  personality: PersonalityId
}
