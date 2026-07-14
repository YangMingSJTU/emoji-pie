import { Check } from 'lucide-react'
import { useMemo } from 'react'
import type {
  EmojiRenderSettings,
  EmojiStyle,
  EmojiStyleSelection
} from '../../../shared/types'
import { STYLE_OPTIONS } from '../config'
import { renderEmoji } from '../lib/emoji-renderer'
import type { EmojiSpec } from '../lib/text-analysis'

interface EffectPickerProps {
  value: EmojiStyleSelection
  renderSettings: EmojiRenderSettings
  onChange: (value: EmojiStyleSelection) => void
}

const PREVIEW_STYLES = STYLE_OPTIONS
  .flatMap(({ previewStyles }) => previewStyles)
  .filter((style, index, values) => values.indexOf(style) === index)

function renderPreview(style: EmojiStyle, renderSettings: EmojiRenderSettings): string {
  const spec: EmojiSpec = {
    id: `effect-preview-${style}`,
    prompt: '好的',
    mode: 'reply',
    style,
    emotion: 'speechless',
    caption: '好的',
    seed: 20_260_714
  }
  return renderEmoji(spec, renderSettings)
}

export function EffectPicker({
  value,
  renderSettings,
  onChange
}: EffectPickerProps): React.JSX.Element {
  const previews = useMemo(
    () => new Map(
      PREVIEW_STYLES.map((style) => [style, renderPreview(style, renderSettings)])
    ),
    [renderSettings]
  )

  return (
    <div className="effect-picker">
      <span className="effect-picker-label">表情效果</span>
      <div className="effect-options" role="radiogroup" aria-label="表情效果">
        {STYLE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            aria-label={option.label}
            className={`effect-option ${value === option.id ? 'is-active' : ''}`}
            data-effect={option.id}
            title={option.description}
            onClick={() => onChange(option.id)}
          >
            <span className={`effect-preview ${option.id === 'smart' ? 'is-smart' : ''}`}>
              {option.previewStyles.map((style) => (
                <img key={style} src={previews.get(style)} alt="" draggable={false} />
              ))}
            </span>
            <span className="effect-option-label">{option.label}</span>
            {value === option.id && (
              <span className="effect-selected" aria-hidden="true">
                <Check size={11} strokeWidth={3} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
