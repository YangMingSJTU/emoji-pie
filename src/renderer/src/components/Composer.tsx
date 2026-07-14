import {
  Dice5,
  Image as ImageIcon,
  LoaderCircle,
  MessageCircle,
  Reply,
  Smile,
  Sparkles,
  Type
} from 'lucide-react'
import type { EmojiRenderSettings, EmojiStyle, GenerationMode } from '../../../shared/types'
import { PROMPT_SUGGESTIONS, STYLE_OPTIONS } from '../config'

interface ComposerProps {
  prompt: string
  mode: GenerationMode
  style: EmojiStyle
  renderSettings: EmojiRenderSettings
  generating: boolean
  onPromptChange: (value: string) => void
  onModeChange: (mode: GenerationMode) => void
  onStyleChange: (style: EmojiStyle) => void
  onRenderSettingsChange: (settings: EmojiRenderSettings) => void
  onGenerate: () => void
  onRandomPrompt: () => void
}

export function Composer({
  prompt,
  mode,
  style,
  renderSettings,
  generating,
  onPromptChange,
  onModeChange,
  onStyleChange,
  onRenderSettingsChange,
  onGenerate,
  onRandomPrompt
}: ComposerProps): React.JSX.Element {
  const suggestions = PROMPT_SUGGESTIONS[mode]

  return (
    <section className="composer" aria-label="表情生成器">
      <div className="composer-toolbar">
        <div className="mode-control" role="group" aria-label="生成模式">
          <button
            type="button"
            className={mode === 'express' ? 'is-active' : ''}
            onClick={() => onModeChange('express')}
          >
            <MessageCircle size={16} />
            表达模式
          </button>
          <button
            type="button"
            className={mode === 'reply' ? 'is-active' : ''}
            onClick={() => onModeChange('reply')}
          >
            <Reply size={16} />
            回复模式
          </button>
        </div>
        <button
          type="button"
          className="icon-button subtle-button"
          onClick={onRandomPrompt}
          title="随机灵感"
          aria-label="随机灵感"
        >
          <Dice5 size={18} />
        </button>
      </div>

      <div className="prompt-field">
        <textarea
          value={prompt}
          maxLength={120}
          rows={3}
          autoFocus
          placeholder={mode === 'express' ? '输入你想表达的话…' : '粘贴对方发来的消息…'}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              onGenerate()
            }
          }}
          aria-label="表情文案"
          aria-keyshortcuts="Control+Enter Meta+Enter"
        />
        <span className="character-count">{prompt.length}/120</span>
      </div>

      <div className="suggestion-row" aria-label="灵感文案">
        {suggestions.map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => onPromptChange(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>

      <div className="render-options">
        <div className="render-layout-field">
          <span>画面版式</span>
          <div className="render-layout-control" role="radiogroup" aria-label="画面版式">
            <button
              type="button"
              role="radio"
              aria-checked={renderSettings.layout === 'compact'}
              className={renderSettings.layout === 'compact' ? 'is-active' : ''}
              onClick={() => onRenderSettingsChange({ ...renderSettings, layout: 'compact' })}
            >
              <Smile size={15} />
              小黄脸
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={renderSettings.layout === 'poster'}
              className={renderSettings.layout === 'poster' ? 'is-active' : ''}
              onClick={() => onRenderSettingsChange({ ...renderSettings, layout: 'poster' })}
            >
              <ImageIcon size={15} />
              表情海报
            </button>
          </div>
        </div>

        <label className="caption-render-switch">
          <span>
            <Type size={15} />
            图片内文字
          </span>
          <input
            type="checkbox"
            checked={renderSettings.embedCaption}
            onChange={(event) => onRenderSettingsChange({
              ...renderSettings,
              embedCaption: event.target.checked
            })}
            aria-label="图片内文字"
          />
          <i aria-hidden="true" />
        </label>
      </div>

      <div className="composer-footer">
        <div className="style-options" role="radiogroup" aria-label="表情风格">
          {STYLE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={style === option.id ? 'is-active' : ''}
              onClick={() => onStyleChange(option.id)}
              role="radio"
              aria-checked={style === option.id}
              title={option.description}
            >
              <i style={{ backgroundColor: option.color }} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="generate-button"
          onClick={onGenerate}
          disabled={generating}
        >
          {generating ? (
            <LoaderCircle className="spin" size={19} />
          ) : (
            <Sparkles size={19} />
          )}
          {generating ? '正在创作' : '生成一组'}
        </button>
      </div>
    </section>
  )
}
