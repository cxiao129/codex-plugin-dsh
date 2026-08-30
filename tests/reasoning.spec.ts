import { BlockAssembler, CallId, createToolResultMessage, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  CODEX_APP_SERVER_PROVIDER,
  CodexAppServerAdapter,
  type AdapterConfig,
} from '../src/adapter.ts'

const config: AdapterConfig = {
  executable: 'codex',
  env: {},
  modelCacheMs: 0,
  catalogTimeoutMs: 10_000,
  turnTimeoutMs: 10_000,
  disposeGraceMs: 1,
  stderrMaxBytes: 1_024,
  modelPageSize: 100,
}

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

/** Run the adapter over a deterministic App Server notification sequence. */
async function streamNotifications(events: NotificationEvent[]): Promise<BlockAssembler> {
  const sessionId = SessionId('codex-reasoning-unit')
  const adapter = new CodexAppServerAdapter({
    sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
  } as never, config)
  const abort = new AbortController()
  const active = {
    sessionId: String(sessionId),
    model: 'gpt-5.6-terra',
    toolSignature: 'unit',
    connection: { close: async () => undefined },
    events: {
      next: async (): Promise<NotificationEvent> => {
        const next = events.shift()
        if (next === undefined) throw new Error('test notification queue exhausted')
        return next
      },
      fail: () => undefined,
    },
    deadline: { touch: () => undefined, dispose: () => undefined },
    signal: abort.signal,
    threadId: 'thread-1',
    turnId: 'turn-1',
    replayState: {
      kind: 'codex-app-server' as const,
      version: 1 as const,
      threadId: 'thread-1',
      turnId: 'turn-1',
      sessionId: String(sessionId),
      toolSignature: 'unit',
    },
    resolveImageUrl: async () => { throw new Error('unexpected image') },
    onAbort: () => undefined,
    blocks: new Map(),
    completedImages: new Set<string>(),
    nextBlockIndex: 0,
    finalOutput: false,
  }
  ;(adapter as unknown as { startTurn: () => Promise<unknown> }).startTurn = async () => active

  const options: GenerateOptions = {
    provider: CODEX_APP_SERVER_PROVIDER,
    model: 'gpt-5.6-terra',
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'test' }] })],
    sessionId,
  }
  const assembled = new BlockAssembler()
  for await (const chunk of adapter.stream(options)) assembled.push(chunk)
  return assembled
}

describe('Codex reasoning summaries', () => {
  it('persists official reasoning summaries as DSH reasoning blocks', async () => {
    const assembled = await streamNotifications([
      event('item/started', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { type: 'reasoning', id: 'reasoning-1', summary: [], content: [] },
      }),
      event('item/reasoning/summaryTextDelta', {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1',
        summaryIndex: 0, delta: 'Inspect the request.',
      }),
      event('item/reasoning/summaryPartAdded', {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 1,
      }),
      event('item/reasoning/textDelta', {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1',
        contentIndex: 0, delta: ' Decide the next step.',
      }),
      event('item/completed', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { type: 'reasoning', id: 'reasoning-1', summary: ['Inspect the request.', ' Decide the next step.'], content: [] },
      }),
      event('item/started', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'message-1', phase: 'final_answer' },
      }),
      event('item/agentMessage/delta', {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Done.',
      }),
      event('item/completed', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'message-1', phase: 'final_answer', text: 'Done.' },
      }),
      event('turn/completed', {
        threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
      }),
    ])

    expect(assembled.blocks()).toEqual([
      { type: 'reasoning', text: 'Inspect the request. Decide the next step.' },
      { type: 'text', text: 'Done.' },
    ])
    expect(assembled.finish).toMatchObject({ kind: 'stop' })
  })

  it('keeps a pending dynamic-tool continuation pinned to its original App Server turn', async () => {
    const sessionId = SessionId('codex-pending-tool-unit')
    const adapter = new CodexAppServerAdapter({
      sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
    } as never, config)
    const response = Promise.withResolvers<unknown>()
    const abort = new AbortController()
    const callId = CallId('call-pending')
    const notifications: NotificationEvent[] = [
      event('item/started', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'message-1', phase: 'final_answer' },
      }),
      event('item/agentMessage/delta', {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Done.',
      }),
      event('item/completed', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'message-1', phase: 'final_answer', text: 'Done.' },
      }),
      event('turn/completed', {
        threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
      }),
    ]
    const active = {
      sessionId: String(sessionId),
      model: 'gpt-original',
      toolSignature: 'original-tools',
      connection: { close: async () => undefined },
      events: {
        next: async (): Promise<NotificationEvent> => {
          const next = notifications.shift()
          if (next === undefined) throw new Error('test notification queue exhausted')
          return next
        },
        fail: () => undefined,
      },
      deadline: { touch: () => undefined, dispose: () => undefined },
      signal: abort.signal,
      threadId: 'thread-1',
      turnId: 'turn-1',
      replayState: {
        kind: 'codex-app-server' as const,
        version: 1 as const,
        threadId: 'thread-1',
        turnId: 'turn-1',
        sessionId: String(sessionId),
        toolSignature: 'original-tools',
      },
      resolveImageUrl: async () => { throw new Error('unexpected image') },
      onAbort: () => undefined,
      blocks: new Map(),
      completedImages: new Set<string>(),
      nextBlockIndex: 0,
      finalOutput: false,
      awaiting: {
        call: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: String(callId),
          namespace: 'dsh',
          tool: 'echo',
          arguments: { text: 'x' },
        },
        response,
      },
    }
    ;(adapter as unknown as { activeTurns: Map<string, unknown> }).activeTurns.set(String(sessionId), active)

    const options: GenerateOptions = {
      provider: CODEX_APP_SERVER_PROVIDER,
      // DSH may have reassembled the following provider step from a newer UI
      // selection and a different available-tool set.
      model: 'gpt-new-selection',
      messages: [createUserMessage({
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'x' }] }],
      })],
      sessionId,
      tools: [{
        name: 'new_tool',
        description: 'A catalog replacement assembled after the pending call.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      }],
    }

    const assembled = new BlockAssembler()
    for await (const chunk of adapter.stream(options)) assembled.push(chunk)

    await expect(response.promise).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'x' }],
      success: true,
    })
    expect(assembled.blocks()).toEqual([{ type: 'text', text: 'Done.' }])
    expect(assembled.finish).toMatchObject({ kind: 'stop' })
  })

  it('retains a pending dynamic-tool RPC after its original DSH provider step aborts', async () => {
    const sessionId = SessionId('codex-interactive-tool-boundary')
    const adapter = new CodexAppServerAdapter({
      sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
      agents: { get: () => undefined },
    } as never, config)
    const firstAbort = new AbortController()
    let closeCount = 0
    let interruptCount = 0
    let pendingResponse: Promise<unknown> | undefined
    let requestHandler: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined
    const connection = {
      initialize: async () => undefined,
      request: async (method: string): Promise<Record<string, unknown>> => {
        switch (method) {
          case 'config/read': return { config: { mcp_servers: {}, apps: {} } }
          case 'thread/start': return { thread: { id: 'thread-interactive' } }
          case 'turn/start': {
            pendingResponse = requestHandler!('item/tool/call', {
              threadId: 'thread-interactive',
              turnId: 'turn-interactive',
              callId: 'call-interactive',
              namespace: 'dsh',
              tool: 'echo',
              arguments: { text: 'wait for a human' },
            })
            return { turn: { id: 'turn-interactive' } }
          }
          default: throw new Error(`unexpected connection request ${method}`)
        }
      },
      interrupt: () => { interruptCount += 1 },
      close: async () => { closeCount += 1 },
    }
    ;(adapter as unknown as {
      openConnection(
        cwd: string,
        signal: AbortSignal,
        handler: (method: string, params: Record<string, unknown>) => Promise<unknown>,
      ): Promise<unknown>
    }).openConnection = async (_cwd, _signal, handler) => {
      requestHandler = handler
      return connection
    }

    const input = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Ask for the tool result.' }],
    })
    const base: GenerateOptions = {
      provider: CODEX_APP_SERVER_PROVIDER,
      model: 'gpt-5.6-terra',
      messages: [input],
      sessionId,
      signal: firstAbort.signal,
      tools: [{
        name: 'echo',
        description: 'Returns text.',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      }],
    }
    const first = new BlockAssembler()
    for await (const chunk of adapter.stream(base)) first.push(chunk)
    expect(first.finish).toMatchObject({ kind: 'tool-calls' })
    const call = first.blocks().find(block => block.type === 'tool-call')
    if (call?.type !== 'tool-call') throw new Error('expected dynamic tool call')

    // Interactive DSH tools can end their outer turn before the user supplies
    // a result. That request signal must not close the retained App Server RPC.
    firstAbort.abort(new Error('outer DSH turn ended while awaiting user input'))
    expect(closeCount).toBe(0)
    expect(interruptCount).toBe(0)

    const active = (adapter as unknown as {
      activeTurns: Map<string, { events: { push(event: NotificationEvent): void } }>
    }).activeTurns.get(String(sessionId))
    if (active === undefined) throw new Error('expected retained active App Server turn')
    active.events.push(event('item/started', {
      threadId: 'thread-interactive', turnId: 'turn-interactive',
      item: { type: 'agentMessage', id: 'message-interactive', phase: 'final_answer' },
    }))
    active.events.push(event('item/agentMessage/delta', {
      threadId: 'thread-interactive', turnId: 'turn-interactive', itemId: 'message-interactive', delta: 'Resumed.',
    }))
    active.events.push(event('item/completed', {
      threadId: 'thread-interactive', turnId: 'turn-interactive',
      item: { type: 'agentMessage', id: 'message-interactive', phase: 'final_answer', text: 'Resumed.' },
    }))
    active.events.push(event('turn/completed', {
      threadId: 'thread-interactive', turn: { id: 'turn-interactive', status: 'completed' },
    }))

    const result = createToolResultMessage({
      callId: call.id,
      content: [{ type: 'text', text: 'human answer' }],
      isError: false,
    })
    const second = new BlockAssembler()
    for await (const chunk of adapter.stream({
      ...base,
      signal: new AbortController().signal,
      messages: [input, first.message({ kind: 'model', provider: CODEX_APP_SERVER_PROVIDER, model: base.model }), result],
    })) second.push(chunk)

    await expect(pendingResponse).resolves.toEqual({
      contentItems: [{ type: 'inputText', text: 'human answer' }],
      success: true,
    })
    expect(second.blocks()).toEqual([{ type: 'text', text: 'Resumed.' }])
    expect(second.finish).toMatchObject({ kind: 'stop' })
    expect(closeCount).toBe(1)
    expect(interruptCount).toBe(0)
  })
})
