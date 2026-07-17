import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { _electron as electron, expect, test } from '@playwright/test'
import sharp from 'sharp'
import type { DesktopApi } from '../../src/shared/types'

test('imports, persists, deduplicates and deletes a local asset through the desktop UI', async () => {
  const testInfo = test.info()
  const userDataPath = testInfo.outputPath('user-data')
  const fixturePath = testInfo.outputPath('fixtures')
  const sourcePath = testInfo.outputPath('fixtures', '猫猫加班.png')
  await Promise.all([
    mkdir(userDataPath, { recursive: true }),
    mkdir(fixturePath, { recursive: true })
  ])
  await sharp({
    create: { width: 96, height: 72, channels: 4, background: '#ffd55f' }
  }).png().toFile(sourcePath)

  const electronApp = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      EMOJI_PIE_USER_DATA: userDataPath,
      EMOJI_PIE_LOCAL_ASSET_FIXTURE_DIR: fixturePath
    }
  })

  try {
    const window = await electronApp.firstWindow()
    await window.setViewportSize({ width: 1320, height: 860 })
    await window.getByRole('button', { name: '本地素材' }).click()
    await expect(window.getByRole('heading', { name: '本地素材' })).toBeVisible()
    await expect(window.getByRole('heading', { name: '建立你的本地梗图库' })).toBeVisible()

    await window.getByRole('button', { name: '导入文件夹' }).click()
    const rightsDialog = window.getByRole('dialog', { name: '确认图片使用权限' })
    await expect(rightsDialog.getByRole('button', { name: '确认并选择' })).toBeDisabled()
    await rightsDialog.getByRole('checkbox').check()
    await rightsDialog.getByRole('button', { name: '确认并选择' }).click()

    const importDialog = window.getByRole('dialog', { name: '导入本地素材' })
    await expect(importDialog).toBeVisible()
    const tagInput = importDialog.getByLabel('猫猫加班.png 标签')
    await expect(tagInput).toBeVisible({ timeout: 10_000 })
    await tagInput.fill('加班，猫')
    await importDialog.getByRole('button', { name: '导入 1 张' }).click()
    await expect(importDialog.getByRole('heading', { name: '已导入 1 张' })).toBeVisible({
      timeout: 10_000
    })
    await importDialog.getByRole('button', { name: '查看本地素材' }).click()

    await expect(window.getByText('猫猫加班', { exact: true })).toBeVisible()
    const thumbnail = window.locator('.local-asset-card img')
    await expect(thumbnail).toHaveCount(1)
    await expect.poll(async () => thumbnail.evaluate((image) =>
      (image as HTMLImageElement).naturalWidth
    )).toBe(320)
    await window.screenshot({ path: testInfo.outputPath('local-assets-library.png'), fullPage: true })

    await window.getByRole('button', { name: '导入文件夹' }).click()
    await window.getByRole('dialog', { name: '确认图片使用权限' }).getByRole('checkbox').check()
    await window.getByRole('dialog', { name: '确认图片使用权限' })
      .getByRole('button', { name: '确认并选择' }).click()
    await expect(importDialog.getByText('已存在，已跳过')).toBeVisible({ timeout: 10_000 })
    await expect(importDialog.getByRole('button', { name: '导入 0 张' })).toBeDisabled()
    await importDialog.getByRole('button', { name: '取消导入' }).click()

    await window.setViewportSize({ width: 960, height: 640 })
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await window.screenshot({ path: testInfo.outputPath('local-assets-compact.png'), fullPage: true })

    await window.getByRole('button', { name: '生成表情' }).click()
    await window.getByLabel('表情文案').fill('今天加班')
    await window.getByRole('radio', { name: '表情海报' }).click()
    await window.getByRole('radio', { name: '本地素材' }).click()
    await expect(window.getByText('共 1 张 · 本机匹配')).toBeVisible()
    await window.getByRole('radio', { name: '手动选图' }).click()
    await window.getByRole('button', { name: '选择素材' }).click()
    const posterPicker = window.getByRole('dialog', { name: '手动选择本地素材' })
    await posterPicker.getByRole('checkbox').check()
    await posterPicker.getByRole('button', { name: '确认选择 1 张' }).click()
    await window.getByRole('button', { name: '用本地素材生成' }).click()

    const generatedCard = window.getByTestId('emoji-card')
    await expect(generatedCard).toHaveCount(1, { timeout: 10_000 })
    await expect.poll(async () => generatedCard.locator('img').evaluate((image) =>
      (image as HTMLImageElement).naturalWidth
    )).toBe(640)
    await expect(window.getByLabel('生成结果').getByRole('button', { name: '重新选图' })).toBeVisible()
    await expect(window.getByRole('button', { name: '换一批' })).toHaveCount(0)
    await generatedCard.getByRole('button', { name: '收藏' }).click()

    await window.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '本地素材' }).click()
    await window.getByRole('button', { name: '编辑 猫猫加班' }).click()
    const editDialog = window.getByRole('dialog', { name: '编辑素材' })
    await editDialog.getByRole('button', { name: '删除素材' }).click()
    const deleteDialog = window.getByRole('alertdialog')
    await expect(deleteDialog).toContainText('不会删除原始导入文件')
    await deleteDialog.getByRole('button', { name: '删除素材' }).click()
    await expect(window.getByRole('heading', { name: '建立你的本地梗图库' })).toBeVisible()

    await window.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '最近生成' }).click()
    await expect(window.getByRole('heading', { name: '最近生成' })).toBeVisible()
    await expect(window.getByText('来自：猫猫加班（源素材已删除）')).toBeVisible()
    await expect(window.getByRole('button', { name: '再次创作' })).toHaveCount(0)
    await expect(window.getByTestId('emoji-card')).toHaveCount(1)

    await window.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的收藏' }).click()
    await expect(window.getByRole('heading', { name: '我的收藏' })).toBeVisible()
    await expect(window.getByText('来自：猫猫加班（源素材已删除）')).toBeVisible()
    await expect(window.getByTestId('emoji-card')).toHaveCount(1)
    await expect(access(sourcePath)).resolves.toBeUndefined()
  } finally {
    await electronApp.close()
  }
})

test('keeps picker permission failures retryable inside the real DesktopApi boundary', async () => {
  const testInfo = test.info()
  const userDataPath = testInfo.outputPath('permission-user-data')
  await mkdir(userDataPath, { recursive: true })
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      EMOJI_PIE_USER_DATA: userDataPath,
      EMOJI_PIE_LOCAL_ASSET_FIXTURE_ERROR: 'permission_denied'
    }
  })
  try {
    const window = await electronApp.firstWindow()
    await window.getByRole('button', { name: '本地素材' }).click()
    await window.getByRole('button', { name: '导入文件夹' }).click()
    const rightsDialog = window.getByRole('dialog', { name: '确认图片使用权限' })
    await rightsDialog.getByRole('checkbox').check()
    await rightsDialog.getByRole('button', { name: '确认并选择' }).click()
    await expect(rightsDialog).toBeVisible()
    await expect(rightsDialog.getByRole('alert')).toContainText('没有权限读取')
    await expect(rightsDialog.getByRole('button', { name: '确认并选择' })).toBeEnabled()
  } finally {
    await electronApp.close()
  }
})

test('recovers the real utility-process queue after two hangs and a crash', async () => {
  const testInfo = test.info()
  const userDataPath = testInfo.outputPath('worker-user-data')
  const fixturePath = testInfo.outputPath('worker-fixtures')
  await Promise.all([
    mkdir(userDataPath, { recursive: true }),
    mkdir(fixturePath, { recursive: true })
  ])
  await Promise.all([
    writeFile(testInfo.outputPath('worker-fixtures', '01-hang.png'), 'YM10_HANG_A'),
    writeFile(testInfo.outputPath('worker-fixtures', '02-hang.png'), 'YM10_HANG_B'),
    writeFile(testInfo.outputPath('worker-fixtures', '03-crash.png'), 'YM10_CRASH'),
    sharp({
      create: { width: 32, height: 24, channels: 4, background: '#00aa88' }
    }).png().toFile(testInfo.outputPath('worker-fixtures', '04-healthy.png'))
  ])
  const retryImage = await sharp({
    create: { width: 35, height: 25, channels: 4, background: '#bb3377' }
  }).png().toBuffer()
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      EMOJI_PIE_USER_DATA: userDataPath,
      EMOJI_PIE_LOCAL_ASSET_FIXTURE_DIR: fixturePath,
      EMOJI_PIE_LOCAL_ASSET_WORKER_TEST_MODE: '1'
    }
  })
  try {
    const window = await electronApp.firstWindow()
    await window.getByRole('button', { name: '本地素材' }).click()
    await window.getByRole('button', { name: '导入文件夹' }).click()
    const rightsDialog = window.getByRole('dialog', { name: '确认图片使用权限' })
    await rightsDialog.getByRole('checkbox').check()
    await rightsDialog.getByRole('button', { name: '确认并选择' }).click()
    const importDialog = window.getByRole('dialog', { name: '导入本地素材' })
    await expect(importDialog.locator('.import-item.is-failed')).toHaveCount(3, {
      timeout: 15_000
    })
    await expect(importDialog.getByLabel('04-healthy.png 标签')).toBeVisible()

    const stagingRoot = testInfo.outputPath('worker-user-data', 'local-assets', 'staging')
    const [sessionDirectory] = await readdir(stagingRoot)
    const stagingDirectory = testInfo.outputPath(
      'worker-user-data',
      'local-assets',
      'staging',
      sessionDirectory
    )
    const stagingFiles = (await readdir(stagingDirectory))
      .filter((fileName) => fileName.endsWith('.png'))
    let repaired = false
    for (const fileName of stagingFiles) {
      const filePath = testInfo.outputPath(
        'worker-user-data',
        'local-assets',
        'staging',
        sessionDirectory,
        fileName
      )
      if ((await readFile(filePath, 'utf8').catch(() => '')).startsWith('YM10_')) {
        await writeFile(filePath, retryImage)
        repaired = true
        break
      }
    }
    expect(repaired).toBe(true)
    await importDialog.getByRole('button', { name: '重试失败项' }).click()
    await expect(importDialog.locator('.import-item.is-staged')).toHaveCount(2, {
      timeout: 15_000
    })
    const tagInputs = importDialog.locator('.import-item.is-staged input[aria-label$="标签"]')
    await expect(tagInputs).toHaveCount(2)
    for (let index = 0; index < await tagInputs.count(); index += 1) {
      await tagInputs.nth(index).fill(`恢复-${index}`)
    }
    await importDialog.getByRole('button', { name: '导入 2 张' }).click()
    await expect(importDialog.getByRole('button', { name: '重试失败项' })).toBeVisible({
      timeout: 10_000
    })
    await expect(importDialog.getByText(/^已导入 2 张$/u)).toHaveCount(0)
  } finally {
    await electronApp.close()
  }
})

test('recovers poster rendering after a utility-process timeout and crash', async () => {
  const testInfo = test.info()
  const userDataPath = testInfo.outputPath('poster-worker-user-data')
  const fixturePath = testInfo.outputPath('poster-worker-fixtures')
  await Promise.all([
    mkdir(userDataPath, { recursive: true }),
    mkdir(fixturePath, { recursive: true })
  ])
  await Promise.all([
    sharp({
      create: { width: 40, height: 30, channels: 4, background: '#aa2200' }
    }).png().toFile(testInfo.outputPath('poster-worker-fixtures', '01-timeout.png')),
    sharp({
      create: { width: 41, height: 31, channels: 4, background: '#22aa00' }
    }).png().toFile(testInfo.outputPath('poster-worker-fixtures', '02-crash.png')),
    sharp({
      create: { width: 42, height: 32, channels: 4, background: '#0022aa' }
    }).png().toFile(testInfo.outputPath('poster-worker-fixtures', '03-healthy.png'))
  ])
  const electronApp = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      EMOJI_PIE_USER_DATA: userDataPath,
      EMOJI_PIE_LOCAL_ASSET_FIXTURE_DIR: fixturePath,
      EMOJI_PIE_LOCAL_ASSET_WORKER_TEST_MODE: '1'
    }
  })
  try {
    const window = await electronApp.firstWindow()
    const imported = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { emojiPie: DesktopApi }).emojiPie
      const begun = await api.localAssets.beginImport({
        sourceKind: 'directory',
        rightsConfirmed: true
      })
      if (!begun.ok) return begun
      let session = begun.value
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const current = await api.localAssets.getImportSession({ sessionId: session.id })
        if (!current.ok) return current
        session = current.value
        if (session.items.every(({ state }) => state === 'staged')) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (!session.items.every(({ state }) => state === 'staged')) {
        throw new Error('poster recovery fixtures did not finish staging')
      }
      for (const item of session.items) {
        const drafted = await api.localAssets.updateImportDraft({
          sessionId: session.id,
          itemId: item.id,
          displayName: item.originalFilename.replace(/\.png$/u, ''),
          tags: ['recovery']
        })
        if (!drafted.ok) return drafted
      }
      const finalized = await api.localAssets.finalizeImport({
        sessionId: session.id,
        itemIds: session.items.map(({ id }) => id)
      })
      if (!finalized.ok) return finalized
      return api.localAssets.list()
    })
    expect(imported).toMatchObject({ ok: true, value: [{}, {}, {}] })
    if (!imported.ok) throw new Error(imported.error.message)
    const idByName = new Map(imported.value.map(({ id, originalFilename }) => [originalFilename, id]))
    const timeoutId = idByName.get('01-timeout.png')
    const crashId = idByName.get('02-crash.png')
    const healthyId = idByName.get('03-healthy.png')
    expect(timeoutId).toBeTruthy()
    expect(crashId).toBeTruthy()
    expect(healthyId).toBeTruthy()
    if (!timeoutId || !crashId || !healthyId) throw new Error('missing poster recovery asset')

    await writeFile(
      testInfo.outputPath('poster-worker-user-data', 'local-assets', 'originals', `${timeoutId}.png`),
      'YM10_HANG_POSTER'
    )
    const timedOut = await window.evaluate(async (assetId) => {
      const api = (globalThis as typeof globalThis & { emojiPie: DesktopApi }).emojiPie
      return api.localAssets.generatePosters({
        prompt: 'recovery', caption: 'timeout', embedCaption: true,
        matchMode: 'manual', selectedAssetIds: [assetId], excludedAssetIds: []
      })
    }, timeoutId)
    expect(timedOut).toMatchObject({
      ok: false, error: { code: 'processing_timeout', retryable: true }
    })

    await writeFile(
      testInfo.outputPath('poster-worker-user-data', 'local-assets', 'originals', `${crashId}.png`),
      'YM10_CRASH_POSTER'
    )
    const crashed = await window.evaluate(async (assetId) => {
      const api = (globalThis as typeof globalThis & { emojiPie: DesktopApi }).emojiPie
      return api.localAssets.generatePosters({
        prompt: 'recovery', caption: 'crash', embedCaption: true,
        matchMode: 'manual', selectedAssetIds: [assetId], excludedAssetIds: []
      })
    }, crashId)
    expect(crashed).toMatchObject({
      ok: false, error: { code: 'processing_crashed', retryable: true }
    })

    const recovered = await window.evaluate(async (assetId) => {
      const api = (globalThis as typeof globalThis & { emojiPie: DesktopApi }).emojiPie
      return api.localAssets.generatePosters({
        prompt: 'recovery', caption: 'healthy', embedCaption: true,
        matchMode: 'manual', selectedAssetIds: [assetId], excludedAssetIds: []
      })
    }, healthyId)
    expect(recovered).toMatchObject({
      ok: true,
      value: { candidates: [{ assetId: healthyId, dataUrl: expect.stringMatching(/^data:image\/png;base64,/u) }] }
    })
  } finally {
    await electronApp.close()
  }
})
