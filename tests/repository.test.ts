import { describe, expect, it } from 'vitest'
import { EmojiRepository } from '../src/main/repository'

describe('EmojiRepository preferences', () => {
  it('persists structured runtime settings and replaces previous values', () => {
    const repository = new EmojiRepository(':memory:')
    try {
      repository.setPreference('runtime', { enabled: false, model: '' })
      repository.setPreference('runtime', { enabled: true, model: 'llama3:latest' })

      expect(repository.getPreference('runtime')).toEqual({
        enabled: true,
        model: 'llama3:latest'
      })
      expect(repository.getPreference('missing')).toBeUndefined()
    } finally {
      repository.close()
    }
  })
})
