import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { app, BrowserWindow, ipcMain } from 'electron'
import { BASELINE_COMMIT, BASELINE_PACKAGE_LOCK_GIT_BLOB_SHA256, DECODE_CONCURRENCY, MAX_LOCAL_IMAGE_BYTES, PROBE_VERSION } from './constants'
import type { KeywordPlan, OpenverseAsset, ProbeMetrics, ProbeRunRequest, ProbeTransport } from './contracts'
import { DailyOnlineQuota } from './daily-quota'
import { ElectronClipboardProbe, FileExportProbe } from './electron-adapters'
import { SECURITY_IMAGE_IDS, startFixtureServer, type RunningFixtureServer } from './fixture-server'
import { stableSha256 } from './hashing'
import { normalizeConfirmedKeywords, planKeywords } from './keyword-planner'
import { importLocalImage } from './local-image-import'
import { assertMetricsMatchSchema } from './metrics'
import { NdjsonMetricsWriter } from './metrics-writer'
import { createFixtureTransport, createOpenverseTransport } from './network'
import { ConfirmedOnlineBatchGate } from './online-authorization'
import { Ym10ProbePipeline } from './pipeline'
import { assertNoForbiddenValues } from './privacy'
import { generateStage2BoundaryFixtures } from './stage2-fixture-generator'
import { SharpUtilityProcessPool } from './worker-pool'

interface RendererPlanRequest {
  input?: unknown
}

interface RendererRunRequest {
  corpusId?: unknown
  confirmedKeywords?: unknown
  session?: unknown
  transport?: unknown
}

interface BuildProvenance {
  source_commit: string
  base_commit: string
  package_lock_git_blob_sha256: string
  package_lock_worktree_sha256: string
}

interface RendererHarnessSnapshot {
  state: {
    input: string
    settings: Record<string, unknown>
    previousBatch: string[]
  }
  heartbeatCount: number
  maximumHeartbeatGapMs: number
  errorText: string
}

interface Stage2HarnessReport {
  fixture_generator_version: string
  fixtures: Array<{ id: string; size_bytes: number; width: number; height: number }>
  worker_pids_before_kill: number[]
  worker_pids_after_recovery: number[]
  killed_worker_pid: number | null
  recovery_ms: number
  output_count: number
  output_set_sha256: string
  retry_output_sha256: string | null
  heartbeat: {
    main_count: number
    main_maximum_gap_ms: number
    renderer_count: number
    renderer_maximum_gap_ms: number
  }
  preservation: {
    input: boolean
    settings: boolean
    previous_batch: boolean
  }
  error_screenshot: { filename: string; size_bytes: number; sha256: string }
  checks: Record<string, boolean>
}

interface SmokeReport {
  schema_version: 1
  probe_version: string
  status: 'pass' | 'fail'
  baseline: BuildProvenance
  checks: Record<string, boolean>
  repeatability: {
    run_fingerprint: string
    candidate_set: string | null
    timing_keys_sha256: string
  }
  privacy: {
    forbidden_value_hits: number
    unconfirmed_request_delta: number
    unconfirmed_quota_delta: number
    unconfirmed_case_count: number
    unconfirmed_plans: Array<{ corpus_id: string; status: KeywordPlan['status']; keywords: string[] }>
  }
  fixture: {
    request_count: number
    search_request_count: number
    image_request_count: number
  }
  stage2_harness: Stage2HarnessReport
  evidence: {
    metrics_sha256: string
    metrics_record_count: number
  }
}

const IPC_PLAN = 'ym10-probe:plan'
const IPC_RUN = 'ym10-probe:run'
const WORKER_PATH = join(__dirname, 'sharp-worker.js')
const FIXTURES_DIRECTORY = join(__dirname, 'fixtures')
const SCHEMA_PATH = join(__dirname, 'schemas', 'metrics.schema.json')
const BUILD_PROVENANCE_PATH = join(__dirname, 'build-provenance.json')

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

async function loadBuildProvenance(): Promise<BuildProvenance> {
  const value = JSON.parse(await readFile(BUILD_PROVENANCE_PATH, 'utf8')) as Partial<BuildProvenance>
  if (!value.source_commit || value.base_commit !== BASELINE_COMMIT ||
    value.package_lock_git_blob_sha256 !== BASELINE_PACKAGE_LOCK_GIT_BLOB_SHA256 ||
    !value.package_lock_worktree_sha256) throw new Error('invalid_build_provenance')
  return value as BuildProvenance
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

function plannedRequest(corpusId: string, input: string, session: 'cold' | 'warm'): ProbeRunRequest {
  const plan = planKeywords(input)
  if (plan.status !== 'ready') throw new Error('smoke_keyword_plan_not_ready')
  return { corpusId, confirmedKeywords: plan.keywords, session }
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

async function rejectsWith(operation: Promise<unknown>, expectedCode: string): Promise<boolean> {
  try {
    await operation
    return false
  } catch (error) {
    return error instanceof Error && error.message === expectedCode
  }
}

async function runSecurityDiagnostics(
  transport: ProbeTransport,
  origin: string
): Promise<Record<string, boolean>> {
  const processor = new SharpUtilityProcessPool(WORKER_PATH)
  try {
    const wrongMediaType = await rejectsWith(
      transport.download(fixtureAsset(origin, SECURITY_IMAGE_IDS.wrongMediaType)),
      'image_content_type_rejected'
    )
    const fakeMagic = await rejectsWith(
      transport.download(fixtureAsset(origin, SECURITY_IMAGE_IDS.fakePngMagic)),
      'image_magic_rejected'
    )
    const mediaMagicMismatch = await rejectsWith(
      transport.download(fixtureAsset(origin, SECURITY_IMAGE_IDS.mediaMagicMismatch)),
      'image_type_mismatch'
    )
    const streamedOverLimit = await rejectsWith(
      transport.download(fixtureAsset(origin, SECURITY_IMAGE_IDS.streamedOverLimit)),
      'streamed_response_too_large'
    )
    const corrupt = await transport.download(fixtureAsset(origin, SECURITY_IMAGE_IDS.corruptPng))
    const corruptRejected = await rejectsWith(processor.process(corrupt.bytes, 0), 'sharp_processing_failed')
    const bomb = await transport.download(fixtureAsset(origin, SECURITY_IMAGE_IDS.dimensionBombPng))
    const bombRejected = await rejectsWith(processor.process(bomb.bytes, 0), 'image_dimensions_rejected')
    const valid = await transport.download(fixtureAsset(
      origin,
      '20000000-0000-4000-8000-000000000001'
    ))

    const crashRejected = await rejectsWith(processor.runDiagnostic('crash'), 'sharp_worker_exited')
    const crashRecovery = (await processor.process(valid.bytes, 0)).png.byteLength > 0

    const firstHang = processor.runDiagnostic('hang')
    const secondHang = processor.runDiagnostic('hang')
    const queuedRecovery = processor.process(valid.bytes, 1)
    const [firstHangRejected, secondHangRejected, recovered] = await Promise.all([
      rejectsWith(firstHang, 'sharp_worker_timeout'),
      rejectsWith(secondHang, 'sharp_worker_timeout'),
      queuedRecovery.then(({ png }) => png.byteLength > 0)
    ])

    return {
      wrong_media_type_rejected: wrongMediaType,
      fake_magic_rejected: fakeMagic,
      media_magic_mismatch_rejected: mediaMagicMismatch,
      streamed_over_limit_rejected: streamedOverLimit,
      corrupt_image_rejected: corruptRejected,
      dimension_bomb_rejected: bombRejected,
      worker_crash_rejected: crashRejected,
      worker_crash_recovered: crashRecovery,
      worker_timeout_rejected: firstHangRejected && secondHangRejected,
      queued_job_recovered_after_timeout: recovered
    }
  } finally {
    processor.dispose()
  }
}

async function runStage2PackagedHarness(outputDirectory: string): Promise<Stage2HarnessReport> {
  const fixtureDirectory = join(outputDirectory, 'stage2-boundary-fixtures')
  const fixtureRecords = await generateStage2BoundaryFixtures(fixtureDirectory)
  const fixtures = await Promise.all(fixtureRecords.map(async (fixture) => ({
    fixture,
    imported: await importLocalImage(fixture.path, fixture.declaredMediaType)
  })))
  const processor = new SharpUtilityProcessPool(WORKER_PATH)
  const window = new BrowserWindow({
    width: 760,
    height: 480,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  let mainHeartbeatCount = 0
  let mainMaximumGapMs = 0
  let lastMainHeartbeat = performance.now()
  const mainHeartbeat = setInterval(() => {
    const now = performance.now()
    mainMaximumGapMs = Math.max(mainMaximumGapMs, now - lastMainHeartbeat)
    lastMainHeartbeat = now
    mainHeartbeatCount += 1
  }, 50)

  try {
    await window.loadFile(join(__dirname, 'renderer', 'stage2-harness.html'))
    const workerPidsBeforeKill = processor.activeWorkerPids()
    const outputs = await Promise.all(Array.from({ length: 9 }, (_, index) => {
      return processor.processLocal(fixtures[index % fixtures.length].imported.bytes, index)
    }))
    const outputHashes = outputs.map(({ sha256: value }) => value)
    const preservedState = {
      input: 'stage2-boundary-fixture-batch',
      settings: { variants: 9, source: 'local', mode: 'non-release-probe' },
      previousBatch: outputHashes
    }
    await window.webContents.executeJavaScript(
      `globalThis.stage2Harness.setState(${JSON.stringify(preservedState)})`
    )
    const before = await window.webContents.executeJavaScript(
      'globalThis.stage2Harness.snapshot()'
    ) as RendererHarnessSnapshot

    const killStartedAt = performance.now()
    const crashFixture = fixtures.find(
      ({ fixture }) => fixture.id === 'edge_8192_by_1024'
    ) ?? fixtures[0]
    const killTarget = processor.processLocal(crashFixture.imported.bytes, 0)
    const killedWorkerPid = processor.terminateBusyWorker()
    const killRejected = await rejectsWith(killTarget, 'sharp_worker_exited')
    const recoveryMs = Math.round(performance.now() - killStartedAt)
    const workerPidsAfterRecovery = processor.activeWorkerPids()

    await window.webContents.executeJavaScript(
      `globalThis.stage2Harness.showWorkerError('sharp_worker_exited', ${JSON.stringify(killedWorkerPid)})`
    )
    const screenshotBytes = window.webContents.capturePage
      ? (await window.webContents.capturePage()).toPNG()
      : Buffer.alloc(0)
    const screenshotFilename = 'stage2-harness-worker-error.png'
    await writeFile(join(outputDirectory, screenshotFilename), screenshotBytes, { flag: 'wx' })

    const retry = await processor.processLocal(crashFixture.imported.bytes, 0)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    const after = await window.webContents.executeJavaScript(
      'globalThis.stage2Harness.snapshot()'
    ) as RendererHarnessSnapshot
    const preservation = {
      input: before.state.input === after.state.input,
      settings: JSON.stringify(before.state.settings) === JSON.stringify(after.state.settings),
      previous_batch: JSON.stringify(before.state.previousBatch) ===
        JSON.stringify(after.state.previousBatch)
    }
    const checks = {
      four_boundary_fixtures_generated: fixtures.length === 4,
      all_boundary_fixtures_entered_local_import: fixtures.every(
        ({ imported }) => imported.bytes.byteLength > 0 && imported.bytes.byteLength <= MAX_LOCAL_IMAGE_BYTES
      ),
      real_utility_process_pool_fixed_at_two: workerPidsBeforeKill.length === DECODE_CONCURRENCY,
      nine_outputs_completed: outputs.length === 9 && outputs.every(({ png }) => png.byteLength > 0),
      busy_real_utility_process_killed: killedWorkerPid !== null && killRejected,
      worker_replaced_within_three_seconds: recoveryMs <= 3_000 &&
        workerPidsAfterRecovery.length === DECODE_CONCURRENCY &&
        !workerPidsAfterRecovery.includes(killedWorkerPid ?? -1),
      retry_completed_after_replacement: retry.png.byteLength > 0,
      main_heartbeat_responsive: mainHeartbeatCount > 0 && mainMaximumGapMs < 1_500,
      renderer_heartbeat_responsive: after.heartbeatCount > 0 && after.maximumHeartbeatGapMs < 1_500,
      input_settings_previous_batch_preserved: Object.values(preservation).every(Boolean),
      screenshotable_worker_error_present: screenshotBytes.byteLength > 0 &&
        after.errorText.includes('sharp_worker_exited')
    }
    return {
      fixture_generator_version: PROBE_VERSION,
      fixtures: fixtureRecords.map(({ id, sizeBytes, width, height }) => ({
        id, size_bytes: sizeBytes, width, height
      })),
      worker_pids_before_kill: workerPidsBeforeKill,
      worker_pids_after_recovery: workerPidsAfterRecovery,
      killed_worker_pid: killedWorkerPid,
      recovery_ms: recoveryMs,
      output_count: outputs.length,
      output_set_sha256: stableSha256(outputHashes),
      retry_output_sha256: retry.sha256,
      heartbeat: {
        main_count: mainHeartbeatCount,
        main_maximum_gap_ms: Math.round(mainMaximumGapMs),
        renderer_count: after.heartbeatCount,
        renderer_maximum_gap_ms: Math.round(after.maximumHeartbeatGapMs)
      },
      preservation,
      error_screenshot: {
        filename: screenshotFilename,
        size_bytes: screenshotBytes.byteLength,
        sha256: sha256(screenshotBytes)
      },
      checks
    }
  } finally {
    clearInterval(mainHeartbeat)
    processor.dispose()
    window.destroy()
  }
}

async function runSmoke(reportPath: string, metricsPath: string): Promise<void> {
  if (!isAbsolute(reportPath) || !isAbsolute(metricsPath)) throw new Error('smoke_paths_must_be_absolute')
  if (await pathExists(reportPath) || await pathExists(metricsPath)) {
    throw new Error('smoke_evidence_path_already_exists')
  }
  await mkdir(dirname(reportPath), { recursive: true })
  await mkdir(dirname(metricsPath), { recursive: true })
  const schema = await loadMetricsSchema()
  const provenance = await loadBuildProvenance()
  const fixtureServer = await startFixtureServer(FIXTURES_DIRECTORY)
  const transport = createFixtureTransport(fixtureServer.origin, fixtureServer.ca)
  let smokeReport: SmokeReport
  try {
    const first = await runPipeline(
      transport,
      plannedRequest('YM-10-001', '今天又要加班了', 'cold'),
      join(dirname(reportPath), 'exports', 'run-1'),
      metricsPath,
      schema
    )
    const second = await runPipeline(
      transport,
      plannedRequest('YM-10-001', '今天又要加班了', 'cold'),
      join(dirname(reportPath), 'exports', 'run-2'),
      metricsPath,
      schema
    )
    const privacy = await runPipeline(
      transport,
      plannedRequest('YM-10-050', '张三说项目代号 X 明天暂停', 'warm'),
      join(dirname(reportPath), 'exports', 'privacy'),
      metricsPath,
      schema
    )

    const unconfirmedInputs = [
      { corpusId: 'YM-10-043', input: '行' },
      { corpusId: 'YM-10-044', input: '6' },
      { corpusId: 'YM-10-048', input: '🙃' },
      { corpusId: 'YM-10-050', input: '张三说项目代号 X 明天暂停' },
      { corpusId: 'YM-10-001', input: '李四客户密码' }
    ]
    const unconfirmedPlans = unconfirmedInputs.map(({ corpusId, input }) => ({
      corpusId,
      plan: planKeywords(input)
    }))
    const requestsBeforeUnconfirmed = fixtureServer.stats.requestCount
    const unconfirmedMetrics: ProbeMetrics[] = []
    for (const item of unconfirmedInputs) {
      unconfirmedMetrics.push(await runPipeline(
        transport,
        { corpusId: item.corpusId, session: 'warm' },
        join(dirname(reportPath), 'exports', `unconfirmed-${item.corpusId}`),
        metricsPath,
        schema
      ))
    }
    const unconfirmedRequestDelta = fixtureServer.stats.requestCount - requestsBeforeUnconfirmed

    const quota = new DailyOnlineQuota(join(dirname(reportPath), 'unconfirmed-quota.json'))
    const onlineGate = new ConfirmedOnlineBatchGate(quota)
    const quotaBefore = await quota.usage()
    for (const item of unconfirmedInputs) {
      if (!(await rejectsWith(onlineGate.authorize(undefined), 'keywords_confirmation_required'))) {
        throw new Error(`unconfirmed_quota_gate_failed_${item.corpusId}`)
      }
    }
    const unconfirmedQuotaDelta = (await quota.usage()) - quotaBefore
    const securityChecks = await runSecurityDiagnostics(transport, fixtureServer.origin)
    const stage2Harness = await runStage2PackagedHarness(dirname(reportPath))

    const metricsRecords = [first, second, privacy, ...unconfirmedMetrics]
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
      ambiguous_plans_need_user_input: unconfirmedPlans.slice(0, 3).every(
        ({ plan }) => plan.status === 'needs_user_input'
      ),
      project_plan_contains_only_safe_terms: unconfirmedPlans[3].plan.status === 'ready' &&
        unconfirmedPlans[3].plan.keywords.every((keyword) =>
          !['张三', '项目代号', 'X'].some((value) => keyword.includes(value))
        ),
      sensitive_fallback_needs_user_input: unconfirmedPlans[4].plan.status === 'needs_user_input',
      all_unconfirmed_runs_need_confirmation: unconfirmedMetrics.every(
        ({ status, error_code }) => status === 'needs_user_input' &&
          error_code === 'keywords_confirmation_required'
      ),
      unconfirmed_cases_sent_no_request: unconfirmedRequestDelta === 0,
      unconfirmed_cases_used_no_quota: unconfirmedQuotaDelta === 0,
      clipboard_verified: Boolean(first.hashes.clipboard && second.hashes.clipboard),
      export_verified: Boolean(first.hashes.export && second.hashes.export),
      utility_process_pool_fixed_at_two: DECODE_CONCURRENCY === 2,
      ...securityChecks,
      ...stage2Harness.checks
    }
    const passed = Object.values(checks).every(Boolean)
    const metricsBytes = await readFile(metricsPath)
    smokeReport = {
      schema_version: 1,
      probe_version: PROBE_VERSION,
      status: passed ? 'pass' : 'fail',
      baseline: provenance,
      checks,
      repeatability: {
        run_fingerprint: first.hashes.run_fingerprint,
        candidate_set: first.hashes.candidate_set,
        timing_keys_sha256: stableSha256(Object.keys(first.timings_ms))
      },
      privacy: {
        forbidden_value_hits: fixtureServer.stats.forbiddenValueHits,
        unconfirmed_request_delta: unconfirmedRequestDelta,
        unconfirmed_quota_delta: unconfirmedQuotaDelta,
        unconfirmed_case_count: unconfirmedInputs.length,
        unconfirmed_plans: unconfirmedPlans.map(({ corpusId, plan }) => ({
          corpus_id: corpusId,
          status: plan.status,
          keywords: plan.keywords
        }))
      },
      fixture: {
        request_count: fixtureServer.stats.requestCount,
        search_request_count: fixtureServer.stats.searchRequests,
        image_request_count: fixtureServer.stats.imageRequests
      },
      stage2_harness: stage2Harness,
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

function normalizedInput(value: unknown): string {
  const input = typeof value === 'string' ? value.trim() : ''
  if (!input || [...input].length > 500) throw new Error('invalid_input')
  return input
}

function normalizeRendererRequest(value: RendererRunRequest): {
  request: ProbeRunRequest
  transport: 'fixture' | 'openverse'
} {
  const corpusId = typeof value?.corpusId === 'string' ? value.corpusId.trim() : ''
  const session = value?.session === 'warm' ? 'warm' : 'cold'
  const transport = value?.transport === 'openverse' ? 'openverse' : 'fixture'
  const confirmedKeywords = normalizeConfirmedKeywords(value?.confirmedKeywords)
  if (!/^YM-10-\d{3}$/u.test(corpusId)) throw new Error('invalid_corpus_id')
  if (!confirmedKeywords) throw new Error('keywords_confirmation_required')
  return { request: { corpusId, confirmedKeywords, session }, transport }
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
  const onlineGate = new ConfirmedOnlineBatchGate(quota)
  let active = false
  ipcMain.handle(IPC_PLAN, (_event, rawRequest: RendererPlanRequest): KeywordPlan => {
    return planKeywords(normalizedInput(rawRequest?.input))
  })
  ipcMain.handle(IPC_RUN, async (_event, rawRequest: RendererRunRequest) => {
    const normalized = normalizeRendererRequest(rawRequest)
    if (active) throw new Error('only_one_search_batch_allowed')
    active = true
    let fixtureServer: RunningFixtureServer | null = null
    try {
      let transport: ProbeTransport
      if (normalized.transport === 'openverse') {
        normalized.request.confirmedKeywords = await onlineGate.authorize(
          normalized.request.confirmedKeywords
        )
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
    } catch (error) {
      const errorCode = error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
        ? error.message
        : 'packaged_smoke_failed'
      console.error(error)
      if (!(await pathExists(smokeReportPath))) {
        await writeFile(smokeReportPath, `${JSON.stringify({
          schema_version: 1,
          probe_version: PROBE_VERSION,
          status: 'fail',
          error_code: errorCode
        }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      }
      app.exit(1)
    }
    return
  }
  await startInteractiveApp()
})

app.on('window-all-closed', () => {
  if (!process.argv.includes('--smoke')) app.quit()
})
