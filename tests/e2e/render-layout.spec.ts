import { mkdirSync } from 'node:fs'
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import type { DesktopApi } from '../../src/shared/types'

interface ImageMetrics {
  width: number
  height: number
  cornerAlpha: number[]
  lowerOpaquePixels: number
  captionBandOpaquePixels: number
  centerAlpha: number
}

async function readImageMetrics(image: Locator): Promise<ImageMetrics> {
  return image.evaluate(async (element) => {
    const target = element as HTMLImageElement
    if (!target.complete) {
      await new Promise<void>((resolve, reject) => {
        target.addEventListener('load', () => resolve(), { once: true })
        target.addEventListener('error', () => reject(new Error('image failed to load')), {
          once: true
        })
      })
    }
    const canvas = document.createElement('canvas')
    canvas.width = target.naturalWidth
    canvas.height = target.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D unavailable')
    context.drawImage(target, 0, 0)
    const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)
    const alphaAt = (x: number, y: number) => data[(y * width + x) * 4 + 3] ?? 0
    let lowerOpaquePixels = 0
    let captionBandOpaquePixels = 0
    const lowerStart = Math.floor(height * 0.94)
    for (let y = lowerStart; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (alphaAt(x, y) > 12) lowerOpaquePixels += 1
      }
    }
    for (let y = Math.floor(height * 0.77); y < Math.floor(height * 0.97); y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (alphaAt(x, y) > 12) captionBandOpaquePixels += 1
      }
    }
    return {
      width,
      height,
      cornerAlpha: [
        alphaAt(0, 0),
        alphaAt(width - 1, 0),
        alphaAt(0, height - 1),
        alphaAt(width - 1, height - 1)
      ],
      lowerOpaquePixels,
      captionBandOpaquePixels,
      centerAlpha: alphaAt(Math.floor(width / 2), Math.floor(height / 2))
    }
  })
}

async function generate(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: '生成一组' })
  await button.click()
  await expect(page.getByRole('button', { name: '正在创作' })).toBeVisible()
  await expect(page.getByRole('button', { name: '生成一组' })).toBeVisible()
  await expect.poll(() => page.getByTestId('emoji-card').count()).toBeGreaterThanOrEqual(9)
}

test('renders, persists and restores compact and poster layouts', async () => {
  const testInfo = test.info()
  const userDataPath = testInfo.outputPath('user-data')
  mkdirSync(userDataPath, { recursive: true })
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      EMOJI_PIE_USER_DATA: userDataPath
    }
  })

  try {
    const page = await electronApp.firstWindow()
    await page.setViewportSize({ width: 1320, height: 860 })
    await expect(page.getByRole('heading', { name: '把这句话做成表情' })).toBeVisible()
    await expect(page.getByRole('radio', { name: '小黄脸' })).toBeChecked()
    await expect(page.getByLabel('图片内文字')).not.toBeChecked()
    const initialEffectPreviewBox = await page.getByTestId('effect-preview-art').boundingBox()
    expect(initialEffectPreviewBox?.width).toBeGreaterThanOrEqual(128)
    expect(initialEffectPreviewBox?.height).toBeGreaterThanOrEqual(128)

    await page.getByLabel('表情文案').fill('今天又要加班')
    await page.getByRole('radio', { name: '社畜打工' }).click()
    await generate(page)

    const compactCard = page.getByTestId('emoji-card').first()
    await expect(compactCard).toHaveAttribute('data-layout', 'compact')
    const compactMetrics = await readImageMetrics(compactCard.locator('img'))
    expect(compactMetrics).toMatchObject({
      width: 256,
      height: 256,
      cornerAlpha: [0, 0, 0, 0]
    })
    expect(compactMetrics.centerAlpha).toBeGreaterThan(200)
    expect(compactMetrics.lowerOpaquePixels).toBe(0)
    await page.screenshot({ path: testInfo.outputPath('compact-no-caption.png'), fullPage: true })

    await page.getByLabel('图片内文字').check()
    await generate(page)
    const captionMetrics = await readImageMetrics(page.getByTestId('emoji-card').first().locator('img'))
    expect(captionMetrics.width).toBe(256)
    expect(captionMetrics.cornerAlpha).toEqual([0, 0, 0, 0])
    expect(captionMetrics.captionBandOpaquePixels).toBeGreaterThan(100)
    await page.screenshot({ path: testInfo.outputPath('compact-with-caption.png'), fullPage: true })

    await page.getByRole('radio', { name: '表情海报' }).click()
    await generate(page)
    const posterMetrics = await readImageMetrics(page.getByTestId('emoji-card').first().locator('img'))
    expect(posterMetrics).toMatchObject({
      width: 640,
      height: 640,
      cornerAlpha: [255, 255, 255, 255]
    })

    await page.getByLabel('图片内文字').uncheck()
    await generate(page)
    const latest = await page.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { emojiPie: DesktopApi }).emojiPie
      return (await api.library.list())[0]
    })
    expect(latest).toMatchObject({ layout: 'poster', embedCaption: false })
    await page.screenshot({ path: testInfo.outputPath('poster-no-caption.png'), fullPage: true })

    await page.reload()
    await expect(page.getByRole('heading', { name: '把这句话做成表情' })).toBeVisible()
    await expect(page.getByRole('radio', { name: '表情海报' })).toBeChecked()
    await expect(page.getByLabel('图片内文字')).not.toBeChecked()

    await page.getByRole('radio', { name: '小黄脸' }).click()
    await page.getByLabel('图片内文字').check()
    await page.getByRole('button', { name: '最近生成' }).click()
    await page.getByTestId('emoji-card').first().getByRole('button', { name: '再次创作' }).click()
    await expect(page.getByRole('radio', { name: '表情海报' })).toBeChecked()
    await expect(page.getByLabel('图片内文字')).not.toBeChecked()

    await page.setViewportSize({ width: 960, height: 640 })
    await expect(page.getByRole('radio', { name: '表情海报' })).toBeVisible()
    await expect(page.getByLabel('图片内文字')).toBeVisible()
    await expect(page.getByRole('radiogroup', { name: '表情效果' }).getByRole('radio'))
      .toHaveCount(8)
    const compactEffectPreviewBox = await page.getByTestId('effect-preview-art').boundingBox()
    expect(compactEffectPreviewBox?.width).toBeGreaterThanOrEqual(128)
    expect(compactEffectPreviewBox?.height).toBeGreaterThanOrEqual(128)
    const generateButtonBox = await page.getByRole('button', { name: '生成一组' }).boundingBox()
    expect(generateButtonBox).not.toBeNull()
    expect((generateButtonBox?.y ?? 640) + (generateButtonBox?.height ?? 1))
      .toBeLessThanOrEqual(640)
    expect(await page.evaluate(
      () => document.documentElement.scrollWidth <= globalThis.innerWidth
    )).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('render-controls-compact-window.png'), fullPage: true })
  } finally {
    await electronApp.close()
  }
})
