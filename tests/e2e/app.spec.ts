import { mkdirSync } from 'node:fs'
import { _electron as electron, expect, test } from '@playwright/test'

test('generates, copies and favorites an emoji batch', async () => {
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
    const window = await electronApp.firstWindow()
    await window.setViewportSize({ width: 1320, height: 860 })

    await expect(window.getByRole('heading', { name: '把这句话做成表情' })).toBeVisible()
    const outputGroup = window.getByRole('radiogroup', { name: '输出形式' })
    const inlineFormat = outputGroup.getByRole('radio', { name: '行内 Emoji' })
    const stickerFormat = outputGroup.getByRole('radio', { name: '黄脸贴纸' })
    await expect(outputGroup.getByRole('radio')).toHaveCount(3)
    await expect(stickerFormat).toBeChecked()
    const effectGroup = window.getByRole('radiogroup', { name: '表情效果' })
    const effectPreview = window.getByTestId('effect-detail-preview')
    const smartEffect = effectGroup.getByRole('radio', { name: '智能搭配' })
    await smartEffect.hover()
    await expect(effectGroup.getByRole('radio')).toHaveCount(8)
    await expect(smartEffect).toBeChecked()
    await expect(effectGroup.locator('img')).toHaveCount(0)
    await expect(effectPreview).toHaveAttribute('data-preview-effect', 'smart')
    await expect(effectPreview.locator('img')).toHaveCount(4)
    await expect.poll(async () => effectPreview.locator('img').evaluateAll((images) =>
      images.every((image) => (image as HTMLImageElement).naturalWidth === 128)
    )).toBe(true)
    await window.screenshot({ path: testInfo.outputPath('effect-picker-smart.png'), fullPage: true })

    await effectGroup.getByRole('radio', { name: '经典黄脸' }).hover()
    await expect(effectPreview).toHaveAttribute('data-preview-effect', 'classic')
    await expect(smartEffect).toBeChecked()

    await window.getByLabel('表情文案').fill('今天又要加班')
    await inlineFormat.click()
    await expect(inlineFormat).toBeChecked()
    await expect(window.getByLabel('行内 Emoji 输出预览')).toBeVisible()
    await expect(effectGroup).toBeHidden()
    await expect(window.getByLabel('图片内文字')).toBeHidden()
    await expect(window.getByTestId('emoji-card')).toHaveCount(0)
    await expect(window.getByRole('region', { name: '行内 Emoji' }).getByRole('button'))
      .toHaveCount(5)

    await window.getByRole('button', { name: '生成 Emoji' }).click()
    await expect(window.getByRole('button', { name: '正在创作' })).toBeVisible()
    await expect(window.getByText('5 个行内 Emoji', { exact: true })).toBeVisible()
    const inlineEmojiTray = window.getByRole('region', { name: '行内 Emoji' })
    await expect(inlineEmojiTray.getByRole('button')).toHaveCount(5)
    await expect(window.getByTestId('emoji-card')).toHaveCount(0)
    await expect.poll(async () => {
      const bounds = await inlineEmojiTray.boundingBox()
      return bounds ? bounds.y + bounds.height : Number.POSITIVE_INFINITY
    }).toBeLessThanOrEqual(860)
    const firstInlineEmoji = inlineEmojiTray.getByRole('button').first()
    const firstInlineValue = await firstInlineEmoji.getAttribute('data-emoji')
    expect(firstInlineValue).toBeTruthy()
    await firstInlineEmoji.click()
    await expect(window.getByText(`${firstInlineValue} 已复制为行内 Emoji`)).toBeVisible()
    expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(firstInlineValue)
    await window.getByRole('button', { name: '换一批' }).click()
    await expect(window.getByRole('button', { name: '生成中' })).toBeVisible()
    await expect(window.getByRole('button', { name: '换一批' })).toBeVisible()
    expect(await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & {
        emojiPie: { library: { list: () => Promise<unknown[]> } }
      }).emojiPie
      return (await api.library.list()).length
    })).toBe(0)
    await window.screenshot({ path: testInfo.outputPath('inline-emoji-output.png') })

    await stickerFormat.click()
    await expect(stickerFormat).toBeChecked()
    await expect(effectGroup).toBeVisible()
    await expect(window.getByLabel('图片内文字')).toBeVisible()
    const officeEffect = effectGroup.getByRole('radio', { name: '社畜打工' })
    await officeEffect.click()
    await expect(officeEffect).toBeChecked()
    await expect(effectPreview).toHaveAttribute('data-preview-effect', 'office')
    await window.getByRole('button', { name: '生成贴纸' }).click()

    await expect(window.getByTestId('emoji-card')).toHaveCount(9)
    await expect(window.getByText('9 张贴纸', { exact: true })).toBeVisible()
    await expect(window.getByText('工作场景')).toBeVisible()
    await expect(window.getByText('继续下滑，自动生成更多')).toHaveCount(0)
    await expect(window.getByRole('region', { name: '行内 Emoji' })).toHaveCount(0)

    const firstSource = await window.getByTestId('emoji-card').first().locator('img').getAttribute('src')
    await window.getByRole('button', { name: '换一批' }).click()
    await expect(window.getByRole('button', { name: '生成中' })).toBeVisible()
    await expect(window.getByTestId('emoji-card')).toHaveCount(9)
    await expect(window.getByRole('button', { name: '换一批' })).toBeVisible()
    await expect(window.getByTestId('emoji-card')).toHaveCount(9)
    const refreshedSource = await window.getByTestId('emoji-card').first().locator('img').getAttribute('src')
    expect(refreshedSource).not.toBe(firstSource)
    expect(await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & {
        emojiPie: { library: { list: () => Promise<unknown[]> } }
      }).emojiPie
      return (await api.library.list()).length
    })).toBe(18)

    await window.screenshot({ path: testInfo.outputPath('emoji-pie-workspace.png'), fullPage: true })

    const firstCard = window.getByTestId('emoji-card').first()
    await firstCard.getByRole('button', { name: /复制表情/ }).click()
    await expect(window.getByText('贴纸 PNG 已复制，可以去聊天窗口粘贴了')).toBeVisible()

    await firstCard.getByRole('button', { name: '收藏' }).click()
    await expect(window.getByText('已加入收藏')).toBeVisible()
    await window.getByRole('button', { name: '我的收藏' }).click()
    await expect(window.getByTestId('emoji-card')).toHaveCount(1)

    await window.screenshot({ path: testInfo.outputPath('emoji-pie-favorites.png'), fullPage: true })

    await window.getByRole('button', { name: 'AI 运行时' }).click()
    await expect(window.getByRole('heading', { name: 'AI 运行时' })).toBeVisible()
    await expect(window.getByRole('radio')).toHaveCount(3)
    await expect(window.getByLabel('AI 运行时可执行文件覆盖')).toHaveValue('')
    await expect(window.getByText('已加入收藏')).toBeHidden()

    await window.getByRole('tab', { name: '本地模型' }).click()
    await expect(window.getByRole('radio')).toHaveCount(3)
    await expect(window.getByRole('radio', { name: /Ollama/ })).toBeChecked()
    await expect(window.getByLabel('本地模型服务地址'))
      .toHaveValue('http://127.0.0.1:11434')
    await expect(window.getByRole('button', { name: '刷新运行时状态' })).toBeEnabled({
      timeout: 15_000
    })
    await window.screenshot({ path: testInfo.outputPath('emoji-pie-agent-runtime.png'), fullPage: true })

    await window.setViewportSize({ width: 960, height: 640 })
    const saveButton = window.getByRole('button', { name: '保存设置' })
    await expect(saveButton).toBeVisible()
    const saveButtonBox = await saveButton.boundingBox()
    expect(saveButtonBox).not.toBeNull()
    expect((saveButtonBox?.y ?? 640) + (saveButtonBox?.height ?? 1)).toBeLessThanOrEqual(640)
    expect(await window.evaluate(
      () => document.documentElement.scrollWidth <= globalThis.innerWidth
    )).toBe(true)
    await window.screenshot({ path: testInfo.outputPath('emoji-pie-agent-runtime-compact.png'), fullPage: true })
  } finally {
    await electronApp.close()
  }
})
