import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ProbeMetrics } from './contracts'
import { assertNoForbiddenValues } from './privacy'

export class NdjsonMetricsWriter {
  constructor(private readonly outputPath: string) {}

  async write(metrics: ProbeMetrics): Promise<void> {
    assertNoForbiddenValues(metrics)
    await mkdir(dirname(this.outputPath), { recursive: true })
    await appendFile(this.outputPath, `${JSON.stringify(metrics)}\n`, 'utf8')
  }
}
