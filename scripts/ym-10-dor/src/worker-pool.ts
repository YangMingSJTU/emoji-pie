import { utilityProcess } from 'electron'
import { DECODE_CONCURRENCY, SHARP_JOB_TIMEOUT_MS } from './constants'
import { ResilientImageWorkerPool, type ProbeWorkerProcess } from './worker-pool-core'

export class SharpUtilityProcessPool extends ResilientImageWorkerPool {
  constructor(workerPath: string, workerCount = DECODE_CONCURRENCY) {
    if (workerCount !== DECODE_CONCURRENCY) throw new Error('decode_concurrency_is_fixed')
    super(
      (index) => utilityProcess.fork(workerPath, [], {
        serviceName: `YM-10 Sharp Worker ${index + 1}`,
        stdio: 'pipe'
      }) as ProbeWorkerProcess,
      workerCount,
      SHARP_JOB_TIMEOUT_MS
    )
  }
}
