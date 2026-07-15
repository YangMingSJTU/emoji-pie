import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import { MAX_LOCAL_IMAGE_BYTES } from './constants'

export type LocalImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface LocalImageInput {
  bytes: Buffer
  mediaType: LocalImageMediaType
  extension: '.png' | '.jpg' | '.jpeg' | '.webp'
}

const EXTENSION_MEDIA_TYPE: Readonly<Record<LocalImageInput['extension'], LocalImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

function detectMediaType(bytes: Buffer): LocalImageMediaType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function normalizeDeclaredMediaType(value: string): LocalImageMediaType | null {
  const normalized = value.split(';', 1)[0].trim().toLowerCase()
  return ['image/png', 'image/jpeg', 'image/webp'].includes(normalized)
    ? normalized as LocalImageMediaType
    : null
}

export async function importLocalImage(
  path: string,
  declaredMediaType: string
): Promise<LocalImageInput> {
  const extension = extname(path).toLowerCase() as LocalImageInput['extension']
  const extensionMediaType = EXTENSION_MEDIA_TYPE[extension]
  if (!extensionMediaType) throw new Error('local_image_extension_rejected')
  const declared = normalizeDeclaredMediaType(declaredMediaType)
  if (!declared) throw new Error('local_image_declared_mime_rejected')
  if (declared !== extensionMediaType) throw new Error('local_image_type_mismatch')

  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('local_image_not_regular_file')
    if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_LOCAL_IMAGE_BYTES) {
      throw new Error('local_image_size_rejected')
    }

    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    if (offset !== bytes.byteLength) throw new Error('local_image_changed_during_read')
    const sentinel = Buffer.alloc(1)
    if ((await handle.read(sentinel, 0, 1, offset)).bytesRead !== 0) {
      throw new Error('local_image_changed_during_read')
    }

    const detected = detectMediaType(bytes)
    if (!detected) throw new Error('local_image_magic_rejected')
    if (detected !== extensionMediaType || detected !== declared) {
      throw new Error('local_image_type_mismatch')
    }
    return { bytes, mediaType: detected, extension }
  } finally {
    await handle.close()
  }
}
