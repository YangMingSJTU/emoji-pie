import { normalizeLocalAssetText } from '../shared/local-assets'

interface SemanticTagRule {
  cues: readonly string[]
  tags: readonly string[]
  exact?: boolean
}

/**
 * Small, deterministic vocabulary for common Chinese chat intent and slang.
 * It expands only the in-memory query; user-authored asset tags stay unchanged
 * and no prompt or tag leaves the main process.
 */
const SEMANTIC_TAG_RULES: readonly SemanticTagRule[] = [
  { cues: ['加班', '熬夜'], tags: ['办公', '夜晚', '疲惫', '工作压力'] },
  { cues: ['需求'], tags: ['工作', '工作压力'] },
  { cues: ['很简单', '就这'], tags: ['讽刺', '无奈'] },
  { cues: ['收到', '明白'], tags: ['确认', '行动'] },
  { cues: ['处理', '办理'], tags: ['行动', '办公'] },
  { cues: ['蓝屏', '死机', '电脑坏'], tags: ['电脑故障', '崩溃'] },
  { cues: ['预算', '经费'], tags: ['金钱', '削减', '无奈'] },
  { cues: ['进度', '截止', 'deadline'], tags: ['截止时间', '催促', '等待'] },
  { cues: ['背锅', '不背'], tags: ['拒绝背锅', '防御'] },
  { cues: ['服了'], tags: ['无语', '投降', '无奈'] },
  { cues: ['裂开'], tags: ['崩溃', '破裂', '震惊'] },
  { cues: ['静静', '冷静一下'], tags: ['安静', '独处', '暂停'] },
  { cues: ['礼貌'], tags: ['质疑', '冒犯', '不满'] },
  { cues: ['谢谢你啊', '谢谢您啊'], tags: ['反讽', '勉强感谢'] },
  { cues: ['好耶'], tags: ['欢呼', '成功', '庆祝'] },
  { cues: ['救命', '救救'], tags: ['求助', '恐慌', '危险'] },
  { cues: ['吃饭', '聚餐'], tags: ['邀请', '晚餐', '聚会'] },
  { cues: ['再改', '改一版', '修改'], tags: ['修改', '工作', '崩溃'] },
  { cues: ['没睡', '睡觉', '睡了'], tags: ['夜晚', '睡眠', '困倦'] },
  { cues: ['在吗', '在不在'], tags: ['问候', '探头', '等待回复'], exact: true },
  { cues: ['早起', '起床'], tags: ['闹钟', '清晨', '困倦'] },
  { cues: ['楼下', '到了', '已到'], tags: ['到达', '等待', '楼房'] },
  { cues: ['堵车', '塞车'], tags: ['交通', '汽车', '烦躁'] },
  { cues: ['快递', '物流'], tags: ['包裹', '物流', '等待'] },
  { cues: ['哈哈', '笑死'], tags: ['大笑', '欢乐'] },
  { cues: ['啊?', '啊？'], tags: ['困惑', '疑问', '震惊'], exact: true },
  { cues: ['行', '可以', '好的'], tags: ['同意', '确认'], exact: true },
  { cues: ['6', '666'], tags: ['厉害', '佩服'], exact: true },
  { cues: ['yyds'], tags: ['赞叹', '最佳', '崇拜'] },
  { cues: ['绝绝子'], tags: ['强烈赞叹', '惊艳'] },
  { cues: ['破防'], tags: ['情绪崩溃', '难过', '感动'] },
  { cues: ['🙃'], tags: ['尴尬', '无奈'], exact: true },
  { cues: ['ok', '没问题'], tags: ['同意', '确认', '完成'] }
]

export function inferLocalAssetQueryTags(value: string): ReadonlySet<string> {
  const normalizedInput = normalizeLocalAssetText(value)
  const inferredTags = new Set<string>()
  for (const rule of SEMANTIC_TAG_RULES) {
    const matches = rule.exact
      ? rule.cues.some((cue) => normalizedInput === normalizeLocalAssetText(cue))
      : rule.cues.some((cue) => normalizedInput.includes(normalizeLocalAssetText(cue)))
    if (!matches) continue
    for (const tag of rule.tags) inferredTags.add(normalizeLocalAssetText(tag))
  }
  return inferredTags
}
