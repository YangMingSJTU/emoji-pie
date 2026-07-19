import { countGraphemes, normalizeLocalAssetId, normalizeLocalAssetText } from './local-assets'

export const MATERIAL_SELECTION_STATE_VERSION = 1 as const
export const MATERIAL_SELECTION_DRAFT_LIMIT = 9
export const MATERIAL_SELECTION_PREFERENCE_KEY = 'material-selection-state-v1'

export type AssetSource = 'user' | 'starter_pack'
export type AssetContentState = 'ready' | 'corrupt' | 'missing'
export type MaterialSelectionMode = 'automatic' | 'manual'
export type AutoScope = 'all' | 'user_only' | 'starter_only'

export interface MaterialSelectionDraftItem {
  assetId: string
  nameSnapshot: string
  source: AssetSource
  packId?: string
  packVersion?: string
  packAssetKey?: string
}

export interface MaterialSelectionState {
  version: typeof MATERIAL_SELECTION_STATE_VERSION
  mode: MaterialSelectionMode
  autoScope: AutoScope
  manualDraft: MaterialSelectionDraftItem[]
  updatedAt: string
}

export type MaterialSelectionStateInput = Omit<MaterialSelectionState, 'version' | 'updatedAt'>

export interface StarterPackRuntimeAsset {
  runtimeId: string
  packAssetKey: string
  file: string
  thumbnailFile: string
  displayName: string
  category: string
  tags: string[]
  mimeType: 'image/png'
  width: number
  height: number
  sizeBytes: number
  sha256: string
  thumbnailBytes: number
  thumbnailSha256: string
}

export interface StarterPackRuntimeManifest {
  schemaVersion: 1
  packId: string
  packVersion: string
  title: string
  generatedFromSha256: string
  assetCount: 36
  hashAlgorithm: 'sha256'
  assets: StarterPackRuntimeAsset[]
}

export const STARTER_PACK_ERROR_CODES = [
  'starter_pack_manifest_invalid',
  'starter_pack_path_invalid',
  'starter_pack_path_escape',
  'starter_pack_file_missing',
  'starter_pack_file_not_regular',
  'starter_pack_file_corrupt'
] as const

export type StarterPackErrorCode = (typeof STARTER_PACK_ERROR_CODES)[number]
export const MATERIAL_SELECTION_ERROR_CODES = [
  'invalid_selection_state',
  'selection_state_write_failed'
] as const
export type MaterialSelectionErrorCode = (typeof MATERIAL_SELECTION_ERROR_CODES)[number]

const PACK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PACK_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const PACK_ASSET_KEY_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const ORIGINAL_FILE_PATTERN = /^originals\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/
const THUMBNAIL_FILE_PATTERN = /^thumbnails\/[a-z0-9]+(?:-[a-z0-9]+)*\.webp$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
}

function normalizedSnapshotName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.normalize('NFKC').trim()
  const length = countGraphemes(normalized)
  return length >= 1 && length <= 60 ? normalized : undefined
}

export function createDefaultMaterialSelectionState(now: string): MaterialSelectionState {
  return {
    version: MATERIAL_SELECTION_STATE_VERSION,
    mode: 'automatic',
    autoScope: 'starter_only',
    manualDraft: [],
    updatedAt: now
  }
}

export function normalizeMaterialSelectionState(
  value: unknown
): MaterialSelectionState | undefined {
  if (!isRecord(value) || value.version !== MATERIAL_SELECTION_STATE_VERSION) return undefined
  if (value.mode !== 'automatic' && value.mode !== 'manual') return undefined
  if (value.autoScope !== 'all' && value.autoScope !== 'user_only' && value.autoScope !== 'starter_only') {
    return undefined
  }
  if (!Array.isArray(value.manualDraft) || value.manualDraft.length > MATERIAL_SELECTION_DRAFT_LIMIT) {
    return undefined
  }
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    return undefined
  }

  const ids = new Set<string>()
  const manualDraft: MaterialSelectionDraftItem[] = []
  for (const item of value.manualDraft) {
    if (!isRecord(item)) return undefined
    const assetId = typeof item.assetId === 'string'
      ? normalizeLocalAssetId(item.assetId)
      : undefined
    const nameSnapshot = normalizedSnapshotName(item.nameSnapshot)
    if (!assetId || !nameSnapshot || ids.has(assetId)) return undefined
    ids.add(assetId)
    if (item.source === 'user') {
      if (item.packId !== undefined || item.packVersion !== undefined || item.packAssetKey !== undefined) {
        return undefined
      }
      manualDraft.push({ assetId, nameSnapshot, source: 'user' })
      continue
    }
    if (
      item.source !== 'starter_pack' ||
      typeof item.packId !== 'string' || !PACK_ID_PATTERN.test(item.packId) ||
      typeof item.packVersion !== 'string' || !PACK_VERSION_PATTERN.test(item.packVersion) ||
      typeof item.packAssetKey !== 'string' || !PACK_ASSET_KEY_PATTERN.test(item.packAssetKey)
    ) {
      return undefined
    }
    manualDraft.push({
      assetId,
      nameSnapshot,
      source: 'starter_pack',
      packId: item.packId,
      packVersion: item.packVersion,
      packAssetKey: item.packAssetKey
    })
  }

  return {
    version: MATERIAL_SELECTION_STATE_VERSION,
    mode: value.mode,
    autoScope: value.autoScope,
    manualDraft,
    updatedAt: value.updatedAt
  }
}

export function normalizeStarterPackRuntimeManifest(
  value: unknown
): StarterPackRuntimeManifest | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  if (!hasExactKeys(value, [
    'schemaVersion',
    'packId',
    'packVersion',
    'title',
    'generatedFromSha256',
    'assetCount',
    'hashAlgorithm',
    'assets'
  ])) return undefined
  if (typeof value.packId !== 'string' || !PACK_ID_PATTERN.test(value.packId)) return undefined
  if (typeof value.packVersion !== 'string' || !PACK_VERSION_PATTERN.test(value.packVersion)) {
    return undefined
  }
  if (typeof value.title !== 'string' || value.title.trim().length === 0) return undefined
  if (typeof value.generatedFromSha256 !== 'string' || !SHA256_PATTERN.test(value.generatedFromSha256)) {
    return undefined
  }
  if (value.assetCount !== 36 || value.hashAlgorithm !== 'sha256') return undefined
  if (!Array.isArray(value.assets) || value.assets.length !== 36) return undefined

  const runtimeIds = new Set<string>()
  const assetKeys = new Set<string>()
  const files = new Set<string>()
  const thumbnailFiles = new Set<string>()
  const assets: StarterPackRuntimeAsset[] = []
  for (const asset of value.assets) {
    if (!isRecord(asset)) return undefined
    if (!hasExactKeys(asset, [
      'runtimeId',
      'packAssetKey',
      'file',
      'thumbnailFile',
      'displayName',
      'category',
      'tags',
      'mimeType',
      'width',
      'height',
      'sizeBytes',
      'sha256',
      'thumbnailBytes',
      'thumbnailSha256'
    ])) return undefined
    const runtimeId = typeof asset.runtimeId === 'string'
      ? normalizeLocalAssetId(asset.runtimeId)
      : undefined
    if (!runtimeId || runtimeIds.has(runtimeId)) return undefined
    if (
      typeof asset.packAssetKey !== 'string' ||
      !PACK_ASSET_KEY_PATTERN.test(asset.packAssetKey) ||
      assetKeys.has(asset.packAssetKey)
    ) {
      return undefined
    }
    if (typeof asset.file !== 'string' || !ORIGINAL_FILE_PATTERN.test(asset.file) || files.has(asset.file)) {
      return undefined
    }
    if (
      typeof asset.thumbnailFile !== 'string' ||
      !THUMBNAIL_FILE_PATTERN.test(asset.thumbnailFile) ||
      thumbnailFiles.has(asset.thumbnailFile)
    ) {
      return undefined
    }
    if (
      typeof asset.displayName !== 'string' ||
      countGraphemes(asset.displayName.trim()) < 1 ||
      countGraphemes(asset.displayName.trim()) > 60
    ) {
      return undefined
    }
    if (typeof asset.category !== 'string' || !PACK_ID_PATTERN.test(asset.category.replaceAll('_', '-'))) {
      return undefined
    }
    if (
      !Array.isArray(asset.tags) || asset.tags.length < 1 || asset.tags.length > 12 ||
      asset.tags.some((tag) => typeof tag !== 'string' || normalizeLocalAssetText(tag).length === 0) ||
      new Set(asset.tags.map((tag) => normalizeLocalAssetText(tag as string))).size !==
        asset.tags.length
    ) {
      return undefined
    }
    if (
      asset.mimeType !== 'image/png' ||
      asset.width !== 1254 ||
      asset.height !== 1254 ||
      !Number.isInteger(asset.sizeBytes) || (asset.sizeBytes as number) <= 0 ||
      typeof asset.sha256 !== 'string' || !SHA256_PATTERN.test(asset.sha256) ||
      !Number.isInteger(asset.thumbnailBytes) || (asset.thumbnailBytes as number) <= 0 ||
      typeof asset.thumbnailSha256 !== 'string' || !SHA256_PATTERN.test(asset.thumbnailSha256)
    ) {
      return undefined
    }
    runtimeIds.add(runtimeId)
    assetKeys.add(asset.packAssetKey)
    files.add(asset.file)
    thumbnailFiles.add(asset.thumbnailFile)
    assets.push({
      runtimeId,
      packAssetKey: asset.packAssetKey,
      file: asset.file,
      thumbnailFile: asset.thumbnailFile,
      displayName: asset.displayName.trim(),
      category: asset.category,
      tags: asset.tags.map((tag) => (tag as string).normalize('NFKC').trim()),
      mimeType: 'image/png',
      width: asset.width as number,
      height: asset.height as number,
      sizeBytes: asset.sizeBytes as number,
      sha256: asset.sha256,
      thumbnailBytes: asset.thumbnailBytes as number,
      thumbnailSha256: asset.thumbnailSha256
    })
  }

  return {
    schemaVersion: 1,
    packId: value.packId,
    packVersion: value.packVersion,
    title: value.title.trim(),
    generatedFromSha256: value.generatedFromSha256,
    assetCount: 36,
    hashAlgorithm: 'sha256',
    assets
  }
}
