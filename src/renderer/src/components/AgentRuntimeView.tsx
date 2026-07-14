import {
  AlertCircle,
  BrainCircuit,
  CheckCircle2,
  Code2,
  Cpu,
  Database,
  HardDrive,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Server,
  TerminalSquare
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_RUNTIME_ENDPOINTS,
  type AgentRuntimeDescriptor,
  type AgentRuntimeDiscovery,
  type AgentRuntimeId,
  type AgentRuntimeKind,
  type AgentRuntimeSettings,
  type AgentRuntimeStatus
} from '../../../shared/types'
import { desktopApi } from '../lib/desktop-api'

type NoticeKind = 'success' | 'error' | 'info'

interface AgentRuntimeViewProps {
  settings: AgentRuntimeSettings
  onSettingsSaved: (settings: AgentRuntimeSettings) => void
  onNotice: (message: string, kind?: NoticeKind) => void
}

const STATUS_LABELS: Record<AgentRuntimeStatus, string> = {
  ready: '可用',
  unavailable: '未检测到',
  error: '检测失败'
}

const LOCAL_MODEL_IDS = new Set<AgentRuntimeId>(['ollama', 'lmstudio', 'openai-compatible'])

function emptyRuntime(
  id: AgentRuntimeId,
  name: string,
  command: string,
  kind: AgentRuntimeKind
): AgentRuntimeDescriptor {
  return {
    id,
    name,
    kind,
    command,
    status: 'unavailable',
    installed: false,
    executablePath: '',
    endpoint: DEFAULT_RUNTIME_ENDPOINTS[id],
    canStart: false,
    runningOwned: false,
    version: '',
    models: [],
    message: '等待检测'
  }
}

const EMPTY_RUNTIMES: AgentRuntimeDescriptor[] = [
  emptyRuntime('ollama', 'Ollama', 'ollama', 'local-model'),
  emptyRuntime('lmstudio', 'LM Studio', 'OpenAI API', 'local-model'),
  emptyRuntime('openai-compatible', 'OpenAI Compatible', 'Local API', 'local-model'),
  emptyRuntime('claude', 'Claude Code', 'claude', 'agent-cli'),
  emptyRuntime('codex', 'Codex', 'codex', 'agent-cli'),
  emptyRuntime('opencode', 'OpenCode', 'opencode', 'agent-cli')
]

function kindForRuntime(runtimeId: AgentRuntimeId): AgentRuntimeKind {
  return LOCAL_MODEL_IDS.has(runtimeId) ? 'local-model' : 'agent-cli'
}

function signature(settings: AgentRuntimeSettings): string {
  return [
    settings.runtimeId,
    settings.executablePath.trim(),
    settings.endpoint.trim()
  ].join(':')
}

function RuntimeIcon({ id }: { id: AgentRuntimeId }): React.JSX.Element {
  if (id === 'ollama') return <Server size={18} />
  if (id === 'lmstudio') return <HardDrive size={18} />
  if (id === 'openai-compatible') return <Database size={18} />
  if (id === 'claude') return <BrainCircuit size={18} />
  if (id === 'codex') return <TerminalSquare size={18} />
  return <Code2 size={18} />
}

export function AgentRuntimeView({
  settings,
  onSettingsSaved,
  onNotice
}: AgentRuntimeViewProps): React.JSX.Element {
  const [draft, setDraft] = useState(settings)
  const [kind, setKind] = useState<AgentRuntimeKind>(kindForRuntime(settings.runtimeId))
  const [discovery, setDiscovery] = useState<AgentRuntimeDiscovery | null>(null)
  const [scannedSignature, setScannedSignature] = useState('')
  const [scanning, setScanning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [saving, setSaving] = useState(false)

  const scan = useCallback(
    async (candidate: AgentRuntimeSettings, announce = false): Promise<void> => {
      setScanning(true)
      try {
        const result = await desktopApi.runtime.discover(candidate)
        setDiscovery(result)
        setScannedSignature(signature(candidate))
        const selected = result.runtimes.find(({ id }) => id === candidate.runtimeId)
        if (selected?.kind === 'local-model' && !candidate.model && selected.models[0]) {
          setDraft((current) => signature(current) === signature(candidate) && !current.model
            ? { ...current, model: selected.models[0].id }
            : current)
        }
        if (announce) onNotice('AI 运行时状态已刷新', 'info')
      } catch (error) {
        onNotice(error instanceof Error ? error.message : 'AI 运行时检测失败', 'error')
      } finally {
        setScanning(false)
      }
    },
    [onNotice]
  )

  useEffect(() => {
    setDraft(settings)
    setKind(kindForRuntime(settings.runtimeId))
    void scan(settings)
  }, [scan, settings])

  const runtimes = discovery?.runtimes ?? EMPTY_RUNTIMES
  const visibleRuntimes = useMemo(
    () => runtimes.filter((runtime) => runtime.kind === kind),
    [kind, runtimes]
  )
  const selectedRuntime = useMemo(
    () => runtimes.find((runtime) => runtime.id === draft.runtimeId) ?? runtimes[0],
    [draft.runtimeId, runtimes]
  )
  const configurationScanned = scannedSignature === signature(draft)
  const runtimeReady = configurationScanned && selectedRuntime?.status === 'ready'
  const localModelSelected = selectedRuntime?.kind === 'local-model'
  const modelOptions = selectedRuntime?.models ?? []
  const savedModelMissing = Boolean(draft.model) && !modelOptions.some(({ id }) => id === draft.model)

  const selectRuntime = useCallback((runtime: AgentRuntimeDescriptor): void => {
    const next: AgentRuntimeSettings = {
      ...draft,
      runtimeId: runtime.id,
      executablePath: '',
      endpoint: DEFAULT_RUNTIME_ENDPOINTS[runtime.id],
      model: ''
    }
    setKind(runtime.kind)
    setDraft(next)
    void scan(next)
  }, [draft, scan])

  const selectKind = (nextKind: AgentRuntimeKind): void => {
    setKind(nextKind)
    if (kindForRuntime(draft.runtimeId) === nextKind) return
    const first = runtimes.find((runtime) => runtime.kind === nextKind)
    if (first) selectRuntime(first)
  }

  const startRuntime = async (): Promise<void> => {
    setStarting(true)
    try {
      await desktopApi.runtime.start(draft)
      await scan(draft)
      onNotice('Ollama 本地服务已启动', 'success')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Ollama 启动失败', 'error')
    } finally {
      setStarting(false)
    }
  }

  const save = async (): Promise<void> => {
    if (draft.enabled && (!runtimeReady || (localModelSelected && !draft.model))) {
      onNotice('请先检测运行时并选择一个可用模型', 'error')
      return
    }

    setSaving(true)
    try {
      const next = await desktopApi.runtime.saveSettings(draft)
      setDraft(next)
      onSettingsSaved(next)
      onNotice(next.enabled ? `${selectedRuntime.name} 已用于表情生成` : '已切换为本地规则生成', 'success')
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'AI 运行时设置保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const stateLabel = selectedRuntime?.canStart && selectedRuntime.status === 'unavailable'
    ? '未启动'
    : STATUS_LABELS[selectedRuntime?.status ?? 'unavailable']

  return (
    <div className="workspace-inner runtime-view">
      <div className="runtime-header">
        <div>
          <span className="eyebrow">
            <Cpu size={15} />
            本机模型与 Agent
          </span>
          <h1>AI 运行时</h1>
          <p>本地服务、CLI 与模型目录</p>
        </div>
        <label className="runtime-switch">
          <span>
            <strong>运行时生成</strong>
            <small>{draft.enabled ? `当前使用 ${selectedRuntime?.name}` : '当前使用本地规则'}</small>
          </span>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
            aria-label="启用 AI 运行时生成"
          />
          <i aria-hidden="true" />
        </label>
      </div>

      <section className="runtime-section" aria-labelledby="runtime-list-heading">
        <div className="runtime-section-heading runtime-source-heading">
          <div>
            <h2 id="runtime-list-heading">运行时来源</h2>
            <span>{visibleRuntimes.filter(({ status }) => status === 'ready').length} 个可用</span>
          </div>
          <div className="runtime-source-controls">
            <div className="runtime-kind-tabs" role="tablist" aria-label="运行时类型">
              <button
                type="button"
                role="tab"
                aria-selected={kind === 'local-model'}
                className={kind === 'local-model' ? 'is-active' : ''}
                onClick={() => selectKind('local-model')}
              >
                <Database size={14} />
                本地模型
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={kind === 'agent-cli'}
                className={kind === 'agent-cli' ? 'is-active' : ''}
                onClick={() => selectKind('agent-cli')}
              >
                <TerminalSquare size={14} />
                Agent CLI
              </button>
            </div>
            <button
              type="button"
              className="runtime-icon-button"
              onClick={() => void scan(draft, true)}
              disabled={scanning}
              title="刷新运行时状态"
              aria-label="刷新运行时状态"
            >
              <RefreshCw className={scanning ? 'spin' : ''} size={17} />
            </button>
          </div>
        </div>

        <div className="runtime-list" role="radiogroup" aria-label="选择 AI 运行时">
          {visibleRuntimes.map((runtime) => (
            <label
              key={runtime.id}
              className={`runtime-row ${draft.runtimeId === runtime.id ? 'is-selected' : ''}`}
            >
              <input
                type="radio"
                name="runtime"
                value={runtime.id}
                checked={draft.runtimeId === runtime.id}
                onChange={() => selectRuntime(runtime)}
              />
              <span className="runtime-radio" aria-hidden="true" />
              <span className="runtime-symbol">
                <RuntimeIcon id={runtime.id} />
              </span>
              <span className="runtime-copy">
                <strong>{runtime.name}</strong>
                <small>{runtime.kind === 'agent-cli' && runtime.installed
                  ? `${runtime.command} · ${runtime.message}`
                  : runtime.message}</small>
              </span>
              <span className={`runtime-state state-${runtime.status}`}>
                {runtime.status === 'ready'
                  ? <CheckCircle2 size={15} />
                  : <AlertCircle size={15} />}
                {runtime.canStart && runtime.status === 'unavailable'
                  ? '未启动'
                  : STATUS_LABELS[runtime.status]}
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="runtime-section connection-section" aria-labelledby="connection-heading">
        <div className="runtime-section-heading">
          <div>
            <h2 id="connection-heading">执行配置</h2>
            <span>{selectedRuntime?.name}</span>
          </div>
        </div>

        <div className="runtime-fields">
          {localModelSelected ? (
            <label className="runtime-field endpoint-field">
              <span>本地服务地址</span>
              <input
                type="url"
                value={draft.endpoint}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  endpoint: event.target.value,
                  model: ''
                }))}
                placeholder={DEFAULT_RUNTIME_ENDPOINTS[draft.runtimeId]}
                spellCheck={false}
                aria-label="本地模型服务地址"
              />
            </label>
          ) : (
            <label className="runtime-field endpoint-field">
              <span>可执行文件覆盖</span>
              <input
                type="text"
                value={draft.executablePath}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  executablePath: event.target.value,
                  model: ''
                }))}
                placeholder={selectedRuntime?.executablePath
                  ? `自动发现：${selectedRuntime.executablePath}`
                  : '留空以自动从 PATH 发现'}
                spellCheck={false}
                aria-label="AI 运行时可执行文件覆盖"
              />
            </label>
          )}
          <label className="runtime-field model-field">
            <span>推理模型</span>
            <select
              value={draft.model}
              onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
              disabled={!runtimeReady}
              aria-label="选择运行时模型"
            >
              <option value="">
                {localModelSelected ? '选择本地模型' : '跟随运行时默认'}
              </option>
              {savedModelMissing && <option value={draft.model}>{draft.model}</option>}
              {modelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}{model.default ? ' · 推荐' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="runtime-actions">
          <span className={`connection-indicator state-${runtimeReady ? 'ready' : 'unavailable'}`}>
            <i />
            {configurationScanned
              ? selectedRuntime?.message || stateLabel
              : '配置已修改，请刷新运行时状态'}
          </span>
          <div className="runtime-command-buttons">
            {selectedRuntime?.canStart && !runtimeReady && (
              <button
                type="button"
                className="secondary-command"
                onClick={() => void startRuntime()}
                disabled={starting || scanning}
              >
                {starting ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}
                {starting ? '正在启动' : '启动 Ollama'}
              </button>
            )}
            <button
              type="button"
              className="save-runtime-button"
              onClick={() => void save()}
              disabled={saving || starting}
            >
              {saving ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />}
              {saving ? '正在保存' : '保存设置'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
