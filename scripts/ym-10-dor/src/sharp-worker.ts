import { createHash } from 'node:crypto'
import sharp from 'sharp'

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

interface WorkerRequest {
  id: number
  inputBase64: string
  variantIndex: number
}

const MAX_INPUT_BYTES = 10 * 1024 * 1024
const MAX_INPUT_PIXELS = 40_000_000
const MAX_EDGE = 8_192
const OUTPUT_EDGE = 512
const COLORS = ['#ffca28', '#42a5f5', '#ef5350', '#66bb6a', '#ab47bc', '#ffa726', '#26a69a', '#7e57c2', '#ec407a']
const POSITIONS = ['centre', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'] as const

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)) return error.message
  return 'sharp_processing_failed'
}

async function processImage(request: WorkerRequest): Promise<{ pngBase64: string; sha256: string }> {
  const input = Buffer.from(request.inputBase64, 'base64')
  if (input.byteLength === 0 || input.byteLength > MAX_INPUT_BYTES) throw new Error('image_size_rejected')
  const source = sharp(input, {
    animated: false,
    failOn: 'warning',
    limitInputPixels: MAX_INPUT_PIXELS
  })
  const metadata = await source.metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (!width || !height || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_INPUT_PIXELS) {
    throw new Error('image_dimensions_rejected')
  }
  if ((metadata.pages ?? 1) !== 1) throw new Error('animated_image_rejected')

  const variant = Math.abs(request.variantIndex) % COLORS.length
  const overlay = Buffer.from(
    `<svg width="${OUTPUT_EDGE}" height="${OUTPUT_EDGE}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="7" y="7" width="498" height="498" rx="32" fill="none" stroke="${COLORS[variant]}" stroke-width="14"/>` +
    `<circle cx="474" cy="38" r="18" fill="${COLORS[variant]}"/>` +
    '</svg>'
  )
  const png = await source
    .rotate()
    .resize(OUTPUT_EDGE, OUTPUT_EDGE, { fit: 'cover', position: POSITIONS[variant] })
    .composite([{ input: overlay, blend: 'over' }])
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer()
  return {
    pngBase64: png.toString('base64'),
    sha256: createHash('sha256').update(png).digest('hex')
  }
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort
if (!parentPort) throw new Error('sharp_worker_requires_utility_process')
parentPort.on('message', (event) => {
  const request = event.data as Partial<WorkerRequest>
  const id = Number(request.id)
  if (!Number.isInteger(id) || typeof request.inputBase64 !== 'string' ||
    !Number.isInteger(request.variantIndex)) {
    parentPort.postMessage({ id, ok: false, errorCode: 'invalid_worker_request' })
    return
  }
  void processImage(request as WorkerRequest)
    .then((result) => parentPort.postMessage({ id, ok: true, ...result }))
    .catch((error) => parentPort.postMessage({ id, ok: false, errorCode: errorCode(error) }))
})
