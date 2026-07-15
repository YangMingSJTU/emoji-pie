import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { MAX_LOCAL_IMAGE_BYTES } from '../src/constants'
import type {
  DetailOutcome,
  DownloadOutcome,
  ProbeTransport,
  SearchOutcome
} from '../src/contracts'
import { startFixtureServer } from '../src/fixture-server'
import { processImageBytes } from '../src/image-processing'
import { importLocalImage } from '../src/local-image-import'
import {
  createFixtureTransport,
  parseRetryAfterMs,
  ProbeNetworkError
} from '../src/network'
import {
  SOURCE_RECHECK_INTERVAL_MS,
  SourceRecheckMachine
} from '../src/source-recheck'

const probeDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixturesDirectory = join(probeDirectory, 'fixtures')
const ASSET_ID = '00000000-0000-4000-8000-000000000001'

function detailPayload(license = 'cc0'): Record<string, unknown> {
  return {
    id: ASSET_ID,
    license,
    mature: false,
    foreign_landing_url: 'https://example.invalid/assets/1',
    license_url: license === 'cc0'
      ? 'https://creativecommons.org/publicdomain/zero/1.0/'
      : 'https://creativecommons.org/licenses/by/4.0/',
    source: 'stage2-fixture',
    thumbnail: `https://api.openverse.org/v1/images/${ASSET_ID}/thumb/`
  }
}

type QueuedDetail = DetailOutcome | Error

class DetailFixtureTransport implements ProbeTransport {
  readonly mode = 'fixture' as const
  readonly requestedIds: string[] = []
  private readonly queued: QueuedDetail[] = []

  enqueue(value: QueuedDetail): void {
    this.queued.push(value)
  }

  cooldownState(): { notBeforeMs: number; remainingMs: number } {
    return { notBeforeMs: 0, remainingMs: 0 }
  }

  search(): Promise<SearchOutcome> {
    throw new Error('unexpected_search')
  }

  detail(assetId: string): Promise<DetailOutcome> {
    this.requestedIds.push(assetId)
    const next = this.queued.shift()
    if (!next) throw new Error('missing_detail_fixture')
    if (next instanceof Error) return Promise.reject(next)
    return Promise.resolve(next)
  }

  download(): Promise<DownloadOutcome> {
    throw new Error('unexpected_download')
  }

  isThumbnailUrlAllowed(value: string, expectedId?: string): boolean {
    return value === `https://api.openverse.org/v1/images/${expectedId}/thumb/`
  }
}

function outcome(payload: unknown): DetailOutcome {
  return { statusCode: 200, responseBytes: 128, payload }
}

describe('Stage 2 A1 lazy source recheck state machine', () => {
  it('does no request on startup/grid/history and checks detail only after 24 hours', async () => {
    let now = Date.parse('2026-07-16T00:00:00.000Z')
    const transport = new DetailFixtureTransport()
    transport.enqueue(outcome(detailPayload()))
    transport.enqueue(outcome(detailPayload()))
    const machine = new SourceRecheckMachine(transport, () => now)

    for (const trigger of ['startup', 'grid', 'history'] as const) {
      await expect(machine.recheck(ASSET_ID.toUpperCase(), trigger)).resolves.toMatchObject({
        requested: false,
        canRecreate: false,
        record: { status: 'unchecked' }
      })
    }
    await expect(machine.recheck(ASSET_ID, 'detail')).resolves.toMatchObject({
      requested: true,
      canRecreate: true,
      record: { status: 'verified' }
    })
    now += SOURCE_RECHECK_INTERVAL_MS
    await expect(machine.recheck(ASSET_ID, 'detail')).resolves.toMatchObject({ requested: false })
    now += 1
    await expect(machine.recheck(ASSET_ID, 'detail')).resolves.toMatchObject({ requested: true })
    expect(transport.requestedIds).toEqual([ASSET_ID, ASSET_ID])
  })

  it('always checks recreate and maps license, unavailable, invalid, and transient outcomes', async () => {
    let now = 1_000
    const transport = new DetailFixtureTransport()
    const machine = new SourceRecheckMachine(transport, () => now)

    transport.enqueue(outcome(detailPayload()))
    expect((await machine.recheck(ASSET_ID, 'recreate')).record.status).toBe('verified')

    now += 10
    transport.enqueue(new ProbeNetworkError('network_error'))
    const preserved = await machine.recheck(ASSET_ID, 'recreate')
    expect(preserved).toMatchObject({
      requested: true,
      canRecreate: true,
      record: { status: 'verified', lastSuccessfulCheckAt: 1_000, lastFailureCode: 'network_error' }
    })

    now += 10
    transport.enqueue(outcome(detailPayload('by')))
    expect(await machine.recheck(ASSET_ID, 'recreate')).toMatchObject({
      canRecreate: false,
      record: { status: 'license_changed', lastSuccessfulCheckAt: now }
    })

    now += 10
    transport.enqueue(new ProbeNetworkError('http_error', 410))
    expect(await machine.recheck(ASSET_ID, 'recreate')).toMatchObject({
      canRecreate: false,
      record: { status: 'unavailable', lastSuccessfulCheckAt: now }
    })

    now += 10
    transport.enqueue(outcome({ id: ASSET_ID, license: 'cc0' }))
    expect(await machine.recheck(ASSET_ID, 'recreate')).toMatchObject({
      canRecreate: false,
      record: { status: 'unchecked', lastFailureCode: 'source_detail_invalid' }
    })
  })
})

describe('Stage 2 A2 Retry-After cooldown', () => {
  it('parses and caps delta-seconds and HTTP-date deterministically', () => {
    const now = Date.parse('2026-07-16T00:00:00.000Z')
    expect(parseRetryAfterMs('12', now)).toBe(12_000)
    expect(parseRetryAfterMs(new Date(now + 4_000).toUTCString(), now)).toBe(4_000)
    expect(parseRetryAfterMs('999999', now, 300_000)).toBe(300_000)
    expect(parseRetryAfterMs('invalid', now)).toBeNull()
  })

  it('sends zero requests during cooldown and exactly one after expiry', async () => {
    const server = await startFixtureServer(fixturesDirectory)
    let now = Date.parse('2026-07-16T00:00:00.000Z')
    try {
      const transport = createFixtureTransport(server.origin, server.ca, { now: () => now })
      await expect(transport.search(['rate-limit-delta'])).rejects.toMatchObject({
        code: 'http_error',
        statusCode: 429,
        retryAfterMs: 2_000,
        notBeforeMs: now + 2_000
      })
      const afterRateLimit = server.stats.requestCount
      now += 500
      await expect(transport.search(['rate-limit-delta'])).rejects.toMatchObject({
        code: 'rate_limit_cooldown',
        remainingMs: 1_500
      })
      expect(server.stats.requestCount).toBe(afterRateLimit)
      expect(transport.cooldownState()).toEqual({ notBeforeMs: now + 1_500, remainingMs: 1_500 })

      now += 1_500
      await expect(transport.search(['rate-limit-delta'])).rejects.toMatchObject({
        code: 'http_error', statusCode: 429
      })
      expect(server.stats.requestCount).toBe(afterRateLimit + 1)
    } finally {
      await server.close()
    }
  })
})

describe('Stage 2 C1/C2 local image entry boundary', () => {
  it('admits a valid 19 MiB local image while the remote processor remains capped at 10 MiB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ym10-local-boundary-'))
    try {
      const source = await sharp({
        create: { width: 64, height: 64, channels: 4, background: '#42a5f5' }
      }).jpeg().toBuffer()
      const nineteenMiB = Buffer.alloc(19 * 1024 * 1024)
      source.copy(nineteenMiB)
      const path = join(directory, 'nineteen-mib.jpg')
      await writeFile(path, nineteenMiB)

      const imported = await importLocalImage(path, 'image/jpeg')
      expect(imported.bytes.byteLength).toBe(19 * 1024 * 1024)
      await expect(processImageBytes(imported.bytes, 0, 'local')).resolves.toMatchObject({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
      })
      await expect(processImageBytes(imported.bytes, 0, 'remote')).rejects.toThrow(
        'image_size_rejected'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects files above 20 MiB before decode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ym10-local-size-'))
    try {
      const path = join(directory, 'oversize.png')
      await writeFile(path, Buffer.alloc(MAX_LOCAL_IMAGE_BYTES + 1))
      await expect(importLocalImage(path, 'image/png')).rejects.toThrow('local_image_size_rejected')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['fake.png', 'image/png', Buffer.from('not-an-image'), 'local_image_magic_rejected'],
    ['mismatch.png', 'image/png', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'local_image_type_mismatch'],
    ['valid.png', 'image/jpeg', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'local_image_type_mismatch'],
    ['unknown.gif', 'image/gif', Buffer.from('GIF89a'), 'local_image_extension_rejected']
  ])('fails closed for %s', async (name, declared, bytes, expectedError) => {
    const directory = await mkdtemp(join(tmpdir(), 'ym10-local-type-'))
    try {
      const path = join(directory, name)
      await writeFile(path, bytes)
      await expect(importLocalImage(path, declared)).rejects.toThrow(expectedError)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
