import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LocalAssetIndex } from '../src/main/local-asset-index'
import type { LocalAssetDto } from '../src/shared/local-assets'

interface FrozenCorpusItem {
  id: number
  mode: 'expression' | 'reply'
  input: string
  acceptable_direction: string
}

interface FrozenCorpus {
  corpus_id: string
  immutable_during_validation: boolean
  items: FrozenCorpusItem[]
  rules: { failed_items_may_be_replaced_or_removed: boolean }
}

const CORPUS_SHA256 = 'bb85300ef8df51b0d6ba2a57b5d485ea2430a65c4dc2b2030bd0fbe72cfb6a33'
const corpusPath = fileURLToPath(new URL('./fixtures/ym-10-corpus-v1.json', import.meta.url))

function expectedTags(item: FrozenCorpusItem): string[] {
  return item.acceptable_direction
    .split('；', 1)[0]
    .split('、')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function corpusAsset(item: FrozenCorpusItem): LocalAssetDto {
  const suffix = String(item.id).padStart(2, '0')
  const importedAt = `2026-07-17T00:00:${suffix}.000Z`
  return {
    id: `123e4567-e89b-42d3-a456-4266141740${suffix}`,
    displayName: `冻结语料素材 ${suffix}`,
    originalFilename: `frozen-${suffix}.png`,
    mimeType: 'image/png',
    width: 960,
    height: 720,
    sizeBytes: 1024,
    tags: expectedTags(item).map((tag) => ({
      displayValue: tag,
      normalizedValue: tag
    })),
    thumbnailUrl: `emoji-pie-local-asset://thumbnail/${suffix}`,
    rightsAssertedAt: importedAt,
    importedAt,
    updatedAt: importedAt
  }
}

describe('YM-10 frozen local relevance corpus', () => {
  it('keeps all 50 immutable cases and reaches the 40/50 product gate offline', () => {
    const corpusBytes = readFileSync(corpusPath)
    const corpus = JSON.parse(corpusBytes.toString('utf8')) as FrozenCorpus
    expect(createHash('sha256').update(corpusBytes).digest('hex')).toBe(CORPUS_SHA256)
    expect(corpus).toMatchObject({
      corpus_id: 'YM-10-Corpus-v1',
      immutable_during_validation: true,
      rules: { failed_items_may_be_replaced_or_removed: false }
    })
    expect(corpus.items.map(({ id }) => id)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1)
    )

    const index = new LocalAssetIndex()
    index.replace(corpus.items.map(corpusAsset))
    const passedIds: number[] = []
    const failedIds: number[] = []
    const cases: Array<Record<string, unknown>> = []
    for (const item of corpus.items) {
      const expected = new Set(expectedTags(item))
      const candidates = index.match(item.input).map((match) => ({
        assetId: match.asset.id,
        assetTags: match.asset.tags.map(({ displayValue }) => displayValue),
        matchedTags: match.matchedTags,
        expectedHitTags: match.asset.tags
          .map(({ displayValue }) => displayValue)
          .filter((tag) => expected.has(tag))
      }))
      const pass = candidates.some(({ expectedHitTags }) => expectedHitTags.length > 0)
      if (pass) passedIds.push(item.id)
      else failedIds.push(item.id)
      cases.push({
        id: item.id,
        mode: item.mode,
        input: item.input,
        acceptableDirection: item.acceptable_direction,
        expectedTags: [...expected],
        pass,
        candidates
      })
    }

    const report = {
      corpusId: corpus.corpus_id,
      corpusSha256: CORPUS_SHA256,
      total: corpus.items.length,
      passed: passedIds.length,
      failed: failedIds.length,
      failedIds,
      cases
    }
    if (process.env.YM10_RELEVANCE_REPORT === '1') {
      console.info(JSON.stringify({ ...report, cases: undefined }))
    }
    if (process.env.YM10_RELEVANCE_RESULT_PATH) {
      writeFileSync(
        process.env.YM10_RELEVANCE_RESULT_PATH,
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8'
      )
    }

    expect(
      passedIds.length,
      JSON.stringify({ passed: passedIds.length, failedIds })
    ).toBeGreaterThanOrEqual(40)
  })
})
