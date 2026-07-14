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
    await window.getByLabel('表情文案').fill('今天又要加班')
    await window.getByRole('radio', { name: '社畜风' }).click()
    await window.getByRole('button', { name: '生成一组' }).click()

    await expect(window.getByTestId('emoji-card')).toHaveCount(9)
    await expect(window.getByText('工作场景')).toBeVisible()

    await window.screenshot({ path: testInfo.outputPath('emoji-pie-workspace.png'), fullPage: true })

    const firstCard = window.getByTestId('emoji-card').first()
    await firstCard.getByRole('button', { name: /复制表情/ }).click()
    await expect(window.getByText('PNG 已复制，可以去聊天窗口粘贴了')).toBeVisible()

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
