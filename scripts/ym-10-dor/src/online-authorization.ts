import type { DailyOnlineQuota } from './daily-quota'
import { normalizeConfirmedKeywords } from './keyword-planner'

export class ConfirmedOnlineBatchGate {
  constructor(private readonly quota: Pick<DailyOnlineQuota, 'consume'>) {}

  async authorize(value: unknown): Promise<string[]> {
    const confirmedKeywords = normalizeConfirmedKeywords(value)
    if (!confirmedKeywords) throw new Error('keywords_confirmation_required')
    await this.quota.consume()
    return confirmedKeywords
  }
}
