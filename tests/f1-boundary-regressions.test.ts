import { execFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateApplicationDatabase } from '../src/main/database-schema'
import { deriveLocalAssetDisplayName } from '../src/main/local-asset-importer'
import {
  readWindowsExcludedLocalAssetPaths,
  selectLocalAssetDirectory
} from '../src/main/local-asset-picker'
import { isLocalImportFullyComplete } from '../src/renderer/src/lib/local-import-state'
import type {
  LocalImportFinalizeResultDto,
  LocalImportItemDto
} from '../src/shared/local-assets'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
const NOW = '2026-07-17T08:00:00.000Z'

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'emoji-pie-f1-boundary-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

function finalizeResult(
  items: LocalImportItemDto[],
  rejectedItems: LocalImportFinalizeResultDto['rejectedItems'] = []
): LocalImportFinalizeResultDto {
  return {
    session: {
      id: '123e4567-e89b-42d3-a456-426614174000',
      sourceKind: 'files',
      state: 'completed',
      items,
      rightsAssertedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW
    },
    finalizedItemIds: items.filter((item) => item.state === 'ready').map((item) => item.id),
    rejectedItems
  }
}

describe('F1 review boundary regressions', () => {
  it('preserves a 61-grapheme filename so metadata validation can block it explicitly', () => {
    expect(deriveLocalAssetDisplayName(`${'名'.repeat(60)}.png`)).toBe('名'.repeat(60))
    expect(deriveLocalAssetDisplayName(`${'名'.repeat(61)}.png`)).toBe('名'.repeat(61))
  })

  it('shows completion only when no rejected or retryable item remains', () => {
    const ready: LocalImportItemDto = {
      id: '123e4567-e89b-42d3-a456-426614174001',
      originalFilename: 'ready.png',
      state: 'ready',
      tags: []
    }
    const failed: LocalImportItemDto = {
      id: '123e4567-e89b-42d3-a456-426614174002',
      originalFilename: 'failed.png',
      state: 'failed',
      tags: [],
      error: { code: 'write_failed', message: 'failed', retryable: true }
    }
    expect(isLocalImportFullyComplete(finalizeResult([ready]))).toBe(true)
    expect(isLocalImportFullyComplete(finalizeResult([ready, failed]))).toBe(false)
    expect(isLocalImportFullyComplete(finalizeResult([failed]))).toBe(false)
    expect(isLocalImportFullyComplete(finalizeResult([ready], [{
      itemId: ready.id,
      error: { code: 'write_failed', message: 'failed', retryable: true }
    }]))).toBe(false)
  })

  it('enforces the 500-asset cap inside the database commit boundary', () => {
    const database = new DatabaseSync(':memory:')
    migrateApplicationDatabase(database)
    const insert = database.prepare(`
      INSERT INTO local_assets (
        id, display_name, normalized_name, original_filename, mime_type,
        width, height, size_bytes, content_sha256, pixel_sha256,
        source_rel_path, thumbnail_rel_path, state, rights_asserted_at,
        imported_at, updated_at
      ) VALUES (?, ?, ?, ?, 'image/png', 1, 1, 1, ?, ?, ?, ?, 'committing', ?, ?, ?)
    `)
    for (let index = 0; index < 500; index += 1) {
      const suffix = index.toString(16).padStart(12, '0')
      const id = `00000000-0000-0000-0000-${suffix}`
      insert.run(
        id,
        `素材 ${index}`,
        `素材 ${index}`,
        `${index}.png`,
        (index + 1).toString(16).padStart(64, '0'),
        (index + 1001).toString(16).padStart(64, '0'),
        `originals/${id}.png`,
        `thumbnails/${id}.webp`,
        NOW,
        NOW,
        NOW
      )
    }
    const id = '00000000-0000-0000-0000-000000000500'
    expect(() => insert.run(
      id,
      '第 501 张',
      '第 501 张',
      '501.png',
      'f'.repeat(64),
      'e'.repeat(64),
      `originals/${id}.png`,
      `thumbnails/${id}.webp`,
      NOW,
      NOW,
      NOW
    )).toThrow(/capacity reached/u)
    expect(database.prepare('SELECT COUNT(*) AS count FROM local_assets').get())
      .toEqual({ count: 500 })
    database.close()
  })

  it('fails closed when directory attribute inspection fails', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'visible.png'), 'image')
    await expect(selectLocalAssetDirectory(directory, async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })).rejects.toThrow('denied')
  })

  it('skips paths reported as hidden, system or reparse entries', async () => {
    const directory = await temporaryDirectory()
    const visible = join(directory, 'visible.png')
    const hidden = join(directory, 'hidden.png')
    await Promise.all([writeFile(visible, 'visible'), writeFile(hidden, 'hidden')])
    const selection = await selectLocalAssetDirectory(directory, async () =>
      new Set([resolve(hidden).toLowerCase()]))
    expect(selection.sources.map((source) => source.originalFilename)).toEqual(['visible.png'])
  })

  it.runIf(process.platform === 'win32')(
    'reads real Windows Hidden and System attributes before selecting directory files',
    async () => {
      const directory = await temporaryDirectory()
      const visible = join(directory, 'visible.png')
      const hidden = join(directory, 'hidden.png')
      const system = join(directory, 'system.png')
      await Promise.all([
        writeFile(visible, 'visible'),
        writeFile(hidden, 'hidden'),
        writeFile(system, 'system')
      ])
      await execFileAsync('attrib.exe', ['+H', hidden])
      await execFileAsync('attrib.exe', ['+S', system])
      try {
        const excluded = await readWindowsExcludedLocalAssetPaths(directory)
        expect(excluded.has(resolve(hidden).toLowerCase())).toBe(true)
        expect(excluded.has(resolve(system).toLowerCase())).toBe(true)
        const selection = await selectLocalAssetDirectory(directory)
        expect(selection.sources.map((source) => source.originalFilename)).toEqual(['visible.png'])
      } finally {
        await execFileAsync('attrib.exe', ['-H', hidden])
        await execFileAsync('attrib.exe', ['-S', system])
      }
    }
  )
})
