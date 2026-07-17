import { describe, expect, it } from 'vitest'
import { SharpLocalAssetWorkerPool } from '../src/main/local-asset-worker'

const CONTROLLED_WORKER_SOURCE = String.raw`
  const { parentPort } = require('node:worker_threads')
  parentPort.on('message', ({ jobId, filePath }) => {
    if (filePath === 'hang') return
    if (filePath === 'crash') process.exit(17)
    parentPort.postMessage({
      jobId,
      ok: true,
      value: {
        mimeType: 'image/png',
        width: 1,
        height: 1,
        pixelSha256: 'a'.repeat(64),
        thumbnail: Buffer.alloc(0)
      }
    })
  })
`

describe('SharpLocalAssetWorkerPool recovery', () => {
  it('terminates and replaces timed-out and crashed workers before continuing', async () => {
    const workers = new SharpLocalAssetWorkerPool(2, 50, CONTROLLED_WORKER_SOURCE)
    try {
      await expect(workers.process('hang')).rejects.toMatchObject({
        code: 'processing_timeout'
      })
      await expect(workers.process('crash')).rejects.toMatchObject({
        code: 'processing_crashed'
      })
      await expect(workers.process('healthy')).resolves.toMatchObject({
        mimeType: 'image/png',
        pixelSha256: 'a'.repeat(64)
      })
    } finally {
      await workers.dispose()
    }
  })
})
