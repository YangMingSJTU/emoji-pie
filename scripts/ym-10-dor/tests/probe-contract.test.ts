import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { ProbeImageProcessor, ProbeTransport } from '../src/contracts'
import { DailyOnlineQuota } from '../src/daily-quota'
import { startFixtureServer } from '../src/fixture-server'
import { sha256 } from '../src/hashing'
import { planKeywords } from '../src/keyword-planner'
import { filterEligibleAssets } from '../src/license-gate'
import { AsyncLimiter } from '../src/limiter'
import { assertMetricsMatchSchema } from '../src/metrics'
import { createFixtureTransport, createOpenverseTransport } from '../src/network'
import { Ym10ProbePipeline } from '../src/pipeline'
import { assertNoForbiddenValues, CORPUS_50_FORBIDDEN_VALUES } from '../src/privacy'

const probeDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixturesDirectory = join(probeDirectory, 'fixtures')
const schemaPath = join(probeDirectory, 'schemas', 'metrics.schema.json')

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('YM-10 local keyword planner', () => {
  it('keeps ready plans local, bounded, and free of corpus 50 private terms', () => {
    const normal = planKeywords('今天又要加班了')
    const privacy = planKeywords('张三说项目代号 X 明天暂停')

    expect(normal.status).toBe('ready')
    expect(normal.keywords).toEqual(['办公', '工作'])
    expect(privacy).toEqual({ status: 'ready', keywords: ['暂停', '停止'] })
    expect(normal.keywords.length).toBeGreaterThanOrEqual(1)
    expect(normal.keywords.length).toBeLessThanOrEqual(3)
    for (const forbidden of CORPUS_50_FORBIDDEN_VALUES) {
      expect(JSON.stringify(privacy)).not.toContain(forbidden)
    }
  })

  it.each(['行', '6', '🙃'])('returns needs_user_input without keywords for %s', (input) => {
    expect(planKeywords(input)).toEqual({ status: 'needs_user_input', keywords: [] })
  })
})

describe('fixed concurrency and license contracts', () => {
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

  it('admits only complete CC0/PDM non-mature unique records', async () => {
    const origin = 'https://127.0.0.1:4443'
    const payload = JSON.parse(
      (await readFile(join(fixturesDirectory, 'openverse-license-matrix.json'), 'utf8'))
        .replaceAll('{{ORIGIN}}', origin)
    )
    const result = filterEligibleAssets(payload, (value) => {
      const url = new URL(value)
      return url.origin === origin && /^\/v1\/images\/[0-9a-f-]+\/thumb\/$/u.test(url.pathname)
    })

    expect(result.assets).toHaveLength(2)
    expect(result.assets.map(({ license }) => license)).toEqual(['cc0', 'pdm'])
    expect(result.distribution).toEqual({
      cc0: 4,
      pdm: 1,
      by: 1,
      by_sa: 1,
      nc: 1,
      nd: 1,
      unknown: 1,
      rejected: 8
    })
  })

  it('keeps the real origin fixed and the fixture origin loopback-only', () => {
    expect(createOpenverseTransport().isThumbnailUrlAllowed(
      'https://api.openverse.org/v1/images/00000000-0000-4000-8000-000000000001/thumb/'
    )).toBe(true)
    expect(() => createFixtureTransport('https://example.com', 'test-ca')).toThrow(
      'fixture_origin_must_be_loopback'
    )
  })
})

describe('localhost HTTPS fixture transport', () => {
  it('performs bounded search/download and rejects redirects', async () => {
    const server = await startFixtureServer(fixturesDirectory)
    try {
      const transport = createFixtureTransport(server.origin, server.ca)
      const search = await transport.search(['办公'])
      const gated = filterEligibleAssets(search.payload, (value) => transport.isThumbnailUrlAllowed(value))
      const download = await transport.download(gated.assets[0])

      expect(search.statusCode).toBe(200)
      expect(gated.assets).toHaveLength(9)
      expect(download.statusCode).toBe(200)
      expect(download.bytes.byteLength).toBeGreaterThan(0)
      expect((await sharp(download.bytes).resize(32, 32).png().toBuffer()).byteLength).toBeGreaterThan(0)
      await expect(transport.search(['redirect-fixture'])).rejects.toMatchObject({
        code: 'redirect_rejected',
        statusCode: 302
      })
    } finally {
      await server.close()
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
    download: async () => ({ statusCode: 200, bytes: Buffer.from([1, 2, 3]) }),
    isThumbnailUrlAllowed: (value) => {
      const url = new URL(value)
      return url.origin === origin && /^\/v1\/images\/[0-9a-f-]+\/thumb\/$/u.test(url.pathname)
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
    const request = { corpusId: 'YM-10-001', input: '今天又要加班了', session: 'cold' as const }
    const first = await pipeline.run(request)
    const second = await pipeline.run(request)

    expect(first.metrics.status).toBe('success')
    expect(first.metrics.candidate_count).toBe(9)
    expect(first.metrics.hashes.run_fingerprint).toBe(second.metrics.hashes.run_fingerprint)
    expect(first.metrics.hashes.candidate_set).toBe(second.metrics.hashes.candidate_set)
    expect(Object.keys(first.metrics.timings_ms)).toEqual(Object.keys(second.metrics.timings_ms))
    expect(() => assertMetricsMatchSchema(first.metrics, schema)).not.toThrow()
  })

  it('does not emit corpus 50 private text and sends no request for needs_user_input', async () => {
    const { pipeline, searchRequests } = await createDeterministicPipeline()
    const privacy = await pipeline.run({
      corpusId: 'YM-10-050',
      input: '张三说项目代号 X 明天暂停',
      session: 'warm'
    })
    const beforeAmbiguous = searchRequests()
    const ambiguous = await pipeline.run({ corpusId: 'YM-10-043', input: '行', session: 'warm' })

    expect(() => assertNoForbiddenValues(privacy.metrics)).not.toThrow()
    expect(ambiguous.metrics.status).toBe('needs_user_input')
    expect(searchRequests()).toBe(beforeAmbiguous)
  })

  it('rejects additional metric properties', async () => {
    const { pipeline, schema } = await createDeterministicPipeline()
    const result = await pipeline.run({ corpusId: 'YM-10-001', input: '加班', session: 'cold' })
    expect(() => assertMetricsMatchSchema({ ...result.metrics, prompt: 'forbidden' } as never, schema))
      .toThrow('additionalProperty')
  })
})

describe('real-network daily quota', () => {
  it('permits ten UTC-day batches and rejects the eleventh', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ym10-quota-test-'))
    try {
      const quota = new DailyOnlineQuota(
        join(directory, 'quota.json'),
        () => new Date('2026-07-15T12:00:00.000Z')
      )
      for (let index = 0; index < 10; index += 1) await quota.consume()
      await expect(quota.consume()).rejects.toThrow('daily_online_limit_reached')
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