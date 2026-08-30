import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_APP_SERVER_PROVIDER,
  CodexAppServerAdapter,
  type AdapterConfig,
} from '../src/adapter.ts'

const baseConfig: AdapterConfig = {
  executable: 'codex',
  env: {},
  modelCacheMs: 0,
  catalogTimeoutMs: 10_000,
  turnTimeoutMs: 10_000,
  disposeGraceMs: 1,
  stderrMaxBytes: 1_024,
  modelPageSize: 100,
}

function adapter(config: AdapterConfig = baseConfig): CodexAppServerAdapter {
  return new CodexAppServerAdapter({
    sessions: { get: () => ({ header: { cwd: '/tmp/workspace' } }) },
  } as never, config)
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: CODEX_APP_SERVER_PROVIDER,
    model: 'gpt-test',
    sessionId: 'session-1',
    messages: [createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Summarize this session.' }],
    })],
    ...overrides,
  } as GenerateOptions
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function completedActive(retainForTools = true) {
  const abort = new AbortController()
  const notifications = [
    {
      kind: 'notification' as const,
      notification: {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'message-1', phase: 'final_answer', text: 'Summary.' },
        },
      },
    },
    {
      kind: 'notification' as const,
      notification: {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed' },
        },
      },
    },
  ]
  return {
    sessionId: 'session-1',
    model: 'gpt-test',
    toolSignature: 'none',
    connection: { close: vi.fn(async () => undefined) },
    events: {
      next: vi.fn(async () => {
        const next = notifications.shift()
        if (next === undefined) throw new Error('test notification queue exhausted')
        return next
      }),
      fail: vi.fn(),
    },
    deadline: { touch: vi.fn(), dispose: vi.fn() },
    signal: abort.signal,
    threadId: 'thread-1',
    turnId: 'turn-1',
    replayState: {
      kind: 'codex-app-server' as const,
      version: 1 as const,
      threadId: 'thread-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      toolSignature: 'none',
    },
    retainForTools,
    persistentThread: retainForTools,
    onAbort: vi.fn(),
    blocks: new Map(),
    completedImages: new Set<string>(),
    nextBlockIndex: 0,
    finalOutput: false,
  }
}

describe('DSH 0.1.1 adapter compatibility', () => {
  it('implements prepareCall and freezes resolved context metadata', async () => {
    const value = adapter({
      ...baseConfig,
      contextWindowTokens: 128_000,
      modelContextWindows: { 'gpt-test': 256_000 },
    })
    ;(value as unknown as { models: () => Promise<readonly unknown[]> }).models = async () => []

    const prepared = await value.prepareCall(CODEX_APP_SERVER_PROVIDER, 'gpt-test')

    expect(prepared.model).toMatchObject({
      provider: CODEX_APP_SERVER_PROVIDER,
      id: 'gpt-test',
      context: { contextWindow: 256_000 },
    })
    expect(prepared.model.inputModalities).toBeUndefined()
    expect(typeof prepared.stream).toBe('function')
  })

  it('disables host retries for stateful App Server turns', () => {
    expect(adapter().providerRetryPolicy(CODEX_APP_SERVER_PROVIDER)).toMatchObject({
      maxRetries: 0,
    })
  })

  it.each(['compaction', 'session-title'] as const)(
    'accepts the DSH %s auxiliary maxTokens field',
    async purpose => {
      const value = adapter()
      const active = completedActive(false)
      const startTurn = vi.fn(async () => active)
      ;(value as unknown as { startTurn: unknown }).startTurn = startTurn

      const chunks = await collect(value.stream(request({ purpose, maxTokens: 8_192 })))

      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({ purpose }),
        'session-1',
        '/tmp/workspace',
        false,
        { kind: 'main', ephemeral: true },
        expect.any(AbortSignal),
      )
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(chunks.at(-1)).not.toHaveProperty('replayState')
      expect(active.connection.close).toHaveBeenCalledOnce()
    },
  )

  it('supports an auxiliary call without a live session identity', async () => {
    const value = adapter()
    const active = completedActive(false)
    const startTurn = vi.fn(async () => active)
    ;(value as unknown as { startTurn: unknown }).startTurn = startTurn

    const auxiliaryRequest = request({ purpose: 'compaction', maxTokens: 8_192 })
    delete auxiliaryRequest.sessionId
    const chunks = await collect(value.stream(auxiliaryRequest))

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'compaction' }),
      'auxiliary:compaction',
      process.cwd(),
      false,
      { kind: 'main', ephemeral: true },
      expect.any(AbortSignal),
    )
    expect(chunks.at(-1)).not.toHaveProperty('replayState')
  })

  it('isolates an auxiliary call from a retained conversational turn in the same session', async () => {
    const value = adapter()
    const retained = completedActive(true)
    const auxiliary = completedActive(false)
    ;(value as unknown as { activeTurns: Map<string, unknown> }).activeTurns.set('session-1', retained)
    const startTurn = vi.fn(async () => auxiliary)
    ;(value as unknown as { startTurn: unknown }).startTurn = startTurn

    const chunks = await collect(value.stream(request({ purpose: 'compaction', maxTokens: 8_192 })))

    expect(startTurn).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      '/tmp/workspace',
      false,
      { kind: 'main', ephemeral: true },
      expect.any(AbortSignal),
    )
    expect(retained.connection.close).not.toHaveBeenCalled()
    expect(auxiliary.connection.close).toHaveBeenCalledOnce()
    expect(chunks.at(-1)).not.toHaveProperty('replayState')
  })

  it('requires a live session for ordinary conversational calls', async () => {
    const value = adapter()
    const ordinaryRequest = request()
    delete ordinaryRequest.sessionId
    await expect(collect(value.stream(ordinaryRequest))).rejects.toThrow('require a live DSH session')
  })

  it('continues to reject unsupported ordinary maxTokens controls', async () => {
    const value = adapter()
    const startTurn = vi.fn()
    ;(value as unknown as { startTurn: unknown }).startTurn = startTurn

    await expect(collect(value.stream(request({ maxTokens: 1_024 })))).rejects.toThrow('maxTokens')
    expect(startTurn).not.toHaveBeenCalled()
  })
})
