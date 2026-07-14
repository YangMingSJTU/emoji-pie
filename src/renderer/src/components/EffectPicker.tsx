import { Check } from 'lucide-react'
import { useMemo, useState } from 'react'
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
  const [previewValue, setPreviewValue] = useState<EmojiStyleSelection | null>(null)
  const previews = useMemo(
    () => new Map(
      PREVIEW_STYLES.map((style) => [style, renderPreview(style, renderSettings)])
    ),
    [renderSettings]
  )
  const visibleValue = previewValue ?? value
  const visibleOption = STYLE_OPTIONS.find((option) => option.id === visibleValue)
    ?? STYLE_OPTIONS[0]

  const previewAdjacentOption = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    offset: number
  ): void => {
    const buttons = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.effect-option') ?? []
    )
    const currentIndex = buttons.indexOf(event.currentTarget)
    const nextButton = buttons[(currentIndex + offset + buttons.length) % buttons.length]
    if (!nextButton) return
    event.preventDefault()
    nextButton.focus()
  }

  return (
    <div className="effect-picker">
      <span className="effect-picker-label">表情效果</span>
      <div className="effect-picker-content">
        <div
          className="effect-options"
          role="radiogroup"
          aria-label="表情效果"
          onPointerLeave={() => setPreviewValue(null)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setPreviewValue(null)
            }
          }}
        >
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
              tabIndex={value === option.id ? 0 : -1}
              onClick={() => onChange(option.id)}
              onFocus={() => setPreviewValue(option.id)}
              onPointerEnter={() => setPreviewValue(option.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') {
                  previewAdjacentOption(event, 1)
                } else if (event.key === 'ArrowLeft') {
                  previewAdjacentOption(event, -1)
                } else if (event.key === 'ArrowDown') {
                  previewAdjacentOption(event, 4)
                } else if (event.key === 'ArrowUp') {
                  previewAdjacentOption(event, -4)
                }
              }}
            >
              <span className="effect-option-label">{option.label}</span>
              {value === option.id && (
                <span className="effect-selected" aria-hidden="true">
                  <Check size={11} strokeWidth={3} />
                </span>
              )}
            </button>
          ))}
        </div>

        <figure
          className="effect-detail"
          data-testid="effect-detail-preview"
          data-preview-effect={visibleOption.id}
          aria-label={`${visibleOption.label}示例：${visibleOption.description}`}
        >
          <div
            className={`effect-detail-art ${visibleOption.id === 'smart' ? 'is-smart' : ''}`}
            data-testid="effect-preview-art"
            aria-hidden="true"
          >
            {visibleOption.previewStyles.map((style) => (
              <img key={style} src={previews.get(style)} alt="" draggable={false} />
            ))}
          </div>
          <figcaption>
            <strong>{visibleOption.label}</strong>
            <span>{visibleOption.description}</span>
          </figcaption>
        </figure>
      </div>
    </div>
  )
}
