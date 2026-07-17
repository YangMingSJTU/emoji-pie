import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { LocalAssetErrorCode, LocalAssetMimeType } from '../shared/local-assets'

export interface LocalAssetWorkerResult {
  mimeType: LocalAssetMimeType
  width: number
  height: number
  pixelSha256: string
  thumbnail: Buffer
}

export interface LocalAssetWorkerPool {
  process: (filePath: string) => Promise<LocalAssetWorkerResult>
  dispose: () => Promise<void>
}

export class LocalAssetWorkerError extends Error {
  constructor(readonly code: LocalAssetErrorCode, message: string) {
    super(message)
    this.name = 'LocalAssetWorkerError'
  }
}

interface WorkerSuccessMessage {
  jobId: string
  ok: true
  value: Omit<LocalAssetWorkerResult, 'thumbnail'> & { thumbnail: Uint8Array }
}

interface WorkerFailureMessage {
  jobId: string
  ok: false
  code: LocalAssetErrorCode
  message: string
}

type WorkerMessage = WorkerSuccessMessage | WorkerFailureMessage

interface QueuedJob {
  id: string
  filePath: string
  resolve: (value: LocalAssetWorkerResult) => void
  reject: (error: Error) => void
}

interface WorkerSlot {
  worker: Worker
  job?: QueuedJob
  timer?: NodeJS.Timeout
  replacing: boolean
}

const WORKER_SOURCE = String.raw`
  const { createHash } = require('node:crypto')
  const { parentPort } = require('node:worker_threads')
  const sharp = require('sharp')

  const MAX_EDGE = 8192
  const MAX_PIXELS = 40000000

  function fail(code, message) {
    const error = new Error(message)
    error.localAssetCode = code
    throw error
  }

  function mimeForFormat(format) {
    if (format === 'png') return 'image/png'
    if (format === 'jpeg') return 'image/jpeg'
    if (format === 'webp') return 'image/webp'
    fail('unsupported_type', '只支持 PNG、JPEG 与静态 WebP')
  }

  parentPort.on('message', async ({ jobId, filePath }) => {
    try {
      const metadata = await sharp(filePath, {
        animated: true,
        failOn: 'error',
        limitInputPixels: MAX_PIXELS + 1
      }).metadata()
      const width = metadata.autoOrient?.width ?? metadata.width
      const height = metadata.autoOrient?.height ?? metadata.height
      if (!width || !height) fail('invalid_image', '无法读取图片尺寸')
      if ((metadata.pages ?? 1) > 1) fail('animated_image_rejected', '不支持动画图片')
      if (width > MAX_EDGE || height > MAX_EDGE) {
        fail('dimensions_too_large', '图片单边尺寸超过 8192 像素')
      }
      if (width * height > MAX_PIXELS) {
        fail('decoded_pixels_too_large', '图片解码像素超过 4000 万')
      }
      const mimeType = mimeForFormat(metadata.format)
      const rawResult = await sharp(filePath, {
        animated: false,
        failOn: 'error',
        limitInputPixels: MAX_PIXELS
      }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const pixelSha256 = createHash('sha256')
        .update(String(rawResult.info.width))
        .update('x')
        .update(String(rawResult.info.height))
        .update('\0')
        .update(rawResult.data)
        .digest('hex')
      const thumbnail = await sharp(filePath, {
        animated: false,
        failOn: 'error',
        limitInputPixels: MAX_PIXELS
      }).rotate().resize(320, 320, {
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: false
      }).webp({ quality: 82, effort: 4 }).toBuffer()
      parentPort.postMessage({
        jobId,
        ok: true,
        value: { mimeType, width, height, pixelSha256, thumbnail }
      })
    } catch (error) {
      parentPort.postMessage({
        jobId,
        ok: false,
        code: error?.localAssetCode ?? 'invalid_image',
        message: error instanceof Error ? error.message : '图片处理失败'
      })
    }
  })
`

/**
 * Keeps exactly two isolated Sharp workers. A timed-out or crashed worker is
 * terminated and replaced before queued work continues.
 */
export class SharpLocalAssetWorkerPool implements LocalAssetWorkerPool {
  private readonly slots: WorkerSlot[] = []
  private readonly queue: QueuedJob[] = []
  private disposed = false

  constructor(
    private readonly workerCount = 2,
    private readonly timeoutMs = 3_000,
    private readonly workerSource = WORKER_SOURCE
  ) {
    if (workerCount !== 2) throw new Error('Local asset worker count is fixed at two')
    for (let index = 0; index < workerCount; index += 1) this.slots.push(this.createSlot())
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
    await Promise.all(this.slots.map(async (slot) => {
      if (slot.timer) clearTimeout(slot.timer)
      slot.job?.reject(error)
      slot.job = undefined
      slot.replacing = true
      await slot.worker.terminate()
    }))
  }

  private createSlot(): WorkerSlot {
    const slot: WorkerSlot = {
      worker: new Worker(this.workerSource, { eval: true }),
      replacing: false
    }
    this.bindSlot(slot)
    return slot
  }

  private bindSlot(slot: WorkerSlot): void {
    slot.worker.on('message', (message: WorkerMessage) => {
      const job = slot.job
      if (!job || message.jobId !== job.id) return
      this.clearJob(slot)
      if (message.ok) {
        job.resolve({ ...message.value, thumbnail: Buffer.from(message.value.thumbnail) })
      } else {
        job.reject(new LocalAssetWorkerError(message.code, message.message))
      }
      this.dispatch()
    })
    slot.worker.on('error', (error) => {
      this.replaceCrashedSlot(slot, error)
    })
    slot.worker.on('exit', (code) => {
      if (!this.disposed && !slot.replacing && code !== 0) {
        this.replaceCrashedSlot(slot, new Error(`Sharp worker exited with code ${code}`))
      }
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
        void this.replaceWorker(slot)
      }, this.timeoutMs)
      slot.worker.postMessage({ jobId: job.id, filePath: job.filePath })
    }
  }

  private clearJob(slot: WorkerSlot): void {
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = undefined
    slot.job = undefined
  }

  private replaceCrashedSlot(slot: WorkerSlot, cause: Error): void {
    if (slot.replacing || this.disposed) return
    const job = slot.job
    this.clearJob(slot)
    job?.reject(new LocalAssetWorkerError('processing_crashed', cause.message))
    void this.replaceWorker(slot)
  }

  private async replaceWorker(slot: WorkerSlot): Promise<void> {
    if (slot.replacing || this.disposed) return
    slot.replacing = true
    await slot.worker.terminate().catch(() => undefined)
    if (this.disposed) return
    slot.worker = new Worker(this.workerSource, { eval: true })
    slot.replacing = false
    this.bindSlot(slot)
    this.dispatch()
  }
}
