import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { SharpLocalAssetWorkerPool } from '../src/main/local-asset-worker'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'emoji-pie-worker-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('SharpLocalAssetWorkerPool', () => {
  it('decodes in the fixed two-worker pool and emits a deterministic 320px thumbnail', async () => {
    const directory = await temporaryDirectory()
    const imagePath = join(directory, 'fixture.png')
    await sharp({
      create: { width: 48, height: 32, channels: 4, background: '#ffcc55' }
    }).png().toFile(imagePath)
    const workers = new SharpLocalAssetWorkerPool()
    try {
      const first = await workers.process(imagePath)
      const second = await workers.process(imagePath)
      expect(first).toMatchObject({ mimeType: 'image/png', width: 48, height: 32 })
      expect(second.pixelSha256).toBe(first.pixelSha256)
      expect(first.pixelSha256).toMatch(/^[0-9a-f]{64}$/u)
      expect(await sharp(first.thumbnail).metadata()).toMatchObject({
        format: 'webp', width: 320, height: 320
      })
    } finally {
      await workers.dispose()
    }
  })

  it('fails closed on corrupt input and keeps the pool usable', async () => {
    const directory = await temporaryDirectory()
    const corruptPath = join(directory, 'corrupt.png')
    const validPath = join(directory, 'valid.png')
    await writeFile(corruptPath, 'not-an-image')
    await sharp({
      create: { width: 12, height: 12, channels: 4, background: '#336699' }
    }).png().toFile(validPath)
    const workers = new SharpLocalAssetWorkerPool()
    try {
      await expect(workers.process(corruptPath)).rejects.toMatchObject({
        code: 'invalid_image'
      })
      await expect(workers.process(validPath)).resolves.toMatchObject({ mimeType: 'image/png' })
    } finally {
      await workers.dispose()
    }
  })
})
