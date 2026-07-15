import type { KeywordPlan } from './contracts'
import { redactPrivateTerms } from './privacy'

const AMBIGUOUS_INPUTS = new Set(['行', '6', '🙃'])
const STOP_WORDS = new Set(['今天', '这个', '那个', '怎么', '一下', '真的', '已经', '还是'])

const KEYWORD_RULES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/加班|需求|老板|会议|进度/u, ['办公', '工作']],
  [/咖啡|奶茶/u, ['咖啡', '饮料']],
  [/周五|下班/u, ['庆祝', '下班']],
  [/电脑|蓝屏/u, ['电脑', '故障']],
  [/红包|预算/u, ['金钱', '期待']],
  [/猫/u, ['猫', '摇头']],
  [/狗/u, ['狗', '怀疑']],
  [/火锅|吃饭/u, ['美食', '聚会']],
  [/下雨/u, ['雨', '居家']],
  [/堵车/u, ['交通', '汽车']],
  [/旅行/u, ['旅行', '飞机']],
  [/暂停|停止/u, ['暂停', '停止']],
  [/开心|好耶|恭喜|通过/u, ['庆祝', '成功']],
  [/睡|早起/u, ['睡眠', '闹钟']],
  [/文件/u, ['文件', '检查']],
  [/快递/u, ['包裹', '物流']],
  [/游戏/u, ['游戏', '失败']],
  [/追剧/u, ['电视', '追剧']],
  [/救命/u, ['求助', '危险']]
]

function safeFallbackTokens(value: string): string[] {
  return (value.match(/[\p{Script=Han}A-Za-z0-9]+/gu) ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2 && !STOP_WORDS.has(entry))
    .map((entry) => [...entry].slice(0, 6).join(''))
}

export function planKeywords(input: string): KeywordPlan {
  const normalized = [...input]
    .map((character) => character.charCodeAt(0) < 32 ? ' ' : character)
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!normalized || AMBIGUOUS_INPUTS.has(normalized)) {
    return { status: 'needs_user_input', keywords: [] }
  }

  const safeInput = redactPrivateTerms(normalized)
  const keywords: string[] = []
  for (const [pattern, candidates] of KEYWORD_RULES) {
    if (!pattern.test(safeInput)) continue
    for (const candidate of candidates) {
      if (!keywords.includes(candidate)) keywords.push(candidate)
      if (keywords.length === 3) break
    }
    if (keywords.length === 3) break
  }
  if (keywords.length === 0) {
    for (const token of safeFallbackTokens(safeInput)) {
      if (!keywords.includes(token)) keywords.push(token)
    }
    keywords.splice(3)
  }
  return keywords.length > 0
    ? { status: 'ready', keywords }
    : { status: 'needs_user_input', keywords: [] }
}
