import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerAdapter, type AdapterConfig } from '../src/adapter.ts'

/** Minimal context exposing only the seams bridgeUserInput touches. */
function makeAdapter(ask = vi.fn(), getAgent = vi.fn()) {
  const ctx = {
    userQuestions: { ask },
    agents: { get: getAgent },
  }
  const config: AdapterConfig = {
    executable: 'codex',
    env: {},
    modelCacheMs: 30_000,
    catalogTimeoutMs: 10_000,
    turnTimeoutMs: 10 * 60_000,
    disposeGraceMs: 3_000,
    stderrMaxBytes: 16_384,
    modelPageSize: 100,
  }
  const adapter = new CodexAppServerAdapter(ctx as never, config)
  return {
    adapter,
    bridge: (params: Record<string, unknown>, agent: unknown, signal?: AbortSignal) =>
      (adapter as unknown as {
        bridgeUserInput(
          params: Record<string, unknown>,
          agent: unknown,
          signal?: AbortSignal,
        ): Promise<unknown>
      }).bridgeUserInput(params, agent, signal),
    ask,
    getAgent,
  }
}

const signal = new AbortController().signal

describe('Codex App Server requestUserInput bridge', () => {
  it('maps questions to the DSH ask format and returns the protocol answer', async () => {
    const ask = vi.fn().mockResolvedValue({
      answers: [
        { id: 'q1', selected: ['Option A'], custom: undefined },
        { id: 'q2', selected: [], custom: 'custom text' },
      ],
    })
    const { bridge, ask: askSpy } = makeAdapter(ask)
    const result = await bridge({
      threadId: 't',
      turnId: 'turn',
      itemId: 'item',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'q1',
          header: 'Choose',
          question: 'Which option?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Option A', description: 'first' },
            { label: 'Option B', description: '' },
          ],
        },
        { id: 'q2', header: '', question: 'Type anything', isOther: true, isSecret: false, options: null },
      ],
    }, { id: 'agent-1' }, signal)

    expect(askSpy).toHaveBeenCalledWith({
      questions: [
        {
          id: 'q1',
          question: 'Which option?',
          header: 'Choose',
          options: [
            { label: 'Option A', description: 'first' },
            { label: 'Option B', description: '' },
          ],
          multiSelect: false,
        },
        { id: 'q2', question: 'Type anything', multiSelect: false },
      ],
      agent: { id: 'agent-1' },
      signal,
    })
    expect(result).toEqual({
      answers: {
        q1: { answers: ['Option A'] },
        q2: { answers: ['custom text'] },
      },
    })
  })

  it('rejects secret questions instead of showing them unmasked', async () => {
    const { bridge, ask } = makeAdapter()
    await expect(bridge({
      threadId: 't',
      turnId: 'turn',
      itemId: 'item',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [{ id: 'pw', header: '', question: 'Enter password', isOther: false, isSecret: true, options: null }],
    }, { id: 'agent-1' }, signal)).rejects.toThrow(/secret user input/)
    expect(ask).not.toHaveBeenCalled()
  })

  it('fails explicitly without a live agent', async () => {
    const { bridge, ask } = makeAdapter()
    await expect(bridge({
      threadId: 't',
      turnId: 'turn',
      itemId: 'item',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [{ id: 'q1', header: '', question: 'Ask', isOther: false, isSecret: false, options: null }],
    }, undefined, signal)).rejects.toThrow(/no live DSH agent/)
    expect(ask).not.toHaveBeenCalled()
  })

  it('rejects a request without a questions array', async () => {
    const { bridge, ask } = makeAdapter()
    await expect(bridge({ threadId: 't' }, { id: 'agent-1' }, signal)).rejects.toThrow(/questions array/)
    expect(ask).not.toHaveBeenCalled()
  })

  it('drops answers that contain neither a selection nor custom text', async () => {
    const ask = vi.fn().mockResolvedValue({
      answers: [{ id: 'q1', selected: [], custom: undefined }],
    })
    const { bridge } = makeAdapter(ask)
    const result = await bridge({
      threadId: 't',
      turnId: 'turn',
      itemId: 'item',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [{ id: 'q1', header: '', question: 'Ask', isOther: false, isSecret: false, options: null }],
    }, { id: 'agent-1' }, signal)
    expect(result).toEqual({ answers: {} })
  })

  it('propagates cancellation when the turn aborts while waiting for an answer', async () => {
    const controller = new AbortController()
    const ask = vi.fn().mockImplementation((request: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('ask_user_question was aborted before the user answered')))
    }))
    const { bridge } = makeAdapter(ask)
    const pending = bridge({
      threadId: 't',
      turnId: 'turn',
      itemId: 'item',
      isBlocking: true,
      autoResolutionMs: null,
      questions: [{ id: 'q1', header: '', question: 'Ask', isOther: false, isSecret: false, options: null }],
    }, { id: 'agent-1' }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/)
  })
})
