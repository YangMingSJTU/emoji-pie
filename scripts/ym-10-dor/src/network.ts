import { request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import {
  DOWNLOAD_CONCURRENCY,
  DOWNLOAD_TIMEOUT_MS,
  MAX_REMOTE_IMAGE_BYTES,
  MAX_RETRY_AFTER_MS,
  MAX_SEARCH_RESPONSE_BYTES,
  OPENVERSE_ASSET_ID,
  OPENVERSE_ORIGIN,
  OPENVERSE_SEARCH_PATH,
  OPENVERSE_THUMBNAIL_PATH,
  PROBE_VERSION,
  SEARCH_CONCURRENCY,
  SEARCH_TIMEOUT_MS
} from './constants'
import type {
  DetailOutcome,
  DownloadOutcome,
  OpenverseAsset,
  ProbeTransport,
  ProbeTransportMode,
  SearchOutcome
} from './contracts'
import { AsyncLimiter } from './limiter'

export class ProbeNetworkError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly notBeforeMs: number | null = null,
    readonly remainingMs: number | null = null
  ) {
    super(code)
  }
}

export interface TransportTimingOptions {
  now?: () => number
  maxRetryAfterMs?: number
}

interface TransportOptions extends TransportTimingOptions {
  mode: ProbeTransportMode
  origin: string
  ca?: string
}

type AllowedImageMediaType = DownloadOutcome['mediaType']
type ExpectedResponse = 'json' | 'image'

interface BoundedResponse {
  bytes: Buffer
  statusCode: number
  mediaType: string
}

const ALLOWED_IMAGE_MEDIA_TYPES = new Set<AllowedImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/webp'
])

export function parseRetryAfterMs(
  value: string | string[] | undefined,
  nowMs: number,
  maximumMs = MAX_RETRY_AFTER_MS
): number | null {
  if (typeof value !== 'string' || !Number.isFinite(nowMs) || maximumMs < 1) return null
  const trimmed = value.trim()
  let delayMs: number
  if (/^\d+$/u.test(trimmed)) {
    delayMs = Number(trimmed) * 1_000
  } else {
    const parsed = Date.parse(trimmed)
    if (!Number.isFinite(parsed)) return null
    delayMs = Math.max(0, parsed - nowMs)
  }
  if (!Number.isFinite(delayMs)) return maximumMs
  return Math.min(maximumMs, Math.max(0, Math.ceil(delayMs)))
}

function normalizedMediaType(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : ''
}

function detectedImageMediaType(bytes: Buffer): AllowedImageMediaType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

async function requestBounded(
  url: URL,
  maximumBytes: number,
  timeoutMs: number,
  expectedResponse: ExpectedResponse,
  ca: string | undefined,
  now: () => number,
  maxRetryAfterMs: number
): Promise<BoundedResponse> {
  const options: RequestOptions = {
    protocol: 'https:',
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    ca,
    rejectUnauthorized: true,
    headers: {
      accept: expectedResponse === 'image' ? 'image/png,image/jpeg,image/webp' : 'application/json',
      'user-agent': `EmojiPie-YM10-DOR-Probe/${PROBE_VERSION}`
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: ProbeNetworkError): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = httpsRequest(options, (response) => {
      const statusCode = response.statusCode ?? 0
      if (statusCode >= 300 && statusCode < 400) {
        response.resume()
        fail(new ProbeNetworkError('redirect_rejected', statusCode))
        return
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        const observedAt = now()
        const retryAfterMs = statusCode === 429
          ? parseRetryAfterMs(response.headers['retry-after'], observedAt, maxRetryAfterMs)
          : null
        fail(new ProbeNetworkError(
          'http_error', statusCode, retryAfterMs,
          retryAfterMs === null ? null : observedAt + retryAfterMs
        ))
        return
      }

      const mediaType = normalizedMediaType(response.headers['content-type'])
      if (expectedResponse === 'json' && mediaType !== 'application/json') {
        response.resume()
        fail(new ProbeNetworkError('json_content_type_rejected', statusCode))
        return
      }
      if (expectedResponse === 'image' && !ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType as AllowedImageMediaType)) {
        response.resume()
        fail(new ProbeNetworkError('image_content_type_rejected', statusCode))
        return
      }

      const declaredLength = Number(response.headers['content-length'] ?? '0')
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        response.resume()
        fail(new ProbeNetworkError('declared_response_too_large', statusCode))
        return
      }

      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        total += chunk.byteLength
        if (total > maximumBytes) {
          fail(new ProbeNetworkError('streamed_response_too_large', statusCode))
          response.destroy()
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      response.once('error', () => fail(new ProbeNetworkError('response_stream_error', statusCode)))
      response.once('aborted', () => fail(new ProbeNetworkError('response_stream_aborted', statusCode)))
      response.once('end', () => {
        if (settled) return
        const bytes = Buffer.concat(chunks)
        if (expectedResponse === 'image') {
          const detected = detectedImageMediaType(bytes)
          if (!detected) {
            fail(new ProbeNetworkError('image_magic_rejected', statusCode))
            return
          }
          if (detected !== mediaType) {
            fail(new ProbeNetworkError('image_type_mismatch', statusCode))
            return
          }
        }
        settled = true
        resolve({ bytes, statusCode, mediaType })
      })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new ProbeNetworkError('request_timeout')))
    request.once('error', (error) => {
      fail(error instanceof ProbeNetworkError ? error : new ProbeNetworkError('network_error'))
    })
    request.end()
  })
}

class HttpsProbeTransport implements ProbeTransport {
  readonly mode: ProbeTransportMode
  private readonly origin: URL
  private readonly ca?: string
  private readonly now: () => number
  private readonly maxRetryAfterMs: number
  private notBeforeMs = 0
  private readonly searchLimiter = new AsyncLimiter(SEARCH_CONCURRENCY)
  private readonly downloadLimiter = new AsyncLimiter(DOWNLOAD_CONCURRENCY)

  constructor(options: TransportOptions) {
    this.mode = options.mode
    this.origin = new URL(options.origin)
    this.ca = options.ca
    this.now = options.now ?? Date.now
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS
    if (this.maxRetryAfterMs < 1) throw new Error('invalid_retry_after_limit')
    if (this.origin.protocol !== 'https:' || this.origin.username || this.origin.password ||
      this.origin.search || this.origin.hash || this.origin.pathname !== '/') {
      throw new Error('invalid_transport_origin')
    }
    if (this.mode === 'openverse' && this.origin.origin !== OPENVERSE_ORIGIN) {
      throw new Error('openverse_origin_is_fixed')
    }
    if (this.mode === 'fixture' && !['localhost', '127.0.0.1'].includes(this.origin.hostname)) {
      throw new Error('fixture_origin_must_be_loopback')
    }
  }

  isThumbnailUrlAllowed(value: string, expectedId?: string): boolean {
    try {
      const url = new URL(value)
      const match = OPENVERSE_THUMBNAIL_PATH.exec(url.pathname)
      return url.origin === this.origin.origin && Boolean(match) &&
        (!expectedId || match?.[1].toLowerCase() === expectedId.toLowerCase()) &&
        !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  }

  cooldownState(): { notBeforeMs: number; remainingMs: number } {
    return {
      notBeforeMs: this.notBeforeMs,
      remainingMs: Math.max(0, this.notBeforeMs - this.now())
    }
  }

  private assertNotCoolingDown(): void {
    const remainingMs = Math.max(0, this.notBeforeMs - this.now())
    if (remainingMs > 0) {
      throw new ProbeNetworkError(
        'rate_limit_cooldown', 429, remainingMs, this.notBeforeMs, remainingMs
      )
    }
  }

  private observeRateLimit(error: unknown): void {
    if (error instanceof ProbeNetworkError && error.statusCode === 429 && error.notBeforeMs !== null) {
      this.notBeforeMs = Math.max(this.notBeforeMs, error.notBeforeMs)
    }
  }

  search(keywords: readonly string[]): Promise<SearchOutcome> {
    return this.searchLimiter.run(async () => {
      if (keywords.length < 1 || keywords.length > 3 || keywords.some((entry) => !entry.trim())) {
        throw new ProbeNetworkError('invalid_keywords')
      }
      this.assertNotCoolingDown()
      const url = new URL(OPENVERSE_SEARCH_PATH, this.origin)
      url.searchParams.set('q', keywords.join(' '))
      url.searchParams.set('license', 'cc0,pdm')
      url.searchParams.set('mature', 'false')
      url.searchParams.set('page', '1')
      url.searchParams.set('page_size', '20')
      const response = await requestBounded(
        url,
        MAX_SEARCH_RESPONSE_BYTES,
        SEARCH_TIMEOUT_MS,
        'json',
        this.ca,
        this.now,
        this.maxRetryAfterMs
      ).catch((error) => {
        this.observeRateLimit(error)
        throw error
      })
      let payload: unknown
      try {
        payload = JSON.parse(response.bytes.toString('utf8'))
      } catch {
        throw new ProbeNetworkError('invalid_json', response.statusCode)
      }
      return {
        statusCode: response.statusCode,
        responseBytes: response.bytes.byteLength,
        payload
      }
    })
  }

  detail(assetId: string): Promise<DetailOutcome> {
    return this.searchLimiter.run(async () => {
      const canonicalId = assetId.trim().toLowerCase()
      if (!OPENVERSE_ASSET_ID.test(canonicalId)) throw new ProbeNetworkError('invalid_asset_id')
      this.assertNotCoolingDown()
      const url = new URL(`/v1/images/${canonicalId}/`, this.origin)
      const response = await requestBounded(
        url,
        MAX_SEARCH_RESPONSE_BYTES,
        SEARCH_TIMEOUT_MS,
        'json',
        this.ca,
        this.now,
        this.maxRetryAfterMs
      ).catch((error) => {
        this.observeRateLimit(error)
        throw error
      })
      let payload: unknown
      try {
        payload = JSON.parse(response.bytes.toString('utf8'))
      } catch {
        throw new ProbeNetworkError('invalid_json', response.statusCode)
      }
      return { statusCode: response.statusCode, responseBytes: response.bytes.byteLength, payload }
    })
  }

  download(asset: OpenverseAsset): Promise<DownloadOutcome> {
    return this.downloadLimiter.run(async () => {
      if (!this.isThumbnailUrlAllowed(asset.thumbnailUrl, asset.id)) {
        throw new ProbeNetworkError('thumbnail_url_rejected')
      }
      this.assertNotCoolingDown()
      const response = await requestBounded(
        new URL(asset.thumbnailUrl),
        MAX_REMOTE_IMAGE_BYTES,
        DOWNLOAD_TIMEOUT_MS,
        'image',
        this.ca,
        this.now,
        this.maxRetryAfterMs
      ).catch((error) => {
        this.observeRateLimit(error)
        throw error
      })
      return {
        bytes: response.bytes,
        statusCode: response.statusCode,
        mediaType: response.mediaType as AllowedImageMediaType
      }
    })
  }
}

export function createOpenverseTransport(options: TransportTimingOptions = {}): ProbeTransport {
  return new HttpsProbeTransport({ mode: 'openverse', origin: OPENVERSE_ORIGIN, ...options })
}

export function createFixtureTransport(
  origin: string,
  ca: string,
  options: TransportTimingOptions = {}
): ProbeTransport {
  return new HttpsProbeTransport({ mode: 'fixture', origin, ca, ...options })
}
