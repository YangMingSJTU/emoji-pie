import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('packaged local asset worker', () => {
  it('includes the dynamic utility-process entrypoint in the application archive', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts?: Record<string, string>
      build?: {
        files?: string[]
        extraResources?: Array<{ from?: string; to?: string; filter?: string[] }>
      }
    }

    expect(packageJson.build?.files).toContain('src/main/local-asset-worker-process.cjs')
    expect(packageJson.scripts?.prebuild).toBe('npm run starter-pack:build')
    expect(packageJson.scripts?.predev).toBe('npm run starter-pack:build')
    expect(packageJson.build?.extraResources).toContainEqual({
      from: '.generated/starter-packs/starter-pack-v1',
      to: 'starter-packs/starter-pack-v1',
      filter: ['**/*']
    })
  })
})
