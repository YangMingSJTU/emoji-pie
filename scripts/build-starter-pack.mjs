import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { load as parseYaml } from 'js-yaml'
import sharp from 'sharp'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SOURCE = join(projectRoot, 'assets', 'starter-pack-v1')
const DEFAULT_OUTPUT = join(projectRoot, '.generated', 'starter-packs', 'starter-pack-v1')
const EXPECTED_ASSET_COUNT = 36
const EXPECTED_WIDTH = 1254
const EXPECTED_HEIGHT = 1254
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const ASSET_KEY_PATTERN = /^SPV1-\d{3}$/
const SOURCE_FILE_PATTERN = /^spv1-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.png$/

function fail(message) {
  throw new Error(`Starter Pack build rejected: ${message}`)
}

function parseArguments(argv) {
  const options = { source: DEFAULT_SOURCE, output: DEFAULT_OUTPUT }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument !== '--source' && argument !== '--output') fail(`unknown argument ${argument}`)
    const value = argv[index + 1]
    if (!value) fail(`missing value for ${argument}`)
    options[argument.slice(2)] = resolve(value)
    index += 1
  }
  return options
}

function assertBuildOutput(output, packId) {
  if (basename(output) !== packId || basename(dirname(output)) !== 'starter-packs') {
    fail('output must end with starter-packs/<pack_id>')
  }
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

function string(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`)
  return value.trim()
}

function integer(value, label) {
  if (!Number.isInteger(value)) fail(`${label} must be an integer`)
  return value
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function validateRuntimeIds(value, packId, keys) {
  const root = record(value, 'runtime-ids.json')
  if (root.schemaVersion !== 1 || root.packId !== packId) fail('runtime ID header mismatch')
  const assets = record(root.assets, 'runtime ID assets')
  if (Object.keys(assets).length !== EXPECTED_ASSET_COUNT) fail('runtime ID count must be 36')
  const ids = new Set()
  const result = new Map()
  for (const key of keys) {
    const id = assets[key]
    if (typeof id !== 'string' || !UUID_PATTERN.test(id) || ids.has(id)) {
      fail(`invalid or duplicate runtime ID for ${key}`)
    }
    ids.add(id)
    result.set(key, id)
  }
  if (Object.keys(assets).some((key) => !keys.has(key))) fail('runtime IDs contain an unknown key')
  return result
}

async function validateSource(source) {
  const manifestPath = join(source, 'manifest.yaml')
  const manifestBytes = await readFile(manifestPath)
  const manifest = record(parseYaml(manifestBytes.toString('utf8')), 'manifest')
  if (manifest.schema_version !== 1) fail('manifest schema_version must be 1')
  const packId = string(manifest.pack_id, 'pack_id')
  const packVersion = string(manifest.pack_version, 'pack_version')
  const title = string(manifest.title, 'title')
  if (packId !== 'starter-pack-v1' || packVersion !== '1.0.0') fail('pack identity mismatch')
  if (manifest.asset_count !== EXPECTED_ASSET_COUNT) fail('asset_count must be 36')
  if (manifest.categories !== 12 || manifest.assets_per_category !== 3) {
    fail('category shape must be 12 categories with 3 assets each')
  }
  if (manifest.validation?.rights_coverage !== '36/36') fail('rights coverage must be 36/36')
  if (manifest.validation?.final_file_count !== EXPECTED_ASSET_COUNT) {
    fail('validation final_file_count must be 36')
  }
  if (manifest.validation?.rights_rows !== EXPECTED_ASSET_COUNT) {
    fail('validation rights_rows must be 36')
  }
  const rights = record(manifest.rights_record, 'rights_record')
  if (
    rights.source_type !== 'team_original' ||
    rights.third_party_source_assets !== false ||
    rights.third_party_templates !== false
  ) {
    fail('rights record is not the frozen team-original policy')
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== EXPECTED_ASSET_COUNT) {
    fail('manifest assets must contain exactly 36 entries')
  }

  const listedFiles = new Set()
  const keys = new Set()
  const hashes = new Set()
  const validated = []
  for (const rawAsset of manifest.assets) {
    const asset = record(rawAsset, 'asset')
    const packAssetKey = string(asset.id, 'asset id')
    const file = string(asset.file, `${packAssetKey} file`)
    if (!ASSET_KEY_PATTERN.test(packAssetKey) || keys.has(packAssetKey)) {
      fail(`invalid or duplicate asset key ${packAssetKey}`)
    }
    if (!SOURCE_FILE_PATTERN.test(file) || listedFiles.has(file)) {
      fail(`invalid or duplicate source file ${file}`)
    }
    if (asset.rights !== 'rights_record') fail(`${packAssetKey} has no rights_record link`)
    if (!Array.isArray(asset.tags) || asset.tags.length < 1 || asset.tags.length > 12) {
      fail(`${packAssetKey} must have 1-12 tags`)
    }
    const declaredBytes = integer(asset.bytes, `${packAssetKey} bytes`)
    const declaredHash = string(asset.sha256, `${packAssetKey} sha256`)
    if (!SHA256_PATTERN.test(declaredHash) || hashes.has(declaredHash)) {
      fail(`${packAssetKey} has an invalid or duplicate SHA-256`)
    }
    const sourcePath = join(source, file)
    const sourceStat = await stat(sourcePath)
    if (!sourceStat.isFile() || sourceStat.size !== declaredBytes) {
      fail(`${packAssetKey} byte size mismatch`)
    }
    if (await sha256(sourcePath) !== declaredHash) fail(`${packAssetKey} SHA-256 mismatch`)
    const metadata = await sharp(sourcePath, { failOn: 'error' }).metadata()
    if (metadata.format !== 'png' || metadata.width !== EXPECTED_WIDTH || metadata.height !== EXPECTED_HEIGHT) {
      fail(`${packAssetKey} must be a ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT} PNG`)
    }
    keys.add(packAssetKey)
    listedFiles.add(file)
    hashes.add(declaredHash)
    validated.push({
      packAssetKey,
      file,
      displayName: string(asset.name, `${packAssetKey} name`),
      category: string(asset.category, `${packAssetKey} category`),
      tags: asset.tags.map((tag) => string(tag, `${packAssetKey} tag`)),
      sizeBytes: declaredBytes,
      sha256: declaredHash
    })
  }

  const sourceNames = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  const expectedNames = [
    'manifest.yaml',
    'prompts.yaml',
    'runtime-ids.json',
    ...listedFiles
  ].sort()
  if (JSON.stringify(sourceNames) !== JSON.stringify(expectedNames)) {
    fail('source directory has missing or extra files')
  }
  const runtimeIds = validateRuntimeIds(
    JSON.parse(await readFile(join(source, 'runtime-ids.json'), 'utf8')),
    packId,
    keys
  )
  const promptRecord = record(
    parseYaml(await readFile(join(source, 'prompts.yaml'), 'utf8')),
    'prompts.yaml'
  )
  if (
    promptRecord.schema_version !== 1 ||
    promptRecord.pack_id !== packId ||
    !Array.isArray(promptRecord.reference_images) ||
    promptRecord.reference_images.length !== 0 ||
    !Array.isArray(promptRecord.third_party_assets) ||
    promptRecord.third_party_assets.length !== 0 ||
    !Array.isArray(promptRecord.prompts) ||
    promptRecord.prompts.length !== EXPECTED_ASSET_COUNT
  ) {
    fail('prompt provenance header or count is invalid')
  }
  const promptKeys = new Set()
  for (const rawPrompt of promptRecord.prompts) {
    const prompt = record(rawPrompt, 'prompt')
    const id = string(prompt.id, 'prompt id')
    const asset = validated.find((candidate) => candidate.packAssetKey === id)
    if (
      !asset ||
      promptKeys.has(id) ||
      string(prompt.title, `${id} prompt title`) !== asset.displayName ||
      string(prompt.scene, `${id} prompt scene`).length < 12
    ) {
      fail(`prompt provenance mismatch for ${id}`)
    }
    promptKeys.add(id)
  }
  return {
    packId,
    packVersion,
    title,
    generatedFromSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    runtimeIds,
    assets: validated
  }
}

async function buildPack(source, output) {
  const validated = await validateSource(source)
  assertBuildOutput(output, validated.packId)
  const temporaryOutput = `${output}.tmp-${randomUUID()}`
  await rm(temporaryOutput, { recursive: true, force: true })
  await mkdir(join(temporaryOutput, 'originals'), { recursive: true })
  await mkdir(join(temporaryOutput, 'thumbnails'), { recursive: true })
  try {
    const runtimeAssets = []
    for (const asset of validated.assets) {
      const originalFile = `originals/${asset.file}`
      const thumbnailName = asset.file.replace(/\.png$/u, '.webp')
      const thumbnailFile = `thumbnails/${thumbnailName}`
      const originalPath = join(temporaryOutput, originalFile)
      const thumbnailPath = join(temporaryOutput, thumbnailFile)
      await copyFile(join(source, asset.file), originalPath)
      await sharp(join(source, asset.file), { failOn: 'error' })
        .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, effort: 6 })
        .toFile(thumbnailPath)
      const thumbnailStat = await stat(thumbnailPath)
      runtimeAssets.push({
        runtimeId: validated.runtimeIds.get(asset.packAssetKey),
        packAssetKey: asset.packAssetKey,
        file: originalFile,
        thumbnailFile,
        displayName: asset.displayName,
        category: asset.category,
        tags: asset.tags,
        mimeType: 'image/png',
        width: EXPECTED_WIDTH,
        height: EXPECTED_HEIGHT,
        sizeBytes: asset.sizeBytes,
        sha256: asset.sha256,
        thumbnailBytes: thumbnailStat.size,
        thumbnailSha256: await sha256(thumbnailPath)
      })
    }
    const runtimeManifest = {
      schemaVersion: 1,
      packId: validated.packId,
      packVersion: validated.packVersion,
      title: validated.title,
      generatedFromSha256: validated.generatedFromSha256,
      assetCount: EXPECTED_ASSET_COUNT,
      hashAlgorithm: 'sha256',
      assets: runtimeAssets
    }
    await writeFile(
      join(temporaryOutput, 'manifest.json'),
      `${JSON.stringify(runtimeManifest, null, 2)}\n`,
      'utf8'
    )
    await rm(output, { recursive: true, force: true })
    await mkdir(dirname(output), { recursive: true })
    await rename(temporaryOutput, output)
    return {
      packId: validated.packId,
      packVersion: validated.packVersion,
      assetCount: runtimeAssets.length,
      manifestSha256: await sha256(join(output, 'manifest.json')),
      output
    }
  } catch (error) {
    await rm(temporaryOutput, { recursive: true, force: true })
    throw error
  }
}

const options = parseArguments(process.argv.slice(2))
const result = await buildPack(options.source, options.output)
process.stdout.write(`${JSON.stringify(result)}\n`)
