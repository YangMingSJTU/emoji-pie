import { processImageBytes } from './image-processing'

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

interface WorkerRequest {
  id: number
  inputBase64: string
  variantIndex: number
  inputKind: 'remote' | 'local'
  diagnosticBehavior?: 'crash' | 'hang'
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)) return error.message
  return 'sharp_processing_failed'
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort
if (!parentPort) throw new Error('sharp_worker_requires_utility_process')
parentPort.on('message', (event) => {
  const request = event.data as Partial<WorkerRequest>
  const id = Number(request.id)
  if (!Number.isInteger(id) || typeof request.inputBase64 !== 'string' ||
    !Number.isInteger(request.variantIndex) ||
    !['remote', 'local'].includes(String(request.inputKind)) ||
    (request.diagnosticBehavior !== undefined &&
      !['crash', 'hang'].includes(request.diagnosticBehavior))) {
    parentPort.postMessage({ id, ok: false, errorCode: 'invalid_worker_request' })
    return
  }
  if (request.diagnosticBehavior === 'crash') {
    process.exit(70)
  }
  if (request.diagnosticBehavior === 'hang') return

  const input = Buffer.from(request.inputBase64, 'base64')
  void processImageBytes(input, Number(request.variantIndex), request.inputKind)
    .then(({ png, sha256 }) => parentPort.postMessage({
      id,
      ok: true,
      pngBase64: png.toString('base64'),
      sha256
    }))
    .catch((error) => parentPort.postMessage({ id, ok: false, errorCode: errorCode(error) }))
})
