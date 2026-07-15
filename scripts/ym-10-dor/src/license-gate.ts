import type { LicenseDistribution, OpenverseAsset } from './contracts'

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

export function filterEligibleAssets(
  payload: unknown,
  isThumbnailUrlAllowed: (value: string) => boolean
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

    const id = clean(result.id, 180)
    const foreignLandingUrl = clean(result.foreign_landing_url)
    const licenseUrl = clean(result.license_url)
    const source = clean(result.source, 180)
    const thumbnailUrl = clean(result.thumbnail)
    const mature = result.mature === true
    const allowedLicense = classification === 'cc0' || classification === 'pdm'
    const accepted = allowedLicense && !mature && Boolean(id) && !seen.has(id) &&
      isHttpsUrl(foreignLandingUrl) && isHttpsUrl(licenseUrl) && Boolean(source) &&
      isThumbnailUrlAllowed(thumbnailUrl)

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
