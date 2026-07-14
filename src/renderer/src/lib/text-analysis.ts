import type {
  EmojiStyle,
  EmotionId,
  GenerationMode,
  RuntimeEmojiVariant,
  TextAnalysis
} from '../../../shared/types'

export interface EmojiSpec {
  id: string
  prompt: string
  mode: GenerationMode
  style: EmojiStyle
  emotion: EmotionId
  caption: string
  seed: number
}

export interface GenerationOverrides {
  analysis?: TextAnalysis
  variants?: RuntimeEmojiVariant[]
}

interface EmotionRule {
  emotion: EmotionId
  label: string
  patterns: RegExp[]
  weight: number
}

const EMOTION_RULES: EmotionRule[] = [
  {
    emotion: 'happy',
    label: '开心',
    patterns: [/开心|快乐|好耶|太好|哈哈|喜欢|赢了|成功|可以的|好消息|周五|下班/],
    weight: 4
  },
  {
    emotion: 'sad',
    label: '委屈',
    patterns: [/难过|伤心|委屈|心碎|哭|不爱了|算了吧|失败|失望|没人懂/],
    weight: 4
  },
  {
    emotion: 'angry',
    label: '生气',
    patterns: [/生气|气死|离谱|烦死|过分|别惹|闭嘴|凭什么|不行|拒绝|滚|怒/],
    weight: 5
  },
  {
    emotion: 'tired',
    label: '疲惫',
    patterns: [/加班|上班|需求|改一下|累|困|不想动|没睡|熬夜|周一|工作|开会|代码|方案/],
    weight: 5
  },
  {
    emotion: 'surprised',
    label: '震惊',
    patterns: [/震惊|居然|竟然|真的[吗？?]|什么[？?]|不会吧|还有这种|突然|没想到|啊[？?]/],
    weight: 5
  },
  {
    emotion: 'awkward',
    label: '尴尬',
    patterns: [/尴尬|哈哈哈?\.{2,}|额|呃|那个|也不是|怎么说|社死|沉默|不熟/],
    weight: 4
  },
  {
    emotion: 'smug',
    label: '得意',
    patterns: [/拿捏|轻松|简单|我会|看我|搞定|稳了|不过如此|问题不大|交给我/],
    weight: 4
  },
  {
    emotion: 'crazy',
    label: '发疯',
    patterns: [/疯|崩溃|受不了|毁灭|都别活|啊{3,}|救命|摆烂|随便吧|无所谓/],
    weight: 6
  },
  {
    emotion: 'speechless',
    label: '无语',
    patterns: [/无语|服了|呵呵|随你|行吧|你说得对|就这|然后呢|没话说|哦|收到/],
    weight: 4
  }
]

const LABELS: Record<EmotionId, string> = {
  happy: '开心',
  sad: '委屈',
  angry: '生气',
  speechless: '无语',
  tired: '疲惫',
  surprised: '震惊',
  awkward: '尴尬',
  smug: '得意',
  crazy: '发疯'
}

const RELATED_EMOTIONS: Record<EmotionId, EmotionId[]> = {
  happy: ['happy', 'smug', 'surprised'],
  sad: ['sad', 'tired', 'awkward'],
  angry: ['angry', 'crazy', 'speechless'],
  speechless: ['speechless', 'awkward', 'tired'],
  tired: ['tired', 'speechless', 'sad'],
  surprised: ['surprised', 'awkward', 'happy'],
  awkward: ['awkward', 'speechless', 'tired'],
  smug: ['smug', 'happy', 'speechless'],
  crazy: ['crazy', 'angry', 'surprised']
}

const REPLY_CAPTIONS: Record<EmotionId, string[]> = {
  happy: ['好耶，这就来', '没问题，包在我身上', '快乐同意', '这事我爱听'],
  sad: ['让我缓一缓', '弱小但会回复', '我先哭一下', '这真的可以吗'],
  angry: ['好的，我忍一下', '你说得都对', '马上，立刻，现在', '我听见心碎了'],
  speechless: ['好的呢', '懂了，但没完全懂', '还能说什么呢', '行，都是我的问题'],
  tired: ['收到，马上改', '我先活着再说', '需求不允许我休息', '这就安排'],
  surprised: ['真的假的？', '还有这种事？', '等一下，让我消化', '你再说一遍'],
  awkward: ['哈哈，也不是不行', '先假装没看见', '这个嘛……', '正在组织语言'],
  smug: ['拿捏', '这题我会', '交给我', '稳了'],
  crazy: ['都别拦我', '我来处理！', '事情开始有趣了', '那就一起疯']
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function hashText(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function analyzeText(text: string, mode: GenerationMode): TextAnalysis {
  const normalized = normalizeText(text)
  const scores = new Map<EmotionId, number>()

  for (const rule of EMOTION_RULES) {
    const matches = rule.patterns.filter((pattern) => pattern.test(normalized)).length
    if (matches > 0) scores.set(rule.emotion, matches * rule.weight)
  }

  if (/[!！]{2,}/.test(normalized)) scores.set('angry', (scores.get('angry') ?? 0) + 2)
  if (/[?？]{2,}/.test(normalized)) scores.set('surprised', (scores.get('surprised') ?? 0) + 2)
  if (/哈{2,}/.test(normalized)) scores.set('happy', (scores.get('happy') ?? 0) + 2)

  const fallback: EmotionId = mode === 'reply' ? 'speechless' : 'happy'
  const emotion = [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback
  const scene = /老板|需求|工作|上班|加班|开会|同事|客户|方案|代码/.test(normalized)
    ? 'work'
    : /朋友|对象|群|消息|回复|聊天/.test(normalized)
      ? 'social'
      : 'daily'

  const keywords = EMOTION_RULES.flatMap((rule) =>
    rule.patterns.flatMap((pattern) => normalized.match(pattern)?.[0] ?? [])
  ).slice(0, 3)

  return {
    emotion,
    emotionLabel: LABELS[emotion],
    scene,
    tone: mode === 'reply' ? '回应' : emotion === 'crazy' ? '宣泄' : '表达',
    intent: mode === 'reply' ? '生成聊天回复' : '传达当前情绪',
    keywords
  }
}

export function createCaption(
  text: string,
  mode: GenerationMode,
  emotion: EmotionId,
  variant: number
): string {
  if (mode === 'reply') {
    const replies = REPLY_CAPTIONS[emotion]
    return replies[variant % replies.length]
  }

  const normalized = normalizeText(text).replace(/^[^：:]{1,8}[：:]\s*/, '')
  if (normalized.length <= 18) return normalized
  return `${normalized.slice(0, 17)}…`
}

export function createGenerationSpecs(
  prompt: string,
  mode: GenerationMode,
  style: EmojiStyle,
  count: number,
  offset = 0,
  nonce = Date.now(),
  overrides: GenerationOverrides = {}
): EmojiSpec[] {
  const normalized = normalizeText(prompt)
  if (!normalized) return []

  const analysis = overrides.analysis ?? analyzeText(normalized, mode)
  const related = RELATED_EMOTIONS[analysis.emotion]
  const baseSeed = hashText(`${normalized}:${mode}:${style}:${nonce}`)
  const customVariants = (overrides.variants ?? [])
    .map((variant) => ({
      emotion: variant.emotion,
      caption: normalizeText(variant.caption).slice(0, 28)
    }))
    .filter((variant) => Boolean(variant.caption && RELATED_EMOTIONS[variant.emotion]))

  return Array.from({ length: count }, (_, index) => {
    const position = index + offset
    const seed = (baseSeed + Math.imul(position + 1, 2654435761)) >>> 0
    const customVariant = customVariants.length > 0
      ? customVariants[position % customVariants.length]
      : undefined
    const emotion = customVariant?.emotion ?? related[position % related.length]
    return {
      id: `${nonce.toString(36)}-${position.toString(36)}-${seed.toString(36)}`,
      prompt: normalized,
      mode,
      style,
      emotion,
      caption: customVariant
        ? customVariant.caption
        : createCaption(normalized, mode, emotion, position),
      seed
    }
  })
}

export function emotionLabel(emotion: EmotionId): string {
  return LABELS[emotion]
}
