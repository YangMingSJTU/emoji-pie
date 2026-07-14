import {
  ArrowDown,
  Heart,
  History,
  Image as ImageIcon,
  Search,
  Sparkles,
  Trash2,
  WandSparkles
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_AGENT_RUNTIME_SETTINGS,
  DEFAULT_EMOJI_RENDER_SETTINGS,
  type AgentRuntimeSettings,
  type AppInfo,
  type EmojiRecord,
  type EmojiRenderSettings,
  type EmojiStyle,
  type GenerationMode,
  type TextAnalysis
} from '../../shared/types'
import { Composer } from './components/Composer'
import { EmojiGrid } from './components/EmojiGrid'
import { AgentRuntimeView } from './components/AgentRuntimeView'
import { Brand, Sidebar, type PageId } from './components/Sidebar'
import { Toast, type ToastKind, type ToastState } from './components/Toast'
import { PROMPT_SUGGESTIONS, SCENE_LABELS } from './config'
import { desktopApi } from './lib/desktop-api'
import { renderEmoji } from './lib/emoji-renderer'
import {
  analyzeText,
  createGenerationSpecs,
  type GenerationOverrides
} from './lib/text-analysis'

const DEMOS: Array<{ prompt: string; mode: GenerationMode; style: EmojiStyle }> = [
  { prompt: '今天又要加班', mode: 'express', style: 'office' },
  { prompt: '我真的服了', mode: 'express', style: 'classic' },
  { prompt: '好耶，终于下班了', mode: 'express', style: 'cute' },
  { prompt: '这个需求很简单', mode: 'reply', style: 'chaos' }
]

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function specsToRecords(
  prompt: string,
  mode: GenerationMode,
  style: EmojiStyle,
  count: number,
  offset: number,
  nonce: number,
  renderSettings: EmojiRenderSettings,
  overrides?: GenerationOverrides
): EmojiRecord[] {
  const createdAt = new Date().toISOString()
  return createGenerationSpecs(prompt, mode, style, count, offset, nonce, overrides).map((spec) => ({
    ...spec,
    layout: renderSettings.layout,
    embedCaption: renderSettings.embedCaption,
    dataUrl: renderEmoji(spec, renderSettings),
    favorite: false,
    createdAt
  }))
}

function makeDemos(renderSettings: EmojiRenderSettings): EmojiRecord[] {
  return DEMOS.flatMap((demo, index) =>
    specsToRecords(
      demo.prompt,
      demo.mode,
      demo.style,
      1,
      index,
      10_000 + index,
      renderSettings
    )
  )
}

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<PageId>('create')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<GenerationMode>('express')
  const [style, setStyle] = useState<EmojiStyle>('classic')
  const [results, setResults] = useState<EmojiRecord[]>([])
  const [library, setLibrary] = useState<EmojiRecord[]>([])
  const [analysis, setAnalysis] = useState<TextAnalysis | null>(null)
  const [activePrompt, setActivePrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [appInfo, setAppInfo] = useState<AppInfo>({ version: '0.1.0', platform: 'unknown' })
  const [agentRuntimeSettings, setAgentRuntimeSettings] = useState<AgentRuntimeSettings>(
    DEFAULT_AGENT_RUNTIME_SETTINGS
  )
  const [renderSettings, setRenderSettings] = useState<EmojiRenderSettings>(
    DEFAULT_EMOJI_RENDER_SETTINGS
  )
  const [analysisSource, setAnalysisSource] = useState('本地规则')
  const [toast, setToast] = useState<ToastState | null>(null)
  const mainRef = useRef<HTMLElement>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef(false)
  const autoLoadedLengthRef = useRef(0)
  const generationOverridesRef = useRef<GenerationOverrides | undefined>(undefined)
  const activeRenderSettingsRef = useRef<EmojiRenderSettings>(DEFAULT_EMOJI_RENDER_SETTINGS)

  const showToast = useCallback((message: string, kind: ToastKind = 'success') => {
    setToast({ id: Date.now(), message, kind })
  }, [])

  const updateRenderSettings = useCallback((settings: EmojiRenderSettings): void => {
    setRenderSettings(settings)
    void desktopApi.renderSettings.save(settings).catch(() => {
      showToast('画面设置保存失败', 'error')
    })
  }, [showToast])

  useEffect(() => {
    let active = true
    void Promise.all([
      desktopApi.library.list(),
      desktopApi.app.getInfo(),
      desktopApi.renderSettings.get(),
      desktopApi.runtime.getSettings()
    ])
      .then(([records, info, savedRenderSettings, runtimeSettings]) => {
        if (!active) return
        setLibrary(records)
        setAppInfo(info)
        setRenderSettings(savedRenderSettings)
        setAgentRuntimeSettings(runtimeSettings)
      })
      .catch(() => showToast('本地资料库读取失败', 'error'))
      .finally(() => {
        if (active) setLibraryLoading(false)
      })
    return () => {
      active = false
    }
  }, [showToast])

  const demos = useMemo(() => makeDemos(renderSettings), [renderSettings])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const generate = useCallback(
    async (append = false): Promise<void> => {
      const normalizedPrompt = prompt.trim()
      if (!normalizedPrompt) {
        showToast('先输入一句想做成表情的话', 'info')
        return
      }
      if (busyRef.current) return

      busyRef.current = true
      setGenerating(true)
      try {
        if (append && normalizedPrompt !== activePrompt) return

        let overrides = append ? generationOverridesRef.current : undefined
        let source = append ? analysisSource : '本地规则'
        let usedFallback = false

        if (!append && agentRuntimeSettings.enabled) {
          try {
            const runtimeResult = await desktopApi.runtime.generate({
              prompt: normalizedPrompt,
              mode
            })
            overrides = {
              analysis: runtimeResult.analysis,
              variants: runtimeResult.variants
            }
            source = `${runtimeResult.runtimeName} · ${runtimeResult.model}`
          } catch (error) {
            console.warn('Agent runtime generation failed; using deterministic fallback.', error)
            usedFallback = true
          }
        } else {
          await wait(append ? 140 : 360)
        }

        const nextAnalysis = overrides?.analysis ?? analyzeText(normalizedPrompt, mode)
        overrides = { ...overrides, analysis: nextAnalysis }
        if (!append) generationOverridesRef.current = overrides

        const batchRenderSettings = append
          ? activeRenderSettingsRef.current
          : { ...renderSettings }
        if (!append) activeRenderSettingsRef.current = batchRenderSettings
        const count = append ? 6 : 9
        const offset = append ? results.length : 0
        const records = specsToRecords(
          normalizedPrompt,
          mode,
          style,
          count,
          offset,
          Date.now() + offset,
          batchRenderSettings,
          overrides
        )
        await desktopApi.library.save(records)
        setResults((current) => (append ? [...current, ...records] : records))
        setLibrary((current) => {
          const ids = new Set(records.map((record) => record.id))
          return [...records, ...current.filter((record) => !ids.has(record.id))].slice(0, 240)
        })
        setAnalysis(nextAnalysis)
        setAnalysisSource(source)
        setActivePrompt(normalizedPrompt)
        if (!append) {
          showToast(
            usedFallback ? 'AI 运行时暂不可用，已使用规则生成' : `已生成 ${count} 张新表情`,
            usedFallback ? 'info' : 'success'
          )
        }
      } catch (error) {
        console.error(error)
        showToast('生成失败，请再试一次', 'error')
      } finally {
        busyRef.current = false
        setGenerating(false)
      }
    },
    [
      activePrompt,
      agentRuntimeSettings,
      analysisSource,
      mode,
      prompt,
      renderSettings,
      results.length,
      showToast,
      style
    ]
  )

  useEffect(() => {
    const target = loadMoreRef.current
    if (!target || page !== 'create' || results.length < 9 || generating) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          autoLoadedLengthRef.current !== results.length &&
          !busyRef.current
        ) {
          autoLoadedLengthRef.current = results.length
          void generate(true)
        }
      },
      { root: mainRef.current, rootMargin: '80px 0px' }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [generate, generating, page, results.length])

  const updateRecord = useCallback((id: string, changes: Partial<EmojiRecord>) => {
    const update = (records: EmojiRecord[]) =>
      records.map((record) => (record.id === id ? { ...record, ...changes } : record))
    setResults(update)
    setLibrary(update)
  }, [])

  const handleFavorite = useCallback(
    async (record: EmojiRecord): Promise<void> => {
      const favorite = !record.favorite
      try {
        await desktopApi.library.toggleFavorite(record.id, favorite)
        updateRecord(record.id, { favorite })
        showToast(favorite ? '已加入收藏' : '已取消收藏')
      } catch {
        showToast('收藏状态保存失败', 'error')
      }
    },
    [showToast, updateRecord]
  )

  const handleCopy = useCallback(
    async (record: EmojiRecord): Promise<void> => {
      try {
        await desktopApi.clipboard.writeImage(record.dataUrl)
        showToast('PNG 已复制，可以去聊天窗口粘贴了')
      } catch {
        showToast('图片复制失败，请使用保存按钮', 'error')
      }
    },
    [showToast]
  )

  const handleDownload = useCallback(
    async (record: EmojiRecord): Promise<void> => {
      try {
        const saved = await desktopApi.dialog.saveImage(record.dataUrl, record.caption)
        if (saved) showToast('表情图片已保存')
      } catch {
        showToast('图片保存失败', 'error')
      }
    },
    [showToast]
  )

  const handleDelete = useCallback(
    async (record: EmojiRecord): Promise<void> => {
      try {
        await desktopApi.library.delete(record.id)
        setLibrary((current) => current.filter((item) => item.id !== record.id))
        setResults((current) => current.filter((item) => item.id !== record.id))
        showToast('记录已删除', 'info')
      } catch {
        showToast('记录删除失败', 'error')
      }
    },
    [showToast]
  )

  const handleReuse = useCallback((record: EmojiRecord) => {
    setPrompt(record.prompt)
    setMode(record.mode)
    setStyle(record.style)
    updateRenderSettings({ layout: record.layout, embedCaption: record.embedCaption })
    setPage('create')
    window.setTimeout(() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 0)
  }, [updateRenderSettings])

  const handleClearHistory = useCallback(async () => {
    try {
      await desktopApi.library.clearHistory()
      setLibrary((current) => current.filter((record) => record.favorite))
      setResults((current) => current.filter((record) => record.favorite))
      showToast('未收藏的历史已清理', 'info')
    } catch {
      showToast('历史清理失败', 'error')
    }
  }, [showToast])

  const randomPrompt = useCallback(() => {
    const options = PROMPT_SUGGESTIONS[mode]
    const next = options[Math.floor(Math.random() * options.length)]
    setPrompt(next)
  }, [mode])

  const favoriteCount = library.filter((record) => record.favorite).length
  const libraryRecords = useMemo(() => {
    const source = page === 'favorites' ? library.filter((record) => record.favorite) : library
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!query) return source
    return source.filter(
      (record) =>
        record.prompt.toLocaleLowerCase().includes(query) ||
        record.caption.toLocaleLowerCase().includes(query)
    )
  }, [library, page, searchQuery])

  return (
    <div className="app-shell">
      <header className="titlebar">
        <Brand />
        <div className="titlebar-context">
          <span>创作工作台</span>
          <i />
          <small>
            {appInfo.platform === 'web'
              ? '浏览器预览'
              : agentRuntimeSettings.enabled
                ? 'AI 运行时'
                : '本地规则'}
          </small>
        </div>
      </header>

      <Sidebar
        page={page}
        historyCount={library.length}
        favoriteCount={favoriteCount}
        version={appInfo.version}
        onNavigate={(nextPage) => {
          setPage(nextPage)
          setSearchQuery('')
          window.setTimeout(() => mainRef.current?.scrollTo({ top: 0 }), 0)
        }}
      />

      <main ref={mainRef} className="workspace">
        {page === 'create' ? (
          <div className="workspace-inner create-view">
            <div className="page-heading">
              <div>
                <span className="eyebrow">
                  <Sparkles size={15} />
                  新建表情
                </span>
                <h1>把这句话做成表情</h1>
                <p>输入情绪或聊天内容，立即得到一组可以直接发送的黄脸表情。</p>
              </div>
            </div>

            <Composer
              prompt={prompt}
              mode={mode}
              style={style}
              renderSettings={renderSettings}
              generating={generating}
              onPromptChange={setPrompt}
              onModeChange={setMode}
              onStyleChange={setStyle}
              onRenderSettingsChange={updateRenderSettings}
              onGenerate={() => void generate(false)}
              onRandomPrompt={randomPrompt}
            />

            {results.length > 0 ? (
              <section className="result-section" aria-label="生成结果">
                <div className="section-heading result-heading">
                  <div>
                    <h2>为“{activePrompt}”生成</h2>
                    <div className="analysis-tags">
                      {analysis && (
                        <>
                          <span className="tag-emotion">{analysis.emotionLabel}</span>
                          <span>{SCENE_LABELS[analysis.scene]}场景</span>
                          <span>{analysis.tone}语气</span>
                          <span className="tag-source">{analysisSource}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <small>{results.length} 张结果</small>
                </div>
                <EmojiGrid
                  records={results}
                  loading={generating}
                  onCopy={handleCopy}
                  onDownload={handleDownload}
                  onFavorite={handleFavorite}
                />
                <div ref={loadMoreRef} className="load-more-sentinel">
                  <ArrowDown size={16} />
                  {generating ? '正在补充更多灵感' : '继续下滑，自动生成更多'}
                </div>
              </section>
            ) : (
              <section className="inspiration-section" aria-label="灵感样片">
                <div className="section-heading">
                  <div>
                    <h2>灵感样片</h2>
                    <p>选择上面的文案开始，也可以直接输入你的原话。</p>
                  </div>
                  <WandSparkles size={20} />
                </div>
                <EmojiGrid
                  records={demos}
                  compact
                  showFavorite={false}
                  onCopy={handleCopy}
                  onDownload={handleDownload}
                />
              </section>
            )}
          </div>
        ) : page === 'runtime' ? (
          <AgentRuntimeView
            settings={agentRuntimeSettings}
            onSettingsSaved={setAgentRuntimeSettings}
            onNotice={showToast}
          />
        ) : (
          <div className="workspace-inner library-view">
            <div className="library-header">
              <div>
                <span className="eyebrow">
                  {page === 'favorites' ? <Heart size={15} /> : <History size={15} />}
                  {page === 'favorites' ? '个人表情库' : '本地记录'}
                </span>
                <h1>{page === 'favorites' ? '我的收藏' : '最近生成'}</h1>
                <p>
                  {page === 'favorites'
                    ? '把常用的表情留在手边，点击图片即可复制。'
                    : '生成记录只保存在本机，可以随时复用原始文案。'}
                </p>
              </div>
              {page === 'history' && library.some((record) => !record.favorite) && (
                <button type="button" className="clear-button" onClick={() => void handleClearHistory()}>
                  <Trash2 size={16} />
                  清理未收藏
                </button>
              )}
            </div>

            <div className="library-toolbar">
              <div className="search-field">
                <Search size={17} />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="搜索文案或回复"
                  aria-label="搜索表情记录"
                />
              </div>
              <span>{libraryRecords.length} 项</span>
            </div>

            {libraryLoading ? (
              <EmojiGrid
                records={[]}
                loading
                onCopy={handleCopy}
                onDownload={handleDownload}
              />
            ) : libraryRecords.length > 0 ? (
              <EmojiGrid
                records={libraryRecords}
                showFavorite
                showDelete
                showReuse
                onCopy={handleCopy}
                onDownload={handleDownload}
                onFavorite={handleFavorite}
                onDelete={handleDelete}
                onReuse={handleReuse}
              />
            ) : (
              <div className="empty-library">
                <span>
                  {page === 'favorites' ? <Heart size={28} /> : <ImageIcon size={28} />}
                </span>
                <h2>{searchQuery ? '没有匹配的表情' : page === 'favorites' ? '还没有收藏' : '还没有生成记录'}</h2>
                <p>
                  {searchQuery
                    ? '换一个关键词再找找。'
                    : page === 'favorites'
                      ? '在生成结果上点一下爱心，就会出现在这里。'
                      : '从一句话开始，第一组表情很快就会出现在这里。'}
                </p>
                {!searchQuery && (
                  <button type="button" onClick={() => setPage('create')}>
                    <Sparkles size={17} />
                    去生成表情
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      <Toast toast={toast} />
    </div>
  )
}
