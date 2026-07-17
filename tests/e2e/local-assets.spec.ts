import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { _electron as electron, expect, test } from '@playwright/test'
import sharp from 'sharp'

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

    await window.getByRole('button', { name: '编辑 猫猫加班' }).click()
    const editDialog = window.getByRole('dialog', { name: '编辑素材' })
    await editDialog.getByRole('button', { name: '删除素材' }).click()
    const deleteDialog = window.getByRole('alertdialog')
    await expect(deleteDialog).toContainText('不会删除原始导入文件')
    await deleteDialog.getByRole('button', { name: '删除素材' }).click()
    await expect(window.getByRole('heading', { name: '建立你的本地梗图库' })).toBeVisible()
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
