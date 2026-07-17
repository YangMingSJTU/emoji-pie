import { randomUUID } from 'node:crypto'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { LocalAssetErrorCode } from '../shared/local-assets'
import {
  LocalAssetWorkerError,
  type LocalAssetWorkerPool,
  type LocalAssetWorkerResult
} from './local-asset-worker'

interface UtilityWorkerMessage {
  jobId: string
  ok: boolean
  value?: Omit<LocalAssetWorkerResult, 'thumbnail'> & { thumbnail: Uint8Array }
  code?: LocalAssetErrorCode
  message?: string
}

interface UtilityJob {
  id: string
  filePath: string
  resolve: (value: LocalAssetWorkerResult) => void
  reject: (error: Error) => void
}

interface UtilitySlot {
  child: UtilityProcess
  job?: UtilityJob
  timer?: NodeJS.Timeout
  replacing: boolean
}

/** Production Sharp isolation: exactly two Electron utility processes. */
export class ElectronSharpUtilityProcessPool implements LocalAssetWorkerPool {
  private readonly slots: UtilitySlot[] = []
  private readonly queue: UtilityJob[] = []
  private disposed = false

  constructor(
    private readonly entryPath: string,
    private readonly workerCount = 2,
    private readonly timeoutMs = 3_000
  ) {
    if (workerCount !== 2) throw new Error('Local asset utility-process count is fixed at two')
    for (let index = 0; index < workerCount; index += 1) this.slots.push(this.createSlot(index))
  }

  process(filePath: string): Promise<LocalAssetWorkerResult> {
    if (this.disposed) {
      return Promise.reject(new LocalAssetWorkerError('processing_crashed', '图片处理池已关闭'))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: randomUUID(), filePath, resolve, reject })
      this.dispatch()
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const error = new LocalAssetWorkerError('cancelled', '图片处理已取消')
    for (const job of this.queue.splice(0)) job.reject(error)
    for (const slot of this.slots) {
      if (slot.timer) clearTimeout(slot.timer)
      slot.job?.reject(error)
      slot.job = undefined
      slot.replacing = true
      slot.child.kill()
    }
  }

  private createSlot(index: number): UtilitySlot {
    const slot: UtilitySlot = {
      child: utilityProcess.fork(this.entryPath, [], {
        serviceName: `EmojiPie Local Asset Worker ${index + 1}`
      }),
      replacing: false
    }
    this.bindSlot(slot, index)
    return slot
  }

  private bindSlot(slot: UtilitySlot, index: number): void {
    slot.child.on('message', (message: UtilityWorkerMessage) => {
      const job = slot.job
      if (!job || message.jobId !== job.id) return
      this.clearJob(slot)
      if (message.ok && message.value) {
        job.resolve({ ...message.value, thumbnail: Buffer.from(message.value.thumbnail) })
      } else {
        job.reject(new LocalAssetWorkerError(
          message.code ?? 'processing_crashed',
          message.message ?? '图片处理进程失败'
        ))
      }
      this.dispatch()
    })
    slot.child.on('exit', (code) => {
      if (this.disposed || slot.replacing) return
      const job = slot.job
      this.clearJob(slot)
      job?.reject(new LocalAssetWorkerError(
        'processing_crashed',
        `图片处理进程异常退出（${code}）`
      ))
      this.replaceSlot(slot, index)
    })
  }

  private dispatch(): void {
    if (this.disposed) return
    for (const slot of this.slots) {
      if (slot.job || slot.replacing) continue
      const job = this.queue.shift()
      if (!job) return
      slot.job = job
      slot.timer = setTimeout(() => {
        const timedOutJob = slot.job
        if (!timedOutJob) return
        this.clearJob(slot)
        timedOutJob.reject(new LocalAssetWorkerError(
          'processing_timeout',
          `图片处理超过 ${this.timeoutMs}ms`
        ))
        const index = this.slots.indexOf(slot)
        this.replaceSlot(slot, index)
      }, this.timeoutMs)
      slot.child.postMessage({ jobId: job.id, filePath: job.filePath })
    }
  }

  private clearJob(slot: UtilitySlot): void {
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = undefined
    slot.job = undefined
  }

  private replaceSlot(slot: UtilitySlot, index: number): void {
    if (slot.replacing || this.disposed) return
    slot.replacing = true
    slot.child.kill()
    slot.child = utilityProcess.fork(this.entryPath, [], {
      serviceName: `EmojiPie Local Asset Worker ${index + 1}`
    })
    slot.replacing = false
    this.bindSlot(slot, index)
    this.dispatch()
  }
}
