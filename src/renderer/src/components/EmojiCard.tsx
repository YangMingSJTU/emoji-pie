import { Copy, Download, Heart, RefreshCw, Trash2 } from 'lucide-react'
import type { EmojiRecord } from '../../../shared/types'
import { emotionLabel } from '../lib/text-analysis'

interface EmojiCardProps {
  record: EmojiRecord
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

export function EmojiCard({
  record,
  compact = false,
  showFavorite = true,
  showDelete = false,
  showReuse = false,
  onCopy,
  onDownload,
  onFavorite,
  onDelete,
  onReuse
}: EmojiCardProps): React.JSX.Element {
  return (
    <article className={`emoji-card ${compact ? 'is-compact' : ''}`} data-testid="emoji-card">
      <button
        type="button"
        className="emoji-preview-button"
        onClick={() => onCopy(record)}
        aria-label={`复制表情：${record.caption}`}
      >
        <img src={record.dataUrl} alt={record.caption} draggable={false} />
        <span className="copy-hint">
          <Copy size={17} />
          点击复制
        </span>
      </button>

      <div className="card-actions">
        {showReuse && onReuse && (
          <button type="button" onClick={() => onReuse(record)} title="再次创作" aria-label="再次创作">
            <RefreshCw size={16} />
          </button>
        )}
        <button type="button" onClick={() => onDownload(record)} title="保存 PNG" aria-label="保存 PNG">
          <Download size={16} />
        </button>
        {showFavorite && onFavorite && (
          <button
            type="button"
            className={record.favorite ? 'is-favorite' : ''}
            onClick={() => onFavorite(record)}
            title={record.favorite ? '取消收藏' : '收藏'}
            aria-label={record.favorite ? '取消收藏' : '收藏'}
          >
            <Heart size={16} fill={record.favorite ? 'currentColor' : 'none'} />
          </button>
        )}
        {showDelete && onDelete && (
          <button type="button" onClick={() => onDelete(record)} title="删除" aria-label="删除">
            <Trash2 size={16} />
          </button>
        )}
      </div>

      {!compact && (
        <footer className="emoji-card-footer">
          <span title={record.caption}>{record.caption}</span>
          <small>{emotionLabel(record.emotion)}</small>
        </footer>
      )}
    </article>
  )
}
