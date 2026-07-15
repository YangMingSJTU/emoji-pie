import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clipboard, nativeImage } from 'electron'
import type { ProbeClipboard, ProbeExporter } from './contracts'

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export class ElectronClipboardProbe implements ProbeClipboard {
  async writeAndVerify(png: Buffer): Promise<{ bytes: number; sha256: string }> {
    const image = nativeImage.createFromBuffer(png)
    if (image.isEmpty()) throw new Error('clipboard_image_invalid')
    clipboard.writeImage(image)
    const readBack = clipboard.readImage().toPNG()
    if (readBack.byteLength === 0) throw new Error('clipboard_readback_empty')
    return { bytes: readBack.byteLength, sha256: sha256(readBack) }
  }
}

export class FileExportProbe implements ProbeExporter {
  constructor(private readonly outputDirectory: string) {}

  async writeAndVerify(png: Buffer): Promise<{ bytes: number; sha256: string }> {
    await mkdir(this.outputDirectory, { recursive: true })
    const expectedHash = sha256(png)
    const outputPath = join(this.outputDirectory, `candidate-${expectedHash}.png`)
    await writeFile(outputPath, png, { flag: 'w' })
    const readBack = await readFile(outputPath)
    const actualHash = sha256(readBack)
    if (actualHash !== expectedHash) throw new Error('export_hash_mismatch')
    return { bytes: readBack.byteLength, sha256: actualHash }
  }
}
