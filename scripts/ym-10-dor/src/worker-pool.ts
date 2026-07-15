import { utilityProcess, type UtilityProcess } from 'electron'
import { DECODE_CONCURRENCY } from './constants'
import type { ProbeImageProcessor, ProcessedImage } from './contracts'

interface WorkerRequest {
  id: number
  inputBase64: string
  variantIndex: number
}

interface WorkerResponse {
  id: number
  ok: boolean
  pngBase64?: string
  sha256?: string
  errorCode?: string
}

interface PendingJob {
  id: number
  input: Buffer
  variantIndex: number
  resolve: (value: ProcessedImage) => void
  reject: (error: Error) => void
}

interface WorkerSlot {
  child: UtilityProcess
  job: PendingJob | null
}

export class SharpUtilityProcessPool implements ProbeImageProcessor {
  private readonly slots: WorkerSlot[] = []
  private readonly queue: PendingJob[] = []
  private nextId = 1
  private disposed = false

  constructor(private readonly workerPath: string, workerCount = DECODE_CONCURRENCY) {
    if (workerCount !== DECODE_CONCURRENCY) throw new Error('decode_concurrency_is_fixed')
    for (let index = 0; index < workerCount; index += 1) this.slots.push(this.spawn(index))
  }

  process(input: Buffer, variantIndex: number): Promise<ProcessedImage> {
    if (this.disposed) return Promise.reject(new Error('worker_pool_disposed'))
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, input, variantIndex, resolve, reject })
      this.pump()
    })
  }

  dispose(): void {
    this.disposed = true
    for (const job of this.queue.splice(0)) job.reject(new Error('worker_pool_disposed'))
    for (const slot of this.slots) {
      slot.job?.reject(new Error('worker_pool_disposed'))
      slot.job = null
      slot.child.kill()
    }
  }

  private spawn(index: number): WorkerSlot {
    const child = utilityProcess.fork(this.workerPath, [], {
      serviceName: `YM-10 Sharp Worker ${index + 1}`,
      stdio: 'pipe'
    })
    const slot: WorkerSlot = { child, job: null }
    child.on('message', (message: WorkerResponse) => this.onMessage(slot, message))
    child.once('exit', () => this.onExit(slot, index))
    return slot
  }

  private onMessage(slot: WorkerSlot, message: WorkerResponse): void {
    const job = slot.job
    if (!job || message.id !== job.id) return
    slot.job = null
    if (!message.ok || !message.pngBase64 || !message.sha256) {
      job.reject(new Error(message.errorCode || 'sharp_worker_failed'))
    } else {
      job.resolve({ png: Buffer.from(message.pngBase64, 'base64'), sha256: message.sha256 })
    }
    this.pump()
  }

  private onExit(slot: WorkerSlot, index: number): void {
    const job = slot.job
    slot.job = null
    job?.reject(new Error('sharp_worker_exited'))
    if (!this.disposed) {
      const replacement = this.spawn(index)
      const slotIndex = this.slots.indexOf(slot)
      if (slotIndex >= 0) this.slots[slotIndex] = replacement
      this.pump()
    }
  }

  private pump(): void {
    if (this.disposed) return
    for (const slot of this.slots) {
      if (slot.job || this.queue.length === 0) continue
      const job = this.queue.shift()
      if (!job) break
      slot.job = job
      const request: WorkerRequest = {
        id: job.id,
        inputBase64: job.input.toString('base64'),
        variantIndex: job.variantIndex
      }
      slot.child.postMessage(request)
    }
  }
}
