import { mkdirSync } from 'node:fs'
import { _electron as electron, expect, test } from '@playwright/test'
import type { AgentRuntimeId, DesktopApi } from '../../src/shared/types'

const requestedRuntime = process.env.EMOJI_PIE_TEST_RUNTIME
const runtimeId: AgentRuntimeId = requestedRuntime === 'codex' || requestedRuntime === 'opencode'
  ? requestedRuntime
  : 'claude'
const runtimeModel = process.env.EMOJI_PIE_TEST_MODEL ?? ''

test.skip(
  process.env.EMOJI_PIE_TEST_AGENT_RUNTIME !== '1',
  'Set EMOJI_PIE_TEST_AGENT_RUNTIME=1 to run against a signed-in local agent CLI.'
)

test('discovers and generates through a real agent runtime', async () => {
  test.setTimeout(150_000)
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
    const generation = await page.evaluate(async ({ selectedRuntime, selectedModel }) => {
      const api = (globalThis as typeof globalThis & { emojiPie: DesktopApi }).emojiPie
      const settings = {
        enabled: true,
        runtimeId: selectedRuntime,
        executablePath: '',
        endpoint: '',
        model: selectedModel
      } as const
      const discovery = await api.runtime.discover(settings)
      const runtime = discovery.runtimes.find(({ id }) => id === selectedRuntime)
      if (runtime?.status !== 'ready') {
        throw new Error(`${selectedRuntime} runtime is not ready: ${runtime?.message ?? 'not found'}`)
      }
      await api.runtime.saveSettings(settings)
      return api.runtime.generate({
        prompt: '老板说这个需求很简单，今晚改完',
        mode: 'reply'
      })
    }, { selectedRuntime: runtimeId, selectedModel: runtimeModel })

    expect(generation.runtimeId).toBe(runtimeId)
    expect(generation.analysis.scene).toBe('work')
    expect(generation.variants).toHaveLength(9)
    expect(generation.variants.every(({ caption }) => caption.length > 0)).toBe(true)
  } finally {
    await electronApp.close()
  }
})
