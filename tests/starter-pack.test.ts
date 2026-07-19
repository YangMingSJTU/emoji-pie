import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StarterPackCatalog } from '../src/main/starter-pack-catalog'
import {
  StarterPackPathError,
  StarterPackPathService,
  resolveStarterPackRoot
} from '../src/main/starter-pack-paths'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const developmentPack = join(
  projectRoot,
  '.generated',
  'starter-packs',
  'starter-pack-v1'
)
const packagedRoot = mkdtempSync(join(tmpdir(), 'emoji-pie-starter-packaged-'))
const packagedPack = join(packagedRoot, 'resources', 'starter-packs', 'starter-pack-v1')

function developmentPaths(): StarterPackPathService {
  return new StarterPackPathService({
    isPackaged: false,
    resourcesPath: join(projectRoot, 'unused-resources'),
    appPath: projectRoot
  })
}

function packagedPaths(): StarterPackPathService {
  return new StarterPackPathService({
    isPackaged: true,
    resourcesPath: join(packagedRoot, 'resources'),
    appPath: join(packagedRoot, 'app.asar')
  })
}

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-starter-pack.mjs'], {
    cwd: projectRoot,
    stdio: 'pipe'
  })
  cpSync(developmentPack, packagedPack, { recursive: true })
}, 180_000)

afterAll(() => {
  rmSync(packagedRoot, { recursive: true, force: true })
})

describe('Starter Pack v1 build and read-only runtime', () => {
  it('builds and rechecks all 36 originals and thumbnails in development', async () => {
    const snapshot = await new StarterPackCatalog(developmentPaths())
      .load('starter-pack-v1', '1.0.0')
    expect(snapshot.manifest).toMatchObject({
      schemaVersion: 1,
      packId: 'starter-pack-v1',
      packVersion: '1.0.0',
      assetCount: 36,
      hashAlgorithm: 'sha256'
    })
    expect(snapshot.assets).toHaveLength(36)
    expect(snapshot.readyCount).toBe(36)
    expect(new Set(snapshot.assets.map(({ runtimeId }) => runtimeId)).size).toBe(36)
    expect(new Set(snapshot.assets.map(({ sha256 }) => sha256)).size).toBe(36)
  }, 120_000)

  it('resolves the same 36/36 catalog from the packaged resources root', async () => {
    expect(resolveStarterPackRoot({
      isPackaged: true,
      resourcesPath: join(packagedRoot, 'resources'),
      appPath: join(packagedRoot, 'app.asar')
    })).toBe(join(packagedRoot, 'resources', 'starter-packs'))
    const snapshot = await new StarterPackCatalog(packagedPaths())
      .load('starter-pack-v1', '1.0.0')
    expect(snapshot.readyCount).toBe(36)
  }, 120_000)

  it('marks a tampered original corrupt instead of returning it as ready', async () => {
    const manifest = JSON.parse(readFileSync(join(packagedPack, 'manifest.json'), 'utf8'))
    const target = join(packagedPack, manifest.assets[0].file)
    const original = readFileSync(target)
    try {
      writeFileSync(target, Buffer.from('tampered'))
      const snapshot = await new StarterPackCatalog(packagedPaths())
        .load('starter-pack-v1', '1.0.0')
      expect(snapshot.readyCount).toBe(35)
      expect(snapshot.assets[0].contentState).toBe('corrupt')
      expect(snapshot.assets[0].originalPath).toBeUndefined()
    } finally {
      writeFileSync(target, original)
    }
  }, 120_000)

  it('marks a missing original unavailable without weakening the rest of the pack', async () => {
    const manifest = JSON.parse(readFileSync(join(packagedPack, 'manifest.json'), 'utf8'))
    const target = join(packagedPack, manifest.assets[1].file)
    const missing = `${target}.missing-test`
    renameSync(target, missing)
    try {
      const snapshot = await new StarterPackCatalog(packagedPaths())
        .load('starter-pack-v1', '1.0.0')
      expect(snapshot.readyCount).toBe(35)
      expect(snapshot.assets[1].contentState).toBe('missing')
    } finally {
      renameSync(missing, target)
    }
  }, 120_000)

  it('rejects absolute, parent, backslash, and mismatched packaged paths', async () => {
    const paths = packagedPaths()
    for (const value of [
      '../manifest.json',
      'originals/../../escape.png',
      'originals\\spv1-001.png',
      resolve(packagedRoot, 'outside.png')
    ]) {
      expect(() => paths.resolvePackFile('starter-pack-v1', value)).toThrow(
        StarterPackPathError
      )
    }
    expect(() => paths.resolvePackFile('../starter-pack-v1', 'manifest.json'))
      .toThrow(StarterPackPathError)
    await expect(paths.resolveRegularPackFile(
      'starter-pack-v1',
      'originals/not-present.png'
    )).rejects.toMatchObject({ code: 'starter_pack_file_missing' })
  })
})
