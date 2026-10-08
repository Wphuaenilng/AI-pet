// 两行协议解析单测（流式输出改造）：双格式兼容 + 兜底
import { describe, expect, it } from 'vitest'
import { parseAiReply } from './PromptBuilder'

describe('parseAiReply', () => {
  it('两行协议：第一行台词 + 第二行 JSON', () => {
    const r = parseAiReply('你好呀！今天也要加油哦\n{"emotion":"happy","action":"dance","memory":""}')
    expect(r.reply).toBe('你好呀！今天也要加油哦')
    expect(r.emotion).toBe('happy')
    expect(r.action).toBe('dance')
  })

  it('两行协议：台词带引号会被剥掉', () => {
    const r = parseAiReply('"嗨嗨"\n{"emotion":"neutral","action":"none","memory":""}')
    expect(r.reply).toBe('嗨嗨')
  })

  it('旧格式：整体 JSON（含 reply 字段）', () => {
    const r = parseAiReply('{"reply":"嗨","emotion":"sad","action":"none","memory":"喜欢猫"}')
    expect(r.reply).toBe('嗨')
    expect(r.emotion).toBe('sad')
    expect(r.memory).toBe('喜欢猫')
  })

  it('纯文本兜底：情绪/动作落默认值', () => {
    const r = parseAiReply('随便说点什么')
    expect(r.reply).toBe('随便说点什么')
    expect(r.emotion).toBe('neutral')
  })

  it('旧坏情形：JSON 但缺 reply，不能把 JSON 串念出来', () => {
    const r = parseAiReply('{"emotion":"happy"}')
    expect(r.reply).toBe('……')
  })

  it('围栏包裹的 JSON 也能解析', () => {
    const r = parseAiReply('```json\n{"reply":"好","emotion":"happy","action":"none","memory":""}\n```')
    expect(r.reply).toBe('好')
    expect(r.emotion).toBe('happy')
  })

  it('越界 emotion 落 neutral（双通道白名单）', () => {
    const r = parseAiReply('台词\n{"emotion":"ecstatic","action":"none","memory":""}')
    expect(r.emotion).toBe('neutral')
  })
})
