import { Check, Image as ImageIcon, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { LocalAssetDto, LocalAssetMatchMode } from '../../../shared/local-assets'

export type PosterBackgroundSource = 'original' | 'local'

interface LocalPosterControlsProps {
  source: PosterBackgroundSource
  matchMode: LocalAssetMatchMode
  assets: LocalAssetDto[]
  selectedAssetIds: string[]
  loading: boolean
  error: string | null
  onSourceChange: (source: PosterBackgroundSource) => void
  onMatchModeChange: (mode: LocalAssetMatchMode) => void
  onSelectedAssetIdsChange: (assetIds: string[]) => void
  onOpenLibrary: () => void
  onRetry: () => void
}

export function LocalPosterControls({
  source,
  matchMode,
  assets,
  selectedAssetIds,
  loading,
  error,
  onSourceChange,
  onMatchModeChange,
  onSelectedAssetIdsChange,
  onOpenLibrary,
  onRetry
}: LocalPosterControlsProps): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [draftSelection, setDraftSelection] = useState<string[]>([])
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const filteredAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return assets
    return assets.filter((asset) =>
      asset.displayName.toLocaleLowerCase().includes(normalizedQuery) ||
      asset.tags.some((tag) => tag.displayValue.toLocaleLowerCase().includes(normalizedQuery))
    )
  }, [assets, query])

  const openPicker = (): void => {
    setDraftSelection(selectedAssetIds.filter((assetId) =>
      assets.some((asset) => asset.id === assetId)
    ))
    setSelectionError(null)
    setQuery('')
    setPickerOpen(true)
  }

  const toggleDraft = (assetId: string): void => {
    if (draftSelection.includes(assetId)) {
      setDraftSelection((current) => current.filter((id) => id !== assetId))
      setSelectionError(null)
      return
    }
    if (draftSelection.length >= 9) {
      setSelectionError('手动模式最多选择 9 张素材；请先取消一张再选择。')
      return
    }
    setDraftSelection((current) => [...current, assetId])
    setSelectionError(null)
  }

  return (
    <div className="local-poster-controls">
      <div className="local-poster-source-row">
        <span>海报底图</span>
        <div role="radiogroup" aria-label="海报底图">
          <button
            type="button"
            role="radio"
            aria-checked={source === 'original'}
            className={source === 'original' ? 'is-active' : ''}
            onClick={() => onSourceChange('original')}
          >
            原创黄脸
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={source === 'local'}
            className={source === 'local' ? 'is-active' : ''}
            onClick={() => onSourceChange('local')}
          >
            本地素材
          </button>
        </div>
      </div>

      {source === 'local' && (
        <div className="local-poster-panel">
          {loading ? (
            <p role="status">正在读取本地素材…</p>
          ) : error ? (
            <div className="local-poster-inline-state" role="alert">
              <p>{error}</p>
              <button type="button" onClick={onRetry}>重试</button>
            </div>
          ) : assets.length === 0 ? (
            <div className="local-poster-inline-state">
              <p>本地素材库还是空的，先导入并补充标签。</p>
              <button type="button" onClick={onOpenLibrary}>去导入素材</button>
            </div>
          ) : (
            <>
              <div className="local-poster-mode-row">
                <div role="radiogroup" aria-label="素材选择方式">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={matchMode === 'automatic'}
                    className={matchMode === 'automatic' ? 'is-active' : ''}
                    onClick={() => onMatchModeChange('automatic')}
                  >自动匹配</button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={matchMode === 'manual'}
                    className={matchMode === 'manual' ? 'is-active' : ''}
                    onClick={() => onMatchModeChange('manual')}
                  >手动选图</button>
                </div>
                <small>共 {assets.length} 张 · 本机匹配</small>
              </div>
              {matchMode === 'automatic' ? (
                <p className="local-poster-privacy">按名称和标签匹配；素材与标签不会发送到 AI 运行时。</p>
              ) : (
                <div className="manual-poster-summary">
                  <span>已选 {selectedAssetIds.length}/9 张，结果按选择顺序生成。</span>
                  <button id="local-poster-picker-button" type="button" onClick={openPicker}>
                    <ImageIcon size={15} />
                    {selectedAssetIds.length > 0 ? '重新选图' : '选择素材'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {pickerOpen && (
        <div className="local-assets-modal-backdrop" role="presentation">
          <section className="local-assets-dialog local-poster-picker" role="dialog" aria-modal="true" aria-labelledby="poster-picker-title">
            <button className="dialog-close" type="button" aria-label="关闭" onClick={() => setPickerOpen(false)}>
              <X size={18} />
            </button>
            <h2 id="poster-picker-title">手动选择本地素材</h2>
            <p>选择 1–9 张；每张生成一张海报，顺序与选择顺序一致。</p>
            <label className="local-poster-picker-search">
              <Search size={16} />
              <span className="sr-only">搜索可选素材</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或标签" />
            </label>
            <div className="local-poster-picker-grid">
              {filteredAssets.map((asset) => {
                const selectedIndex = draftSelection.indexOf(asset.id)
                return (
                  <label key={asset.id} className={selectedIndex >= 0 ? 'is-selected' : ''}>
                    <input
                      type="checkbox"
                      checked={selectedIndex >= 0}
                      onChange={() => toggleDraft(asset.id)}
                    />
                    <img src={asset.thumbnailUrl} alt="" />
                    <strong>{asset.displayName}</strong>
                    {selectedIndex >= 0 && <span><Check size={13} /> {selectedIndex + 1}</span>}
                  </label>
                )
              })}
            </div>
            {selectionError && <p className="local-poster-picker-error" role="alert">{selectionError}</p>}
            <div className="dialog-actions">
              <button type="button" onClick={() => setPickerOpen(false)}>取消</button>
              <button
                type="button"
                disabled={draftSelection.length === 0}
                onClick={() => {
                  onSelectedAssetIdsChange(draftSelection)
                  setPickerOpen(false)
                }}
              >确认选择 {draftSelection.length} 张</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
