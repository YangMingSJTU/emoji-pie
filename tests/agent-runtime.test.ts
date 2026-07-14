import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AgentRuntimeManager,
  inspectClaudeProtocolLine,
  normalizeAgentRuntimeSettings,
  openCodeChildEnvironment,
  parseClaudeStreamOutput,
  parseCodexJsonOutput,
  parseCodexModelCatalog,
  parseOpenCodeModels,
  parseRuntimeGenerationResponse,
  requiresCodexServiceTierFallback,
  resolveRuntimeLaunch,
  type RuntimeDefinition
} from '../src/main/agent-runtime'
import {
  LocalModelRuntimeManager,
  normalizeLoopbackEndpoint,
  parseOllamaChatContent,
  parseOllamaModels,
  parseOpenAIChatContent,
  parseOpenAIModels
} from '../src/main/local-model-runtime'
import type { EmotionId } from '../src/shared/types'

const emotions: EmotionId[] = [
  'happy',
  'sad',
  'angry',
  'speechless',
  'tired',
  'surprised',
  'awkward',
  'smug',
  'crazy'
]

function generationPayload(): string {
  return JSON.stringify({
    analysis: {
      emotion: 'tired',
      scene: 'work',
      tone: '克制吐槽',
      intent: '回复工作消息',
      keywords: ['需求', '加班']
    },
    variants: emotions.map((emotion, index) => ({
      emotion,
      caption: index === 0 ? '这就安排' : `方案${index + 1}`
    }))
  })
}

describe('agent runtime settings', () => {
  it('normalizes an empty configuration to the default runtime', () => {
    expect(normalizeAgentRuntimeSettings(undefined)).toEqual({
      enabled: false,
      runtimeId: 'claude',
      executablePath: '',
      endpoint: '',
      model: ''
    })
  })

  it('accepts only absolute executable overrides', () => {
    const executablePath = resolve('runtime-bin', 'agent-cli')
    expect(normalizeAgentRuntimeSettings({
      enabled: true,
      runtimeId: 'codex',
      executablePath,
      model: 'gpt-test'
    })).toEqual({
      enabled: true,
      runtimeId: 'codex',
      executablePath,
      endpoint: '',
      model: 'gpt-test'
    })

    expect(() => normalizeAgentRuntimeSettings({ executablePath: 'bin/agent-cli' }))
      .toThrow('绝对路径')
  })

  it('normalizes local model endpoints and rejects remote hosts', () => {
    expect(normalizeAgentRuntimeSettings({
      enabled: true,
      runtimeId: 'ollama',
      model: 'llama3:latest'
    })).toEqual({
      enabled: true,
      runtimeId: 'ollama',
      executablePath: '',
      endpoint: 'http://127.0.0.1:11434',
      model: 'llama3:latest'
    })
    expect(normalizeLoopbackEndpoint(
      'http://localhost:11434/',
      'http://127.0.0.1:11434'
    )).toBe('http://localhost:11434')
    expect(normalizeLoopbackEndpoint(
      'http://127.9.8.7:8000/v1/',
      'http://127.0.0.1:8000'
    )).toBe('http://127.9.8.7:8000/v1')

    expect(() => normalizeLoopbackEndpoint(
      'https://models.example.com/v1',
      'http://127.0.0.1:8000'
    )).toThrow('只允许')
    expect(() => normalizeLoopbackEndpoint(
      'http://localhost:8000/v1?token=secret',
      'http://127.0.0.1:8000'
    )).toThrow('不能包含')
  })

  it('treats an explicit executable as a hard override during discovery', async () => {
    const manager = new AgentRuntimeManager()
    const result = await manager.discover({
      enabled: true,
      runtimeId: 'claude',
      executablePath: process.execPath,
      model: ''
    })
    const claude = result.runtimes.find(({ id }) => id === 'claude')

    expect(claude?.status).toBe('ready')
    expect(claude?.executablePath).toBe(resolve(process.execPath))
    expect(claude?.version).toMatch(/\d+\.\d+\.\d+/)
    expect(claude?.models.length).toBeGreaterThan(0)
  })
})

describe('runtime protocol parsing', () => {
  it('parses exactly nine runtime-planned emoji variants', () => {
    const result = parseRuntimeGenerationResponse(`\n\`\`\`json\n${generationPayload()}\n\`\`\``)

    expect(result.analysis).toMatchObject({
      emotion: 'tired',
      emotionLabel: '疲惫',
      scene: 'work'
    })
    expect(result.variants).toHaveLength(9)
    expect(result.variants[0]).toEqual({ emotion: 'happy', caption: '这就安排' })
  })

  it('rejects unknown emotions and incomplete variant batches', () => {
    const unknownEmotion = JSON.parse(generationPayload())
    unknownEmotion.variants[0].emotion = 'neutral'
    expect(() => parseRuntimeGenerationResponse(JSON.stringify(unknownEmotion)))
      .toThrow('必须返回 9 个')

    const incomplete = JSON.parse(generationPayload())
    incomplete.variants.pop()
    expect(() => parseRuntimeGenerationResponse(JSON.stringify(incomplete)))
      .toThrow('必须返回 9 个')
  })

  it('extracts Claude structured output and Codex agent messages', () => {
    const claude = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] } }),
      JSON.stringify({ type: 'result', structured_output: JSON.parse(generationPayload()) })
    ].join('\n')
    const codex = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: generationPayload() }
    })

    expect(JSON.parse(parseClaudeStreamOutput(claude)).variants).toHaveLength(9)
    expect(JSON.parse(parseCodexJsonOutput(codex)).variants).toHaveLength(9)
  })

  it('keeps Claude input open until result and answers control requests', () => {
    expect(inspectClaudeProtocolLine(JSON.stringify({ type: 'system' }))).toEqual({
      complete: false,
      response: ''
    })
    expect(inspectClaudeProtocolLine(JSON.stringify({ type: 'result' }))).toEqual({
      complete: true,
      response: ''
    })

    const action = inspectClaudeProtocolLine(JSON.stringify({
      type: 'control_request',
      request_id: 'request-1',
      request: {
        subtype: 'can_use_tool',
        input: { command: 'echo test', run_in_background: true }
      }
    }))
    expect(action.complete).toBe(false)
    expect(JSON.parse(action.response)).toMatchObject({
      type: 'control_response',
      response: {
        request_id: 'request-1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'echo test', run_in_background: false }
        }
      }
    })
  })

  it('parses dynamic Codex and OpenCode model catalogs', () => {
    expect(parseCodexModelCatalog(JSON.stringify({
      models: [
        { slug: 'gpt-visible', display_name: 'GPT Visible', visibility: 'list' },
        { slug: 'gpt-hidden', display_name: 'GPT Hidden', visibility: 'hide' }
      ]
    }))).toEqual([
      { id: 'gpt-visible', label: 'GPT Visible', provider: 'openai', default: true }
    ])

    expect(parseOpenCodeModels('openai/gpt-test\nanthropic/claude-test\nopenai/gpt-test\n'))
      .toEqual([
        { id: 'openai/gpt-test', label: 'openai/gpt-test', provider: 'openai' },
        { id: 'anthropic/claude-test', label: 'anthropic/claude-test', provider: 'anthropic' }
      ])
  })

  it('limits the Codex config fallback to the known old-CLI service tier error', () => {
    expect(requiresCodexServiceTierFallback(
      'unknown variant `priority`, expected `fast` or `flex` in `service_tier`'
    )).toBe(true)
    expect(requiresCodexServiceTierFallback('authentication failed')).toBe(false)
  })

  it('denies OpenCode tools without discarding inline provider configuration', () => {
    const environment = openCodeChildEnvironment({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'ollama/qwen', permission: 'allow' })
    })

    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'ollama/qwen',
      permission: { '*': 'deny' }
    })
  })
})

describe('local model runtime protocols', () => {
  it('parses Ollama and OpenAI-compatible model catalogs and chat output', () => {
    expect(parseOllamaModels({
      models: [{ name: 'llama3:latest' }, { model: 'qwen3:8b' }, { name: 'llama3:latest' }]
    })).toEqual([
      { id: 'llama3:latest', label: 'llama3:latest', provider: 'ollama', default: true },
      { id: 'qwen3:8b', label: 'qwen3:8b', provider: 'ollama' }
    ])
    expect(parseOpenAIModels({
      data: [
        { id: 'local-model', name: 'Local Model', owned_by: 'lmstudio' },
        { id: 'local-model' }
      ]
    })).toEqual([
      {
        id: 'local-model',
        label: 'Local Model',
        provider: 'lmstudio',
        default: true
      }
    ])
    expect(parseOllamaChatContent({ message: { content: generationPayload() } }))
      .toBe(generationPayload())
    expect(parseOpenAIChatContent({
      choices: [{ message: { content: generationPayload() } }]
    })).toBe(generationPayload())
  })

  it('generates through Ollama and applies the shared nine-variant contract', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3:latest' }] }))
      }
      if (url.endsWith('/api/chat')) {
        return new Response(JSON.stringify({ message: { content: generationPayload() } }))
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    const manager = new AgentRuntimeManager({
      environment: { PATH: '' },
      fetchImplementation
    })

    const result = await manager.generate({
      enabled: true,
      runtimeId: 'ollama',
      executablePath: '',
      endpoint: 'http://127.0.0.1:11434',
      model: 'llama3:latest'
    }, {
      prompt: '老板说今晚改完',
      mode: 'reply'
    })

    expect(result.runtimeId).toBe('ollama')
    expect(result.model).toBe('llama3:latest')
    expect(result.variants).toHaveLength(9)
    expect(requests.some(({ url }) => url.endsWith('/api/chat'))).toBe(true)
    expect(requests.every(({ init }) => init?.redirect === 'error')).toBe(true)
  })

  it('retries once when a local model violates the generation contract', async () => {
    let chatRequests = 0
    const fetchImplementation = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'small-model' }] }))
      }
      if (url.endsWith('/api/chat')) {
        chatRequests += 1
        const content = chatRequests === 1
          ? JSON.stringify({
              analysis: JSON.parse(generationPayload()).analysis,
              variants: []
            })
          : generationPayload()
        return new Response(JSON.stringify({ message: { content } }))
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    const manager = new AgentRuntimeManager({ fetchImplementation })

    const result = await manager.generate({
      enabled: true,
      runtimeId: 'ollama',
      executablePath: '',
      endpoint: 'http://127.0.0.1:11434',
      model: 'small-model'
    }, {
      prompt: '再改一版',
      mode: 'reply'
    })

    expect(chatRequests).toBe(2)
    expect(result.variants).toHaveLength(9)
  })

  it('falls back to json_object for compatible servers without strict schemas', async () => {
    const responseFormats: string[] = []
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }))
      }
      if (url.endsWith('/v1/chat/completions')) {
        const request = JSON.parse(String(init?.body)) as {
          response_format?: { type?: string }
        }
        responseFormats.push(request.response_format?.type ?? '')
        if (responseFormats.length === 1) {
          return new Response('strict schema unsupported', { status: 400 })
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: generationPayload() } }]
        }))
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    const manager = new LocalModelRuntimeManager({ fetchImplementation })

    const result = await manager.execute({
      enabled: true,
      runtimeId: 'lmstudio',
      executablePath: '',
      endpoint: 'http://127.0.0.1:1234',
      model: 'local-model'
    }, '用户输入', '系统提示', { type: 'object' })

    expect(responseFormats).toEqual(['json_schema', 'json_object'])
    expect(result.output).toBe(generationPayload())
  })

  it('falls back to JSON mode for older Ollama schema implementations', async () => {
    const formats: unknown[] = []
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'older-model' }] }))
      }
      if (url.endsWith('/api/chat')) {
        const request = JSON.parse(String(init?.body)) as { format?: unknown }
        formats.push(request.format)
        if (formats.length === 1) return new Response('schema unsupported', { status: 400 })
        return new Response(JSON.stringify({ message: { content: generationPayload() } }))
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch
    const manager = new LocalModelRuntimeManager({ fetchImplementation })

    const result = await manager.execute({
      enabled: true,
      runtimeId: 'ollama',
      executablePath: '',
      endpoint: 'http://127.0.0.1:11434',
      model: 'older-model'
    }, '用户输入', '系统提示', { type: 'object' })

    expect(formats).toEqual([{ type: 'object' }, 'json'])
    expect(result.output).toBe(generationPayload())
  })
})

describe.runIf(process.platform === 'win32')('Windows npm shim resolution', () => {
  it('launches a known npm CLI through node without a shell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'emoji-pie-shim-test-'))
    const shimPath = join(directory, 'claude.cmd')
    const scriptPath = join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    const definition: RuntimeDefinition = {
      id: 'claude',
      name: 'Claude Code',
      command: 'claude',
      environmentPath: 'EMOJI_PIE_CLAUDE_PATH',
      npmScript: join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    }

    try {
      await mkdir(dirname(scriptPath), { recursive: true })
      await writeFile(shimPath, '@echo off\r\n', 'utf8')
      await writeFile(scriptPath, '', 'utf8')
      const launch = await resolveRuntimeLaunch(
        definition,
        shimPath,
        { PATH: dirname(process.execPath) },
        'win32'
      )

      expect(launch.executablePath.toLowerCase()).toBe(process.execPath.toLowerCase())
      expect(launch.prefixArgs).toEqual([resolve(scriptPath)])
      expect(launch.displayPath).toBe(resolve(shimPath))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
