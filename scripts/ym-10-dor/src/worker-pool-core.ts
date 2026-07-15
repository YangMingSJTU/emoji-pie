import { createHash } from 'node:crypto'
import type { ProbeImageProcessor, ProcessedImage } from './contracts'

export interface ProbeWorkerProcess {
  readonly pid?: number
  postMessage(message: unknown): void
  kill(): unknown
  on(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'exit', listener: () => void): unknown
}

interface WorkerRequest {
  id: number
  inputBase64: string
  variantIndex: number
  inputKind: 'remote' | 'local'
  diagnosticBehavior?: 'crash' | 'hang'
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
  inputKind: 'remote' | 'local'
  diagnosticBehavior?: 'crash' | 'hang'
  resolve: (value: ProcessedImage) => void
  reject: (error: Error) => void
}

interface WorkerSlot {
  index: number
  child: ProbeWorkerProcess
  job: PendingJob | null
  timer: NodeJS.Timeout | null
}

function asWorkerResponse(value: unknown): WorkerResponse | null {
  if (!value || typeof value !== 'object') return null
  const response = value as Partial<WorkerResponse>
  return Number.isInteger(response.id) && typeof response.ok === 'boolean'
    ? response as WorkerResponse
    : null
}

export class ResilientImageWorkerPool implements ProbeImageProcessor {
  private readonly slots: WorkerSlot[] = []
  private readonly queue: PendingJob[] = []
  private nextId = 1
  private disposed = false

  constructor(
    private readonly createWorker: (index: number) => ProbeWorkerProcess,
    workerCount: number,
    private readonly jobTimeoutMs: number
  ) {
    if (!Number.isInteger(workerCount) || workerCount < 1) throw new Error('invalid_worker_count')
    if (!Number.isInteger(jobTimeoutMs) || jobTimeoutMs < 1) throw new Error('invalid_worker_timeout')
    for (let index = 0; index < workerCount; index += 1) this.slots.push(this.spawn(index))
  }

  process(input: Buffer, variantIndex: number): Promise<ProcessedImage> {
    return this.enqueue(input, variantIndex, 'remote')
  }

  processLocal(input: Buffer, variantIndex: number): Promise<ProcessedImage> {
    return this.enqueue(input, variantIndex, 'local')
  }

  runDiagnostic(behavior: 'crash' | 'hang'): Promise<ProcessedImage> {
    return this.enqueue(Buffer.alloc(0), 0, 'remote', behavior)
  }

  activeWorkerPids(): number[] {
    return this.slots
      .map(({ child }) => child.pid)
      .filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0)
  }

  terminateBusyWorker(): number | null {
    const slot = this.slots.find((candidate) => candidate.job !== null)
    if (!slot) return null
    const pid = slot.child.pid ?? null
    slot.child.kill()
    return pid
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const job of this.queue.splice(0)) job.reject(new Error('worker_pool_disposed'))
    for (const slot of this.slots) {
      this.rejectSlotJob(slot, 'worker_pool_disposed')
      slot.child.kill()
    }
  }

  private enqueue(
    input: Buffer,
    variantIndex: number,
    inputKind: 'remote' | 'local',
    diagnosticBehavior?: 'crash' | 'hang'
  ): Promise<ProcessedImage> {
    if (this.disposed) return Promise.reject(new Error('worker_pool_disposed'))
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        input,
        variantIndex,
        inputKind,
        diagnosticBehavior,
        resolve,
        reject
      })
      this.pump()
    })
  }

  private spawn(index: number): WorkerSlot {
    const child = this.createWorker(index)
    const slot: WorkerSlot = { index, child, job: null, timer: null }
    child.on('message', (message) => this.onMessage(slot, message))
    child.once('exit', () => this.replaceSlot(slot, 'sharp_worker_exited', false))
    return slot
  }

  private onMessage(slot: WorkerSlot, value: unknown): void {
    const job = slot.job
    if (!job) return
    const message = asWorkerResponse(value)
    if (!message) {
      this.replaceSlot(slot, 'sharp_worker_protocol_error', true)
      return
    }
    if (message.id !== job.id) return
    this.clearSlotJob(slot)
    if (!message.ok || !message.pngBase64 || !message.sha256) {
      job.reject(new Error(message.errorCode || 'sharp_worker_failed'))
      this.pump()
      return
    }
    const png = Buffer.from(message.pngBase64, 'base64')
    const actualSha256 = createHash('sha256').update(png).digest('hex')
    if (png.byteLength === 0 || message.sha256 !== actualSha256) {
      job.reject(new Error('sharp_worker_integrity_error'))
      this.replaceSlot(slot, 'sharp_worker_integrity_error', true)
      return
    }
    job.resolve({ png, sha256: actualSha256 })
    this.pump()
  }

  private replaceSlot(slot: WorkerSlot, errorCode: string, kill: boolean): void {
    const slotIndex = this.slots.indexOf(slot)
    if (slotIndex < 0) return
    this.rejectSlotJob(slot, errorCode)
    if (kill) slot.child.kill()
    if (this.disposed) return
    this.slots[slotIndex] = this.spawn(slot.index)
    this.pump()
  }

  private clearSlotJob(slot: WorkerSlot): PendingJob | null {
    const job = slot.job
    slot.job = null
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = null
    return job
  }

  private rejectSlotJob(slot: WorkerSlot, errorCode: string): void {
    this.clearSlotJob(slot)?.reject(new Error(errorCode))
  }

  private pump(): void {
    if (this.disposed) return
    for (const slot of this.slots) {
      if (slot.job || this.queue.length === 0) continue
      const job = this.queue.shift()
      if (!job) break
      slot.job = job
      slot.timer = setTimeout(() => {
        if (slot.job?.id === job.id) this.replaceSlot(slot, 'sharp_worker_timeout', true)
      }, this.jobTimeoutMs)
      const request: WorkerRequest = {
        id: job.id,
        inputBase64: job.input.toString('base64'),
        variantIndex: job.variantIndex,
        inputKind: job.inputKind,
        diagnosticBehavior: job.diagnosticBehavior
      }
      try {
        slot.child.postMessage(request)
      } catch {
        this.replaceSlot(slot, 'sharp_worker_post_failed', true)
      }
    }
  }
}
