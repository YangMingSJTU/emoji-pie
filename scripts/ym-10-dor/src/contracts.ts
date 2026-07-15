export type ProbeTransportMode = 'fixture' | 'openverse'
export type ProbeRunStatus = 'success' | 'partial' | 'needs_user_input' | 'failed'

export interface KeywordPlan {
  status: 'ready' | 'needs_user_input'
  keywords: string[]
}

export interface ProbeRunRequest {
  corpusId: string
  confirmedKeywords?: string[]
  session: 'cold' | 'warm'
}

export interface OpenverseAsset {
  id: string
  license: string
  mature: boolean
  foreignLandingUrl: string
  licenseUrl: string
  source: string
  thumbnailUrl: string
}

export interface LicenseDistribution {
  cc0: number
  pdm: number
  by: number
  by_sa: number
  nc: number
  nd: number
  unknown: number
  rejected: number
}

export interface SearchOutcome {
  statusCode: number
  responseBytes: number
  payload: unknown
}

export interface DetailOutcome {
  statusCode: number
  responseBytes: number
  payload: unknown
}

export interface DownloadOutcome {
  bytes: Buffer
  statusCode: number
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
}

export interface ProbeTransport {
  readonly mode: ProbeTransportMode
  cooldownState(): { notBeforeMs: number; remainingMs: number }
  search(keywords: readonly string[]): Promise<SearchOutcome>
  detail(assetId: string): Promise<DetailOutcome>
  download(asset: OpenverseAsset): Promise<DownloadOutcome>
  isThumbnailUrlAllowed(value: string, expectedId?: string): boolean
}

export interface ProcessedImage {
  png: Buffer
  sha256: string
}

export interface ProbeImageProcessor {
  process(input: Buffer, variantIndex: number): Promise<ProcessedImage>
  dispose(): void
}

export interface ProbeClipboard {
  writeAndVerify(png: Buffer): Promise<{ bytes: number; sha256: string }>
}

export interface ProbeExporter {
  writeAndVerify(png: Buffer): Promise<{ bytes: number; sha256: string }>
}

export interface ProbeTimings {
  planner: number
  search: number
  license_gate: number
  download_span: number
  decode_compose_span: number
  three_ready: number
  nine_ready: number
  clipboard: number
  export: number
  total: number
}

export interface ProbeBytes {
  search_response: number
  downloaded: number
  generated: number
  clipboard: number
  exported: number
}

export interface ProbeHashes {
  run_fingerprint: string
  candidate_set: string | null
  clipboard: string | null
  export: string | null
}

export interface ProbeMetrics {
  schema_version: 1
  probe_version: string
  corpus_id: string
  session: 'cold' | 'warm'
  transport: ProbeTransportMode
  status: ProbeRunStatus
  error_code: string | null
  status_code: number | null
  result_count: number
  eligible_count: number
  candidate_count: number
  license_distribution: LicenseDistribution
  bytes: ProbeBytes
  timings_ms: ProbeTimings
  hashes: ProbeHashes
}

export interface ProbeRunResult {
  metrics: ProbeMetrics
  candidates: ProcessedImage[]
}
