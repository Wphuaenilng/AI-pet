// 知识库落盘同步回归（M7 审查修复）：mock Tauri IPC 通道，验证
// 1) save 后广播 kb://updated（带窗口 label）；2) 重载后再同步记忆不覆盖他窗新文档；
// 3) embedding 中途失败时已成功批次仍落盘。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KB_FILE, KnowledgeIndex, type EmbedConfig } from './rag'

const CFG: EmbedConfig = { base_url: 'http://x/v1', api_key: '', model: 'bge-m3' }

// vi.mock 工厂被提升，共享状态必须经 vi.hoisted 初始化
const h = vi.hoisted(() => ({
  /** 模拟磁盘：write_data 深拷贝落盘，read_data 深拷贝读出（与真实文件隔离一致） */
  files: new Map<string, unknown>(),
  emitted: [] as { event: string; payload: unknown }[],
}))

vi.mock('../lib/tauri', () => ({
  isTauri: true,
  DEFAULT_SETTINGS: {},
  DEFAULT_MEMORY: {
    shortTerm: [],
    userInfo: { nickname: '', facts: [] },
    petMemory: [],
    digests: [],
    stats: { totalChats: 0, lastInteraction: 0 },
  },
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'read_data') {
      const v = h.files.get(args?.name as string)
      return v === undefined ? null : structuredClone(v)
    }
    if (cmd === 'write_data') {
      h.files.set(args?.name as string, structuredClone(args?.data))
      return null
    }
    return null
  },
  emitAll: async (event: string, payload: unknown) => {
    h.emitted.push({ event, payload })
  },
  getLabel: () => 'test-window',
}))

interface DiskShape {
  docs: { name: string; chunks: { text: string; vec: number[] | null }[] }[]
  mem: { text: string; vec: number[] | null }[]
}

function disk(): DiskShape {
  return h.files.get(KB_FILE) as DiskShape
}

beforeEach(() => {
  h.files.clear()
  h.emitted.length = 0
})

describe('KnowledgeIndex 落盘同步', () => {
  it('save 后广播 kb://updated 且携带窗口 label', async () => {
    const idx = new KnowledgeIndex()
    await idx.addDocs([{ name: 'a.md', text: '第一条知识内容。' }], null)
    expect(h.files.has(KB_FILE)).toBe(true)
    const ev = h.emitted.find((e) => e.event === 'kb://updated')
    expect(ev).toBeTruthy()
    expect((ev!.payload as { label: string }).label).toBe('test-window')
  })

  it('回归：重载后再同步记忆，不覆盖其他窗口刚导入的文档', async () => {
    // 聊天窗先加载（旧副本）
    const staleChatIdx = await KnowledgeIndex.load()
    // 设置窗导入新文档并落盘
    const settingsIdx = await KnowledgeIndex.load()
    await settingsIdx.addDocs([{ name: 'new.md', text: '新导入的知识内容。' }], null)
    expect(disk().docs.map((d) => d.name)).toContain('new.md')

    // 修复后的聊天窗行为：收到 kb://updated 先重载，再用新副本同步记忆
    const freshIdx = await KnowledgeIndex.load()
    await freshIdx.syncMemory(['主人喜欢喝奶茶'], null)
    expect(disk().docs.map((d) => d.name)).toContain('new.md')
    expect(disk().mem.map((m) => m.text)).toEqual(['主人喜欢喝奶茶'])

    // 对照（修复前的 bug 路径）：直接用旧副本同步会把新文档整文件盖掉。
    // 此断言锁定"为什么必须先重载"；若未来 save 改为合并写，更新本段即可。
    await staleChatIdx.syncMemory(['主人喜欢喝奶茶', '今天被摸了'], null)
    expect(disk().docs.map((d) => d.name)).not.toContain('new.md')
  })

  it('embedMissing：中途失败也把已成功批次的向量落盘', async () => {
    const idx = new KnowledgeIndex()
    // 20 个 ~547 字段落 → 20 块（>16，必有两个批次）
    const para = (i: number) => `这是第${i}段。` + '充'.repeat(540)
    const text = Array.from({ length: 20 }, (_, i) => para(i)).join('\n\n')
    await idx.addDocs([{ name: 'big.md', text }], null)
    expect(disk().docs[0].chunks.length).toBeGreaterThan(16)
    expect(disk().docs[0].chunks.every((c) => c.vec === null)).toBe(true)

    let calls = 0
    idx.embedFn = async (_cfg, inputs) => {
      calls++
      if (calls === 2) throw new Error('网络中断')
      return inputs.map(() => [1, 0])
    }
    const ok = await idx.embedMissing(CFG)
    expect(ok).toBe(false)
    // 第一批 16 块的向量已持久化，重启后不必重新请求
    expect(disk().docs[0].chunks.filter((c) => c.vec).length).toBe(16)
  })
})