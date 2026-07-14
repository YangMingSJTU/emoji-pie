import { readFile } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import sharp from 'sharp'

const source = new URL('../assets/icon.svg', import.meta.url)
const output = new URL('../assets/icon.png', import.meta.url)
const svg = await readFile(source)

await sharp(svg)
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toFile(fileURLToPath(output))
