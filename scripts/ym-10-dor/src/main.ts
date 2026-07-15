import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { BASELINE_COMMIT, BASELINE_PACKAGE_LOCK_SHA256, DECODE_CONCURRENCY, PROBE_VERSION } from './constants'
import type { ProbeMetrics, ProbeRunRequest, ProbeTransport } from './contracts'
import { DailyOnlineQuota } from './daily-quota'
import { ElectronClipboardProbe, FileExportProbe } from './electron-adapters'
import { startFixtureServer, type RunningFixtureServer } from './fixture-server'
import { stableSha256 } from './hashing'
import { assertMetricsMatchSchema } from './metrics'
import { NdjsonMetricsWriter } from './metrics-writer'
import { createFixtureTransport, createOpenverseTransport } from './network'
import { Ym10ProbePipeline } from './pipeline'
import { assertNoForbiddenValues } from './privacy'
import { SharpUtilityProcessPool } from './worker-pool'

interface RendererRunRequest {
  corpusId?: unknown
  input?: unknown
  session?: unknown
  transport?: unknown
}

interface SmokeReport {
  schema_version: 1
  probe_version: string
  status: 'pass' | 'fail'
  baseline: {
    git_commit: string
    package_lock_sha256: string
  }
  checks: Record<string, boolean>
  repeatability: {
    run_fingerprint: string
    candidate_set: string | null
    timing_keys_sha256: string
  }
  privacy: {
    forbidden_value_hits: number
    needs_user_input_request_delta: number
  }
  fixture: {
    request_count: number
    search_request_count: number
    image_request_count: number
  }
  evidence: {
    metrics_sha256: string
    metrics_record_count: number
  }
}

const IPC_RUN = 'ym10-probe:run'
const WORKER_PATH = join(__dirname, 'sharp-worker.js')
const FIXTURES_DIRECTORY = join(__dirname, 'fixtures')
const SCHEMA_PATH = join(__dirname, 'schemas', 'metrics.schema.json')

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function loadMetricsSchema(): Promise<unknown> {
  return JSON.parse(await readFile(SCHEMA_PATH, 'utf8'))
}

async function runPipeline(
  transport: ProbeTransport,
  request: ProbeRunRequest,
  outputDirectory: string,
  metricsPath: string,
  schema: unknown
): Promise<ProbeMetrics> {
  const processor = new SharpUtilityProcessPool(WORKER_PATH)
  const writer = new NdjsonMetricsWriter(metricsPath)
  const pipeline = new Ym10ProbePipeline({
    transport,
    imageProcessor: processor,
    clipboard: new ElectronClipboardProbe(),
    exporter: new FileExportProbe(outputDirectory),
    metricsSchema: schema,
    writeMetrics: (metrics) => writer.write(metrics)
  })
  try {
    return (await pipeline.run(request)).metrics
  } finally {
    processor.dispose()
  }
}

function sameTimingKeys(left: ProbeMetrics, right: ProbeMetrics): boolean {
  return Object.keys(left.timings_ms).join(',') === Object.keys(right.timings_ms).join(',')
}

async function runSmoke(reportPath: string, metricsPath: string): Promise<void> {
  if (!isAbsolute(reportPath) || !isAbsolute(metricsPath)) throw new Error('smoke_paths_must_be_absolute')
  if (await pathExists(reportPath) || await pathExists(metricsPath)) {
    throw new Error('smoke_evidence_path_already_exists')
  }
  await mkdir(dirname(reportPath), { recursive: true })
  await mkdir(dirname(metricsPath), { recursive: true })
  const schema = await loadMetricsSchema()
  const fixtureServer = await startFixtureServer(FIXTURES_DIRECTORY)
  const transport = createFixtureTransport(fixtureServer.origin, fixtureServer.ca)
  let smokeReport: SmokeReport
  try {
    const first = await runPipeline(
      transport,
      { corpusId: 'YM-10-001', input: '今天又要加班了', session: 'cold' },
      join(dirname(reportPath), 'exports', 'run-1'),
      metricsPath,
      schema
    )
    const second = await runPipeline(
      transport,
      { corpusId: 'YM-10-001', input: '今天又要加班了', session: 'cold' },
      join(dirname(reportPath), 'exports', 'run-2'),
      metricsPath,
      schema
    )
    const privacy = await runPipeline(
      transport,
      { corpusId: 'YM-10-050', input: '张三说项目代号 X 明天暂停', session: 'warm' },
      join(dirname(reportPath), 'exports', 'privacy'),
      metricsPath,
      schema
    )
    const searchesBeforeAmbiguous = fixtureServer.stats.searchRequests
    const ambiguous = await runPipeline(
      transport,
      { corpusId: 'YM-10-043', input: '行', session: 'warm' },
      join(dirname(reportPath), 'exports', 'ambiguous'),
      metricsPath,
      schema
    )
    const ambiguousRequestDelta = fixtureServer.stats.searchRequests - searchesBeforeAmbiguous
    const metricsRecords = [first, second, privacy, ambiguous]
    for (const metrics of metricsRecords) {
      assertMetricsMatchSchema(metrics, schema)
      assertNoForbiddenValues(metrics)
    }
    const checks = {
      first_run_success: first.status === 'success' && first.candidate_count === 9,
      second_run_success: second.status === 'success' && second.candidate_count === 9,
      deterministic_fingerprint: first.hashes.run_fingerprint === second.hashes.run_fingerprint,
      deterministic_candidate_set: first.hashes.candidate_set === second.hashes.candidate_set,
      timing_points_consistent: sameTimingKeys(first, second),
      metrics_schema_valid: true,
      privacy_case_success: privacy.status === 'success' && privacy.candidate_count === 9,
      privacy_forbidden_values_absent: fixtureServer.stats.forbiddenValueHits === 0,
      ambiguous_case_needs_user_input: ambiguous.status === 'needs_user_input',
      ambiguous_case_sent_no_request: ambiguousRequestDelta === 0,
      clipboard_verified: Boolean(first.hashes.clipboard && second.hashes.clipboard),
      export_verified: Boolean(first.hashes.export && second.hashes.export),
      utility_process_pool_fixed_at_two: DECODE_CONCURRENCY === 2
    }
    const passed = Object.values(checks).every(Boolean)
    const metricsBytes = await readFile(metricsPath)
    smokeReport = {
      schema_version: 1,
      probe_version: PROBE_VERSION,
      status: passed ? 'pass' : 'fail',
      baseline: {
        git_commit: BASELINE_COMMIT,
        package_lock_sha256: BASELINE_PACKAGE_LOCK_SHA256
      },
      checks,
      repeatability: {
        run_fingerprint: first.hashes.run_fingerprint,
        candidate_set: first.hashes.candidate_set,
        timing_keys_sha256: stableSha256(Object.keys(first.timings_ms))
      },
      privacy: {
        forbidden_value_hits: fixtureServer.stats.forbiddenValueHits,
        needs_user_input_request_delta: ambiguousRequestDelta
      },
      fixture: {
        request_count: fixtureServer.stats.requestCount,
        search_request_count: fixtureServer.stats.searchRequests,
        image_request_count: fixtureServer.stats.imageRequests
      },
      evidence: {
        metrics_sha256: sha256(metricsBytes),
        metrics_record_count: metricsRecords.length
      }
    }
    assertNoForbiddenValues(smokeReport)
    await writeFile(reportPath, `${JSON.stringify(smokeReport, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    })
    if (!passed) throw new Error('smoke_checks_failed')
  } finally {
    await fixtureServer.close()
  }
}

function normalizeRendererRequest(value: RendererRunRequest): {
  request: ProbeRunRequest
  transport: 'fixture' | 'openverse'
} {
  const corpusId = typeof value?.corpusId === 'string' ? value.corpusId.trim() : ''
  const input = typeof value?.input === 'string' ? value.input.trim() : ''
  const session = value?.session === 'warm' ? 'warm' : 'cold'
  const transport = value?.transport === 'openverse' ? 'openverse' : 'fixture'
  if (!/^YM-10-\d{3}$/u.test(corpusId)) throw new Error('invalid_corpus_id')
  if (!input || [...input].length > 500) throw new Error('invalid_input')
  return { request: { corpusId, input, session }, transport }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 800,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  void window.loadFile(join(__dirname, 'renderer', 'index.html'))
  window.once('ready-to-show', () => window.show())
  return window
}

async function startInteractiveApp(): Promise<void> {
  const schema = await loadMetricsSchema()
  const quota = new DailyOnlineQuota(join(app.getPath('userData'), 'online-quota.json'))
  let active = false
  ipcMain.handle(IPC_RUN, async (_event, rawRequest: RendererRunRequest) => {
    if (active) throw new Error('only_one_search_batch_allowed')
    active = true
    let fixtureServer: RunningFixtureServer | null = null
    try {
      const normalized = normalizeRendererRequest(rawRequest)
      let transport: ProbeTransport
      if (normalized.transport === 'openverse') {
        await quota.consume()
        transport = createOpenverseTransport()
      } else {
        fixtureServer = await startFixtureServer(FIXTURES_DIRECTORY)
        transport = createFixtureTransport(fixtureServer.origin, fixtureServer.ca)
      }
      const runRoot = join(app.getPath('userData'), 'runs', `${Date.now()}-${process.pid}`)
      return await runPipeline(
        transport,
        normalized.request,
        join(runRoot, 'exports'),
        join(runRoot, 'metrics.ndjson'),
        schema
      )
    } finally {
      await fixtureServer?.close()
      active = false
    }
  })
  createWindow()
}

app.setName('YM-10 DOR Probe')
app.setAppUserModelId('com.emojipie.ym10dorprobe')
void app.whenReady().then(async () => {
  const smokeReportPath = argumentValue('--smoke-report')
  if (process.argv.includes('--smoke')) {
    const metricsPath = argumentValue('--metrics')
    if (!smokeReportPath || !metricsPath) throw new Error('smoke_evidence_paths_required')
    try {
      await runSmoke(smokeReportPath, metricsPath)
      app.exit(0)
    } catch {
      app.exit(1)
    }
    return
  }
  await startInteractiveApp()
})

app.on('window-all-closed', () => app.quit())
