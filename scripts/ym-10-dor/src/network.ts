import { request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import {
  DOWNLOAD_CONCURRENCY,
  DOWNLOAD_TIMEOUT_MS,
  MAX_IMAGE_RESPONSE_BYTES,
  MAX_SEARCH_RESPONSE_BYTES,
  OPENVERSE_ORIGIN,
  OPENVERSE_SEARCH_PATH,
  OPENVERSE_THUMBNAIL_PATH,
  PROBE_VERSION,
  SEARCH_CONCURRENCY,
  SEARCH_TIMEOUT_MS
} from './constants'
import type {
  DownloadOutcome,
  OpenverseAsset,
  ProbeTransport,
  ProbeTransportMode,
  SearchOutcome
} from './contracts'
import { AsyncLimiter } from './limiter'

export class ProbeNetworkError extends Error {
  constructor(readonly code: string, readonly statusCode: number | null = null) {
    super(code)
  }
}

interface TransportOptions {
  mode: ProbeTransportMode
  origin: string
  ca?: string
}

async function requestBounded(
  url: URL,
  maximumBytes: number,
  timeoutMs: number,
  ca?: string
): Promise<{ bytes: Buffer; statusCode: number }> {
  const options: RequestOptions = {
    protocol: 'https:',
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    ca,
    rejectUnauthorized: true,
    headers: {
      accept: url.pathname.endsWith('/thumb/') ? 'image/*' : 'application/json',
      'user-agent': `EmojiPie-YM10-DOR-Probe/${PROBE_VERSION}`
    }
  }

  return new Promise((resolve, reject) => {
    const request = httpsRequest(options, (response) => {
      const statusCode = response.statusCode ?? 0
      if (statusCode >= 300 && statusCode < 400) {
        response.resume()
        reject(new ProbeNetworkError('redirect_rejected', statusCode))
        return
      }
      const declaredLength = Number(response.headers['content-length'] ?? '0')
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        response.destroy()
        reject(new ProbeNetworkError('declared_response_too_large', statusCode))
        return
      }

      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        total += chunk.byteLength
        if (total > maximumBytes) {
          response.destroy(new ProbeNetworkError('streamed_response_too_large', statusCode))
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      response.once('end', () => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(new ProbeNetworkError('http_error', statusCode))
          return
        }
        resolve({ bytes: Buffer.concat(chunks), statusCode })
      })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new ProbeNetworkError('request_timeout')))
    request.once('error', (error) => {
      reject(error instanceof ProbeNetworkError ? error : new ProbeNetworkError('network_error'))
    })
    request.end()
  })
}

class HttpsProbeTransport implements ProbeTransport {
  readonly mode: ProbeTransportMode
  private readonly origin: URL
  private readonly ca?: string
  private readonly searchLimiter = new AsyncLimiter(SEARCH_CONCURRENCY)
  private readonly downloadLimiter = new AsyncLimiter(DOWNLOAD_CONCURRENCY)

  constructor(options: TransportOptions) {
    this.mode = options.mode
    this.origin = new URL(options.origin)
    this.ca = options.ca
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

  isThumbnailUrlAllowed(value: string): boolean {
    try {
      const url = new URL(value)
      return url.origin === this.origin.origin && OPENVERSE_THUMBNAIL_PATH.test(url.pathname) &&
        !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  }

  search(keywords: readonly string[]): Promise<SearchOutcome> {
    return this.searchLimiter.run(async () => {
      if (keywords.length < 1 || keywords.length > 3 || keywords.some((entry) => !entry.trim())) {
        throw new ProbeNetworkError('invalid_keywords')
      }
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
        this.ca
      )
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

  download(asset: OpenverseAsset): Promise<DownloadOutcome> {
    return this.downloadLimiter.run(async () => {
      if (!this.isThumbnailUrlAllowed(asset.thumbnailUrl)) {
        throw new ProbeNetworkError('thumbnail_url_rejected')
      }
      return requestBounded(
        new URL(asset.thumbnailUrl),
        MAX_IMAGE_RESPONSE_BYTES,
        DOWNLOAD_TIMEOUT_MS,
        this.ca
      )
    })
  }
}

export function createOpenverseTransport(): ProbeTransport {
  return new HttpsProbeTransport({ mode: 'openverse', origin: OPENVERSE_ORIGIN })
}

export function createFixtureTransport(origin: string, ca: string): ProbeTransport {
  return new HttpsProbeTransport({ mode: 'fixture', origin, ca })
}
