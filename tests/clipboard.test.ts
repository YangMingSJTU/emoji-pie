import { describe, expect, it, vi } from 'vitest'
import { writeTextWithFallback } from '../src/renderer/src/lib/clipboard'

describe('text clipboard fallback', () => {
  it('uses the primary writer when it succeeds', async () => {
    const primary = vi.fn().mockResolvedValue(undefined)
    const fallback = vi.fn().mockResolvedValue(undefined)

    await writeTextWithFallback('😄', primary, fallback)

    expect(primary).toHaveBeenCalledWith('😄')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('uses the fallback when the primary writer is unavailable', async () => {
    const fallback = vi.fn().mockResolvedValue(undefined)

    await writeTextWithFallback('😄', undefined, fallback)

    expect(fallback).toHaveBeenCalledWith('😄')
  })

  it('uses the fallback when the primary writer rejects', async () => {
    const primary = vi.fn().mockRejectedValue(new Error('permission denied'))
    const fallback = vi.fn().mockResolvedValue(undefined)

    await writeTextWithFallback('😄', primary, fallback)

    expect(primary).toHaveBeenCalledWith('😄')
    expect(fallback).toHaveBeenCalledWith('😄')
  })

  it('preserves both errors when no writer succeeds', async () => {
    const primary = vi.fn().mockRejectedValue(new Error('native failed'))
    const fallback = vi.fn().mockRejectedValue(new Error('browser failed'))

    await expect(writeTextWithFallback('😄', primary, fallback)).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.any(Error), expect.any(Error)]
    })
  })
})
