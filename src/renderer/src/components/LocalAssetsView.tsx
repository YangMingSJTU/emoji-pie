import {
  CheckCircle2,
  FolderOpen,
  ImagePlus,
  Images,
  Pencil,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  normalizeLocalAssetText,
  validateLocalAssetMetadata,
  type LocalAssetDto,
  type LocalImportItemDto,
  type LocalImportSessionDto,
  type LocalImportSourceKind
} from '../../../shared/local-assets'
import { desktopApi } from '../lib/desktop-api'
import { isLocalImportFullyComplete } from '../lib/local-import-state'
import type { ToastKind } from './Toast'

interface LocalAssetsViewProps {
  onNotice: (message: string, kind?: ToastKind) => void
  onAssetDeleted?: (assetId: string) => void
}

interface DraftValue {
  displayName: string
  tagsText: string
}

function parseTags(value: string): string[] {
  return value.split(/[,，\n]/u).map((tag) => tag.trim()).filter(Boolean)
}

function itemDraft(item: LocalImportItemDto): DraftValue {
  return {
    displayName: item.displayName ?? item.originalFilename.replace(/\.[^.]+$/u, ''),
    tagsText: item.tags.map((tag) => tag.displayValue).join('，')
  }
}

function errorLabel(item: LocalImportItemDto): string {
  if (item.state === 'duplicate') return '已存在，已跳过'
  if (item.error?.code === 'file_too_large') return '文件超过 20 MiB'
  if (item.error?.code === 'animated_image_rejected') return '暂不支持动画图片'
  if (item.error?.code === 'unsupported_type') return '扩展名与图片内容不一致'
  return item.error?.message ?? '图片处理失败'
}

export function LocalAssetsView({ onNotice, onAssetDeleted }: LocalAssetsViewProps): React.JSX.Element {
  const [assets, setAssets] = useState<LocalAssetDto[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [rightsSource, setRightsSource] = useState<LocalImportSourceKind | null>(null)
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [session, setSession] = useState<LocalImportSessionDto | null>(null)
  const [rightsError, setRightsError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, DraftValue>>({})
  const [busy, setBusy] = useState(false)
  const [completedCount, setCompletedCount] = useState<number | null>(null)
  const [editing, setEditing] = useState<LocalAssetDto | null>(null)
  const [editDraft, setEditDraft] = useState<DraftValue>({ displayName: '', tagsText: '' })
  const [deleting, setDeleting] = useState<LocalAssetDto | null>(null)

  const loadAssets = useCallback(async (): Promise<void> => {
    const result = await desktopApi.localAssets.list()
    if (!result.ok) {
      setLoadError(result.error.message)
      setAssets([])
      return
    }
    setLoadError(null)
    setAssets(result.value)
  }, [])

  useEffect(() => {
    let active = true
    void loadAssets().catch(() => {
      if (active) setLoadError('本地素材库读取失败')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
    }
  }, [loadAssets])

  useEffect(() => {
    if (!session?.items.some((item) => item.state === 'processing')) return
    let cancelled = false
    const timer = window.setInterval(() => {
      void desktopApi.localAssets.getImportSession({ sessionId: session.id }).then((result) => {
        if (cancelled || !result.ok) return
        setSession(result.value)
        setDrafts((current) => {
          const next = { ...current }
          for (const item of result.value.items) {
            if (item.state === 'staged' && !next[item.id]) next[item.id] = itemDraft(item)
          }
          return next
        })
      })
    }, 180)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [session])

  const filteredAssets = useMemo(() => {
    const normalized = normalizeLocalAssetText(query)
    if (!normalized) return assets
    return assets.filter((asset) =>
      normalizeLocalAssetText(asset.displayName).includes(normalized) ||
      asset.tags.some((tag) => tag.normalizedValue.includes(normalized))
    )
  }, [assets, query])

  const stagedItems = session?.items.filter((item) => item.state === 'staged') ?? []
  const processingCount = session?.items.filter((item) => item.state === 'processing').length ?? 0
  const invalidDraftIds = new Set(stagedItems.filter((item) => {
    const draft = drafts[item.id] ?? itemDraft(item)
    return validateLocalAssetMetadata(draft.displayName, parseTags(draft.tagsText)).length > 0
  }).map((item) => item.id))

  const closeImport = useCallback(() => {
    setSession(null)
    setDrafts({})
    setCompletedCount(null)
  }, [])

  const beginImport = useCallback(async () => {
    if (!rightsSource || !rightsConfirmed) return
    setBusy(true)
    try {
      setRightsError(null)
      const result = await desktopApi.localAssets.beginImport({
        sourceKind: rightsSource,
        rightsConfirmed: true
      })
      if (!result.ok) {
        if (result.error.code === 'cancelled') {
          setRightsSource(null)
          setRightsConfirmed(false)
        } else {
          setRightsError(result.error.message)
          onNotice(result.error.message, 'error')
        }
        return
      }
      setSession(result.value)
      setDrafts(Object.fromEntries(result.value.items.map((item) => [item.id, itemDraft(item)])))
      setRightsSource(null)
      setRightsConfirmed(false)
    } catch {
      setRightsError('无法读取所选图片，请检查访问权限后重试')
      onNotice('无法读取所选图片，请检查访问权限后重试', 'error')
    } finally {
      setBusy(false)
    }
  }, [onNotice, rightsConfirmed, rightsSource])

  const finalizeImport = useCallback(async () => {
    if (!session || stagedItems.length === 0 || invalidDraftIds.size > 0) return
    setBusy(true)
    try {
      for (const item of stagedItems) {
        const draft = drafts[item.id] ?? itemDraft(item)
        const updated = await desktopApi.localAssets.updateImportDraft({
          sessionId: session.id,
          itemId: item.id,
          displayName: draft.displayName,
          tags: parseTags(draft.tagsText)
        })
        if (!updated.ok) {
          onNotice(updated.error.message, 'error')
          return
        }
      }
      const result = await desktopApi.localAssets.finalizeImport({
        sessionId: session.id,
        itemIds: stagedItems.map((item) => item.id)
      })
      if (!result.ok) {
        onNotice(result.error.message, 'error')
        return
      }
      setSession(result.value.session)
      if (isLocalImportFullyComplete(result.value)) {
        setCompletedCount(result.value.finalizedItemIds.length)
      } else {
        setCompletedCount(null)
      }
      await loadAssets()
      const rejectedCount = new Set([
        ...result.value.rejectedItems.map((rejection) => rejection.itemId),
        ...result.value.session.items.filter((item) => item.state === 'failed').map((item) => item.id)
      ]).size
      onNotice(rejectedCount > 0
        ? `已导入 ${result.value.finalizedItemIds.length} 张，${rejectedCount} 张需处理`
        : `已导入 ${result.value.finalizedItemIds.length} 张本地素材`, rejectedCount > 0 ? 'error' : undefined)
    } finally {
      setBusy(false)
    }
  }, [drafts, invalidDraftIds, loadAssets, onNotice, session, stagedItems])

  const cancelImport = useCallback(async () => {
    if (!session) return
    setBusy(true)
    try {
      const result = await desktopApi.localAssets.cancelImport({ sessionId: session.id })
      if (!result.ok) {
        onNotice(result.error.message, 'error')
        return
      }
      closeImport()
    } finally {
      setBusy(false)
    }
  }, [closeImport, onNotice, session])

  const retryFailed = useCallback(async () => {
    if (!session) return
    const itemIds = session.items.filter((item) => item.state === 'failed').map((item) => item.id)
    if (itemIds.length === 0) return
    setBusy(true)
    try {
      const result = await desktopApi.localAssets.retryImportItems({
        sessionId: session.id,
        itemIds
      })
      if (!result.ok) {
        onNotice(result.error.message, 'error')
        setCompletedCount(null)
      }
      else {
        setCompletedCount(null)
        setSession(result.value)
      }
    } finally {
      setBusy(false)
    }
  }, [onNotice, session])

  const saveEdit = useCallback(async () => {
    if (!editing) return
    const tags = parseTags(editDraft.tagsText)
    if (validateLocalAssetMetadata(editDraft.displayName, tags).length > 0) return
    setBusy(true)
    try {
      const result = await desktopApi.localAssets.updateMetadata({
        assetId: editing.id,
        displayName: editDraft.displayName,
        tags
      })
      if (!result.ok) {
        onNotice(result.error.message, 'error')
        return
      }
      setAssets((current) => current.map((asset) => asset.id === editing.id ? result.value : asset))
      setEditing(null)
      onNotice('素材信息已更新')
    } finally {
      setBusy(false)
    }
  }, [editDraft, editing, onNotice])

  const confirmDelete = useCallback(async () => {
    if (!deleting) return
    setBusy(true)
    try {
      const result = await desktopApi.localAssets.delete({ assetId: deleting.id })
      if (!result.ok) {
        onNotice(result.error.message, 'error')
        return
      }
      setAssets((current) => current.filter((asset) => asset.id !== deleting.id))
      onAssetDeleted?.(deleting.id)
      setDeleting(null)
      onNotice('已从本地素材库删除；既有历史与收藏已保留', 'info')
    } finally {
      setBusy(false)
    }
  }, [deleting, onAssetDeleted, onNotice])

  return (
    <div className="workspace-inner local-assets-view">
      <div className="local-assets-header">
        <div>
          <span className="eyebrow"><Images size={15} /> 本机图片库</span>
          <h1>本地素材</h1>
          <p>图片、标签与检索都保存在本机，导入不会修改原文件。</p>
        </div>
        <div className="local-assets-header-actions">
          <button type="button" onClick={() => setRightsSource('files')}>
            <ImagePlus size={16} /> 导入图片
          </button>
          <button type="button" onClick={() => setRightsSource('directory')}>
            <FolderOpen size={16} /> 导入文件夹
          </button>
        </div>
      </div>

      <div className="local-assets-toolbar">
        <label>
          <Search size={16} />
          <span className="sr-only">搜索本地素材</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称或标签"
          />
        </label>
        <span>{filteredAssets.length} 张素材</span>
      </div>

      {loading ? (
        <div className="local-assets-empty"><p>正在读取本地素材库…</p></div>
      ) : loadError ? (
        <div className="local-assets-empty">
          <Images size={34} />
          <h2>本地素材暂不可用</h2>
          <p>{loadError}</p>
        </div>
      ) : filteredAssets.length === 0 ? (
        <div className="local-assets-empty">
          <Images size={34} />
          <h2>{query ? '没有匹配的本地素材' : '建立你的本地梗图库'}</h2>
          <p>{query ? '换个名称或标签再试试。' : '导入图片、补充标签，之后就能按文字在本机匹配。'}</p>
          {!query && (
            <button type="button" onClick={() => setRightsSource('files')}>
              <ImagePlus size={16} /> 导入图片
            </button>
          )}
        </div>
      ) : (
        <div className="local-assets-grid" aria-live="polite">
          {filteredAssets.map((asset) => (
            <article key={asset.id} className="local-asset-card">
              <img src={asset.thumbnailUrl} alt="" />
              <div className="local-asset-card-body">
                <strong>{asset.displayName}</strong>
                <div className="local-asset-tags">
                  {asset.tags.slice(0, 3).map((tag) => <span key={tag.normalizedValue}>#{tag.displayValue}</span>)}
                  {asset.tags.length > 3 && <small>+{asset.tags.length - 3}</small>}
                </div>
                <button
                  type="button"
                  aria-label={`编辑 ${asset.displayName}`}
                  onClick={() => {
                    setEditing(asset)
                    setEditDraft({
                      displayName: asset.displayName,
                      tagsText: asset.tags.map((tag) => tag.displayValue).join('，')
                    })
                  }}
                >
                  <Pencil size={14} /> 编辑
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {rightsSource && (
        <div className="local-assets-modal-backdrop" role="presentation">
          <section className="local-assets-dialog" role="dialog" aria-modal="true" aria-labelledby="rights-title">
            <button className="dialog-close" type="button" aria-label="关闭" onClick={() => setRightsSource(null)}>
              <X size={18} />
            </button>
            <h2 id="rights-title">确认图片使用权限</h2>
            <p>表情派会把所选图片复制到应用的本地素材库；不会修改原文件，也不会上传。</p>
            <label className="rights-confirmation">
              <input
                type="checkbox"
                checked={rightsConfirmed}
                onChange={(event) => setRightsConfirmed(event.target.checked)}
              />
              <span>我拥有这些图片，或已获得使用这些图片的权限。</span>
            </label>
            {rightsError && <p role="alert">{rightsError}</p>}
            <div className="dialog-actions">
              <button type="button" onClick={() => setRightsSource(null)}>取消</button>
              <button type="button" disabled={!rightsConfirmed || busy} onClick={() => void beginImport()}>
                {busy ? '正在打开…' : '确认并选择'}
              </button>
            </div>
          </section>
        </div>
      )}

      {session && (
        <div className="local-assets-modal-backdrop" role="presentation">
          <section className="local-assets-dialog import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <h2 id="import-title">导入本地素材</h2>
            {processingCount > 0 ? (
              <div className="import-progress">
                <progress
                  max={session.items.length}
                  value={session.items.length - processingCount}
                  aria-label="图片检查进度"
                />
                <p>正在检查图片 {session.items.length - processingCount} / {session.items.length}</p>
              </div>
            ) : completedCount !== null ? (
              <div className="import-complete">
                <CheckCircle2 size={38} />
                <h3>已导入 {completedCount} 张</h3>
                <p>重复或无效图片不会进入素材库。</p>
                <button type="button" onClick={closeImport}>查看本地素材</button>
              </div>
            ) : (
              <>
                <p className="import-summary">
                  还需补标签 {invalidDraftIds.size} 张 · 重复/失败{' '}
                  {session.items.filter((item) => item.state === 'duplicate' || item.state === 'failed').length} 张
                </p>
                <div className="import-item-list">
                  {session.items.map((item) => {
                    const draft = drafts[item.id] ?? itemDraft(item)
                    const editable = item.state === 'staged'
                    return (
                      <div key={item.id} className={`import-item is-${item.state}`}>
                        <div className="import-item-copy">
                          <strong>{item.originalFilename}</strong>
                          {editable ? (
                            <>
                              <label>
                                <span>名称</span>
                                <input
                                  value={draft.displayName}
                                  aria-label={`${item.originalFilename} 名称`}
                                  onChange={(event) => setDrafts((current) => ({
                                    ...current,
                                    [item.id]: { ...draft, displayName: event.target.value }
                                  }))}
                                />
                              </label>
                              <label>
                                <span>标签</span>
                                <input
                                  value={draft.tagsText}
                                  aria-label={`${item.originalFilename} 标签`}
                                  placeholder="用逗号分隔，至少 1 个"
                                  onChange={(event) => setDrafts((current) => ({
                                    ...current,
                                    [item.id]: { ...draft, tagsText: event.target.value }
                                  }))}
                                />
                              </label>
                              {invalidDraftIds.has(item.id) && <small>名称 1–60 字；标签 1–12 个，每个 1–20 字</small>}
                            </>
                          ) : (
                            <span>{errorLabel(item)}</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="dialog-actions import-actions">
                  <button type="button" disabled={busy} onClick={() => void cancelImport()}>取消导入</button>
                  {session.items.some((item) => item.state === 'failed') && (
                    <button type="button" disabled={busy} onClick={() => void retryFailed()}>重试失败项</button>
                  )}
                  <button
                    type="button"
                    disabled={busy || stagedItems.length === 0 || invalidDraftIds.size > 0}
                    onClick={() => void finalizeImport()}
                  >
                    {busy ? '正在导入…' : `导入 ${stagedItems.length} 张`}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {editing && (
        <div className="local-assets-modal-backdrop" role="presentation">
          <section className="local-assets-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-title">
            <h2 id="edit-title">编辑素材</h2>
            <label className="dialog-field">
              <span>名称</span>
              <input value={editDraft.displayName} onChange={(event) => setEditDraft((current) => ({
                ...current, displayName: event.target.value
              }))} />
            </label>
            <label className="dialog-field">
              <span>标签</span>
              <input value={editDraft.tagsText} onChange={(event) => setEditDraft((current) => ({
                ...current, tagsText: event.target.value
              }))} />
            </label>
            <p className="asset-file-facts">{editing.originalFilename} · {editing.width}×{editing.height}</p>
            <button type="button" className="danger-link" onClick={() => {
              setDeleting(editing)
              setEditing(null)
            }}><Trash2 size={15} /> 删除素材</button>
            <div className="dialog-actions">
              <button type="button" onClick={() => setEditing(null)}>取消</button>
              <button
                type="button"
                disabled={busy || validateLocalAssetMetadata(
                  editDraft.displayName,
                  parseTags(editDraft.tagsText)
                ).length > 0}
                onClick={() => void saveEdit()}
              >保存</button>
            </div>
          </section>
        </div>
      )}

      {deleting && (
        <div className="local-assets-modal-backdrop" role="presentation">
          <section className="local-assets-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
            <h2 id="delete-title">从本地素材库删除“{deleting.displayName}”？</h2>
            <p>将删除应用管理的素材副本、缩略图、名称、标签与检索记录；它不会再用于新的生成或换一批。</p>
            <p>不会删除原始导入文件、已导出图片、已有生成历史或收藏；旧记录会标记“源素材已删除”。</p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setDeleting(null)}>取消</button>
              <button className="danger-button" type="button" disabled={busy} onClick={() => void confirmDelete()}>
                {busy ? '正在删除…' : '删除素材'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
