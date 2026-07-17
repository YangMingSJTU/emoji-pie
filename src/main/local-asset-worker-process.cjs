/* eslint-disable @typescript-eslint/no-require-imports */
/* global process, require */
const { createHash } = require('node:crypto')
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

process.parentPort.on('message', async ({ data }) => {
  const { jobId, filePath } = data
  try {
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
