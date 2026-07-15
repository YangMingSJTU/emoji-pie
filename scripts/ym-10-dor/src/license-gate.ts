import { OPENVERSE_ASSET_ID } from './constants'
import type { LicenseDistribution, OpenverseAsset } from './contracts'

const CANONICAL_LICENSE_URLS = {
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  pdm: 'https://creativecommons.org/publicdomain/mark/1.0/'
} as const

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function clean(value: unknown, maximum = 1_024): string {
  return typeof value === 'string'
    ? [...value]
      .map((character) => character.charCodeAt(0) < 32 ? ' ' : character)
      .join('')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, maximum)
    : ''
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

export function emptyLicenseDistribution(): LicenseDistribution {
  return { cc0: 0, pdm: 0, by: 0, by_sa: 0, nc: 0, nd: 0, unknown: 0, rejected: 0 }
}

function classifyLicense(value: string): keyof Omit<LicenseDistribution, 'rejected'> {
  const license = value.toLowerCase().replace(/[_ ]/gu, '-')
  if (license === 'cc0') return 'cc0'
  if (license === 'pdm' || license === 'public-domain') return 'pdm'
  if (license === 'by' || license === 'cc-by') return 'by'
  if (license.includes('by-sa')) return 'by_sa'
  if (license.includes('nc')) return 'nc'
  if (license.includes('nd')) return 'nd'
  return 'unknown'
}

function licenseUrlMatches(value: string, classification: keyof LicenseDistribution): boolean {
  if (classification !== 'cc0' && classification !== 'pdm') return false
  try {
    return new URL(value).href === CANONICAL_LICENSE_URLS[classification]
  } catch {
    return false
  }
}

export function filterEligibleAssets(
  payload: unknown,
  isThumbnailUrlAllowed: (value: string, expectedId: string) => boolean
): { assets: OpenverseAsset[]; distribution: LicenseDistribution; resultCount: number } {
  const root = asRecord(payload)
  const rawResults = Array.isArray(root.results) ? root.results : []
  const distribution = emptyLicenseDistribution()
  const assets: OpenverseAsset[] = []
  const seen = new Set<string>()

  for (const rawResult of rawResults) {
    const result = asRecord(rawResult)
    const license = clean(result.license, 80).toLowerCase()
    const classification = classifyLicense(license)
    distribution[classification] += 1

    const rawId = clean(result.id, 180)
    const id = rawId.toLowerCase()
    const foreignLandingUrl = clean(result.foreign_landing_url)
    const licenseUrl = clean(result.license_url)
    const source = clean(result.source, 180)
    const thumbnailUrl = clean(result.thumbnail)
    const accepted = (classification === 'cc0' || classification === 'pdm') &&
      result.mature === false && OPENVERSE_ASSET_ID.test(rawId) && !seen.has(id) &&
      isHttpsUrl(foreignLandingUrl) && licenseUrlMatches(licenseUrl, classification) &&
      Boolean(source) && isThumbnailUrlAllowed(thumbnailUrl, id)

    if (!accepted) {
      distribution.rejected += 1
      continue
    }
    seen.add(id)
    assets.push({
      id,
      license: classification,
      mature: false,
      foreignLandingUrl,
      licenseUrl,
      source,
      thumbnailUrl
    })
  }

  const declaredCount = Number(root.result_count)
  return {
    assets,
    distribution,
    resultCount: Number.isInteger(declaredCount) && declaredCount >= 0
      ? declaredCount
      : rawResults.length
  }
}
