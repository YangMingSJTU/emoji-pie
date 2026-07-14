import { mkdirSync } from 'node:fs'
import { _electron as electron, expect, test } from '@playwright/test'
import type { DesktopApi } from '../../src/shared/types'

test.skip(
  process.env.EMOJI_PIE_TEST_LOCAL_MODEL !== '1',
  'Set EMOJI_PIE_TEST_LOCAL_MODEL=1 to run against a local Ollama service.'
)

test('discovers and generates through a real Ollama model', async () => {
  test.setTimeout(180_000)
  const userDataPath = test.info().outputPath('user-data')
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
    await expect(page.getByRole('heading', { name: '把这句话做成表情' })).toBeVisible()
    await page.waitForFunction(() => 'emojiPie' in globalThis)
    const result = await page.evaluate(async (requestedModel) => {
      const api = (globalThis as typeof globalThis & { emojiPie: DesktopApi }).emojiPie
      const baseSettings = {
        enabled: true,
        runtimeId: 'ollama',
        executablePath: '',
        endpoint: 'http://127.0.0.1:11434',
        model: requestedModel
      } as const
      const discovery = await api.runtime.discover(baseSettings)
      const runtime = discovery.runtimes.find(({ id }) => id === 'ollama')
      if (runtime?.status !== 'ready') {
        throw new Error(`Ollama runtime is not ready: ${runtime?.message ?? 'not found'}`)
      }
      const model = requestedModel || runtime.models[0]?.id
      if (!model) throw new Error('Ollama has no available model')
      const settings = { ...baseSettings, model }
      await api.runtime.saveSettings(settings)
      return api.runtime.generate({
        prompt: '老板说这个需求很简单，今晚改完',
        mode: 'reply'
      })
    }, process.env.EMOJI_PIE_TEST_MODEL ?? '')

    expect(result.runtimeId).toBe('ollama')
    expect(result.model.length).toBeGreaterThan(0)
    expect(result.analysis.scene).toBe('work')
    expect(result.variants).toHaveLength(9)
    expect(result.variants.every(({ caption }) => caption.length > 0)).toBe(true)
  } finally {
    await electronApp.close()
  }
})
