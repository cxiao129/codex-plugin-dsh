import { describe, expect, it } from 'vitest'
// The dry-run script deliberately exports pure evidence evaluators for regression tests.
// @ts-expect-error JavaScript CLI module has no declaration file.
import { evaluateArchiveCandidate, inspectSessionRows } from '../scripts/thread-archive-dry-run.mjs'

function sessionRows(options: {
  mode?: 'one-shot' | 'continuable'
  origin?: string
  terminal?: boolean
  seedLength?: number
} = {}) {
  const mode = options.mode ?? 'one-shot'
  const seedLength = options.seedLength ?? 0
  return [
    {
      type: 'session',
      version: 0,
      id: 'child-1',
      parentSession: 'parent-1',
      origin: options.origin ?? 'subagent',
      delegationDepth: 1,
      ...(seedLength === 0 ? {} : { seedLength }),
    },
    ...Array.from({ length: seedLength }, (_, seq) => ({
      seq,
      type: 'assistant/message',
      data: {},
    })),
    { seq: seedLength, type: 'turn/start', data: { turn: 1 } },
    {
      seq: seedLength + 1,
      type: 'subagent/descriptor',
      data: {
        version: 2,
        mode,
        provider: 'spawn',
        ...(mode === 'continuable' ? { label: 'worker' } : {}),
      },
    },
    ...(options.terminal === false
      ? [{ seq: seedLength + 2, type: 'assistant/chunk', data: {} }]
      : [{
          seq: seedLength + 2,
          type: 'turn/end',
          data: { turn: 1, reason: { kind: 'completed' } },
        }]),
  ]
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    session: inspectSessionRows(sessionRows()),
    receipts: [{
      threadId: 'thread-1',
      sessionId: 'child-1',
      kind: 'start',
      createdAt: 1,
      deleted: false,
    }],
    binding: {
      sessionId: 'child-1',
      released: false,
      refs: [{ threadId: 'thread-1', role: 'pending', externalState: 'live' }],
    },
    referenceCount: 1,
    pendingIntent: undefined,
    thread: { id: 'thread-1', archived: 0, is_pinned: 0 },
    ...overrides,
  }
}

describe('one-shot archive dry-run evidence', () => {
  it('uses the child own suffix after a fork seed', () => {
    const inspected = inspectSessionRows(sessionRows({ seedLength: 2 }))
    expect(inspected).toMatchObject({
      sessionId: 'child-1',
      parentSessionId: 'parent-1',
      mode: 'one-shot',
      terminal: true,
      lastEventSeq: 4,
      outcomeKind: 'completed',
    })
  })

  it('admits only a terminal, uniquely owned, unshared and unpinned thread', () => {
    expect(evaluateArchiveCandidate(evidence())).toMatchObject({
      status: 'eligible_after_live_check',
      blockers: [],
      requiredAtExecution: expect.arrayContaining([
        expect.stringContaining('thread/read'),
      ]),
    })
  })

  it('reports an already archived owned thread without scheduling action', () => {
    expect(evaluateArchiveCandidate(evidence({
      thread: { id: 'thread-1', archived: 1, is_pinned: 0 },
    }))).toMatchObject({
      status: 'already_archived',
      blockers: [],
      codexArchived: true,
    })
  })

  it('fails closed when ownership, terminal state, or exclusivity is not proven', () => {
    const session = inspectSessionRows(sessionRows({ terminal: false }))
    const decision = evaluateArchiveCandidate(evidence({
      session,
      receipts: [],
      binding: undefined,
      referenceCount: 0,
      thread: undefined,
    }))
    expect(decision.status).toBe('blocked')
    expect(decision.blockers).toEqual(expect.arrayContaining([
      'dsh_own_turn_not_terminal',
      'ownership_receipt_missing',
      'registry_binding_missing',
    ]))
  })

  it('never treats a continuable child as an archive candidate', () => {
    const decision = evaluateArchiveCandidate(evidence({
      session: inspectSessionRows(sessionRows({ mode: 'continuable' })),
    }))
    expect(decision).toMatchObject({
      status: 'blocked',
      blockers: expect.arrayContaining(['descriptor_not_one_shot']),
    })
  })

  it('respects pinned threads and pending management intents', () => {
    const decision = evaluateArchiveCandidate(evidence({
      pendingIntent: { threadId: 'thread-1', action: 'archive' },
      thread: { id: 'thread-1', archived: 0, is_pinned: 1 },
    }))
    expect(decision).toMatchObject({
      status: 'blocked',
      blockers: expect.arrayContaining([
        'registry_management_pending',
        'codex_thread_pinned',
      ]),
    })
  })
})
