// RAG 知识库（M7）：文档分块入库 + 「向量语义 / bigram 字面」混合检索。
// - 索引整体存 kb_docs.json（read_data/write_data，Rust 端原子写），不引入专门的向量库
// - embedding 走独立配置（settings.embed*，OpenAI 兼容 /v1/embeddings，Ollama 同协议）；
//   未配置或调用失败一律降级 bigram（复用 Memory.ts 的 relevanceScore），离线能力不丢
// - mem 集合镜像 memory.md 的画像/事件/摘要行，实现记忆的语义召回升级；
//   向量按内容缓存（文本相同即复用），只有新行才请求 embedding
import { emitAll, getLabel, invoke, isTauri } from '../lib/tauri'
import { bigramCoverage, bigrams } from './Memory'

export const KB_FILE = 'kb_docs'

export const MAX_DOCS = 50
export const MAX_CHUNKS = 2000
/** 单文档导入上限（字符数；约 2MB 文本） */
export const MAX_DOC_CHARS = 2_000_000
/** 块长上限（字符）与块间重叠 */
export const CHUNK_MAX = 600
const CHUNK_OVERLAP = 60
/** embedding 单次批量条数（OpenAI 兼容端点均支持数组输入） */
const EMBED_BATCH = 16
/** 低于该相关性的命中直接丢弃（bigram 覆盖率本身偏低，阈值要小） */
const MIN_SCORE = 0.05

export interface RagHit {
  /** 展示用来源：文档名 或「记忆」 */
  source: string
  text: string
  score: number
}

export interface KbChunk {
  text: string
  /** null = 尚未向量化（未配置 embedding 或请求失败），检索时只用 bigram */
  vec: number[] | null
}

export interface KbDoc {
  id: string
  name: string
  addedAt: number
  /** 原文保留：重建索引时重新分块，不必重新导入 */
  text: string
  chunks: KbChunk[]
}

interface MemEntry {
  text: string
  vec: number[] | null
}

interface KbData {
  docs: KbDoc[]
  mem: MemEntry[]
}

export interface EmbedConfig {
  base_url: string
  api_key: string
  model: string
}

/** 从设置取 embedding 配置；模型留空 = 未启用（返回 null，检索降级 bigram） */
export function embedConfigOf(s: { embedBaseUrl: string; embedApiKey: string; embedModel: string }): EmbedConfig | null {
  const base_url = s.embedBaseUrl.trim()
  const model = s.embedModel.trim()
  if (!base_url || !model) return null
  return { base_url, api_key: s.embedApiKey.trim(), model }
}

/* ------------------------------------------------------- 纯函数（可单测） */

/** 余弦相似度；零向量（无重叠）返回 0 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

/**
 * 分块：按空行/Markdown 标题切段，顺序打包到 CHUNK_MAX；
 * 跨块保留 CHUNK_OVERLAP 字符尾部重叠，避免答案被切在边界上。
 * 超限的单段按句读硬切。返回 null 表示没有可入库的内容。
 */
export function chunkText(text: string): string[] {
  const src = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}|(?<=\n)(?=#{1,6}\s)/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!src.length) return []

  // 超长单段按句读硬切成 ≤CHUNK_MAX 的碎段
  const paras: string[] = []
  for (const p of src) {
    if (p.length <= CHUNK_MAX) {
      paras.push(p)
      continue
    }
    let cur = ''
    // 以句号/问叹号/换行为界（含收尾引号），中文英文都覆盖
    for (const seg of p.split(/(?<=[。！？!?；;\n])/)) {
      if (cur.length + seg.length > CHUNK_MAX && cur) {
        paras.push(cur)
        cur = seg
      } else {
        cur += seg
      }
    }
    if (cur.trim()) paras.push(cur)
  }
  // 兜底：无句读的超长 seg 硬切后仍可能超限，统一按字符二次切分
  for (let i = paras.length - 1; i >= 0; i--) {
    if (paras[i].length > CHUNK_MAX) {
      const pieces: string[] = []
      for (let j = 0; j < paras[i].length; j += CHUNK_MAX) {
        pieces.push(paras[i].slice(j, j + CHUNK_MAX))
      }
      paras.splice(i, 1, ...pieces)
    }
  }

  const chunks: string[] = []
  let cur = ''
  for (const p of paras) {
    if (!cur) {
      cur = p
    } else if (cur.length + 1 + p.length <= CHUNK_MAX) {
      cur += '\n' + p
    } else {
      chunks.push(cur)
      // 重叠：上一块尾部拼到下一块开头；给正文留足空间，保证不超 CHUNK_MAX
      const room = CHUNK_MAX - p.length - 1
      const tail = room > 0 ? cur.slice(-Math.min(CHUNK_OVERLAP, room)) : ''
      cur = tail ? tail + '\n' + p : p
    }
  }
  if (cur.trim()) chunks.push(cur)
  return chunks
}

/* ------------------------------------------------------------- 索引本体 */

function emptyData(): KbData {
  return { docs: [], mem: [] }
}

/** 存档形状校验：手改/旧版损坏也不崩，坏字段按空处理 */
export function parseKbData(raw: unknown): KbData {
  const d = emptyData()
  if (!raw || typeof raw !== 'object') return d
  const obj = raw as Partial<KbData>
  if (Array.isArray(obj.docs)) {
    for (const x of obj.docs) {
      if (!x || typeof x !== 'object') continue
      const doc = x as Partial<KbDoc>
      if (typeof doc.id !== 'string' || typeof doc.name !== 'string' || !Array.isArray(doc.chunks)) continue
      d.docs.push({
        id: doc.id,
        name: doc.name,
        addedAt: typeof doc.addedAt === 'number' ? doc.addedAt : 0,
        text: typeof doc.text === 'string' ? doc.text : '',
        chunks: doc.chunks
          .filter((c): c is KbChunk => !!c && typeof c.text === 'string')
          .map((c) => ({ text: c.text, vec: Array.isArray(c.vec) ? c.vec : null })),
      })
    }
  }
  if (Array.isArray(obj.mem)) {
    for (const x of obj.mem) {
      if (!x || typeof x.text !== 'string') continue
      d.mem.push({ text: x.text, vec: Array.isArray(x.vec) ? x.vec : null })
    }
  }
  return d
}

const round5 = (v: number): number => Math.round(v * 1e5) / 1e5

/** 默认 embedding 通道：Rust ai_embed 命令（非 Tauri 环境返回 null，调用方按失败降级） */
const defaultEmbed = (cfg: EmbedConfig, inputs: string[]): Promise<number[][]> => aiEmbed(cfg, inputs)

export class KnowledgeIndex {
  private data: KbData = emptyData()
  /** embedding 通道：单测注入假实现用；生产保持默认（Rust ai_embed） */
  embedFn: (cfg: EmbedConfig, inputs: string[]) => Promise<number[][]> = defaultEmbed

  /** 是否具备 embedding 条件：配置齐全，且在 Tauri 里或通道被测试替换过 */
  private canEmbed(cfg: EmbedConfig | null): cfg is EmbedConfig {
    return !!cfg && (isTauri || this.embedFn !== defaultEmbed)
  }

  static async load(): Promise<KnowledgeIndex> {
    const idx = new KnowledgeIndex()
    if (isTauri) {
      try {
        idx.data = parseKbData(await invoke<unknown>('read_data', { name: KB_FILE }))
      } catch {
        idx.data = emptyData()
      }
    }
    return idx
  }

  private async save(): Promise<void> {
    if (!isTauri) return
    await invoke('write_data', { name: KB_FILE, data: this.data })
    // 整文件覆写 + 多窗口各持副本：落盘后必须通知其他窗口重载，
    // 否则旧副本会把新导入/删除的文档覆盖回去（携带 label 供监听方跳过自己）
    await emitAll('kb://updated', { label: getLabel() })
  }

  list(): { id: string; name: string; addedAt: number; chunks: number }[] {
    return this.data.docs.map((d) => ({ id: d.id, name: d.name, addedAt: d.addedAt, chunks: d.chunks.length }))
  }

  stats(): { docs: number; chunks: number; embedded: number } {
    const all = [...this.data.docs.flatMap((d) => d.chunks), ...this.data.mem]
    return {
      docs: this.data.docs.length,
      chunks: all.length,
      embedded: all.filter((c) => c.vec).length,
    }
  }

  /** 调用方在保存记忆文件后传入最新行；向量按文本缓存，变化行才重新向量化 */
  async syncMemory(lines: string[], cfg: EmbedConfig | null): Promise<void> {
    const old = new Map(this.data.mem.map((m) => [m.text, m.vec]))
    const mem: MemEntry[] = lines.map((text) => ({ text, vec: old.get(text) ?? null }))
    const changed = mem.length !== this.data.mem.length || mem.some((m, i) => m.text !== this.data.mem[i]?.text)
    this.data.mem = mem
    if (changed) await this.save()
    await this.embedMissing(cfg)
  }

  /** 导入文档并尽力向量化；返回实际入库情况供 UI 提示 */
  async addDocs(files: { name: string; text: string }[], cfg: EmbedConfig | null): Promise<{ added: number; chunks: number; embedded: boolean }> {
    let added = 0
    for (const f of files) {
      const text = f.text.replace(/\r\n?/g, '\n').trim()
      if (!text || text.length > MAX_DOC_CHARS) continue
      if (this.data.docs.length >= MAX_DOCS) break
      const pieces = chunkText(text)
      if (!pieces.length) continue
      const room = MAX_CHUNKS - this.stats().chunks
      if (room <= 0) break
      this.data.docs.push({
        id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: f.name || '未命名',
        addedAt: Date.now(),
        text,
        chunks: pieces.slice(0, room).map((t) => ({ text: t, vec: null })),
      })
      added++
    }
    if (added) await this.save()
    const embedded = await this.embedMissing(cfg)
    return { added, chunks: this.stats().chunks, embedded }
  }

  async removeDoc(id: string): Promise<void> {
    this.data.docs = this.data.docs.filter((d) => d.id !== id)
    await this.save()
  }

  async clear(): Promise<void> {
    this.data = emptyData()
    await this.save()
  }

  /** 重建索引：原文重新分块 + 全量重嵌入（embedding 配置变更后用）。
   *  返回向量化块数；-1 = 配置齐全但向量化失败；未配置 embedding 只重分块，返回 0（不算失败） */
  async rebuildAll(cfg: EmbedConfig | null, onProgress?: (done: number, total: number) => void): Promise<number> {
    const docs = this.data.docs
    this.data.docs = docs.map((d) => ({
      ...d,
      chunks: chunkText(d.text).map((t) => ({ text: t, vec: null })),
    }))
    await this.save()
    if (!this.canEmbed(cfg)) return 0
    const ok = await this.embedMissing(cfg, onProgress)
    return ok ? this.stats().embedded : -1
  }

  /** 给所有 vec 为 null 的块补向量；任一批失败即停止并返回 false（已有的向量保留） */
  async embedMissing(cfg: EmbedConfig | null, onProgress?: (done: number, total: number) => void): Promise<boolean> {
    if (!this.canEmbed(cfg)) return false
    const targets: KbChunk[] = [
      ...this.data.docs.flatMap((d) => d.chunks),
      ...this.data.mem,
    ].filter((c) => !c.vec)
    let done = 0
    for (let i = 0; i < targets.length; i += EMBED_BATCH) {
      const batch = targets.slice(i, i + EMBED_BATCH)
      try {
        const vecs = await this.embedFn(cfg, batch.map((c) => c.text))
        batch.forEach((c, j) => (c.vec = vecs[j]?.map(round5) ?? null))
      } catch (e) {
        console.warn('embedding 失败，已降级字面检索', e)
        // 已成功批次的向量先落盘，重启后不必重复请求
        if (done) await this.save()
        return false
      }
      done += batch.length
      onProgress?.(done, targets.length)
    }
    if (targets.length) await this.save()
    return true
  }

  /**
   * 混合检索：向量命中为主、bigram 字面兜底；embedding 不可用/失败时
   * 自动整条降级为字面检索。永不抛错（聊天主流程不能被检索卡住）。
   */
  async search(query: string, k = 5, cfg: EmbedConfig | null): Promise<RagHit[]> {
    const q = query.trim()
    if (!q) return []
    type Cand = { source: string; text: string; bigram: number; vec: number[] | null; vecScore: number }
    const cands: Cand[] = []
    // query 的 bigram 只算一次，候选块逐个复用（此前每块都重建一遍）
    const qGrams = bigrams(q)
    for (const d of this.data.docs) {
      for (const c of d.chunks) {
        cands.push({ source: d.name, text: c.text, bigram: bigramCoverage(qGrams, c.text), vec: c.vec, vecScore: 0 })
      }
    }
    for (const m of this.data.mem) {
      cands.push({ source: '记忆', text: m.text, bigram: bigramCoverage(qGrams, m.text), vec: m.vec, vecScore: 0 })
    }
    if (!cands.length) return []

    // 尽力语义打分：查询向量化一次；失败则全部保持纯 bigram
    if (this.canEmbed(cfg)) {
      try {
        const [qv] = await this.embedFn(cfg, [q])
        if (qv?.length) {
          for (const c of cands) {
            if (c.vec) c.vecScore = Math.max(0, cosine(qv, c.vec))
          }
        }
      } catch (e) {
        console.warn('查询向量化失败，降级字面检索', e)
      }
    }

    // 字面与语义取高者，排序后过滤噪声并截取 top-k
    const hits = cands
      .map((c) => ({ source: c.source, text: c.text, score: Math.max(c.bigram, c.vecScore) }))
      .filter((h) => h.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
    return hits
  }
}

/** Rust ai_embed 命令封装：OpenAI 兼容 /v1/embeddings，返回与输入同序的向量数组 */
export async function aiEmbed(cfg: EmbedConfig, inputs: string[]): Promise<number[][]> {
  const vecs = await invoke<number[][]>('ai_embed', { config: cfg, inputs })
  if (!Array.isArray(vecs)) throw new Error('embedding 响应格式异常')
  return vecs
}
