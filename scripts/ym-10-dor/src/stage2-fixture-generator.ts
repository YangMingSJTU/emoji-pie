import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDeflate } from 'node:zlib'
import { MAX_LOCAL_IMAGE_BYTES } from './constants'

export interface Stage2BoundaryFixture {
  id: 'nineteen_mib' | 'forty_megapixels' | 'edge_8192_by_1024' | 'edge_8192_by_1'
  path: string
  declaredMediaType: 'image/png'
  sizeBytes: number
  width: number
  height: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.byteLength)
  chunk.writeUInt32BE(data.byteLength, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength)
  return chunk
}

async function deflateTransparentRgba(width: number, height: number): Promise<Buffer> {
  const stream = createDeflate({ level: 9 })
  const chunks: Buffer[] = []
  stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
  const completed = once(stream, 'end')
  const row = Buffer.alloc(1 + width * 4)
  for (let index = 0; index < height; index += 1) {
    if (!stream.write(row)) await once(stream, 'drain')
  }
  stream.end()
  await completed
  return Buffer.concat(chunks)
}

async function transparentPng(width: number, height: number): Promise<Buffer> {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', await deflateTransparentRgba(width, height)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

async function writeFixture(
  directory: string,
  id: Stage2BoundaryFixture['id'],
  width: number,
  height: number,
  exactSize?: number
): Promise<Stage2BoundaryFixture> {
  let bytes = await transparentPng(width, height)
  if (exactSize !== undefined) {
    if (bytes.byteLength > exactSize) throw new Error('stage2_fixture_exceeds_exact_size')
    bytes = Buffer.concat([bytes, Buffer.alloc(exactSize - bytes.byteLength)])
  }
  if (bytes.byteLength > MAX_LOCAL_IMAGE_BYTES) throw new Error('stage2_fixture_exceeds_local_limit')
  const path = join(directory, `${id}.png`)
  await writeFile(path, bytes, { flag: 'wx' })
  return { id, path, declaredMediaType: 'image/png', sizeBytes: bytes.byteLength, width, height }
}

export async function generateStage2BoundaryFixtures(
  directory: string
): Promise<Stage2BoundaryFixture[]> {
  await mkdir(directory, { recursive: false })
  const fixtures: Stage2BoundaryFixture[] = []
  fixtures.push(await writeFixture(directory, 'nineteen_mib', 64, 64, 19 * 1024 * 1024))
  fixtures.push(await writeFixture(directory, 'forty_megapixels', 8_000, 5_000))
  fixtures.push(await writeFixture(directory, 'edge_8192_by_1024', 8_192, 1_024))
  fixtures.push(await writeFixture(directory, 'edge_8192_by_1', 8_192, 1))
  return fixtures
}
