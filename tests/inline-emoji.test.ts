import { describe, expect, it } from 'vitest'
import type { EmotionId, TextAnalysis } from '../src/shared/types'
import { createInlineEmojiSuggestions } from '../src/renderer/src/lib/inline-emoji'

const EMOTIONS: EmotionId[] = [
  'happy',
  'sad',
  'angry',
  'speechless',
  'tired',
  'surprised',
  'awkward',
  'smug',
  'crazy'
]

function analysis(emotion: EmotionId, scene: TextAnalysis['scene'] = 'daily'): TextAnalysis {
  return {
    emotion,
    emotionLabel: emotion,
    scene,
    tone: '表达',
    intent: '传达当前情绪',
    keywords: []
  }
}

describe('inline emoji suggestions', () => {
  it('returns five deterministic, clipboard-safe suggestions for every emotion', () => {
    for (const emotion of EMOTIONS) {
      const first = createInlineEmojiSuggestions('测试文案', 'express', analysis(emotion), 42)
      const second = createInlineEmojiSuggestions('测试文案', 'express', analysis(emotion), 42)

      expect(first).toEqual(second)
      expect(first).toHaveLength(5)
      expect(new Set(first.map(({ value }) => value)).size).toBe(5)
      for (const suggestion of first) {
        expect(suggestion.value).not.toMatch(/\[|\]|:/)
        expect(suggestion.value).not.toContain('\u200d')
        expect(suggestion.value).not.toContain('\ufe0f')
        expect([...suggestion.value].length).toBeGreaterThanOrEqual(1)
        expect([...suggestion.value].length).toBeLessThanOrEqual(2)
        for (const codePoint of [...suggestion.value]) {
          expect(codePoint).toMatch(/^\p{Emoji_Presentation}$/u)
        }
      }
    }
  })

  it('adds scene context without replacing the detected emotion', () => {
    const work = createInlineEmojiSuggestions('今天又要加班', 'express', analysis('tired', 'work'), 7)
    const social = createInlineEmojiSuggestions('群里怎么回复', 'reply', analysis('awkward', 'social'), 7)

    expect(work.some(({ value }) => value.includes('💻'))).toBe(true)
    expect(work.some(({ value }) => value.includes('☕'))).toBe(true)
    expect(social.some(({ value }) => value.includes('👀'))).toBe(true)
    expect(social.some(({ value }) => value.includes('💬'))).toBe(true)
  })
})
