import type { EmojiRecord } from '../../../shared/types'
import { EmojiCard } from './EmojiCard'

interface EmojiGridProps {
  records: EmojiRecord[]
  loading?: boolean
  compact?: boolean
  showFavorite?: boolean
  showDelete?: boolean
  showReuse?: boolean
  onCopy: (record: EmojiRecord) => void
  onDownload: (record: EmojiRecord) => void
  onFavorite?: (record: EmojiRecord) => void
  onDelete?: (record: EmojiRecord) => void
  onReuse?: (record: EmojiRecord) => void
}

export function EmojiGrid({
  records,
  loading = false,
  compact = false,
  showFavorite = true,
  showDelete = false,
  showReuse = false,
  onCopy,
  onDownload,
  onFavorite,
  onDelete,
  onReuse
}: EmojiGridProps): React.JSX.Element {
  const usesCompactLayout = records.length > 0 && records.every(({ layout }) => layout === 'compact')
  return (
    <div
      className={`emoji-grid ${compact ? 'is-compact' : ''} ${usesCompactLayout ? 'has-compact-layout' : ''}`}
      aria-live="polite"
    >
      {records.map((record) => (
        <EmojiCard
          key={record.id}
          record={record}
          compact={compact}
          showFavorite={showFavorite}
          showDelete={showDelete}
          showReuse={showReuse}
          onCopy={onCopy}
          onDownload={onDownload}
          onFavorite={onFavorite}
          onDelete={onDelete}
          onReuse={onReuse}
        />
      ))}
      {loading &&
        Array.from({ length: records.length > 0 ? 3 : 6 }, (_, index) => (
          <div className="emoji-skeleton" key={`skeleton-${index}`} aria-hidden="true">
            <span />
            <i />
          </div>
        ))}
    </div>
  )
}
