import { spawn, type ChildProcess } from 'node:child_process'
import { lookup } from 'node:dns'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { extname, isAbsolute, join, resolve } from 'node:path'
import type {
  AgentRuntimeDescriptor,
  AgentRuntimeModel,
  AgentRuntimeSettings
} from '../shared/types'
import { DEFAULT_RUNTIME_ENDPOINTS } from '../shared/types'

export type LocalModelRuntimeId = 'ollama' | 'lmstudio' | 'openai-compatible'

interface LocalModelDefinition {
  id: LocalModelRuntimeId
  name: string
  command: string
  protocol: 'ollama' | 'openai'
}

interface ModelCacheEntry {
  expiresAt: number
  models: AgentRuntimeModel[]
}

export interface LocalModelExecutionResult {
  output: string
  durationMs: number
  runtimeId: LocalModelRuntimeId
  runtimeName: string
  model: string
}

interface LocalModelRuntimeOptions {
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  fetchImplementation?: typeof fetch
}

const DISCOVERY_TIMEOUT_MS = 2_500
const GENERATION_TIMEOUT_MS = 60_000
const START_TIMEOUT_MS = 15_000
const MODEL_CACHE_TTL_MS = 60_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

const LOCAL_MODEL_DEFINITIONS: LocalModelDefinition[] = [
  { id: 'ollama', name: 'Ollama', command: 'ollama', protocol: 'ollama' },
  { id: 'lmstudio', name: 'LM Studio', command: 'OpenAI API', protocol: 'openai' },
  {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
    command: 'Local API',
    protocol: 'openai'
  }
]

const LOCAL_MODEL_IDS = new Set<LocalModelRuntimeId>(
  LOCAL_MODEL_DEFINITIONS.map(({ id }) => id)
)

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function cleanSingleLine(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') return ''
  return [...value]
    .map((character) => (character.charCodeAt(0) < 32 ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumLength)
}

export function isLocalModelRuntimeId(value: unknown): value is LocalModelRuntimeId {
  return LOCAL_MODEL_IDS.has(value as LocalModelRuntimeId)
}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

function isLoopbackAddress(value: string): boolean {
  const address = value.toLowerCase()
  if (address === '::1') return true
  return isIP(address) === 4 && address.split('.')[0] === '127'
}

export function normalizeLoopbackEndpoint(value: unknown, fallback: string): string {
  const raw = cleanSingleLine(value, 1_024) || fallback
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('本地模型服务地址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('本地模型服务只支持 HTTP 或 HTTPS')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('本地模型服务地址不能包含凭据、查询参数或片段')
  }
  const hostname = normalizedHostname(url)
  if (hostname !== 'localhost' && !isLoopbackAddress(hostname)) {
    throw new Error('本地模型服务只允许 localhost、127.0.0.0/8 或 ::1')
  }
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${pathname}`
}

async function verifyLoopbackResolution(endpoint: string): Promise<void> {
  const hostname = normalizedHostname(new URL(endpoint))
  if (hostname !== 'localhost') return
  const addresses = await new Promise<string[]>((resolvePromise, rejectPromise) => {
    lookup(hostname, { all: true, verbatim: true }, (error, results) => {
      if (error) rejectPromise(error)
      else resolvePromise(results.map(({ address }) => address))
    })
  })
  if (addresses.length === 0 || addresses.some((address) => !isLoopbackAddress(address))) {
    throw new Error('localhost 解析到了非回环地址')
  }
}

function routeUrl(
  endpoint: string,
  protocol: LocalModelDefinition['protocol'],
  resource: 'models' | 'chat'
): string {
  const url = new URL(endpoint)
  let basePath = url.pathname.replace(/\/+$/, '')
  if (protocol === 'openai' && !basePath.toLowerCase().endsWith('/v1')) {
    basePath = `${basePath}/v1`
  }
  const suffix = protocol === 'ollama'
    ? resource === 'models' ? '/api/tags' : '/api/chat'
    : resource === 'models' ? '/models' : '/chat/completions'
  url.pathname = `${basePath}${suffix}`.replace(/\/{2,}/g, '/')
  return url.toString()
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error('本地模型响应超过 2MB 限制')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('本地模型响应超过 2MB 限制')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function parseOllamaModels(value: unknown): AgentRuntimeModel[] {
  const payload = asRecord(value)
  if (!Array.isArray(payload.models)) return []
  const seen = new Set<string>()
  const models: AgentRuntimeModel[] = []
  for (const itemValue of payload.models) {
    const item = asRecord(itemValue)
    const id = cleanSingleLine(item.name || item.model, 180)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({ id, label: id, provider: 'ollama' })
  }
  if (models[0]) models[0].default = true
  return models
}

export function parseOpenAIModels(value: unknown): AgentRuntimeModel[] {
  const payload = asRecord(value)
  if (!Array.isArray(payload.data)) return []
  const seen = new Set<string>()
  const models: AgentRuntimeModel[] = []
  for (const itemValue of payload.data) {
    const item = asRecord(itemValue)
    const id = cleanSingleLine(item.id, 180)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      label: cleanSingleLine(item.name, 180) || id,
      provider: cleanSingleLine(item.owned_by, 80) || 'local'
    })
  }
  if (models[0]) models[0].default = true
  return models
}

export function parseOllamaChatContent(value: unknown): string {
  return cleanSingleLine(asRecord(asRecord(value).message).content, MAX_RESPONSE_BYTES)
}

export function parseOpenAIChatContent(value: unknown): string {
  const choices = asRecord(value).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  return cleanSingleLine(asRecord(asRecord(choices[0]).message).content, MAX_RESPONSE_BYTES)
}

class LocalModelHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function isRunnableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

async function searchPath(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<string | undefined> {
  const delimiter = platform === 'win32' ? ';' : ':'
  const names = platform === 'win32' && !extname(command)
    ? [`${command}.exe`, `${command}.cmd`]
    : [command]
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    const normalizedDirectory = directory.trim().replace(/^"|"$/g, '')
    if (!normalizedDirectory) continue
    for (const name of names) {
      const candidate = join(normalizedDirectory, name)
      if (await isRunnableFile(candidate, platform)) return canonicalPath(candidate)
    }
  }
  return undefined
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    })
    killer.unref()
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

export class LocalModelRuntimeManager {
  private readonly environment: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly fetchImplementation: typeof fetch
  private readonly modelCache = new Map<string, ModelCacheEntry>()
  private readonly ownedProcesses = new Map<LocalModelRuntimeId, ChildProcess>()
  private startPromise: Promise<AgentRuntimeDescriptor> | null = null

  constructor(options: LocalModelRuntimeOptions = {}) {
    this.environment = options.environment ?? process.env
    this.platform = options.platform ?? process.platform
    this.fetchImplementation = options.fetchImplementation ?? fetch
  }

  private definition(runtimeId: LocalModelRuntimeId): LocalModelDefinition {
    const definition = LOCAL_MODEL_DEFINITIONS.find(({ id }) => id === runtimeId)
    if (!definition) throw new Error('未知本地模型运行时')
    return definition
  }

  private endpointFor(
    definition: LocalModelDefinition,
    settings: AgentRuntimeSettings
  ): string {
    const candidate = settings.runtimeId === definition.id ? settings.endpoint : ''
    return normalizeLoopbackEndpoint(candidate, DEFAULT_RUNTIME_ENDPOINTS[definition.id])
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<unknown> {
    await verifyLoopbackResolution(url)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref()
    try {
      const response = await this.fetchImplementation(url, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers
        }
      })
      const text = await readBoundedResponse(response)
      if (!response.ok) {
        throw new LocalModelHttpError(
          response.status,
          cleanSingleLine(text, 300) || `HTTP ${response.status}`
        )
      }
      try {
        return text ? JSON.parse(text) : {}
      } catch {
        throw new Error('本地模型返回的 JSON 无法解析')
      }
    } catch (error) {
      if (error instanceof LocalModelHttpError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`本地模型请求超过 ${Math.round(timeoutMs / 1_000)} 秒`)
      }
      if (error instanceof Error && error.message.startsWith('本地模型')) throw error
      throw new Error(`无法连接本地模型服务${error instanceof Error ? `：${error.message}` : ''}`)
    } finally {
      clearTimeout(timer)
    }
  }

  private async fetchModels(
    definition: LocalModelDefinition,
    endpoint: string
  ): Promise<AgentRuntimeModel[]> {
    const cacheKey = `${definition.id}:${endpoint}`
    const cached = this.modelCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.models
    const payload = await this.requestJson(
      routeUrl(endpoint, definition.protocol, 'models'),
      { method: 'GET' },
      DISCOVERY_TIMEOUT_MS
    )
    const models = definition.protocol === 'ollama'
      ? parseOllamaModels(payload)
      : parseOpenAIModels(payload)
    if (models.length > 0) {
      this.modelCache.set(cacheKey, {
        models,
        expiresAt: Date.now() + MODEL_CACHE_TTL_MS
      })
    }
    return models
  }

  private async resolveOllamaExecutable(explicitPath = ''): Promise<string | undefined> {
    if (explicitPath) {
      if (!isAbsolute(explicitPath) || !(await isRunnableFile(explicitPath, this.platform))) {
        throw new Error('配置的 Ollama 可执行文件不存在或不可运行')
      }
      return canonicalPath(explicitPath)
    }

    const environmentOverride = cleanSingleLine(this.environment.EMOJI_PIE_OLLAMA_PATH, 1_024)
    if (environmentOverride) {
      const path = environmentOverride.includes('/') || environmentOverride.includes('\\')
        ? environmentOverride
        : await searchPath(environmentOverride, this.environment, this.platform)
      if (!path || !(await isRunnableFile(path, this.platform))) {
        throw new Error('EMOJI_PIE_OLLAMA_PATH 指向的可执行文件不可用')
      }
      return canonicalPath(path)
    }

    const fromPath = await searchPath('ollama', this.environment, this.platform)
    if (fromPath) return fromPath

    const candidates = this.platform === 'win32'
      ? [
          this.environment.LOCALAPPDATA
            ? join(this.environment.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')
            : '',
          this.environment.LOCALAPPDATA
            ? join(this.environment.LOCALAPPDATA, 'Ollama', 'ollama.exe')
            : ''
        ]
      : this.platform === 'darwin'
        ? ['/Applications/Ollama.app/Contents/Resources/ollama', '/usr/local/bin/ollama']
        : ['/usr/local/bin/ollama', '/usr/bin/ollama']
    for (const candidate of candidates.filter(Boolean)) {
      if (await isRunnableFile(candidate, this.platform)) return canonicalPath(candidate)
    }
    return undefined
  }

  private async inspectDefinition(
    definition: LocalModelDefinition,
    settings: AgentRuntimeSettings
  ): Promise<AgentRuntimeDescriptor> {
    let endpoint = DEFAULT_RUNTIME_ENDPOINTS[definition.id]
    try {
      endpoint = this.endpointFor(definition, settings)
    } catch (error) {
      return {
        id: definition.id,
        name: definition.name,
        kind: 'local-model',
        command: definition.command,
        status: 'error',
        installed: false,
        executablePath: '',
        endpoint,
        canStart: false,
        runningOwned: false,
        version: '',
        models: [],
        message: error instanceof Error ? error.message : '本地模型地址无效'
      }
    }

    let executablePath = ''
    if (definition.id === 'ollama') {
      try {
        executablePath = await this.resolveOllamaExecutable(
          settings.runtimeId === 'ollama' ? settings.executablePath : ''
        ) ?? ''
      } catch (error) {
        return {
          id: definition.id,
          name: definition.name,
          kind: 'local-model',
          command: definition.command,
          status: 'error',
          installed: false,
          executablePath: '',
          endpoint,
          canStart: false,
          runningOwned: false,
          version: '',
          models: [],
          message: error instanceof Error ? error.message : 'Ollama 路径无效'
        }
      }
    }

    const runningOwned = this.ownedProcesses.has(definition.id)
    try {
      const models = await this.fetchModels(definition, endpoint)
      return {
        id: definition.id,
        name: definition.name,
        kind: 'local-model',
        command: definition.command,
        status: 'ready',
        installed: true,
        executablePath,
        endpoint,
        canStart: false,
        runningOwned,
        version: 'Local HTTP',
        models: settings.runtimeId === definition.id ? models : [],
        message: models.length > 0 ? `${models.length} 个模型 · ${endpoint}` : `已连接 · ${endpoint}`
      }
    } catch {
      const canStart = definition.id === 'ollama' && Boolean(executablePath)
      return {
        id: definition.id,
        name: definition.name,
        kind: 'local-model',
        command: definition.command,
        status: 'unavailable',
        installed: canStart,
        executablePath,
        endpoint,
        canStart,
        runningOwned,
        version: '',
        models: [],
        message: canStart ? '服务未运行，可由应用启动' : `无法连接 ${endpoint}`
      }
    }
  }

  async discover(settings: AgentRuntimeSettings): Promise<AgentRuntimeDescriptor[]> {
    return Promise.all(
      LOCAL_MODEL_DEFINITIONS.map((definition) => this.inspectDefinition(definition, settings))
    )
  }

  async execute(
    settings: AgentRuntimeSettings,
    prompt: string,
    systemPrompt: string,
    schema: unknown
  ): Promise<LocalModelExecutionResult> {
    if (!isLocalModelRuntimeId(settings.runtimeId)) throw new Error('请选择本地模型运行时')
    const definition = this.definition(settings.runtimeId)
    const endpoint = this.endpointFor(definition, settings)
    const models = await this.fetchModels(definition, endpoint)
    const model = settings.model || models.find(({ default: preferred }) => preferred)?.id || models[0]?.id
    if (!model) throw new Error(`${definition.name} 没有可用模型`)

    const startedAt = Date.now()
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ]
    let payload: unknown
    if (definition.protocol === 'ollama') {
      const baseRequest = {
        model,
        messages,
        stream: false,
        options: { temperature: 0.75, num_predict: 700 }
      }
      try {
        payload = await this.requestJson(
          routeUrl(endpoint, definition.protocol, 'chat'),
          {
            method: 'POST',
            body: JSON.stringify({ ...baseRequest, format: schema })
          },
          GENERATION_TIMEOUT_MS
        )
      } catch (error) {
        if (!(error instanceof LocalModelHttpError) || ![400, 422].includes(error.status)) {
          throw error
        }
        payload = await this.requestJson(
          routeUrl(endpoint, definition.protocol, 'chat'),
          {
            method: 'POST',
            body: JSON.stringify({ ...baseRequest, format: 'json' })
          },
          GENERATION_TIMEOUT_MS
        )
      }
    } else {
      const baseRequest = {
        model,
        messages,
        stream: false,
        temperature: 0.75,
        max_tokens: 700
      }
      try {
        payload = await this.requestJson(
          routeUrl(endpoint, definition.protocol, 'chat'),
          {
            method: 'POST',
            body: JSON.stringify({
              ...baseRequest,
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'emoji_pie_generation', strict: true, schema }
              }
            })
          },
          GENERATION_TIMEOUT_MS
        )
      } catch (error) {
        if (!(error instanceof LocalModelHttpError) || ![400, 404, 422].includes(error.status)) {
          throw error
        }
        payload = await this.requestJson(
          routeUrl(endpoint, definition.protocol, 'chat'),
          {
            method: 'POST',
            body: JSON.stringify({
              ...baseRequest,
              response_format: { type: 'json_object' }
            })
          },
          GENERATION_TIMEOUT_MS
        )
      }
    }

    const output = definition.protocol === 'ollama'
      ? parseOllamaChatContent(payload)
      : parseOpenAIChatContent(payload)
    if (!output) throw new Error(`${definition.name} 没有返回最终结果`)
    return {
      output,
      durationMs: Date.now() - startedAt,
      runtimeId: definition.id,
      runtimeName: definition.name,
      model
    }
  }

  private async startOllama(settings: AgentRuntimeSettings): Promise<AgentRuntimeDescriptor> {
    const definition = this.definition('ollama')
    const endpoint = this.endpointFor(definition, settings)
    const endpointUrl = new URL(endpoint)
    if (endpointUrl.pathname !== '/' && endpointUrl.pathname !== '') {
      throw new Error('应用启动 Ollama 时，服务地址不能包含路径')
    }

    const current = await this.inspectDefinition(definition, settings)
    if (current.status === 'ready') return current
    const executablePath = await this.resolveOllamaExecutable(settings.executablePath)
    if (!executablePath) throw new Error('未找到 Ollama 可执行文件')
    if (this.platform === 'win32' && extname(executablePath).toLowerCase() === '.cmd') {
      throw new Error('Ollama 启动路径必须指向 ollama.exe')
    }

    let child = this.ownedProcesses.get('ollama')
    const processState: { spawnError?: Error } = {}
    if (!child) {
      child = spawn(executablePath, ['serve'], {
        detached: this.platform !== 'win32',
        env: { ...this.environment, OLLAMA_HOST: endpointUrl.host },
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      })
      this.ownedProcesses.set('ollama', child)
      child.once('error', (error) => {
        processState.spawnError = error
      })
      child.once('exit', () => {
        if (this.ownedProcesses.get('ollama') === child) this.ownedProcesses.delete('ollama')
      })
      child.unref()
    }

    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (processState.spawnError) {
        throw new Error(`Ollama 启动失败：${processState.spawnError.message}`)
      }
      if (child.exitCode !== null) throw new Error('Ollama 服务进程提前退出')
      try {
        await this.fetchModels(definition, endpoint)
        return this.inspectDefinition(definition, settings)
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
      }
    }
    terminateProcessTree(child)
    this.ownedProcesses.delete('ollama')
    throw new Error('Ollama 服务启动超时')
  }

  async start(settings: AgentRuntimeSettings): Promise<AgentRuntimeDescriptor> {
    if (settings.runtimeId !== 'ollama') throw new Error('只有 Ollama 支持由应用启动')
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startOllama(settings)
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  dispose(): void {
    for (const child of this.ownedProcesses.values()) terminateProcessTree(child)
    this.ownedProcesses.clear()
  }
}
