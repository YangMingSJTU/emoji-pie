import { performance } from 'node:perf_hooks'
import { MAX_CANDIDATES, PROBE_VERSION } from './constants'
import type {
  LicenseDistribution,
  ProbeBytes,
  ProbeClipboard,
  ProbeExporter,
  ProbeHashes,
  ProbeImageProcessor,
  ProbeMetrics,
  ProbeRunRequest,
  ProbeRunResult,
  ProbeTimings,
  ProbeTransport,
  ProcessedImage
} from './contracts'
import { stableSha256 } from './hashing'
import { normalizeConfirmedKeywords } from './keyword-planner'
import { emptyLicenseDistribution, filterEligibleAssets } from './license-gate'
import { assertMetricsMatchSchema, emptyTimings } from './metrics'
import { ProbeNetworkError } from './network'
import { assertNoForbiddenValues } from './privacy'

interface PipelineOptions {
  transport: ProbeTransport
  imageProcessor: ProbeImageProcessor
  clipboard: ProbeClipboard
  exporter: ProbeExporter
  metricsSchema: unknown
  writeMetrics?: (metrics: ProbeMetrics) => Promise<void>
}

interface Span {
  startedAt: number
  endedAt: number
}

function elapsed(startedAt: number, endedAt = performance.now()): number {
  return Math.max(0, Math.round(endedAt - startedAt))
}

function startSpan(span: Span): void {
  if (span.startedAt === 0) span.startedAt = performance.now()
}

function endSpan(span: Span): void {
  span.endedAt = performance.now()
}

function spanDuration(span: Span): number {
  return span.startedAt > 0 && span.endedAt >= span.startedAt
    ? elapsed(span.startedAt, span.endedAt)
    : 0
}

function errorCode(error: unknown): { code: string; statusCode: number | null } {
  if (error instanceof ProbeNetworkError) {
    return { code: error.code, statusCode: error.statusCode }
  }
  if (error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)) {
    return { code: error.message, statusCode: null }
  }
  return { code: 'probe_operation_failed', statusCode: null }
}

function zeroBytes(): ProbeBytes {
  return { search_response: 0, downloaded: 0, generated: 0, clipboard: 0, exported: 0 }
}

function zeroHashes(): ProbeHashes {
  return { run_fingerprint: '', candidate_set: null, clipboard: null, export: null }
}

function baseMetrics(
  request: ProbeRunRequest,
  transport: ProbeTransport,
  timings: ProbeTimings,
  bytes: ProbeBytes,
  distribution: LicenseDistribution,
  hashes: ProbeHashes
): ProbeMetrics {
  return {
    schema_version: 1,
    probe_version: PROBE_VERSION,
    corpus_id: request.corpusId,
    session: request.session,
    transport: transport.mode,
    status: 'failed',
    error_code: null,
    status_code: null,
    result_count: 0,
    eligible_count: 0,
    candidate_count: 0,
    license_distribution: distribution,
    bytes,
    timings_ms: timings,
    hashes
  }
}

export class Ym10ProbePipeline {
  private readonly transport: ProbeTransport
  private readonly imageProcessor: ProbeImageProcessor
  private readonly clipboard: ProbeClipboard
  private readonly exporter: ProbeExporter
  private readonly metricsSchema: unknown
  private readonly writeMetrics?: (metrics: ProbeMetrics) => Promise<void>

  constructor(options: PipelineOptions) {
    this.transport = options.transport
    this.imageProcessor = options.imageProcessor
    this.clipboard = options.clipboard
    this.exporter = options.exporter
    this.metricsSchema = options.metricsSchema
    this.writeMetrics = options.writeMetrics
  }

  async run(request: ProbeRunRequest): Promise<ProbeRunResult> {
    if (!/^YM-10-\d{3}$/u.test(request.corpusId)) throw new Error('invalid_corpus_id')
    const startedAt = performance.now()
    const timings = emptyTimings()
    const bytes = zeroBytes()
    const distribution = emptyLicenseDistribution()
    const hashes = zeroHashes()
    const metrics = baseMetrics(request, this.transport, timings, bytes, distribution, hashes)

    const confirmationStartedAt = performance.now()
    const confirmedKeywords = normalizeConfirmedKeywords(request.confirmedKeywords)
    timings.planner = elapsed(confirmationStartedAt)
    if (!confirmedKeywords) {
      metrics.status = 'needs_user_input'
      metrics.error_code = 'keywords_confirmation_required'
      timings.total = elapsed(startedAt)
      return this.finalize(metrics, [])
    }

    let searchPayload: unknown
    try {
      const searchStartedAt = performance.now()
      const search = await this.transport.search(confirmedKeywords)
      timings.search = elapsed(searchStartedAt)
      metrics.status_code = search.statusCode
      bytes.search_response = search.responseBytes
      searchPayload = search.payload
    } catch (error) {
      const failure = errorCode(error)
      metrics.error_code = failure.code
      metrics.status_code = failure.statusCode
      timings.total = elapsed(startedAt)
      return this.finalize(metrics, [])
    }

    const gateStartedAt = performance.now()
    const gated = filterEligibleAssets(
      searchPayload,
      (value, expectedId) => this.transport.isThumbnailUrlAllowed(value, expectedId)
    )
    timings.license_gate = elapsed(gateStartedAt)
    Object.assign(distribution, gated.distribution)
    metrics.result_count = gated.resultCount
    metrics.eligible_count = gated.assets.length

    const downloadSpan: Span = { startedAt: 0, endedAt: 0 }
    const decodeSpan: Span = { startedAt: 0, endedAt: 0 }
    let completedCandidates = 0
    let firstProcessingError: string | null = null
    const tasks = gated.assets.slice(0, MAX_CANDIDATES).map(async (asset, index) => {
      try {
        startSpan(downloadSpan)
        const download = await this.transport.download(asset)
        bytes.downloaded += download.bytes.byteLength
        endSpan(downloadSpan)

        startSpan(decodeSpan)
        const processed = await this.imageProcessor.process(download.bytes, index)
        bytes.generated += processed.png.byteLength
        endSpan(decodeSpan)
        completedCandidates += 1
        if (completedCandidates === 3) timings.three_ready = elapsed(startedAt)
        if (completedCandidates === 9) timings.nine_ready = elapsed(startedAt)
        return processed
      } catch (error) {
        firstProcessingError ??= errorCode(error).code
        return null
      }
    })
    const processed = (await Promise.all(tasks)).filter(
      (candidate): candidate is ProcessedImage => candidate !== null
    )
    timings.download_span = spanDuration(downloadSpan)
    timings.decode_compose_span = spanDuration(decodeSpan)
    metrics.candidate_count = processed.length

    if (processed[0]) {
      try {
        const clipboardStartedAt = performance.now()
        const clipboard = await this.clipboard.writeAndVerify(processed[0].png)
        timings.clipboard = elapsed(clipboardStartedAt)
        bytes.clipboard = clipboard.bytes
        hashes.clipboard = clipboard.sha256

        const exportStartedAt = performance.now()
        const exported = await this.exporter.writeAndVerify(processed[0].png)
        timings.export = elapsed(exportStartedAt)
        bytes.exported = exported.bytes
        hashes.export = exported.sha256
      } catch (error) {
        firstProcessingError ??= errorCode(error).code
      }
    }

    hashes.candidate_set = processed.length > 0
      ? stableSha256(processed.map(({ sha256 }) => sha256))
      : null
    metrics.status = processed.length === MAX_CANDIDATES && !firstProcessingError
      ? 'success'
      : processed.length > 0
        ? 'partial'
        : 'failed'
    metrics.error_code = firstProcessingError ??
      (processed.length < MAX_CANDIDATES ? 'candidate_shortfall' : null)
    timings.total = elapsed(startedAt)
    return this.finalize(metrics, processed)
  }

  private async finalize(metrics: ProbeMetrics, candidates: ProcessedImage[]): Promise<ProbeRunResult> {
    metrics.hashes.run_fingerprint = stableSha256({
      probe_version: metrics.probe_version,
      corpus_id: metrics.corpus_id,
      session: metrics.session,
      transport: metrics.transport,
      status: metrics.status,
      error_code: metrics.error_code,
      status_code: metrics.status_code,
      result_count: metrics.result_count,
      eligible_count: metrics.eligible_count,
      candidate_count: metrics.candidate_count,
      license_distribution: metrics.license_distribution,
      candidate_set: metrics.hashes.candidate_set,
      clipboard: metrics.hashes.clipboard,
      export: metrics.hashes.export
    })
    assertMetricsMatchSchema(metrics, this.metricsSchema)
    assertNoForbiddenValues(metrics)
    await this.writeMetrics?.(metrics)
    return { metrics, candidates }
  }
}
