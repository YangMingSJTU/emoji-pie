import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('packaged local asset worker', () => {
  it('includes the dynamic utility-process entrypoint in the application archive', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      build?: { files?: string[] }
    }

    expect(packageJson.build?.files).toContain('src/main/local-asset-worker-process.cjs')
  })
})
