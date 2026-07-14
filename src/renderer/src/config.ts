import type {
  EmojiStyle,
  EmojiStyleSelection,
  GenerationMode
} from '../../shared/types'

export const STYLE_OPTIONS: Array<{
  id: EmojiStyleSelection
  label: string
  description: string
  previewStyles: EmojiStyle[]
}> = [
  {
    id: 'smart',
    label: '智能搭配',
    description: '按情绪和场景混合效果',
    previewStyles: ['classic', 'cute', 'office', 'chaos']
  },
  {
    id: 'classic',
    label: '经典黄脸',
    description: '直接、耐看',
    previewStyles: ['classic']
  },
  {
    id: 'cute',
    label: '软萌可爱',
    description: '圆润、亲和',
    previewStyles: ['cute']
  },
  {
    id: 'deadpan',
    label: '冷淡敷衍',
    description: '克制、无语',
    previewStyles: ['deadpan']
  },
  {
    id: 'office',
    label: '社畜打工',
    description: '班味十足',
    previewStyles: ['office']
  },
  {
    id: 'sarcastic',
    label: '阴阳怪气',
    description: '挑眉、反话感',
    previewStyles: ['sarcastic']
  },
  {
    id: 'spectator',
    label: '吃瓜围观',
    description: '看热闹、围观',
    previewStyles: ['spectator']
  },
  {
    id: 'chaos',
    label: '破防发疯',
    description: '高能、抽象',
    previewStyles: ['chaos']
  }
]

export const PROMPT_SUGGESTIONS: Record<GenerationMode, string[]> = {
  express: ['今天又要加班', '我真的服了', '好耶，终于下班了', '今天不想努力了'],
  reply: ['这个需求简单改一下', '今晚加班吗？', '在吗，帮我个忙', '明天早上开个会']
}

export const SCENE_LABELS = {
  daily: '日常',
  work: '工作',
  social: '社交'
} as const
