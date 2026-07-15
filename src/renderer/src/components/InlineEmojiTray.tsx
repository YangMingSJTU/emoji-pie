import { Copy, Type } from 'lucide-react'
import type { InlineEmojiSuggestion } from '../lib/inline-emoji'

interface InlineEmojiTrayProps {
  suggestions: InlineEmojiSuggestion[]
  onCopy: (suggestion: InlineEmojiSuggestion) => void
}

export function InlineEmojiTray({
  suggestions,
  onCopy
}: InlineEmojiTrayProps): React.JSX.Element {
  return (
    <section className="inline-emoji-strip" aria-label="行内 Emoji">
      <div className="inline-emoji-title">
        <span aria-hidden="true">
          <Type size={16} />
        </span>
        <div>
          <strong>行内 Emoji</strong>
          <small>文本</small>
        </div>
      </div>
      <div className="inline-emoji-options">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.id}
            type="button"
            data-emoji={suggestion.value}
            title={`复制 ${suggestion.value}`}
            aria-label={`复制行内 Emoji：${suggestion.value}，${suggestion.label}`}
            onClick={() => onCopy(suggestion)}
          >
            <span className="inline-emoji-glyph" aria-hidden="true">
              {suggestion.value}
            </span>
            <span className="inline-emoji-label">{suggestion.label}</span>
            <Copy size={14} aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  )
}
