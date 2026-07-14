import { describe, expect, it } from 'vitest'
import {
  analyzeText,
  createCaption,
  createGenerationSpecs,
  hashText
} from '../src/renderer/src/lib/text-analysis'

describe('analyzeText', () => {
  it('recognizes a tired work reply from requirement language', () => {
    const result = analyzeText('老板：这个需求简单改一下', 'reply')

    expect(result.emotion).toBe('tired')
    expect(result.scene).toBe('work')
    expect(result.intent).toBe('生成聊天回复')
  })

  it('recognizes high-energy emotional language', () => {
    const result = analyzeText('救命啊啊啊，我真的要疯了！！！', 'express')

    expect(result.emotion).toBe('crazy')
    expect(result.emotionLabel).toBe('发疯')
  })

  it('uses mode-sensitive fallbacks for neutral text', () => {
    expect(analyzeText('明天见', 'express').emotion).toBe('happy')
    expect(analyzeText('明天见', 'reply').emotion).toBe('speechless')
  })
})

describe('generation parameters', () => {
  it('creates unique, repeatable specs for a fixed nonce', () => {
    const first = createGenerationSpecs('今天又要加班', 'express', 'office', 9, 0, 1234)
    const second = createGenerationSpecs('今天又要加班', 'express', 'office', 9, 0, 1234)

    expect(first).toEqual(second)
    expect(new Set(first.map((item) => item.id)).size).toBe(9)
    expect(new Set(first.map((item) => item.seed)).size).toBe(9)
  })

  it('resolves smart selection into a varied set of concrete effects', () => {
    const result = createGenerationSpecs('今天又要加班', 'express', 'smart', 9, 0, 1234)
    const styles = new Set(result.map((item) => item.style))

    expect(styles.size).toBeGreaterThanOrEqual(3)
    expect([...styles].join(',')).not.toContain('smart')
    expect(styles.has('office')).toBe(true)
  })

  it('keeps an explicitly selected effect across the whole batch', () => {
    const result = createGenerationSpecs('我先看看', 'reply', 'spectator', 9, 0, 4321)

    expect(new Set(result.map((item) => item.style))).toEqual(new Set(['spectator']))
  })

  it('returns varied reply captions', () => {
    const captions = Array.from({ length: 4 }, (_, index) =>
      createCaption('这个需求简单改一下', 'reply', 'tired', index)
    )

    expect(new Set(captions).size).toBe(4)
    expect(captions).toContain('收到，马上改')
  })

  it('keeps the hash stable', () => {
    expect(hashText('EmojiPie')).toBe(hashText('EmojiPie'))
    expect(hashText('EmojiPie')).not.toBe(hashText('emoji-pie'))
  })

  it('uses validated runtime variants as direct generation overrides', () => {
    const result = createGenerationSpecs('这个需求很简单', 'reply', 'office', 3, 0, 42, {
      analysis: {
        emotion: 'tired',
        emotionLabel: '疲惫',
        scene: 'work',
        tone: '克制吐槽',
        intent: '回复工作消息',
        keywords: ['需求']
      },
      variants: [
        { emotion: 'tired', caption: '这就安排' },
        { emotion: 'speechless', caption: '马上改好' }
      ]
    })

    expect(result.map((item) => item.caption)).toEqual(['这就安排', '马上改好', '这就安排'])
    expect(result[0].emotion).toBe('tired')
    expect(result[1].emotion).toBe('speechless')
  })
})
