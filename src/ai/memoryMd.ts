// memory.md 的解析与序列化（M5：长期记忆 = 可编辑的 Markdown 文件）
// 独立叶子模块：store.ts 与 Memory.ts 共用，避免循环依赖。

export const MEMORY_FILE = 'memory.md'

export interface MemorySections {
  /** 用户画像：偏好、习惯、称呼…… */
  profile: string[]
  /** 宠物记忆：和用户之间发生的事 */
  events: string[]
  /** 对话摘要：被压缩的旧对话话题行 */
  digests: string[]
}

const HEADERS: Array<{ title: string; key: keyof MemorySections }> = [
  { title: '用户画像', key: 'profile' },
  { title: '宠物记忆', key: 'events' },
  { title: '对话摘要', key: 'digests' },
]

const HINTS: Record<keyof MemorySections, string> = {
  profile: '<!-- 关于用户的一切：偏好、习惯、称呼等，每行一条，以 "- " 开头 -->',
  events: '<!-- 和用户之间发生的事、值得记住的时刻 -->',
  digests: '<!-- 更早对话的话题压缩，由系统自动写入 -->',
}

/** 解析 memory.md：按 "## 标题" 分段，收集 "- " 条目；其余行忽略（容忍手改） */
export function parseMemoryMd(text: string): MemorySections {
  const sections: MemorySections = { profile: [], events: [], digests: [] }
  let cur: keyof MemorySections | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim()
      cur = HEADERS.find((h) => h.title === title)?.key ?? null
      continue
    }
    if (!cur || !line.startsWith('- ')) continue
    const item = line.slice(2).trim()
    if (item) sections[cur].push(item)
  }
  return sections
}

/** 序列化 memory.md：空段落写入提示注释，引导用户手填 */
export function serializeMemoryMd(s: MemorySections): string {
  const list = (items: string[]) => items.map((x) => `- ${x}`).join('\n')
  const out: string[] = [
    '# 记忆',
    '',
    '这里是小黑点的长期记忆。你可以直接用记事本编辑这个文件，改完自动生效。',
    '',
  ]
  for (const h of HEADERS) {
    out.push(`## ${h.title}`, '')
    const items = s[h.key]
    out.push(items.length ? list(items) : HINTS[h.key], '')
  }
  return out.join('\n')
}

/** 空白模板（重置记忆用） */
export function emptyMd(): string {
  return serializeMemoryMd({ profile: [], events: [], digests: [] })
}
