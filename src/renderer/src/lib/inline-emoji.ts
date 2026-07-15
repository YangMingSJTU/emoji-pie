import type { EmotionId, GenerationMode, TextAnalysis } from '../../../shared/types'
import { hashText } from './text-analysis'

export interface InlineEmojiSuggestion {
  id: string
  value: string
  label: string
}

interface EmojiOption {
  value: string
  label: string
}

const EMOTION_OPTIONS: Record<EmotionId, readonly EmojiOption[]> = {
  happy: [
    { value: '😄', label: '开心' },
    { value: '😁', label: '得意' },
    { value: '😂', label: '笑出声' },
    { value: '😊', label: '满足' },
    { value: '😉', label: '收到' },
    { value: '😎', label: '稳了' },
    { value: '🥳', label: '庆祝' }
  ],
  sad: [
    { value: '😔', label: '低落' },
    { value: '😢', label: '难过' },
    { value: '😭', label: '绷不住' },
    { value: '😞', label: '失望' },
    { value: '😟', label: '担心' },
    { value: '😣', label: '委屈' },
    { value: '😥', label: '心累' }
  ],
  angry: [
    { value: '😠', label: '生气' },
    { value: '😡', label: '火大' },
    { value: '😤', label: '忍住' },
    { value: '🙄', label: '不耐烦' },
    { value: '😒', label: '不爽' },
    { value: '😑', label: '冷静' },
    { value: '😣', label: '憋住' }
  ],
  speechless: [
    { value: '😑', label: '无语' },
    { value: '😶', label: '沉默' },
    { value: '🙄', label: '白眼' },
    { value: '😐', label: '平静' },
    { value: '😒', label: '就这' },
    { value: '😬', label: '难评' },
    { value: '🤐', label: '闭麦' }
  ],
  tired: [
    { value: '😴', label: '困了' },
    { value: '😫', label: '累了' },
    { value: '😩', label: '心累' },
    { value: '😪', label: '没电' },
    { value: '😵', label: '宕机' },
    { value: '😑', label: '放空' },
    { value: '😔', label: '想躺' }
  ],
  surprised: [
    { value: '😮', label: '吃惊' },
    { value: '😲', label: '震惊' },
    { value: '😳', label: '愣住' },
    { value: '😱', label: '吓到' },
    { value: '🤯', label: '爆炸' },
    { value: '😯', label: '没想到' },
    { value: '😵', label: '头晕' }
  ],
  awkward: [
    { value: '😅', label: '尴尬' },
    { value: '😬', label: '难绷' },
    { value: '🙃', label: '微笑' },
    { value: '😶', label: '沉默' },
    { value: '🤭', label: '憋笑' },
    { value: '😳', label: '社死' },
    { value: '😐', label: '装镇定' }
  ],
  smug: [
    { value: '😏', label: '拿捏' },
    { value: '😎', label: '稳了' },
    { value: '😉', label: '懂的' },
    { value: '😌', label: '舒服' },
    { value: '😁', label: '得意' },
    { value: '🤭', label: '偷笑' },
    { value: '🙂', label: '淡定' }
  ],
  crazy: [
    { value: '🤪', label: '发疯' },
    { value: '😵', label: '宕机' },
    { value: '🤯', label: '爆炸' },
    { value: '😈', label: '搞事' },
    { value: '😂', label: '笑疯' },
    { value: '😭', label: '崩溃' },
    { value: '😱', label: '救命' }
  ]
}

const SCENE_OPTIONS: Record<TextAnalysis['scene'], readonly EmojiOption[]> = {
  daily: [
    { value: '✨', label: '加点戏' },
    { value: '👍', label: '可以' }
  ],
  work: [
    { value: '💻', label: '工位' },
    { value: '☕', label: '续命' }
  ],
  social: [
    { value: '👀', label: '围观' },
    { value: '💬', label: '回复' }
  ]
}

function rotate<T>(values: readonly T[], offset: number): T[] {
  return values.map((_, index) => values[(index + offset) % values.length])
}

export function createInlineEmojiSuggestions(
  prompt: string,
  mode: GenerationMode,
  analysis: TextAnalysis,
  nonce: number
): InlineEmojiSuggestion[] {
  const emotionOptions = EMOTION_OPTIONS[analysis.emotion]
  const sceneOptions = SCENE_OPTIONS[analysis.scene]
  const offset = hashText(`${prompt}:${mode}:${analysis.emotion}:${nonce}`) % emotionOptions.length
  const rotated = rotate(emotionOptions, offset)
  const choices: EmojiOption[] = [
    ...rotated.slice(0, 3),
    {
      value: `${rotated[3].value}${sceneOptions[0].value}`,
      label: `${rotated[3].label}·${sceneOptions[0].label}`
    },
    {
      value: `${rotated[4].value}${sceneOptions[1].value}`,
      label: `${rotated[4].label}·${sceneOptions[1].label}`
    }
  ]

  return choices.map((choice, index) => ({
    id: `inline-${index}-${hashText(`${choice.value}:${choice.label}`).toString(36)}`,
    ...choice
  }))
}
