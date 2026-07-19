import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EmojiRepository } from '../src/main/repository'
import {
  DEFAULT_EMOJI_RENDER_SETTINGS,
  isEmojiStyle,
  normalizeEmojiRenderSettings,
  type EmojiRecord
} from '../src/shared/types'

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

describe('emoji render settings', () => {
  it('accepts concrete effects but keeps smart selection out of records', () => {
    expect(isEmojiStyle('spectator')).toBe(true)
    expect(isEmojiStyle('smart')).toBe(false)
    expect(isEmojiStyle('unknown')).toBe(false)
  })

  it('defaults to a compact image without embedded text', () => {
    expect(DEFAULT_EMOJI_RENDER_SETTINGS).toEqual({
      outputType: 'image',
      layout: 'compact',
      embedCaption: false
    })
    expect(normalizeEmojiRenderSettings(undefined)).toEqual(DEFAULT_EMOJI_RENDER_SETTINGS)
    expect(normalizeEmojiRenderSettings({ layout: 'poster', embedCaption: true })).toEqual({
      outputType: 'image',
      layout: 'poster',
      embedCaption: true
    })
    expect(normalizeEmojiRenderSettings({
      outputType: 'inline',
      layout: 'poster',
      embedCaption: true
    })).toEqual({
      outputType: 'inline',
      layout: 'poster',
      embedCaption: true
    })
    expect(normalizeEmojiRenderSettings({ layout: 'unknown', embedCaption: 'yes' })).toEqual(
      DEFAULT_EMOJI_RENDER_SETTINGS
    )
  })

  it('persists render metadata with a generated image', () => {
    const repository = new EmojiRepository(':memory:')
    const record: EmojiRecord = {
      id: 'compact-1',
      prompt: '收到',
      mode: 'reply',
      style: 'spectator',
      layout: 'compact',
      embedCaption: false,
      emotion: 'happy',
      caption: '收到',
      seed: 42,
      dataUrl: 'data:image/png;base64,AQ==',
      favorite: false,
      createdAt: '2026-07-14T00:00:00.000Z'
    }
    try {
      repository.save([record])
      expect(repository.list()[0]).toEqual(record)
    } finally {
      repository.close()
    }
  })

  it('persists a local source snapshot and reports a removed source without losing history', () => {
    const repository = new EmojiRepository(':memory:')
    const record: EmojiRecord = {
      id: 'local-1',
      prompt: '加班',
      mode: 'express',
      style: 'office',
      layout: 'poster',
      embedCaption: true,
      emotion: 'tired',
      caption: '加班',
      seed: 7,
      dataUrl: 'data:image/png;base64,AQ==',
      favorite: true,
      createdAt: '2026-07-17T00:00:00.000Z',
      localSource: {
        assetId: '123E4567-E89B-42D3-A456-426614174000',
        assetNameSnapshot: '素材 A',
        matchMode: 'automatic',
        assetSource: 'user',
        sourceDeleted: false
      }
    }
    try {
      repository.save([record])
      expect(repository.list()[0]).toMatchObject({
        id: 'local-1',
        favorite: true,
        localSource: {
          assetId: '123e4567-e89b-42d3-a456-426614174000',
          assetNameSnapshot: '素材 A',
          matchMode: 'automatic',
          assetSource: 'user',
          sourceDeleted: true
        }
      })
    } finally {
      repository.close()
    }
  })

  it('migrates old records as poster images with embedded captions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'emoji-pie-migration-'))
    const databasePath = join(directory, 'old.sqlite')
    const oldDatabase = new DatabaseSync(databasePath)
    oldDatabase.exec(`
      CREATE TABLE generations (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        mode TEXT NOT NULL,
        style TEXT NOT NULL,
        emotion TEXT NOT NULL,
        caption TEXT NOT NULL,
        seed INTEGER NOT NULL,
        image BLOB NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO generations (
        id, prompt, mode, style, emotion, caption, seed, image, favorite, created_at
      ) VALUES (
        'legacy-1', '旧表情', 'express', 'office', 'tired', '旧表情', 7,
        X'01', 1, '2026-07-01T00:00:00.000Z'
      );
    `)
    oldDatabase.close()

    const repository = new EmojiRepository(databasePath)
    try {
      expect(repository.list()[0]).toMatchObject({
        id: 'legacy-1',
        layout: 'poster',
        embedCaption: true,
        favorite: true
      })
    } finally {
      repository.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
