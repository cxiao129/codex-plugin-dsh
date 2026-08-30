import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { CodexAppServerAdapter, type AdapterConfig } from '../src/adapter.ts'
import type { CodexAppServerConnection } from '../src/app-server.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { codexToolSignature } from '../src/tools.ts'

type NotificationEvent = {
  readonly kind: 'notification'
  readonly notification: {
    readonly method: string
    readonly params: Record<string, unknown>
  }
}

function event(method: string, params: Record<string, unknown>): NotificationEvent {
  return { kind: 'notification', notification: { method, params } }
}

/** Fake connection that captures the observer and protocol handler the adapter
 * wires on the real class, so tests can drive notifications and requests. */
function fakeConnection() {
  const closed = vi.fn(async () => {})
  const interrupted = vi.fn()
  let observer: { notification(notification: { method: string; params: Record<string, unknown> }): void } | undefined
  let requestHandler: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined
  const value = {
    initialize: vi.fn(async () => undefined),
    request: vi.fn(async (method: string) => method === 'thread/start'
      ? { thread: { id: 'thread-1', turns: [] } }
      : method === 'thread/read'
        ? { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed', items: [] }] } }
        : method === 'thread/resume'
          ? { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed', items: [] }] } }
          : method === 'thread/fork'
          ? { thread: { id: 'thread-fork', turns: [{ id: 'turn-1', status: 'completed', items: [] }] } }
          : method === 'turn/start'
            ? { turn: { id: 'turn-1' } }
            : method === 'threadSection/list'
              ? { data: [{ id: 'section-dsh-subagents', name: 'DSH 子代理', appearance: null }], nextCursor: null }
              : method === 'threadSection/create'
                ? { section: { id: 'section-created', name: 'DSH 子代理', appearance: null } }
                : method === 'config/read'
                  ? { config: {} }
                  : {}),
    close: closed,
    interrupt: interrupted,
  }
  return {
    value: value as unknown as CodexAppServerConnection,
    closed,
    interrupted,
    attach(observerArg: unknown, requestHandlerArg: unknown) {
      observer = observerArg as typeof observer
      requestHandler = requestHandlerArg as typeof requestHandler
    },
    notify(method: string, params: Record<string, unknown>) {
      observer?.notification({ method, params })
    },
    request(method: string, params: Record<string, unknown>) {
      return requestHandler?.(method, params)
    },
  }
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    sessionId: 'session-1',
    provider: 'codex-app-server',
    model: 'gpt-test',
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }],
    tools: [{
      name: 'echo',
      description: 'Returns text.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    }],
    signal: new AbortController().signal,
    ...overrides,
  } as GenerateOptions
}

function childSession(mode: 'one-shot' | 'continuable', label: string) {
  const data = mode === 'one-shot'
    ? snapshotSubagentDescriptor({ mode, provider: 'session', label })
    : snapshotSubagentDescriptor({ mode, provider: 'session', label })
  return {
    header: { cwd: '/tmp/workspace', origin: 'subagent' },
    events: [{ seq: 0, time: 1, type: 'subagent/descriptor', data }],
  }
}

function makeAdapter(
  turnTimeoutMs = 600_000,
  sessionOverride?: { readonly header: Record<string, unknown>; readonly events: readonly unknown[] },
) {
  const agentListeners = new Map<string, (...args: never[]) => unknown>()
  const agent = {
    id: 'session-1',
    ctx: {
      on: vi.fn((name: string, listener: (...args: never[]) => unknown) => {
        agentListeners.set(name, listener)
        return () => agentListeners.delete(name)
      }),
    },
  }
  const attachmentDeferred = Promise.withResolvers<{ ref: { mediaType: string }; data: Uint8Array }>()
  const ctx = {
    subprocess: {},
    sessions: {
      get: () => sessionOverride ?? { header: { cwd: '/tmp/workspace' }, events: [] },
    },
    attachments: {
      readImage: vi.fn(() => attachmentDeferred.promise),
    },
    agents: { get: () => agent },
    userQuestions: { ask: vi.fn() },
  }
  const config: AdapterConfig = {
    executable: 'codex',
    env: {},
    modelCacheMs: 30_000,
    catalogTimeoutMs: 10_000,
    turnTimeoutMs,
    disposeGraceMs: 3_000,
    stderrMaxBytes: 16_384,
    modelPageSize: 100,
  }
  const adapter = new CodexAppServerAdapter(ctx as never, config)
  const connections = fakeConnection()
  ;(adapter as unknown as { openConnection: unknown }).openConnection = vi.fn(
    async (_cwd: string, _signal: AbortSignal, requestHandler: unknown, observer: unknown) => {
      connections.attach(observer, requestHandler)
      return connections.value
    },
  )
  return { adapter, ctx, agentListeners, agent, connections, attachmentDeferred }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Completion sequence that drives a retained turn to a clean stop. */
function completionEvents(threadId = 'thread-1', turnId = 'turn-1'): NotificationEvent[] {
  return [
    event('item/started', {
      threadId, turnId,
      item: { type: 'agentMessage', id: 'message-2', phase: 'final_answer' },
    }),
    event('item/agentMessage/delta', {
      threadId, turnId, itemId: 'message-2', delta: 'Resumed.',
    }),
    event('item/completed', {
      threadId, turnId,
      item: { type: 'agentMessage', id: 'message-2', phase: 'final_answer', text: 'Resumed.' },
    }),
    event('turn/completed', {
      threadId, turn: { id: turnId, status: 'completed' },
    }),
  ]
}

describe('Codex App Server retained turn lifecycle', () => {
  /** Inject a dynamic-tool request during turn/start so the retained turn is
   * guaranteed active and the protocol handler is wired before any stream step
   * consumes it. The App Server RPC stays open until a continuation answers. */
  function queueDynamicTool(turnTimeoutMs = 600_000) {
    const { adapter, agentListeners, connections } = makeAdapter(turnTimeoutMs)
    ;(adapter as unknown as { openConnection: unknown }).openConnection = vi.fn(
      async (_cwd: string, _signal: AbortSignal, requestHandler: unknown, observer: unknown) => {
        connections.attach(observer, requestHandler)
        const handler = requestHandler as (method: string, params: Record<string, unknown>) => Promise<unknown>
        const original = connections.value.request.bind(connections.value) as (method: string) => Promise<Record<string, unknown>>
        const request = async (method: string): Promise<Record<string, unknown>> => {
          const result = await original(method)
          if (method === 'turn/start') {
            void handler('item/tool/call', {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-1',
              callId: 'call-1',
              tool: 'echo',
              arguments: {},
              namespace: 'dsh',
            }).catch(() => {})
          }
          return result
        }
        ;(connections.value as unknown as { request: unknown }).request = request
        return connections.value
      },
    )
    return { adapter, agentListeners, connections }
  }

  it('does not start a turn while explicit lifecycle management holds the fence', async () => {
    const { adapter, connections } = makeAdapter()
    const gate = Promise.withResolvers<void>()
    const management = adapter.withLifecycleFence(() => gate.promise)
    await new Promise(resolve => setImmediate(resolve))

    await expect(collect(adapter.stream(options()))).rejects.toThrow('lifecycle management is in progress')
    expect((adapter as unknown as { openConnection: ReturnType<typeof vi.fn> }).openConnection).not.toHaveBeenCalled()

    gate.resolve()
    await management
  })

  it('holds lifecycle management until thread creation receipt persistence finishes', async () => {
    const { adapter, connections } = makeAdapter()
    const receiptGate = Promise.withResolvers<void>()
    const recordCreated = vi.fn(async () => receiptGate.promise)
    adapter.setThreadCreationObserver({ recordCreated })

    const stream = collect(adapter.stream(options()))
    await vi.waitFor(() => expect(recordCreated).toHaveBeenCalledOnce())
    const managementEntered = vi.fn()
    const management = adapter.withLifecycleFence(async () => {
      managementEntered()
      expect(adapter.hasActiveSession('session-1')).toBe(true)
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(managementEntered).not.toHaveBeenCalled()

    receiptGate.resolve()
    await management
    expect(managementEntered).toHaveBeenCalledOnce()
    for (const entry of completionEvents()) connections.notify(entry.notification.method, entry.notification.params)
    await expect(stream).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ]))
  })

  it('waits for a receipt-persisting startup before session disposal returns', async () => {
    const { adapter, connections } = makeAdapter()
    const receiptGate = Promise.withResolvers<void>()
    const recordCreated = vi.fn(async () => receiptGate.promise)
    adapter.setThreadCreationObserver({ recordCreated })
    const stream = collect(adapter.stream(options())).catch(error => error as Error)
    await vi.waitFor(() => expect(recordCreated).toHaveBeenCalledOnce())

    let disposed = false
    const disposal = adapter.disposeSession('session-1').then(() => { disposed = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
    receiptGate.resolve()
    await disposal
    expect(await stream).toBeInstanceOf(Error)
    expect(connections.closed).toHaveBeenCalledOnce()
  })

  it('single-flights concurrent same-session startup and rejects a duplicate conversational turn', async () => {
    const { adapter, connections } = makeAdapter()
    const gate = Promise.withResolvers<void>()
    const request = connections.value.request as unknown as ReturnType<typeof vi.fn>
    const original = request.getMockImplementation() as ((method: string, ...args: unknown[]) => Promise<unknown>)
    request.mockImplementation(async (method: string, ...args: unknown[]) => {
      if (method === 'thread/start') await gate.promise
      return original(method, ...args)
    })

    const first = collect(adapter.stream(options()))
    await new Promise(resolve => setImmediate(resolve))
    const second = collect(adapter.stream(options())).then(
      chunks => ({ chunks }),
      error => ({ error: error as Error }),
    )
    await new Promise(resolve => setImmediate(resolve))
    gate.resolve()
    await new Promise(resolve => setImmediate(resolve))
    for (const entry of completionEvents()) connections.notify(entry.notification.method, entry.notification.params)

    const [firstChunks, secondResult] = await Promise.all([first, second])
    expect(firstChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(secondResult).toHaveProperty('error')
    expect('error' in secondResult ? secondResult.error.message : '').toContain('already active for this DSH session')
    expect(request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1)
    expect((adapter as unknown as { openConnection: ReturnType<typeof vi.fn> }).openConnection).toHaveBeenCalledOnce()
  })

  it('cancels and closes a same-session startup before session disposal returns', async () => {
    const { adapter, connections } = makeAdapter()
    const initialize = connections.value.initialize as unknown as ReturnType<typeof vi.fn>
    initialize.mockImplementation(async (signal: AbortSignal) => new Promise((_, reject) => {
      const fail = (): void => reject(signal.reason)
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    }))

    const pending = collect(adapter.stream(options())).then(
      chunks => ({ chunks }),
      error => ({ error: error as Error }),
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(adapter.hasActiveSession('session-1')).toBe(true)

    await adapter.disposeSession('session-1')
    const result = await pending
    expect(result).toHaveProperty('error')
    expect(connections.closed).toHaveBeenCalledOnce()
    expect(adapter.hasActiveSession('session-1')).toBe(false)
  })

  it('cancels and closes startup before plugin disposal returns', async () => {
    const { adapter, connections } = makeAdapter()
    const initialize = connections.value.initialize as unknown as ReturnType<typeof vi.fn>
    initialize.mockImplementation(async (signal: AbortSignal) => new Promise((_, reject) => {
      const fail = (): void => reject(signal.reason)
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    }))

    const pending = collect(adapter.stream(options())).catch(error => error as Error)
    await new Promise(resolve => setImmediate(resolve))
    await adapter.dispose()
    expect(await pending).toBeInstanceOf(Error)
    expect(connections.closed).toHaveBeenCalledOnce()
    await expect(collect(adapter.stream(options()))).rejects.toThrow('adapter is disposed')
  })

  it('serializes DSH tool continuations so a concurrent step cannot double-resolve the pending RPC', async () => {
    const { adapter, attachmentDeferred } = makeAdapter()
    // Queue the dynamic-tool request during turn/start so the retained turn is
    // guaranteed active before any stream step consumes it.
    let connectionsHandle: ReturnType<typeof fakeConnection>
    ;(adapter as unknown as { openConnection: unknown }).openConnection = vi.fn(
      async (_cwd: string, _signal: AbortSignal, requestHandler: unknown, observer: unknown) => {
        connectionsHandle = fakeConnection()
        connectionsHandle.attach(observer, requestHandler)
        const handler = requestHandler as (method: string, params: Record<string, unknown>) => Promise<unknown>
        const original = connectionsHandle.value.request.bind(connectionsHandle.value) as (method: string) => Promise<Record<string, unknown>>
        const request = async (method: string): Promise<Record<string, unknown>> => {
          const result = await original(method)
          if (method === 'turn/start') {
            void handler('item/tool/call', {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'item-1',
              callId: 'call-1',
              tool: 'echo',
              arguments: {},
              namespace: 'dsh',
            }).catch(() => {})
          }
          return result
        }
        ;(connectionsHandle.value as unknown as { request: unknown }).request = request
        return connectionsHandle.value
      },
    )

    const firstStep = new AbortController()
    const first = adapter.stream(options({ signal: firstStep.signal }))
    const firstChunks = await collect(first)
    expect(firstChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    // DSH aborts the completed provider step before it dispatches the tool-result
    // continuation. Image resolution in that later step must use its new signal.
    firstStep.abort(new DOMException('first provider step ended', 'AbortError'))

    const continuation = options({
      messages: [{
        id: MessageId('message-tool-result'),
        role: 'user',
        source: { kind: 'tool', callId: CallId('call-1') },
        content: [{ type: 'tool-result', toolCallId: CallId('call-1'), isError: false, content: [{ type: 'image', attachment: { attachmentId: AttachmentId('image-1'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }] }],
      }],
    })

    // Second continuation holds the pending call open while resolving the image.
    const second = adapter.stream(continuation)
    const secondIterator = second[Symbol.asyncIterator]()
    void secondIterator.next()
    await new Promise(resolve => setImmediate(resolve))

    // A third concurrent continuation must be rejected by the resuming guard.
    const third = adapter.stream(continuation)
    await expect(collect(third)).rejects.toThrow('another DSH tool continuation')

    const active = (adapter as unknown as { activeTurns: Map<string, { events: { push(event: NotificationEvent): void } }> })
      .activeTurns.get('session-1')
    if (active === undefined) throw new Error('expected retained active App Server turn')
    for (const entry of completionEvents()) active.events.push(entry)

    attachmentDeferred.resolve({ ref: { mediaType: 'image/png' }, data: new Uint8Array([1]) })
    const secondChunks: StreamChunk[] = []
    for (;;) {
      const next = await secondIterator.next()
      if (next.done) break
      secondChunks.push(next.value)
    }
    expect(secondChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(connectionsHandle!.closed).toHaveBeenCalled()
  })

  it('closes the retained App Server turn when the owning DSH session is disposed', async () => {
    const { adapter, connections } = queueDynamicTool()

    const stream = adapter.stream(options())
    const iterator = stream[Symbol.asyncIterator]()
    const firstChunks: unknown[] = []
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      firstChunks.push(next.value)
    }
    expect(firstChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })

    await adapter.disposeSession('session-1')

    expect(connections.closed).toHaveBeenCalled()
  })

  it('refreshes the idle deadline when a later DSH tool continuation arrives', async () => {
    const { adapter, connections } = queueDynamicTool(40)

    const firstChunks = await collect(adapter.stream(options()))
    expect(firstChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })

    await new Promise(resolve => setTimeout(resolve, 25))
    const continuation = collect(adapter.stream(options({
      messages: [{
        id: MessageId('message-tool-result-text'),
        role: 'user',
        source: { kind: 'tool', callId: CallId('call-1') },
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          isError: false,
          content: [{ type: 'text', text: 'done' }],
        }],
      }],
    })))
    await new Promise(resolve => setTimeout(resolve, 25))

    // More than one original absolute timeout has elapsed, but the continuation
    // refreshed the inactivity deadline and the App Server process is still live.
    expect(connections.closed).not.toHaveBeenCalled()
    for (const entry of completionEvents()) connections.notify(entry.notification.method, entry.notification.params)

    const secondChunks = await continuation
    expect(secondChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(connections.closed).toHaveBeenCalled()
  })

  it('suspends the idle deadline while a DSH dynamic-tool result is pending and resumes after it', async () => {
    const { adapter, connections } = queueDynamicTool(10)

    const firstChunks = await collect(adapter.stream(options()))
    expect(firstChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })

    // A DSH tool or human approval may legitimately take much longer than one
    // App Server idle window. The pending JSON-RPC request holds the deadline.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(connections.closed).not.toHaveBeenCalled()

    const resumed = collect(adapter.stream(options({
      messages: [{
        id: MessageId('message-delayed-tool-result'),
        role: 'user',
        source: { kind: 'tool', callId: CallId('call-1') },
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          isError: false,
          content: [{ type: 'text', text: 'delayed result' }],
        }],
      }],
    })))
    for (const entry of completionEvents()) connections.notify(entry.notification.method, entry.notification.params)

    const resumedChunks = await resumed
    expect(resumedChunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(connections.closed).toHaveBeenCalled()
  })

  it('resumes the same persistent App Server thread when the DSH checkpoint is its current head', async () => {
    const { adapter, connections } = makeAdapter()

    const first = collect(adapter.stream(options()))
    await new Promise(resolve => setImmediate(resolve))
    for (const entry of completionEvents()) connections.notify(entry.notification.method, entry.notification.params)
    const firstChunks = await first
    const finish = firstChunks.findLast(chunk => chunk.type === 'finish')
    if (finish?.type !== 'finish' || finish.replayState === undefined) {
      throw new Error('expected a durable Codex replay checkpoint')
    }

    const second = collect(adapter.stream(options({
      messages: [
        {
          id: MessageId('message-assistant-checkpoint'),
          role: 'assistant',
          source: {
            kind: 'model',
            provider: 'codex-app-server',
            model: 'gpt-test',
            replayState: finish.replayState,
          },
          content: [{ type: 'text', text: 'Resumed.' }],
        },
        {
          id: MessageId('message-user-continue'),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'continue' }],
        },
      ],
    })))
    await new Promise(resolve => setImmediate(resolve))
    for (const entry of completionEvents()) connections.notify(entry.notification.method, entry.notification.params)
    await second

    const request = connections.value.request as unknown as ReturnType<typeof vi.fn>
    expect(request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'thread/fork')).toHaveLength(0)
  })

  it('forks only when the persisted App Server head diverges from the durable DSH checkpoint', async () => {
    const { adapter, connections } = makeAdapter()

    const pending = collect(adapter.stream(options({
      messages: [
        {
          id: MessageId('message-assistant-diverged'),
          role: 'assistant',
          source: {
            kind: 'model',
            provider: 'codex-app-server',
            model: 'gpt-test',
            replayState: {
              response: {
                kind: 'codex-app-server',
                version: 1,
                threadId: 'thread-1',
                turnId: 'turn-checkpoint',
                sessionId: 'session-1',
                toolSignature: codexToolSignature(options().tools),
              },
            },
          },
          content: [{ type: 'text', text: 'Checkpoint response.' }],
        },
        {
          id: MessageId('message-user-diverged'),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'retry from checkpoint' }],
        },
      ],
    })))
    await new Promise(resolve => setImmediate(resolve))
    for (const entry of completionEvents('thread-fork')) {
      connections.notify(entry.notification.method, entry.notification.params)
    }
    await pending

    const request = connections.value.request as unknown as ReturnType<typeof vi.fn>
    expect(request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(0)
    expect(request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(0)
    const forks = request.mock.calls.filter(([method]) => method === 'thread/fork')
    expect(forks).toHaveLength(1)
    expect(forks[0]?.[1]).toMatchObject({ threadId: 'thread-1', lastTurnId: 'turn-checkpoint' })
  })

  it('rebuilds representable DSH history when the checkpoint thread is missing', async () => {
    const { adapter, connections } = makeAdapter()
    const request = connections.value.request as unknown as ReturnType<typeof vi.fn>
    const original = request.getMockImplementation() as ((method: string, ...args: unknown[]) => Promise<unknown>) | undefined
    request.mockImplementation(async (method: string, ...args: unknown[]) => {
      if (method === 'thread/read') throw new Error('Codex thread not found')
      if (original === undefined) throw new Error('missing fake request implementation')
      return original(method, ...args)
    })

    const pending = collect(adapter.stream(options({
      messages: [
        {
          id: MessageId('message-assistant-missing-thread'),
          role: 'assistant',
          source: {
            kind: 'model',
            provider: 'codex-app-server',
            model: 'gpt-test',
            replayState: {
              response: {
                kind: 'codex-app-server',
                version: 1,
                threadId: 'thread-missing',
                turnId: 'turn-old',
                sessionId: 'session-1',
                toolSignature: codexToolSignature(options().tools),
              },
            },
          },
          content: [{ type: 'text', text: 'Durable answer.' }],
        },
        {
          id: MessageId('message-user-after-missing'),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'continue with durable context' }],
        },
      ],
    })))
    await new Promise(resolve => setImmediate(resolve))
    for (const entry of completionEvents()) connections.notify(entry.notification.method, entry.notification.params)
    await pending

    expect(request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'thread/resume')).toHaveLength(0)
    expect(request.mock.calls.filter(([method]) => method === 'thread/fork')).toHaveLength(0)
    const inject = request.mock.calls.find(([method]) => method === 'thread/inject_items')
    expect(inject?.[1]).toMatchObject({
      threadId: 'thread-1',
      items: [expect.objectContaining({ type: 'message', role: 'assistant' })],
    })
  })

  it('keeps one-shot DSH subagents ephemeral while preserving their dynamic-tool turn', async () => {
    const { adapter, connections } = makeAdapter(600_000, childSession('one-shot', 'Snapshot review'))
    const recordCreated = vi.fn(async () => undefined)
    adapter.setThreadCreationObserver({ recordCreated })

    const pending = collect(adapter.stream(options()))
    await new Promise(resolve => setImmediate(resolve))

    const request = connections.value.request as unknown as ReturnType<typeof vi.fn>
    const start = request.mock.calls.find(([method]) => method === 'thread/start')
    expect(start?.[1]).toMatchObject({ ephemeral: true })
    expect(start?.[1].dynamicTools).toHaveLength(1)
    expect(request.mock.calls.some(([method]) => method === 'thread/name/set')).toBe(false)
    expect(request.mock.calls.some(([method]) => method === 'thread/section/move')).toBe(false)
    expect(recordCreated).not.toHaveBeenCalled()

    for (const entry of completionEvents()) connections.notify(entry.notification.method, entry.notification.params)
    const chunks = await pending
    expect(chunks.at(-1)).not.toHaveProperty('replayState')
  })

  it('names and groups continuable DSH subagents while keeping replay state', async () => {
    const { adapter, connections } = makeAdapter(600_000, childSession('continuable', 'Long-running review'))
    const recordCreated = vi.fn(async () => undefined)
    adapter.setThreadCreationObserver({ recordCreated })

    const pending = collect(adapter.stream(options()))
    await new Promise(resolve => setImmediate(resolve))

    const request = connections.value.request as unknown as ReturnType<typeof vi.fn>
    const start = request.mock.calls.find(([method]) => method === 'thread/start')
    expect(start?.[1]).toMatchObject({ ephemeral: false })
    expect(request).toHaveBeenCalledWith(
      'thread/name/set',
      { threadId: 'thread-1', name: '[DSH 子代理] Long-running review' },
      expect.any(AbortSignal),
    )
    expect(request).toHaveBeenCalledWith(
      'thread/section/move',
      { threadId: 'thread-1', sectionId: 'section-dsh-subagents', beforeThreadId: null },
      expect.any(AbortSignal),
    )
    expect(recordCreated).toHaveBeenCalledWith({
      sessionId: 'session-1',
      threadId: 'thread-1',
      kind: 'start',
    })

    for (const entry of completionEvents()) connections.notify(entry.notification.method, entry.notification.params)
    const chunks = await pending
    expect(chunks.at(-1)).toHaveProperty('replayState')
  })

  it('runs auxiliary purposes in an ephemeral thread without dynamic tools or retained state', async () => {
    const { adapter, connections } = makeAdapter()

    const pending = collect(adapter.stream(options({ purpose: 'compaction', maxTokens: 8_192 })))
    await new Promise(resolve => setImmediate(resolve))

    const threadStart = connections.value.request as unknown as ReturnType<typeof vi.fn>
    const call = threadStart.mock.calls.find(([method]) => method === 'thread/start')
    expect(call?.[1]).toMatchObject({ ephemeral: true, dynamicTools: [] })
    expect((adapter as unknown as { activeTurns: Map<string, unknown> }).activeTurns.size).toBe(0)

    for (const entry of completionEvents()) connections.notify(entry.notification.method, entry.notification.params)
    const chunks = await pending
    expect(chunks.at(-1)).not.toHaveProperty('replayState')
    expect(connections.closed).toHaveBeenCalled()
  })

  it('closes an inactive turn when no App Server request is waiting on DSH', async () => {
    const { adapter, connections } = makeAdapter(10)

    await expect(collect(adapter.stream(options()))).rejects.toThrow('App Server turn was idle')
    expect(connections.interrupted).toHaveBeenCalledWith('thread-1', 'turn-1')
    expect(connections.closed).toHaveBeenCalled()
  })
})
