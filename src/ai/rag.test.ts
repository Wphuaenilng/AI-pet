import { describe, expect, it } from 'vitest'
import { KnowledgeIndex, chunkText, cosine, embedConfigOf, parseKbData, type EmbedConfig } from './rag'

const CFG: EmbedConfig = { base_url: 'http://x/v1', api_key: '', model: 'bge-m3' }

type DataShape = {
  docs: { id: string; name: string; addedAt: number; text: string; chunks: { text: string; vec: number[] | null }[] }[]
  mem: { text: string; vec: number[] | null }[]
}

function getData(idx: KnowledgeIndex): DataShape {
  return (idx as unknown as { data: DataShape }).data
}

describe('chunkText 分块', () => {
  it('按空行与 Markdown 标题切段并打包', () => {
    const text = '第一段内容。\n\n## 标题A\n标题A下的段落。\n\n## 标题B\n标题B下的段落。'
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks.join('')).toContain('标题A下的段落')
    expect(chunks.join('')).toContain('标题B下的段落')
  })

  it('超长段落按句读硬切且每块不超上限', () => {
    const sentence = '这是一句完整的测试句子，用来撑长度。'
    const text = sentence.repeat(80) // 约 800 字，超过 CHUNK_MAX=600
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(600)
  })

  it('空文本返回空数组', () => {
    expect(chunkText('  \n\n  ')).toEqual([])
  })
})

describe('cosine', () => {
  it('同向为 1，正交为 0，反向为 -1，退化输入为 0', () => {
    expect(cosine([1, 0, 2], [2, 0, 4])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1)
    expect(cosine([], [])).toBe(0)
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })
})

describe('embedConfigOf', () => {
  it('模型或地址为空 = 未启用；去空格后返回 snake_case 配置', () => {
    expect(embedConfigOf({ embedBaseUrl: '', embedApiKey: '', embedModel: '' })).toBeNull()
    expect(embedConfigOf({ embedBaseUrl: 'http://x', embedApiKey: '', embedModel: '' })).toBeNull()
    expect(embedConfigOf({ embedBaseUrl: ' http://x ', embedApiKey: ' k ', embedModel: ' bge ' })).toEqual({
      base_url: 'http://x',
      api_key: 'k',
      model: 'bge',
    })
  })
})

describe('KnowledgeIndex', () => {
  it('降级路径：未配置 embedding 时按 bigram 召回且带来源', async () => {
    const idx = new KnowledgeIndex()
    await idx.addDocs([{ name: 'notes.md', text: '小黑点最爱吃的小零食是冻干鸡肉。' }], null)
    const hits = await idx.search('冻干鸡肉', 5, null)
    expect(hits.length).toBe(1)
    expect(hits[0].source).toBe('notes.md')
    expect(hits[0].score).toBeGreaterThan(0)
  })

  it('无关查询不返回噪声', async () => {
    const idx = new KnowledgeIndex()
    await idx.addDocs([{ name: 'a.md', text: '小黑点最爱吃的小零食是冻干鸡肉。' }], null)
    expect(await idx.search('量子力学的基本假设', 5, null)).toEqual([])
    expect(await idx.search('   ', 5, CFG)).toEqual([])
  })

  it('语义命中：低字面重叠的块靠注入的向量升到首位（embedFn 注入）', async () => {
    const idx = new KnowledgeIndex()
    await idx.addDocs(
      [
        { name: 'en.md', text: 'The birthday is on May first' },
        { name: 'other.md', text: 'Party venue is booked now' },
      ],
      null,
    )
    const data = getData(idx)
    const birthday = data.docs.find((d) => d.name === 'en.md')!.chunks[0]
    birthday.vec = [0.95, 0.05, 0]
    // 查询向量与生日块近似同向
    idx.embedFn = async () => [[1, 0, 0]]
    const hits = await idx.search('birthday date', 5, CFG)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].source).toBe('en.md')
    expect(hits[0].score).toBeGreaterThan(0.5)
    // 其余命中（仅字面微弱重叠）分数被明显拉开
    if (hits.length > 1) expect(hits[1].score).toBeLessThan(0.2)
  })

  it('记忆集合：syncMemory 后可召回且来源为「记忆」，相同文本保留缓存向量', async () => {
    const idx = new KnowledgeIndex()
    await idx.syncMemory(['主人喜欢喝奶茶', '宠物叫小黑点'], null)
    // 手动给第一行挂向量，第二行留 null
    getData(idx).mem[0].vec = [1, 0, 0]
    await idx.syncMemory(['主人喜欢喝奶茶', '宠物叫小黑点', '今天喂过猫'], null)
    const data = getData(idx)
    expect(data.mem).toHaveLength(3)
    expect(data.mem[0].vec).toEqual([1, 0, 0]) // 缓存复用
    expect(data.mem[2].vec).toBeNull()
    const hits = await idx.search('奶茶', 5, null)
    expect(hits[0]?.source).toBe('记忆')
  })

  it('addDocs + 注入通道：导入即向量化，统计正确', async () => {
    const idx = new KnowledgeIndex()
    idx.embedFn = async (_cfg, inputs) => inputs.map(() => [1, 1, 0])
    const r = await idx.addDocs([{ name: 'a.md', text: '第一条知识内容。\n\n第二条知识内容。' }], CFG)
    expect(r.added).toBe(1)
    expect(r.embedded).toBe(true)
    expect(idx.stats().embedded).toBe(idx.stats().chunks)
  })

  it('删除与清空', async () => {
    const idx = new KnowledgeIndex()
    await idx.addDocs([{ name: 'a.md', text: '第一段。' }, { name: 'b.md', text: '第二段。' }], null)
    expect(idx.stats().docs).toBe(2)
    const [doc] = idx.list()
    await idx.removeDoc(doc.id)
    expect(idx.stats().docs).toBe(1)
    await idx.clear()
    expect(idx.stats()).toEqual({ docs: 0, chunks: 0, embedded: 0 })
  })

  it('rebuildAll：保留原文重分块并全量重嵌入', async () => {
    const idx = new KnowledgeIndex()
    idx.embedFn = async (_cfg, inputs) => inputs.map(() => [0, 1, 0])
    await idx.addDocs([{ name: 'a.md', text: '旧的分块内容。' }], CFG)
    getData(idx).docs[0].chunks[0].vec = [9, 9, 9] // 模拟旧向量过期
    await idx.rebuildAll(CFG)
    const st = idx.stats()
    expect(st.embedded).toBe(st.chunks)
    expect(getData(idx).docs[0].chunks[0].vec).toEqual([0, 1, 0])
  })

  it('rebuildAll：未配置 embedding 只重分块，返回 0 而非失败', async () => {
    const idx = new KnowledgeIndex()
    idx.embedFn = async (_cfg, inputs) => inputs.map(() => [0, 1, 0])
    await idx.addDocs([{ name: 'a.md', text: '旧的分块内容。' }], CFG)
    expect(getData(idx).docs[0].chunks[0].vec).not.toBeNull()
    const n = await idx.rebuildAll(null)
    expect(n).toBe(0)
    expect(getData(idx).docs[0].chunks[0].vec).toBeNull()
  })

  it('损坏存档按空处理不崩溃', () => {
    const d = parseKbData({
      docs: [{ id: 'x', name: 'n', chunks: [{ text: 'ok', vec: 'bad' }, { text: 1 }, null] }, null, 'x'],
      mem: [{ text: 'ok', vec: [1] }, { bad: true }, null],
      junk: 1,
    })
    expect(d.docs).toHaveLength(1)
    expect(d.docs[0].chunks).toEqual([{ text: 'ok', vec: null }])
    expect(d.mem).toEqual([{ text: 'ok', vec: [1] }])
    expect(parseKbData(null).docs).toEqual([])
    expect(parseKbData('garbage').mem).toEqual([])
  })
})
