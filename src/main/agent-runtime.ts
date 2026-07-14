import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import type {
  AgentRuntimeDescriptor,
  AgentRuntimeDiscovery,
  AgentRuntimeGenerateRequest,
  AgentRuntimeGenerationResult,
  AgentRuntimeId,
  AgentRuntimeModel,
  AgentRuntimeSettings,
  EmotionId,
  RuntimeEmojiVariant,
  TextAnalysis
} from '../shared/types'
import { DEFAULT_AGENT_RUNTIME_SETTINGS, DEFAULT_RUNTIME_ENDPOINTS } from '../shared/types'
import {
  isLocalModelRuntimeId,
  LocalModelRuntimeManager,
  normalizeLoopbackEndpoint,
  type LocalModelRuntimeId
} from './local-model-runtime'

const VERSION_TIMEOUT_MS = 4_000
const MODEL_TIMEOUT_MS = 15_000
const EXECUTION_TIMEOUT_MS = 90_000
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const MODEL_CACHE_TTL_MS = 60_000

export interface RuntimeDefinition {
  id: AgentRuntimeId
  name: string
  command: string
  environmentPath: string
  npmScript?: string
}

export interface RuntimeLaunch {
  executablePath: string
  prefixArgs: string[]
  displayPath: string
}

interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
}

interface ExecuteOptions {
  launch: RuntimeLaunch
  cwd: string
  model: string
  systemPrompt: string
  timeoutMs: number
  environment: NodeJS.ProcessEnv
}

interface BackendResult {
  output: string
  durationMs: number
}

interface RuntimeBackend {
  execute(prompt: string, options: ExecuteOptions): Promise<BackendResult>
}

interface ModelCacheEntry {
  expiresAt: number
  models: AgentRuntimeModel[]
}

const RUNTIME_DEFINITIONS: RuntimeDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    environmentPath: 'EMOJI_PIE_CLAUDE_PATH',
    npmScript: join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    environmentPath: 'EMOJI_PIE_CODEX_PATH',
    npmScript: join('node_modules', '@openai', 'codex', 'bin', 'codex.js')
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    environmentPath: 'EMOJI_PIE_OPENCODE_PATH'
  }
]

const RUNTIME_IDS = new Set<AgentRuntimeId>([
  'ollama',
  'lmstudio',
  'openai-compatible',
  ...RUNTIME_DEFINITIONS.map(({ id }) => id)
])

const EMOTION_LABELS: Record<EmotionId, string> = {
  happy: '开心',
  sad: '委屈',
  angry: '生气',
  speechless: '无语',
  tired: '疲惫',
  surprised: '震惊',
  awkward: '尴尬',
  smug: '得意',
  crazy: '发疯'
}

const EMOTIONS = new Set<EmotionId>(Object.keys(EMOTION_LABELS) as EmotionId[])
const SCENES = new Set<TextAnalysis['scene']>(['daily', 'work', 'social'])

const GENERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['analysis', 'variants'],
  properties: {
    analysis: {
      type: 'object',
      additionalProperties: false,
      required: ['emotion', 'scene', 'tone', 'intent', 'keywords'],
      properties: {
        emotion: { type: 'string', enum: [...EMOTIONS] },
        scene: { type: 'string', enum: [...SCENES] },
        tone: { type: 'string', minLength: 1 },
        intent: { type: 'string', minLength: 1 },
        keywords: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: { type: 'string', minLength: 1 }
        }
      }
    },
    variants: {
      type: 'array',
      minItems: 9,
      maxItems: 9,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['emotion', 'caption'],
        properties: {
          emotion: { type: 'string', enum: [...EMOTIONS] },
          caption: { type: 'string', minLength: 1, maxLength: 14 }
        }
      }
    }
  }
} as const

const SYSTEM_PROMPT = `你是 EmojiPie 的表情生成规划器。不要使用任何工具，也不要解释过程，只输出符合 JSON Schema 的对象。
analysis 用于描述整句输入；variants 必须提供 9 个有明显差异的聊天表情方案。
每个 variant 的 emotion 只能是 happy、sad、angry、speechless、tired、surprised、awkward、smug、crazy 之一，caption 不超过 14 个汉字。
回复模式要生成适合直接发送的回应；表达模式要保留用户原意。文案自然、有网感，但不得包含攻击、歧视或露骨内容。`

function cleanSingleLine(value: unknown, maximumLength: number): string {
  if (typeof value !== 'string') return ''
  const printable = [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127 ? ' ' : character
    })
    .join('')
  return printable.replace(/\s+/g, ' ').trim().slice(0, maximumLength)
}

function cleanStringList(value: unknown, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => cleanSingleLine(item, maximumLength))
    .filter(Boolean)
    .slice(0, maximumItems)
}

function cleanCaption(value: unknown): string {
  return [...cleanSingleLine(value, 100)].slice(0, 14).join('')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function runtimeDefinition(runtimeId: AgentRuntimeId): RuntimeDefinition {
  const definition = RUNTIME_DEFINITIONS.find(({ id }) => id === runtimeId)
  if (!definition) throw new Error('未知 AI 运行时')
  return definition
}

export function normalizeAgentRuntimeSettings(value: unknown): AgentRuntimeSettings {
  const candidate = value && typeof value === 'object'
    ? (value as Partial<AgentRuntimeSettings>)
    : {}
  const runtimeId = RUNTIME_IDS.has(candidate.runtimeId as AgentRuntimeId)
    ? (candidate.runtimeId as AgentRuntimeId)
    : DEFAULT_AGENT_RUNTIME_SETTINGS.runtimeId
  const executablePath = runtimeId === 'ollama' || !isLocalModelRuntimeId(runtimeId)
    ? cleanSingleLine(candidate.executablePath, 1_024)
    : ''
  if (executablePath && !isAbsolute(executablePath)) {
    throw new Error('运行时路径覆盖必须使用绝对路径')
  }
  const endpoint = isLocalModelRuntimeId(runtimeId)
    ? normalizeLoopbackEndpoint(candidate.endpoint, DEFAULT_RUNTIME_ENDPOINTS[runtimeId])
    : ''

  return {
    enabled: candidate.enabled === true,
    runtimeId,
    executablePath,
    endpoint,
    model: cleanSingleLine(candidate.model, 180)
  }
}

function extractJsonObject(value: string): string {
  const withoutFence = value.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('运行时没有返回有效 JSON')
  return withoutFence.slice(start, end + 1)
}

export function parseRuntimeGenerationResponse(
  value: string
): Pick<AgentRuntimeGenerationResult, 'analysis' | 'variants'> {
  let payload: Record<string, unknown>
  try {
    payload = asRecord(JSON.parse(extractJsonObject(value)))
  } catch (error) {
    if (error instanceof Error && error.message === '运行时没有返回有效 JSON') throw error
    throw new Error('运行时返回的 JSON 无法解析')
  }

  const analysisPayload = asRecord(payload.analysis)
  const emotion = cleanSingleLine(analysisPayload.emotion, 32) as EmotionId
  const scene = cleanSingleLine(analysisPayload.scene, 32) as TextAnalysis['scene']
  if (!EMOTIONS.has(emotion)) throw new Error('运行时返回了未知情绪')
  if (!SCENES.has(scene)) throw new Error('运行时返回了未知场景')

  const variants: RuntimeEmojiVariant[] = Array.isArray(payload.variants)
    ? payload.variants
        .map((value) => {
          const item = asRecord(value)
          const variantEmotion = cleanSingleLine(item.emotion, 32) as EmotionId
          const caption = cleanCaption(item.caption)
          return EMOTIONS.has(variantEmotion) && caption
            ? { emotion: variantEmotion, caption }
            : null
        })
        .filter((item): item is RuntimeEmojiVariant => item !== null)
        .slice(0, 9)
    : []
  if (variants.length !== 9) throw new Error('运行时必须返回 9 个可用表情方案')

  return {
    analysis: {
      emotion,
      emotionLabel: EMOTION_LABELS[emotion],
      scene,
      tone: cleanSingleLine(analysisPayload.tone, 24) || '表达',
      intent: cleanSingleLine(analysisPayload.intent, 48) || '传达当前情绪',
      keywords: cleanStringList(analysisPayload.keywords, 5, 16)
    },
    variants
  }
}

function trimStderr(value: string): string {
  return cleanSingleLine(value.slice(-MAX_STDERR_BYTES), 500)
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
  const forceTimer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }, 2_000)
  forceTimer.unref()
}

async function runProcess(
  launch: RuntimeLaunch,
  args: string[],
  options: {
    cwd?: string
    input?: string
    timeoutMs: number
    environment?: NodeJS.ProcessEnv
    keepStdinOpen?: boolean
    onStdoutLine?: (line: string, stdin: Writable | null) => void
  }
): Promise<ProcessResult> {
  const startedAt = Date.now()
  const childEnvironment: NodeJS.ProcessEnv = {
    ...(options.environment ?? process.env),
    CI: '1',
    NO_COLOR: '1'
  }
  delete childEnvironment.FORCE_COLOR
  const child = spawn(launch.executablePath, [...launch.prefixArgs, ...args], {
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    env: childEnvironment,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let outputExceeded = false
    let stdoutLineBuffer = ''
    let hardStop: NodeJS.Timeout | undefined

    const timeoutError = (): Error => {
      const detail = trimStderr(stderr)
      return new Error(
        `运行时执行超过 ${Math.round(options.timeoutMs / 1_000)} 秒${detail ? `：${detail}` : ''}`
      )
    }

    const settleError = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (hardStop) clearTimeout(hardStop)
      rejectPromise(error)
    }

    const handleStdoutLines = (value: string, flush = false): void => {
      if (!options.onStdoutLine) return
      stdoutLineBuffer += value
      const lines = stdoutLineBuffer.split(/\r?\n/)
      stdoutLineBuffer = flush ? '' : (lines.pop() ?? '')
      if (flush && lines.at(-1) === '') lines.pop()
      try {
        for (const line of lines) options.onStdoutLine(line, child.stdin)
        if (flush && stdoutLineBuffer) options.onStdoutLine(stdoutLineBuffer, child.stdin)
      } catch (error) {
        terminateProcessTree(child)
        settleError(error instanceof Error ? error : new Error('运行时协议处理失败'))
      }
    }

    const timeout = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
      hardStop = setTimeout(() => settleError(timeoutError()), 5_000)
      hardStop.unref()
    }, options.timeoutMs)
    timeout.unref()

    child.once('error', (error) => settleError(new Error(`无法启动运行时：${error.message}`)))
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdout += text
      handleStdoutLines(text)
      if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES && !outputExceeded) {
        outputExceeded = true
        terminateProcessTree(child)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_BYTES)
    })
    child.stdin?.on('error', () => undefined)
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (hardStop) clearTimeout(hardStop)
      handleStdoutLines('', true)
      if (timedOut) {
        rejectPromise(timeoutError())
        return
      }
      if (outputExceeded) {
        rejectPromise(new Error('运行时输出超过大小限制'))
        return
      }
      resolvePromise({
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt
      })
    })

    if (options.keepStdinOpen) {
      child.stdin?.write(options.input ?? '')
    } else {
      child.stdin?.end(options.input ?? '')
    }
  })
}

async function isRunnableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
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
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  const entries = (environment.PATH ?? '')
    .split(pathDelimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
  const names = platform === 'win32' && !extname(command)
    ? [`${command}.exe`, `${command}.cmd`]
    : [command]

  for (const directory of entries) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (await isRunnableFile(candidate)) return canonicalPath(candidate)
    }
  }
  return undefined
}

async function resolveOpenCodeNative(shimPath: string): Promise<string | undefined> {
  const packageNames = process.arch === 'arm64'
    ? ['opencode-windows-arm64', 'opencode-windows-x64', 'opencode-windows-x64-baseline']
    : ['opencode-windows-x64', 'opencode-windows-x64-baseline', 'opencode-windows-arm64']
  for (const packageName of packageNames) {
    const candidate = join(
      dirname(shimPath),
      'node_modules',
      'opencode-ai',
      'node_modules',
      packageName,
      'bin',
      'opencode.exe'
    )
    if (await isRunnableFile(candidate)) return canonicalPath(candidate)
  }
  return undefined
}

export async function resolveRuntimeLaunch(
  definition: RuntimeDefinition,
  displayPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<RuntimeLaunch> {
  const resolvedDisplayPath = await canonicalPath(displayPath)
  if (platform !== 'win32' || extname(resolvedDisplayPath).toLowerCase() !== '.cmd') {
    return {
      executablePath: resolvedDisplayPath,
      prefixArgs: [],
      displayPath: resolvedDisplayPath
    }
  }

  if (definition.id === 'opencode') {
    const nativePath = await resolveOpenCodeNative(resolvedDisplayPath)
    if (nativePath) {
      return { executablePath: nativePath, prefixArgs: [], displayPath: resolvedDisplayPath }
    }
  }

  if (!definition.npmScript) {
    throw new Error(`${definition.name} 的 Windows shim 无法直接启动`)
  }
  const scriptPath = join(dirname(resolvedDisplayPath), definition.npmScript)
  if (!(await isRunnableFile(scriptPath))) {
    throw new Error(`${definition.name} 的 npm 入口文件不存在`)
  }
  const nodePath = await searchPath('node', environment, platform)
  if (!nodePath) throw new Error('运行 npm CLI 需要可用的 node.exe')
  return {
    executablePath: nodePath,
    prefixArgs: [await canonicalPath(scriptPath)],
    displayPath: resolvedDisplayPath
  }
}

function parseVersionNumber(value: string): [number, number, number] | null {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function versionAtLeast(value: string, minimum: [number, number, number]): boolean {
  const parsed = parseVersionNumber(value)
  if (!parsed) return false
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] > minimum[index]) return true
    if (parsed[index] < minimum[index]) return false
  }
  return true
}

function claudeModels(): AgentRuntimeModel[] {
  return [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', default: true },
    { id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'anthropic' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic' },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', provider: 'anthropic' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'anthropic' }
  ]
}

function codexFallbackModels(): AgentRuntimeModel[] {
  return [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', provider: 'openai', default: true },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', provider: 'openai' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', provider: 'openai' },
    { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai' },
    { id: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', provider: 'openai' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', provider: 'openai' },
    { id: 'gpt-5.2', label: 'GPT-5.2', provider: 'openai' }
  ]
}

export function parseCodexModelCatalog(value: string): AgentRuntimeModel[] {
  const payload = asRecord(JSON.parse(value))
  if (!Array.isArray(payload.models)) return []
  const models = payload.models
    .map<AgentRuntimeModel | null>((value) => {
      const model = asRecord(value)
      const id = cleanSingleLine(model.slug, 180)
      if (!id || model.visibility === 'hide') return null
      return {
        id,
        label: cleanSingleLine(model.display_name, 180) || id,
        provider: 'openai'
      } satisfies AgentRuntimeModel
    })
    .filter((model): model is AgentRuntimeModel => model !== null)
  if (models[0]) models[0].default = true
  return models
}

export function parseOpenCodeModels(value: string): AgentRuntimeModel[] {
  const seen = new Set<string>()
  const models: AgentRuntimeModel[] = []
  for (const rawLine of value.split(/\r?\n/)) {
    const id = rawLine.trim().split(/\s+/)[0]
    if (!id || !id.includes('/') || id === id.toUpperCase() || seen.has(id)) continue
    if (id.startsWith('{') || id.startsWith('[') || id.startsWith('"')) continue
    seen.add(id)
    models.push({ id, label: id, provider: id.split('/')[0] })
  }
  return models
}

export function parseClaudeStreamOutput(value: string): string {
  let assistantText = ''
  let resultText = ''
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = asRecord(JSON.parse(line))
      if (event.type === 'assistant') {
        const message = asRecord(event.message)
        if (Array.isArray(message.content)) {
          for (const blockValue of message.content) {
            const block = asRecord(blockValue)
            if (block.type === 'text' && typeof block.text === 'string') {
              assistantText += block.text
            }
          }
        }
      }
      if (event.type === 'result') {
        if (event.structured_output && typeof event.structured_output === 'object') {
          resultText = JSON.stringify(event.structured_output)
        } else if (typeof event.result === 'string') {
          resultText = event.result
        }
      }
    } catch {
      // Runtime logs can share stdout; only protocol JSON lines are consumed.
    }
  }
  return resultText || assistantText
}

export interface ClaudeProtocolAction {
  complete: boolean
  response: string
}

export function inspectClaudeProtocolLine(value: string): ClaudeProtocolAction {
  let event: Record<string, unknown>
  try {
    event = asRecord(JSON.parse(value))
  } catch {
    return { complete: false, response: '' }
  }
  if (event.type === 'result') return { complete: true, response: '' }
  if (event.type !== 'control_request') return { complete: false, response: '' }

  const requestId = cleanSingleLine(event.request_id, 180)
  if (!requestId) return { complete: false, response: '' }
  const request = asRecord(event.request)
  const input = { ...asRecord(request.input) }
  if (input.run_in_background === true) input.run_in_background = false
  return {
    complete: false,
    response: `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'allow',
          updatedInput: input
        }
      }
    })}\n`
  }
}

function claudeChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {}
  const blocked = new Set([
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_SSE_PORT'
  ])
  for (const [key, value] of Object.entries(environment)) {
    if (blocked.has(key) || key.startsWith('CLAUDECODE_')) continue
    filtered[key] = value
  }
  return filtered
}

export function openCodeChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let inlineConfig: Record<string, unknown> = {}
  try {
    inlineConfig = asRecord(JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? '{}'))
  } catch {
    inlineConfig = {}
  }
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...inlineConfig,
      permission: { '*': 'deny' }
    })
  }
}

export function parseCodexJsonOutput(value: string): string {
  let output = ''
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = asRecord(JSON.parse(line))
      const item = asRecord(event.item)
      if (event.type === 'item.completed' && item.type === 'agent_message') {
        output = cleanSingleLine(item.text, MAX_STDOUT_BYTES)
      }
    } catch {
      // Ignore non-protocol lines from older Codex builds.
    }
  }
  return output
}

export function requiresCodexServiceTierFallback(value: string): boolean {
  return /unknown variant\s+[`'"]?priority[`'"]?[\s\S]*service_tier/i.test(value)
}

class ClaudeBackend implements RuntimeBackend {
  async execute(prompt: string, options: ExecuteOptions): Promise<BackendResult> {
    const mcpConfigPath = join(options.cwd, 'emoji-pie-mcp.json')
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }), 'utf8')
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--tools', '',
      '--max-turns', '1',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--mcp-config', mcpConfigPath,
      '--append-system-prompt', options.systemPrompt,
      '--json-schema', JSON.stringify(GENERATION_SCHEMA)
    ]
    if (options.model) args.push('--model', options.model)
    const input = `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }]
      }
    })}\n`
    const result = await runProcess(options.launch, args, {
      cwd: options.cwd,
      input,
      timeoutMs: options.timeoutMs,
      environment: claudeChildEnvironment(options.environment),
      keepStdinOpen: true,
      onStdoutLine: (line, stdin) => {
        const action = inspectClaudeProtocolLine(line)
        if (action.response && stdin && !stdin.destroyed) stdin.write(action.response)
        if (action.complete && stdin && !stdin.destroyed) stdin.end()
      }
    })
    if (result.exitCode !== 0) {
      throw new Error(`Claude Code 执行失败${result.stderr ? `：${trimStderr(result.stderr)}` : ''}`)
    }
    const output = parseClaudeStreamOutput(result.stdout)
    if (!output) throw new Error('Claude Code 没有返回最终结果')
    return { output, durationMs: result.durationMs }
  }
}

class CodexBackend implements RuntimeBackend {
  async execute(prompt: string, options: ExecuteOptions): Promise<BackendResult> {
    const schemaPath = join(options.cwd, 'emoji-pie-output.schema.json')
    const outputPath = join(options.cwd, 'emoji-pie-output.json')
    await writeFile(schemaPath, JSON.stringify(GENERATION_SCHEMA), 'utf8')
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--output-schema', schemaPath,
      '--output-last-message', outputPath,
      '--cd', options.cwd
    ]
    if (options.model) args.push('--model', options.model)
    args.push('-')
    const run = (compatibilityArgs: string[] = []): Promise<ProcessResult> => runProcess(
      options.launch,
      [...compatibilityArgs, ...args],
      {
        cwd: options.cwd,
        input: `${options.systemPrompt}\n\n${prompt}`,
        timeoutMs: options.timeoutMs,
        environment: options.environment
      }
    )
    let result = await run()
    let totalDurationMs = result.durationMs
    if (result.exitCode !== 0 && requiresCodexServiceTierFallback(result.stderr)) {
      result = await run(['-c', 'service_tier="fast"'])
      totalDurationMs += result.durationMs
    }
    if (result.exitCode !== 0) {
      throw new Error(`Codex 执行失败${result.stderr ? `：${trimStderr(result.stderr)}` : ''}`)
    }
    let output = ''
    try {
      output = await readFile(outputPath, 'utf8')
    } catch {
      output = parseCodexJsonOutput(result.stdout)
    }
    if (!output.trim()) throw new Error('Codex 没有返回最终结果')
    return { output, durationMs: totalDurationMs }
  }
}

class OpenCodeBackend implements RuntimeBackend {
  async execute(prompt: string, options: ExecuteOptions): Promise<BackendResult> {
    const args = [
      'run',
      '--format', 'json',
      '--dir', options.cwd,
      '--prompt', options.systemPrompt
    ]
    if (options.model) args.push('--model', options.model)
    args.push(prompt)
    const result = await runProcess(options.launch, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      environment: openCodeChildEnvironment(options.environment)
    })
    if (result.exitCode !== 0) {
      throw new Error(`OpenCode 执行失败${result.stderr ? `：${trimStderr(result.stderr)}` : ''}`)
    }

    let output = ''
    for (const line of result.stdout.split(/\r?\n/)) {
      let event: Record<string, unknown>
      try {
        event = asRecord(JSON.parse(line))
      } catch {
        continue
      }
      const part = asRecord(event.part)
      if (event.type === 'text' && typeof part.text === 'string') output += part.text
      if (event.type === 'error') {
        const detail = cleanSingleLine(asRecord(event.error).message, 240)
        throw new Error(`OpenCode 返回执行错误${detail ? `：${detail}` : ''}`)
      }
    }
    if (!output) throw new Error('OpenCode 没有返回最终结果')
    return { output, durationMs: result.durationMs }
  }
}

const BACKENDS: Record<Exclude<AgentRuntimeId, LocalModelRuntimeId>, RuntimeBackend> = {
  claude: new ClaudeBackend(),
  codex: new CodexBackend(),
  opencode: new OpenCodeBackend()
}

async function safeRemoveRuntimeDirectory(directory: string): Promise<void> {
  const resolvedRoot = resolve(tmpdir())
  const resolvedDirectory = resolve(directory)
  if (
    dirname(resolvedDirectory) !== resolvedRoot ||
    !basename(resolvedDirectory).startsWith('emoji-pie-runtime-')
  ) {
    return
  }
  await rm(resolvedDirectory, { recursive: true, force: true })
}

export class AgentRuntimeManager {
  private readonly environment: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly modelCache = new Map<string, ModelCacheEntry>()
  private readonly localModels: LocalModelRuntimeManager
  private shellResolutionPromise: Promise<Map<string, string>> | null = null

  constructor(options: {
    environment?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    fetchImplementation?: typeof fetch
  } = {}) {
    this.environment = options.environment ?? process.env
    this.platform = options.platform ?? process.platform
    this.localModels = new LocalModelRuntimeManager({
      environment: this.environment,
      platform: this.platform,
      fetchImplementation: options.fetchImplementation
    })
  }

  private async resolveViaLoginShell(): Promise<Map<string, string>> {
    if (this.platform === 'win32') return new Map()
    if (this.shellResolutionPromise) return this.shellResolutionPromise
    this.shellResolutionPromise = (async () => {
      const result = new Map<string, string>()
      const shell = cleanSingleLine(this.environment.SHELL, 500)
      const supportedShells = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh'])
      if (!shell || !supportedShells.has(basename(shell))) return result
      const names = RUNTIME_DEFINITIONS.map(({ command }) => command)
      const script = names
        .map((name) => `p=$(command -v ${name} 2>/dev/null); [ -n "$p" ] && printf '${name}\\t%s\\n' "$p"`)
        .join('; ')
      const launch: RuntimeLaunch = { executablePath: shell, prefixArgs: [], displayPath: shell }
      try {
        const output = await runProcess(launch, ['-ilc', script], {
          timeoutMs: 3_000,
          environment: this.environment
        })
        for (const line of output.stdout.split(/\r?\n/)) {
          const [name, path] = line.split('\t', 2)
          if (name && path && isAbsolute(path) && await isRunnableFile(path)) {
            result.set(name, await canonicalPath(path))
          }
        }
      } catch {
        return result
      }
      return result
    })()
    return this.shellResolutionPromise
  }

  private async resolveDefinition(
    definition: RuntimeDefinition,
    explicitPath = ''
  ): Promise<RuntimeLaunch | undefined> {
    let displayPath: string | undefined
    if (explicitPath) {
      if (!(await isRunnableFile(explicitPath))) {
        throw new Error('配置的可执行文件不存在或不可运行')
      }
      displayPath = explicitPath
    } else {
      const environmentOverride = cleanSingleLine(this.environment[definition.environmentPath], 1_024)
      if (environmentOverride) {
        displayPath = environmentOverride.includes('/') || environmentOverride.includes('\\')
          ? environmentOverride
          : await searchPath(environmentOverride, this.environment, this.platform)
        if (!displayPath || !(await isRunnableFile(displayPath))) {
          throw new Error(`${definition.environmentPath} 指向的运行时不可用`)
        }
      } else {
        displayPath = await searchPath(definition.command, this.environment, this.platform)
        if (!displayPath) {
          displayPath = (await this.resolveViaLoginShell()).get(definition.command)
        }
      }
    }
    return displayPath
      ? resolveRuntimeLaunch(definition, displayPath, this.environment, this.platform)
      : undefined
  }

  private async detectVersion(launch: RuntimeLaunch): Promise<string> {
    const result = await runProcess(launch, ['--version'], {
      timeoutMs: VERSION_TIMEOUT_MS,
      environment: this.environment
    })
    if (result.exitCode !== 0) throw new Error(trimStderr(result.stderr) || '版本检测失败')
    return cleanSingleLine(result.stdout || result.stderr, 120)
  }

  private async listModels(
    definition: RuntimeDefinition,
    launch: RuntimeLaunch,
    version: string
  ): Promise<AgentRuntimeModel[]> {
    const key = `${definition.id}:${launch.displayPath}:${version}`
    const cached = this.modelCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.models

    let models: AgentRuntimeModel[] = []
    if (definition.id === 'claude') {
      models = claudeModels()
    } else if (definition.id === 'codex') {
      models = codexFallbackModels()
      if (versionAtLeast(version, [0, 122, 0])) {
        try {
          const result = await runProcess(launch, ['debug', 'models', '--bundled'], {
            timeoutMs: MODEL_TIMEOUT_MS,
            environment: this.environment
          })
          const discovered = result.exitCode === 0 ? parseCodexModelCatalog(result.stdout) : []
          if (discovered.length > 0) models = discovered
        } catch {
          // Keep Multica's safe bundled fallback when dynamic discovery fails.
        }
      }
    } else {
      try {
        let result = await runProcess(launch, ['models', '--verbose'], {
          timeoutMs: MODEL_TIMEOUT_MS,
          environment: this.environment
        })
        models = parseOpenCodeModels(result.stdout)
        if (models.length === 0) {
          result = await runProcess(launch, ['models'], {
            timeoutMs: MODEL_TIMEOUT_MS,
            environment: this.environment
          })
          models = parseOpenCodeModels(result.stdout)
        }
      } catch {
        models = []
      }
    }

    if (models.length > 0) {
      this.modelCache.set(key, { models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS })
    }
    return models
  }

  private async inspectRuntime(
    definition: RuntimeDefinition,
    settings: AgentRuntimeSettings
  ): Promise<AgentRuntimeDescriptor> {
    const explicitPath = settings.runtimeId === definition.id ? settings.executablePath : ''
    try {
      const launch = await this.resolveDefinition(definition, explicitPath)
      if (!launch) {
        return {
          id: definition.id,
          name: definition.name,
          kind: 'agent-cli',
          command: definition.command,
          status: 'unavailable',
          installed: false,
          executablePath: '',
          endpoint: '',
          canStart: false,
          runningOwned: false,
          version: '',
          models: [],
          message: `未在 PATH 中发现 ${definition.command}`
        }
      }
      const version = await this.detectVersion(launch)
      let models: AgentRuntimeModel[] = []
      let modelError = false
      if (settings.runtimeId === definition.id) {
        try {
          models = await this.listModels(definition, launch, version)
        } catch {
          modelError = true
        }
      }
      return {
        id: definition.id,
        name: definition.name,
        kind: 'agent-cli',
        command: definition.command,
        status: 'ready',
        installed: true,
        executablePath: launch.displayPath,
        endpoint: '',
        canStart: false,
        runningOwned: false,
        version,
        models,
        message: modelError ? `${version} · 模型目录读取失败` : version
      }
    } catch (error) {
      return {
        id: definition.id,
        name: definition.name,
        kind: 'agent-cli',
        command: definition.command,
        status: 'error',
        installed: true,
        executablePath: explicitPath,
        endpoint: '',
        canStart: false,
        runningOwned: false,
        version: '',
        models: [],
        message: error instanceof Error ? cleanSingleLine(error.message, 180) : '运行时检测失败'
      }
    }
  }

  async discover(value: unknown): Promise<AgentRuntimeDiscovery> {
    const settings = normalizeAgentRuntimeSettings(value)
    const [localRuntimes, cliRuntimes] = await Promise.all([
      this.localModels.discover(settings),
      Promise.all(RUNTIME_DEFINITIONS.map((definition) => this.inspectRuntime(definition, settings)))
    ])
    return {
      runtimes: [...localRuntimes, ...cliRuntimes],
      scannedAt: new Date().toISOString()
    }
  }

  async start(value: unknown): Promise<AgentRuntimeDescriptor> {
    return this.localModels.start(normalizeAgentRuntimeSettings(value))
  }

  async generate(
    value: unknown,
    request: AgentRuntimeGenerateRequest
  ): Promise<AgentRuntimeGenerationResult> {
    const settings = normalizeAgentRuntimeSettings(value)
    if (!settings.enabled) throw new Error('AI 运行时生成尚未启用')
    const prompt = cleanSingleLine(request?.prompt, 500)
    if (!prompt) throw new Error('生成内容不能为空')
    const mode = request?.mode === 'reply' ? 'reply' : 'express'
    const generationPrompt = `生成模式：${mode === 'reply' ? '回复模式' : '表达模式'}\n用户输入：${prompt}`
    if (isLocalModelRuntimeId(settings.runtimeId)) {
      const prompts = [
        generationPrompt,
        `${generationPrompt}\n校验提醒：必须返回恰好 9 个 variants；每项都要使用允许的 emotion，caption 不能为空且不超过 14 个字。`
      ]
      let lastError: Error | null = null
      let totalDurationMs = 0
      for (const localPrompt of prompts) {
        const result = await this.localModels.execute(
          settings,
          localPrompt,
          SYSTEM_PROMPT,
          GENERATION_SCHEMA
        )
        totalDurationMs += result.durationMs
        try {
          const parsed = parseRuntimeGenerationResponse(result.output)
          return {
            ...parsed,
            runtimeId: result.runtimeId,
            runtimeName: result.runtimeName,
            model: result.model,
            durationMs: totalDurationMs
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error('本地模型输出校验失败')
        }
      }
      throw lastError ?? new Error('本地模型输出校验失败')
    }
    const definition = runtimeDefinition(settings.runtimeId)
    const launch = await this.resolveDefinition(definition, settings.executablePath)
    if (!launch) throw new Error(`未找到 ${definition.name} 运行时`)

    const directory = await mkdtemp(join(tmpdir(), 'emoji-pie-runtime-'))
    try {
      const backend = BACKENDS[settings.runtimeId]
      const result = await backend.execute(
        generationPrompt,
        {
          launch,
          cwd: directory,
          model: settings.model,
          systemPrompt: SYSTEM_PROMPT,
          timeoutMs: EXECUTION_TIMEOUT_MS,
          environment: this.environment
        }
      )
      const parsed = parseRuntimeGenerationResponse(result.output)
      return {
        ...parsed,
        runtimeId: settings.runtimeId,
        runtimeName: definition.name,
        model: settings.model || '运行时默认',
        durationMs: result.durationMs
      }
    } finally {
      await safeRemoveRuntimeDirectory(directory).catch(() => undefined)
    }
  }

  dispose(): void {
    this.localModels.dispose()
  }
}
