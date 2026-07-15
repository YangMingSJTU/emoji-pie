import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { MAX_ONLINE_BATCHES_PER_UTC_DAY } from './constants'

interface QuotaState {
  utcDate: string
  count: number
}

export class DailyOnlineQuota {
  private operation: Promise<void> = Promise.resolve()

  constructor(
    private readonly statePath: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  consume(): Promise<void> {
    const result = this.operation.then(() => this.consumeNow())
    this.operation = result.catch(() => undefined)
    return result
  }

  private async consumeNow(): Promise<void> {
    const utcDate = this.now().toISOString().slice(0, 10)
    let state: QuotaState = { utcDate, count: 0 }
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<QuotaState>
      if (parsed.utcDate === utcDate && Number.isInteger(parsed.count) && Number(parsed.count) >= 0) {
        state = { utcDate, count: Number(parsed.count) }
      }
    } catch {
      // Missing or malformed local quota state resets only the current UTC day.
    }
    if (state.count >= MAX_ONLINE_BATCHES_PER_UTC_DAY) throw new Error('daily_online_limit_reached')
    state.count += 1
    await mkdir(dirname(this.statePath), { recursive: true })
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', flag: 'w' })
    await rename(temporaryPath, this.statePath)
  }
}
