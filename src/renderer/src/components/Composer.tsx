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
import type {
  EmojiRenderSettings,
  EmojiStyleSelection,
  GenerationMode
} from '../../../shared/types'
import { PROMPT_SUGGESTIONS } from '../config'
import { EffectPicker } from './EffectPicker'

interface ComposerProps {
  prompt: string
  mode: GenerationMode
  style: EmojiStyleSelection
  renderSettings: EmojiRenderSettings
  generating: boolean
  onPromptChange: (value: string) => void
  onModeChange: (mode: GenerationMode) => void
  onStyleChange: (style: EmojiStyleSelection) => void
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
  const inlineOutput = renderSettings.outputType === 'inline'
  const generateLabel = inlineOutput
    ? '生成 Emoji'
    : renderSettings.layout === 'compact'
      ? '生成贴纸'
      : '生成海报'

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
        <div className="output-format-field">
          <span>输出形式</span>
          <div className="output-format-control" role="radiogroup" aria-label="输出形式">
            <button
              type="button"
              role="radio"
              aria-checked={inlineOutput}
              className={inlineOutput ? 'is-active' : ''}
              onClick={() => onRenderSettingsChange({ ...renderSettings, outputType: 'inline' })}
            >
              <Type size={15} />
              行内 Emoji
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!inlineOutput && renderSettings.layout === 'compact'}
              className={!inlineOutput && renderSettings.layout === 'compact' ? 'is-active' : ''}
              onClick={() => onRenderSettingsChange({
                ...renderSettings,
                outputType: 'image',
                layout: 'compact'
              })}
            >
              <Smile size={15} />
              黄脸贴纸
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!inlineOutput && renderSettings.layout === 'poster'}
              className={!inlineOutput && renderSettings.layout === 'poster' ? 'is-active' : ''}
              onClick={() => onRenderSettingsChange({
                ...renderSettings,
                outputType: 'image',
                layout: 'poster'
              })}
            >
              <ImageIcon size={15} />
              表情海报
            </button>
          </div>
        </div>

        {!inlineOutput && (
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
        )}
      </div>

      <div className={`composer-footer ${inlineOutput ? 'is-inline-output' : ''}`}>
        {inlineOutput ? (
          <div className="inline-output-preview" aria-label="行内 Emoji 输出预览">
            <span className="inline-output-preview-icon" aria-hidden="true">
              <Type size={17} />
            </span>
            <div>
              <strong>Unicode Emoji</strong>
              <small>5 个候选</small>
            </div>
            <div className="inline-output-preview-glyphs" aria-hidden="true">
              <span>🙂</span>
              <span>😄</span>
              <span>😮</span>
              <span>😑</span>
              <span>😭</span>
            </div>
          </div>
        ) : (
          <EffectPicker
            value={style}
            renderSettings={renderSettings}
            onChange={onStyleChange}
          />
        )}

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
          {generating ? '正在创作' : generateLabel}
        </button>
      </div>
    </section>
  )
}
