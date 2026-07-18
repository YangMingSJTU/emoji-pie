import type { LocalImportFinalizeResultDto } from '../../../shared/local-assets'

export function isLocalImportFullyComplete(result: LocalImportFinalizeResultDto): boolean {
  return result.rejectedItems.length === 0 && !result.session.items.some((item) =>
    item.state === 'failed' ||
    item.state === 'processing' ||
    item.state === 'staged' ||
    item.state === 'committing'
  )
}
