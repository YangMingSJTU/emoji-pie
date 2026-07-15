import { readFile } from 'node:fs/promises'
import { createServer, type Server as HttpsServer } from 'node:https'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { MAX_IMAGE_RESPONSE_BYTES } from './constants'
import { CORPUS_50_FORBIDDEN_VALUES, findForbiddenValues } from './privacy'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAZklEQVR42u3QMREAAAgEIOPYP4al3hyeDBSgMp3PSoAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECLhvAc3TAsKDD/FPAAAAAElFTkSuQmCC',
  'base64'
)

export const SECURITY_IMAGE_IDS = {
  wrongMediaType: '10000000-0000-4000-8000-000000000001',
  fakePngMagic: '10000000-0000-4000-8000-000000000002',
  mediaMagicMismatch: '10000000-0000-4000-8000-000000000003',
  streamedOverLimit: '10000000-0000-4000-8000-000000000004',
  corruptPng: '10000000-0000-4000-8000-000000000005',
  dimensionBombPng: '10000000-0000-4000-8000-000000000006'
} as const

export interface FixtureServerStats {
  requestCount: number
  searchRequests: number
  imageRequests: number
  forbiddenValueHits: number
}

export interface RunningFixtureServer {
  origin: string
  ca: string
  stats: FixtureServerStats
  close(): Promise<void>
}

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

function createDimensionBombPng(): Buffer {
  const width = 8_193
  const height = 1
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const row = Buffer.alloc(1 + width * 4)
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(row, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const DIMENSION_BOMB_PNG = createDimensionBombPng()
const CORRUPT_PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from('corrupt-png-payload')])

function closeServer(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

function writeBody(
  response: import('node:http').ServerResponse,
  mediaType: string,
  body: Buffer
): void {
  response.writeHead(200, {
    'content-type': mediaType,
    'content-length': String(body.byteLength)
  }).end(body)
}

export async function startFixtureServer(fixturesDirectory: string): Promise<RunningFixtureServer> {
  const [key, cert, ca, responseTemplate] = await Promise.all([
    readFile(join(fixturesDirectory, 'certs', 'localhost-key.pem'), 'utf8'),
    readFile(join(fixturesDirectory, 'certs', 'localhost-cert.pem'), 'utf8'),
    readFile(join(fixturesDirectory, 'certs', 'localhost-ca.pem'), 'utf8'),
    readFile(join(fixturesDirectory, 'openverse-smoke.json'), 'utf8')
  ])
  const stats: FixtureServerStats = {
    requestCount: 0,
    searchRequests: 0,
    imageRequests: 0,
    forbiddenValueHits: 0
  }
  let origin = ''
  const server = createServer({ key, cert }, (request, response) => {
    stats.requestCount += 1
    const rawTarget = request.url ?? ''
    stats.forbiddenValueHits += findForbiddenValues(rawTarget, CORPUS_50_FORBIDDEN_VALUES).length
    const url = new URL(rawTarget, origin)
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    if (url.pathname === '/v1/images/') {
      stats.searchRequests += 1
      if (url.searchParams.get('q') === 'rate-limit-delta') {
        response.writeHead(429, { 'retry-after': '2' }).end()
        return
      }
      if (url.searchParams.get('q') === 'redirect-fixture') {
        response.writeHead(302, { location: `${origin}/v1/images/` }).end()
        return
      }
      if (url.searchParams.get('license') !== 'cc0,pdm' ||
        url.searchParams.get('mature') !== 'false') {
        response.writeHead(400).end()
        return
      }
      const body = Buffer.from(responseTemplate.replaceAll('{{ORIGIN}}', origin))
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(body.byteLength)
      }).end(body)
      return
    }
    const thumbnailMatch = /^\/v1\/images\/([0-9a-f-]+)\/thumb\/$/iu.exec(url.pathname)
    if (thumbnailMatch) {
      stats.imageRequests += 1
      const id = thumbnailMatch[1].toLowerCase()
      if (id === SECURITY_IMAGE_IDS.wrongMediaType) {
        writeBody(response, 'text/plain', Buffer.from('not-an-image'))
        return
      }
      if (id === SECURITY_IMAGE_IDS.fakePngMagic) {
        writeBody(response, 'image/png', Buffer.from('not-an-image'))
        return
      }
      if (id === SECURITY_IMAGE_IDS.mediaMagicMismatch) {
        writeBody(response, 'image/jpeg', FIXTURE_PNG)
        return
      }
      if (id === SECURITY_IMAGE_IDS.streamedOverLimit) {
        response.on('error', () => undefined)
        response.writeHead(200, { 'content-type': 'image/png' })
        response.write(PNG_SIGNATURE)
        const chunk = Buffer.alloc(1024 * 1024)
        for (let index = 0; index <= MAX_IMAGE_RESPONSE_BYTES / chunk.byteLength; index += 1) {
          if (response.destroyed) break
          response.write(chunk)
        }
        response.end()
        return
      }
      if (id === SECURITY_IMAGE_IDS.corruptPng) {
        writeBody(response, 'image/png', CORRUPT_PNG)
        return
      }
      if (id === SECURITY_IMAGE_IDS.dimensionBombPng) {
        writeBody(response, 'image/png', DIMENSION_BOMB_PNG)
        return
      }
      writeBody(response, 'image/png', FIXTURE_PNG)
      return
    }
    if (url.pathname === '/fixture/redirect') {
      response.writeHead(302, { location: `${origin}/v1/images/` }).end()
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('fixture_server_address_unavailable')
  }
  origin = `https://127.0.0.1:${address.port}`
  return {
    origin,
    ca,
    stats,
    close: () => closeServer(server)
  }
}
