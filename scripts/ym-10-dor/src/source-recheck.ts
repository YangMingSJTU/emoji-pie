import { OPENVERSE_ASSET_ID } from './constants'
import type { ProbeTransport } from './contracts'
import { filterEligibleAssets } from './license-gate'
import { ProbeNetworkError } from './network'

export const SOURCE_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000

export type SourceStatus = 'verified' | 'license_changed' | 'unavailable' | 'unchecked'
export type SourceRecheckTrigger = 'detail' | 'recreate' | 'startup' | 'grid' | 'history'

export interface SourceRecheckRecord {
  assetId: string
  status: SourceStatus
  lastAttemptAt: number | null
  lastSuccessfulCheckAt: number | null
  lastFailureCode: string | null
}

export interface SourceRecheckResult {
  requested: boolean
  canRecreate: boolean
  record: SourceRecheckRecord
}

function initialRecord(assetId: string): SourceRecheckRecord {
  return {
    assetId,
    status: 'unchecked',
    lastAttemptAt: null,
    lastSuccessfulCheckAt: null,
    lastFailureCode: null
  }
}

function clone(record: SourceRecheckRecord): SourceRecheckRecord {
  return { ...record }
}

export class SourceRecheckMachine {
  private readonly records = new Map<string, SourceRecheckRecord>()

  constructor(
    private readonly transport: ProbeTransport,
    private readonly now: () => number = Date.now
  ) {}

  snapshot(assetId: string): SourceRecheckRecord {
    const id = this.canonicalId(assetId)
    return clone(this.records.get(id) ?? initialRecord(id))
  }

  canRecreate(assetId: string): boolean {
    return this.snapshot(assetId).status === 'verified'
  }

  async recheck(assetId: string, trigger: SourceRecheckTrigger): Promise<SourceRecheckResult> {
    const id = this.canonicalId(assetId)
    const previous = this.records.get(id) ?? initialRecord(id)
    if (!this.shouldRequest(previous, trigger)) return this.result(previous, false)

    const attemptedAt = this.now()
    try {
      const detail = await this.transport.detail(id)
      const payload = detail.payload && typeof detail.payload === 'object'
        ? detail.payload as Record<string, unknown>
        : {}
      const license = typeof payload.license === 'string' ? payload.license.toLowerCase() : ''
      const gated = filterEligibleAssets(
        { result_count: 1, results: [payload] },
        (value, expectedId) => this.transport.isThumbnailUrlAllowed(value, expectedId)
      )
      let status: SourceStatus
      let failure: string | null = null
      if (gated.assets.some((asset) => asset.id === id)) {
        status = 'verified'
      } else if (license && !['cc0', 'pdm', 'public-domain'].includes(license)) {
        status = 'license_changed'
      } else {
        status = 'unchecked'
        failure = 'source_detail_invalid'
      }
      const next: SourceRecheckRecord = {
        assetId: id,
        status,
        lastAttemptAt: attemptedAt,
        lastSuccessfulCheckAt: status === 'unchecked' ? previous.lastSuccessfulCheckAt : attemptedAt,
        lastFailureCode: failure
      }
      this.records.set(id, next)
      return this.result(next, true)
    } catch (error) {
      if (error instanceof ProbeNetworkError && [404, 410].includes(error.statusCode ?? 0)) {
        const unavailable: SourceRecheckRecord = {
          assetId: id,
          status: 'unavailable',
          lastAttemptAt: attemptedAt,
          lastSuccessfulCheckAt: attemptedAt,
          lastFailureCode: null
        }
        this.records.set(id, unavailable)
        return this.result(unavailable, true)
      }
      const failed: SourceRecheckRecord = {
        ...previous,
        status: previous.lastSuccessfulCheckAt === null ? 'unchecked' : previous.status,
        lastAttemptAt: attemptedAt,
        lastFailureCode: error instanceof ProbeNetworkError ? error.code : 'source_recheck_failed'
      }
      this.records.set(id, failed)
      return this.result(failed, true)
    }
  }

  private shouldRequest(record: SourceRecheckRecord, trigger: SourceRecheckTrigger): boolean {
    if (trigger === 'recreate') return true
    if (trigger !== 'detail') return false
    return record.lastSuccessfulCheckAt === null ||
      this.now() - record.lastSuccessfulCheckAt > SOURCE_RECHECK_INTERVAL_MS
  }

  private canonicalId(assetId: string): string {
    const id = assetId.trim().toLowerCase()
    if (!OPENVERSE_ASSET_ID.test(id)) throw new Error('invalid_asset_id')
    return id
  }

  private result(record: SourceRecheckRecord, requested: boolean): SourceRecheckResult {
    return { requested, canRecreate: record.status === 'verified', record: clone(record) }
  }
}
