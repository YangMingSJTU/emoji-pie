/* eslint-disable @typescript-eslint/no-require-imports */
/* global Buffer, process, require */
const { createHash } = require('node:crypto')
const { readFile } = require('node:fs/promises')
const sharp = require('sharp')

const MAX_EDGE = 8192
const MAX_PIXELS = 40000000

function fail(code, message) {
  const error = new Error(message)
  error.localAssetCode = code
  throw error
}

function mimeForFormat(format) {
  if (format === 'png') return 'image/png'
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  fail('unsupported_type', '只支持 PNG、JPEG 与静态 WebP')
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function captionOverlay(caption) {
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(caption)]
    .map(({ segment }) => segment)
  const fontSize = segments.length <= 20 ? 48 : segments.length <= 60 ? 38 : 30
  const charsPerLine = fontSize === 48 ? 12 : fontSize === 38 ? 16 : 18
  const lines = []
  for (let index = 0; index < segments.length; index += charsPerLine) {
    lines.push(segments.slice(index, index + charsPerLine).join(''))
  }
  const lineHeight = Math.ceil(fontSize * 1.3)
  const bandHeight = Math.max(112, lines.length * lineHeight + 44)
  const top = 640 - bandHeight
  const tspans = lines.map((line, index) =>
    `<tspan x="320" y="${top + 28 + fontSize + index * lineHeight}">${escapeXml(line)}</tspan>`
  ).join('')
  return Buffer.from(
    `<svg width="640" height="640" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="${top}" width="640" height="${bandHeight}" fill="#000" fill-opacity="0.72"/>` +
    `<text text-anchor="middle" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" ` +
    `font-size="${fontSize}" font-weight="700" fill="#fff">${tspans}</text></svg>`
  )
}

process.parentPort.on('message', async ({ data }) => {
  const {
    jobId, filePath, operation = 'inspect', caption = '', embedCaption = false, variant = 0
  } = data
  try {
    if (process.env.EMOJI_PIE_LOCAL_ASSET_WORKER_TEST_MODE === '1') {
      const marker = await readFile(filePath, 'utf8').catch(() => '')
      if (marker.startsWith('YM10_HANG')) return
      if (marker.startsWith('YM10_CRASH')) {
        process.exit(17)
        return
      }
    }
    if (operation === 'render-poster') {
      const positions = ['centre', 'north', 'south', 'east', 'west']
      let pipeline = sharp(filePath, {
        animated: false,
        failOn: 'error',
        limitInputPixels: MAX_PIXELS
      }).rotate().resize(640, 640, {
        fit: 'cover',
        position: positions[Math.abs(variant) % positions.length]
      })
      if (embedCaption && caption) {
        pipeline = pipeline.composite([{ input: captionOverlay(caption), top: 0, left: 0 }])
      }
      const poster = await pipeline.png({ compressionLevel: 9 }).toBuffer()
      process.parentPort.postMessage({ jobId, ok: true, poster })
      return
    }
    const metadata = await sharp(filePath, {
      animated: true,
      failOn: 'error',
      limitInputPixels: MAX_PIXELS + 1
    }).metadata()
    const width = metadata.autoOrient?.width ?? metadata.width
    const height = metadata.autoOrient?.height ?? metadata.height
    if (!width || !height) fail('invalid_image', '无法读取图片尺寸')
    if ((metadata.pages ?? 1) > 1) fail('animated_image_rejected', '不支持动画图片')
    if (width > MAX_EDGE || height > MAX_EDGE) {
      fail('dimensions_too_large', '图片单边尺寸超过 8192 像素')
    }
    if (width * height > MAX_PIXELS) {
      fail('decoded_pixels_too_large', '图片解码像素超过 4000 万')
    }
    const mimeType = mimeForFormat(metadata.format)
    const rawResult = await sharp(filePath, {
      animated: false,
      failOn: 'error',
      limitInputPixels: MAX_PIXELS
    }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const pixelSha256 = createHash('sha256')
      .update(String(rawResult.info.width))
      .update('x')
      .update(String(rawResult.info.height))
      .update('\0')
      .update(rawResult.data)
      .digest('hex')
    const thumbnail = await sharp(filePath, {
      animated: false,
      failOn: 'error',
      limitInputPixels: MAX_PIXELS
    }).rotate().resize(320, 320, {
      fit: 'cover',
      position: 'centre',
      withoutEnlargement: false
    }).webp({ quality: 82, effort: 4 }).toBuffer()
    process.parentPort.postMessage({
      jobId,
      ok: true,
      value: { mimeType, width, height, pixelSha256, thumbnail }
    })
  } catch (error) {
    process.parentPort.postMessage({
      jobId,
      ok: false,
      code: error?.localAssetCode ?? 'invalid_image',
      message: error instanceof Error ? error.message : '图片处理失败'
    })
  }
})
