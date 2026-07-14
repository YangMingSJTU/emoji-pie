import type { EmojiStyle, GenerationMode } from '../../shared/types'

export const STYLE_OPTIONS: Array<{
  id: EmojiStyle
  label: string
  description: string
  color: string
}> = [
  { id: 'classic', label: '默认黄脸', description: '直接、有梗', color: '#f2c94c' },
  { id: 'cute', label: '可爱风', description: '软萌、亲和', color: '#ed8da0' },
  { id: 'office', label: '社畜风', description: '班味十足', color: '#6ea98b' },
  { id: 'chaos', label: '发疯风', description: '高能、抽象', color: '#e86552' }
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
