import { normalizeLocalAssetText, type LocalAssetDto } from '../shared/local-assets'

export type LocalAssetMatchField = 'name' | 'tag'

export interface LocalAssetMatch {
  asset: LocalAssetDto
  score: number
  matchedFields: LocalAssetMatchField[]
  matchedTags: string[]
}

interface IndexedAsset {
  asset: LocalAssetDto
  normalizedName: string
  normalizedTags: Array<{ displayValue: string; normalizedValue: string }>
}

function queryTerms(value: string): string[] {
  return [...new Set(value.split(/\s+/u).filter(Boolean))]
}
function hasMeaningfulSubstring(left: string, right: string): boolean {
  if (left.includes(right) || right.includes(left)) return true
  const rightCharacters = [...right]
  if (rightCharacters.length < 2) return false
  for (let length = Math.min(4, rightCharacters.length); length >= 2; length -= 1) {
    for (let index = 0; index <= rightCharacters.length - length; index += 1) {
      const candidate = rightCharacters.slice(index, index + length).join('')
      if (/\p{Script=Han}/u.test(candidate) && left.includes(candidate)) return true
    }
  }
  return false
}


/** Deterministic, in-memory ready-asset index for the frozen first-release scale. */
export class LocalAssetIndex {
  private readonly assets = new Map<string, IndexedAsset>()

  replace(assets: readonly LocalAssetDto[]): void {
    this.assets.clear()
    for (const asset of assets) this.upsert(asset)
  }

  upsert(asset: LocalAssetDto): void {
    this.assets.set(asset.id, {
      asset,
      normalizedName: normalizeLocalAssetText(asset.displayName),
      normalizedTags: asset.tags.map((tag) => ({
        displayValue: tag.displayValue,
        normalizedValue: normalizeLocalAssetText(tag.normalizedValue)
      }))
    })
  }

  remove(assetId: string): void {
    this.assets.delete(assetId)
  }

  match(
    input: string,
    options: { limit?: number; excludedIds?: ReadonlySet<string> } = {}
  ): LocalAssetMatch[] {
    const normalizedInput = normalizeLocalAssetText(input)
    if (!normalizedInput) return []
    const terms = queryTerms(normalizedInput)
    const excludedIds = options.excludedIds ?? new Set<string>()
    const matches: LocalAssetMatch[] = []

    for (const indexed of this.assets.values()) {
      if (excludedIds.has(indexed.asset.id)) continue
      let score = 0
      let nameMatched = false
      const matchedTags: string[] = []

      for (const tag of indexed.normalizedTags) {
        const fullTagMatch = normalizedInput.includes(tag.normalizedValue)
        const termMatch = terms.some((term) =>
          term.includes(tag.normalizedValue) || tag.normalizedValue.includes(term)
        )
        if (fullTagMatch) {
          score += 1_000
          matchedTags.push(tag.displayValue)
        } else if (termMatch) {
          score += 400
          matchedTags.push(tag.displayValue)
        }
      }

      if (
        normalizedInput.includes(indexed.normalizedName) ||
        indexed.normalizedName.includes(normalizedInput) ||
        hasMeaningfulSubstring(normalizedInput, indexed.normalizedName) ||
        terms.some((term) =>
          indexed.normalizedName.includes(term) || term.includes(indexed.normalizedName)
        )
      ) {
        nameMatched = true
        score += 100
      }

      if (score === 0) continue
      matches.push({
        asset: indexed.asset,
        score,
        matchedFields: [
          ...(matchedTags.length > 0 ? ['tag' as const] : []),
          ...(nameMatched ? ['name' as const] : [])
        ],
        matchedTags
      })
    }

    matches.sort((left, right) =>
      right.score - left.score ||
      right.matchedTags.length - left.matchedTags.length ||
      right.asset.importedAt.localeCompare(left.asset.importedAt) ||
      left.asset.id.localeCompare(right.asset.id)
    )
    return matches.slice(0, options.limit ?? 9)
  }
}
