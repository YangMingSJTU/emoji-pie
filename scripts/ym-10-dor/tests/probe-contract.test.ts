import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { OpenverseAsset, ProbeImageProcessor, ProbeTransport } from '../src/contracts'
import { DailyOnlineQuota } from '../src/daily-quota'
import { SECURITY_IMAGE_IDS, startFixtureServer } from '../src/fixture-server'
import { sha256 } from '../src/hashing'
import { processImageBytes } from '../src/image-processing'
import { normalizeConfirmedKeywords, planKeywords } from '../src/keyword-planner'
import { filterEligibleAssets } from '../src/license-gate'
import { AsyncLimiter } from '../src/limiter'
import { assertMetricsMatchSchema } from '../src/metrics'
import { createFixtureTransport, createOpenverseTransport } from '../src/network'
import { ConfirmedOnlineBatchGate } from '../src/online-authorization'
import { Ym10ProbePipeline } from '../src/pipeline'
import { assertNoForbiddenValues, CORPUS_50_FORBIDDEN_VALUES } from '../src/privacy'
import { ResilientImageWorkerPool, type ProbeWorkerProcess } from '../src/worker-pool-core'

const probeDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixturesDirectory = join(probeDirectory, 'fixtures')
const schemaPath = join(probeDirectory, 'schemas', 'metrics.schema.json')

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

function fixtureAsset(origin: string, id: string): OpenverseAsset {
  return {
    id,
    license: 'cc0',
    mature: false,
    foreignLandingUrl: `https://example.invalid/${id}`,
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    source: 'fixture',
    thumbnailUrl: `${origin}/v1/images/${id}/thumb/`
  }
}

describe('YM-10 local keyword planning and explicit confirmation', () => {
  it('emits only known semantic terms and never falls back to private input tokens', () => {
    const normal = planKeywords('今天又要加班了')
    const privacy = planKeywords('张三说项目代号 X 明天暂停')

    expect(normal).toEqual({ status: 'ready', keywords: ['办公', '工作'] })
    expect(privacy).toEqual({ status: 'ready', keywords: ['暂停', '停止'] })
    for (const forbidden of CORPUS_50_FORBIDDEN_VALUES) {
      expect(JSON.stringify(privacy)).not.toContain(forbidden)
    }
    expect(planKeywords('李四客户密码')).toEqual({ status: 'needs_user_input', keywords: [] })
    expect(planKeywords('Project Phoenix secret')).toEqual({ status: 'needs_user_input', keywords: [] })
  })

  it.each(['行', '6', '🙃'])('returns needs_user_input without keywords for %s', (input) => {
    expect(planKeywords(input)).toEqual({ status: 'needs_user_input', keywords: [] })
  })

  it('accepts only an explicit bounded list of confirmed keywords', () => {
    expect(normalizeConfirmedKeywords([' 办公 ', '工作', '办公'])).toEqual(['办公', '工作'])
    expect(normalizeConfirmedKeywords(undefined)).toBeNull()
    expect(normalizeConfirmedKeywords([])).toBeNull()
    expect(normalizeConfirmedKeywords(['a', 'b', 'c', 'd'])).toBeNull()
    expect(normalizeConfirmedKeywords(['ok', 'x\u0000y'])).toBeNull()
  })

  it('does not consume online quota until confirmed keywords exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ym10-confirmation-test-'))
    try {
      const quota = new DailyOnlineQuota(
        join(directory, 'quota.json'),
        () => new Date('2026-07-15T12:00:00.000Z')
      )
      const gate = new ConfirmedOnlineBatchGate(quota)
      for (const input of ['行', '6', '🙃', '张三说项目代号 X 明天暂停', '李四客户密码']) {
        const plan = planKeywords(input)
        await expect(gate.authorize(undefined)).rejects.toThrow('keywords_confirmation_required')
        expect(await quota.usage(), input).toBe(0)
        if (['行', '6', '🙃', '李四客户密码'].includes(input)) {
          expect(plan.status, input).toBe('needs_user_input')
        }
      }
      await expect(gate.authorize(['办公'])).resolves.toEqual(['办公'])
      expect(await quota.usage()).toBe(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('fixed concurrency and fail-closed license contracts', () => {
  it('never exceeds the configured async limit', async () => {
    const limiter = new AsyncLimiter(3)
    let active = 0
    let maximum = 0
    await Promise.all(Array.from({ length: 12 }, (_, index) => limiter.run(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, index % 3))
      active -= 1
    })))
    expect(maximum).toBe(3)
  })

  it('admits only mature=false records with matching UUID, thumbnail, and license URL', async () => {
    const origin = 'https://127.0.0.1:4443'
    const payload = JSON.parse(
      (await readFile(join(fixturesDirectory, 'openverse-license-matrix.json'), 'utf8'))
        .replaceAll('{{ORIGIN}}', origin)
    )
    const result = filterEligibleAssets(payload, (value, expectedId) => {
      const url = new URL(value)
      const match = /^\/v1\/images\/([0-9a-f-]+)\/thumb\/$/u.exec(url.pathname)
      return url.origin === origin && match?.[1] === expectedId && !url.search && !url.hash
    })

    expect(result.assets.map(({ id }) => id)).toEqual([
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000012'
    ])
    expect(result.assets.map(({ license }) => license)).toEqual(['cc0', 'pdm'])
    expect(result.distribution).toEqual({
      cc0: 11,
      pdm: 2,
      by: 1,
      by_sa: 1,
      nc: 1,
      nd: 1,
      unknown: 1,
      rejected: 16
    })
  })

  it('keeps origin and thumbnail ID fixed', () => {
    const transport = createOpenverseTransport()
    const id = '00000000-0000-4000-8000-000000000001'
    expect(transport.isThumbnailUrlAllowed(
      `https://api.openverse.org/v1/images/${id}/thumb/`,
      id
    )).toBe(true)
    expect(transport.isThumbnailUrlAllowed(
      `https://api.openverse.org/v1/images/${id}/thumb/`,
      '00000000-0000-4000-8000-000000000002'
    )).toBe(false)
    expect(() => createFixtureTransport('https://example.com', 'test-ca')).toThrow(
      'fixture_origin_must_be_loopback'
    )
  })
})

describe('localhost HTTPS fixture transport and image trust boundary', () => {
  it('performs bounded search/download and rejects redirects', async () => {
    const server = await startFixtureServer(fixturesDirectory)
    try {
      const transport = createFixtureTransport(server.origin, server.ca)
      const search = await transport.search(['办公'])
      const gated = filterEligibleAssets(
        search.payload,
        (value, expectedId) => transport.isThumbnailUrlAllowed(value, expectedId)
      )
      const download = await transport.download(gated.assets[0])

      expect(search.statusCode).toBe(200)
      expect(gated.assets).toHaveLength(9)
      expect(download.statusCode).toBe(200)
      expect(download.mediaType).toBe('image/png')
      expect((await sharp(download.bytes).resize(32, 32).png().toBuffer()).byteLength).toBeGreaterThan(0)
      await expect(transport.search(['redirect-fixture'])).rejects.toMatchObject({
        code: 'redirect_rejected',
        statusCode: 302
      })
    } finally {
      await server.close()
    }
  })

  it('rejects MIME, magic, mismatch, and streamed-over-limit inputs before Sharp', async () => {
    const server = await startFixtureServer(fixturesDirectory)
    try {
      const transport = createFixtureTransport(server.origin, server.ca)
      const cases: Array<[string, string]> = [
        [SECURITY_IMAGE_IDS.wrongMediaType, 'image_content_type_rejected'],
        [SECURITY_IMAGE_IDS.fakePngMagic, 'image_magic_rejected'],
        [SECURITY_IMAGE_IDS.mediaMagicMismatch, 'image_type_mismatch'],
        [SECURITY_IMAGE_IDS.streamedOverLimit, 'streamed_response_too_large']
      ]
      for (const [id, code] of cases) {
        await expect(transport.download(fixtureAsset(server.origin, id))).rejects.toMatchObject({
          code
        })
      }
    } finally {
      await server.close()
    }
  })

  it('rejects corrupt and dimension-bomb PNGs inside the bounded Sharp processor', async () => {
    const server = await startFixtureServer(fixturesDirectory)
    try {
      const transport = createFixtureTransport(server.origin, server.ca)
      const corrupt = await transport.download(fixtureAsset(server.origin, SECURITY_IMAGE_IDS.corruptPng))
      const bomb = await transport.download(fixtureAsset(server.origin, SECURITY_IMAGE_IDS.dimensionBombPng))
      await expect(processImageBytes(corrupt.bytes, 0)).rejects.toThrow()
      await expect(processImageBytes(bomb.bytes, 0)).rejects.toThrow('image_dimensions_rejected')
    } finally {
      await server.close()
    }
  })
})

class FakeWorker extends EventEmitter implements ProbeWorkerProcess {
  killed = false

  postMessage(value: unknown): void {
    const request = value as { id: number; diagnosticBehavior?: string }
    if (request.diagnosticBehavior === 'hang') return
    if (request.diagnosticBehavior === 'crash') {
      queueMicrotask(() => this.emit('exit'))
      return
    }
    const png = Buffer.from(`worker-${request.id}`)
    queueMicrotask(() => this.emit('message', {
      id: request.id,
      ok: true,
      pngBase64: png.toString('base64'),
      sha256: sha256(png)
    }))
  }

  kill(): void {
    this.killed = true
    queueMicrotask(() => this.emit('exit'))
  }
}

describe('bounded worker watchdog and recovery', () => {
  it('replaces a crashed worker and completes the next job', async () => {
    const workers: FakeWorker[] = []
    const pool = new ResilientImageWorkerPool(() => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    }, 1, 100)
    try {
      await expect(pool.runDiagnostic('crash')).rejects.toThrow('sharp_worker_exited')
      await expect(pool.process(Buffer.from('valid'), 0)).resolves.toMatchObject({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
      })
      expect(workers.length).toBeGreaterThanOrEqual(2)
    } finally {
      pool.dispose()
    }
  })

  it('kills a timed-out worker and drains its queued job through the replacement', async () => {
    const workers: FakeWorker[] = []
    const pool = new ResilientImageWorkerPool(() => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    }, 1, 20)
    try {
      const hanging = pool.runDiagnostic('hang')
      const queued = pool.process(Buffer.from('valid'), 1)
      await expect(hanging).rejects.toThrow('sharp_worker_timeout')
      await expect(queued).resolves.toMatchObject({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
      })
      expect(workers[0].killed).toBe(true)
      expect(workers.length).toBeGreaterThanOrEqual(2)
    } finally {
      pool.dispose()
    }
  })
})

class DeterministicImageProcessor implements ProbeImageProcessor {
  process(_input: Buffer, variantIndex: number) {
    const png = Buffer.from(`candidate-${variantIndex}`, 'utf8')
    return Promise.resolve({ png, sha256: sha256(png) })
  }

  dispose(): void {}
}

async function createDeterministicPipeline() {
  const origin = 'https://api.openverse.org'
  const payload = JSON.parse(
    (await readFile(join(fixturesDirectory, 'openverse-smoke.json'), 'utf8'))
      .replaceAll('{{ORIGIN}}', origin)
  )
  let searchRequests = 0
  const transport: ProbeTransport = {
    mode: 'fixture',
    search: async () => {
      searchRequests += 1
      return { statusCode: 200, responseBytes: 1234, payload }
    },
    download: async () => ({
      statusCode: 200,
      bytes: Buffer.from([1, 2, 3]),
      mediaType: 'image/png'
    }),
    isThumbnailUrlAllowed: (value, expectedId) => {
      const url = new URL(value)
      const match = /^\/v1\/images\/([0-9a-f-]+)\/thumb\/$/u.exec(url.pathname)
      return url.origin === origin && match?.[1] === expectedId
    }
  }
  const schema = await readJson(schemaPath)
  const verify = async (png: Buffer) => ({ bytes: png.byteLength, sha256: sha256(png) })
  const pipeline = new Ym10ProbePipeline({
    transport,
    imageProcessor: new DeterministicImageProcessor(),
    clipboard: { writeAndVerify: verify },
    exporter: { writeAndVerify: verify },
    metricsSchema: schema
  })
  return { pipeline, schema, searchRequests: () => searchRequests }
}

describe('privacy-safe metrics and repeatability', () => {
  it('keeps deterministic fingerprints independent of timings and validates the schema', async () => {
    const { pipeline, schema } = await createDeterministicPipeline()
    const request = {
      corpusId: 'YM-10-001',
      confirmedKeywords: ['办公', '工作'],
      session: 'cold' as const
    }
    const first = await pipeline.run(request)
    const second = await pipeline.run(request)

    expect(first.metrics.status).toBe('success')
    expect(first.metrics.candidate_count).toBe(9)
    expect(first.metrics.hashes.run_fingerprint).toBe(second.metrics.hashes.run_fingerprint)
    expect(first.metrics.hashes.candidate_set).toBe(second.metrics.hashes.candidate_set)
    expect(Object.keys(first.metrics.timings_ms)).toEqual(Object.keys(second.metrics.timings_ms))
    expect(() => assertMetricsMatchSchema(first.metrics, schema)).not.toThrow()
  })

  it.each([
    ['YM-10-043', '行'],
    ['YM-10-044', '6'],
    ['YM-10-048', '🙃'],
    ['YM-10-050', '张三说项目代号 X 明天暂停'],
    ['YM-10-001', '李四客户密码']
  ])('sends no request before confirmation for %s', async (corpusId) => {
    const { pipeline, searchRequests } = await createDeterministicPipeline()
    const before = searchRequests()
    const result = await pipeline.run({ corpusId, session: 'warm' })
    expect(result.metrics.status).toBe('needs_user_input')
    expect(result.metrics.error_code).toBe('keywords_confirmation_required')
    expect(searchRequests()).toBe(before)
  })

  it('does not emit corpus 50 private text after safe semantic keywords are confirmed', async () => {
    const { pipeline } = await createDeterministicPipeline()
    const privacy = await pipeline.run({
      corpusId: 'YM-10-050',
      confirmedKeywords: ['暂停', '停止'],
      session: 'warm'
    })
    expect(() => assertNoForbiddenValues(privacy.metrics)).not.toThrow()
  })

  it('rejects additional metric properties', async () => {
    const { pipeline, schema } = await createDeterministicPipeline()
    const result = await pipeline.run({
      corpusId: 'YM-10-001',
      confirmedKeywords: ['办公'],
      session: 'cold'
    })
    expect(() => assertMetricsMatchSchema({ ...result.metrics, prompt: 'forbidden' } as never, schema))
      .toThrow('additionalProperty')
  })
})

describe('real-network daily quota', () => {
  it('permits ten confirmed UTC-day batches and rejects the eleventh', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ym10-quota-test-'))
    try {
      const quota = new DailyOnlineQuota(
        join(directory, 'quota.json'),
        () => new Date('2026-07-15T12:00:00.000Z')
      )
      const gate = new ConfirmedOnlineBatchGate(quota)
      for (let index = 0; index < 10; index += 1) await gate.authorize(['办公'])
      await expect(gate.authorize(['办公'])).rejects.toThrow('daily_online_limit_reached')
      expect(await quota.usage()).toBe(10)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('fixture manifest', () => {
  it('matches every frozen fixture byte-for-byte', async () => {
    const manifest = await readJson(join(fixturesDirectory, 'fixture-manifest.json')) as {
      fixtures: Array<{ path: string; size_bytes: number; sha256: string }>
    }
    for (const fixture of manifest.fixtures) {
      const bytes = await readFile(join(fixturesDirectory, fixture.path))
      expect(bytes.byteLength, fixture.path).toBe(fixture.size_bytes)
      expect(createHash('sha256').update(bytes).digest('hex'), fixture.path).toBe(fixture.sha256)
    }
  })
})
