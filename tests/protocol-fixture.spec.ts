import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerAdapter, type AdapterConfig } from '../src/adapter.ts'
import type { CodexAppServerConnection } from '../src/app-server.ts'

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/codex-0.148-thread-lifecycle.json', import.meta.url),
  'utf8',
)) as {
  readonly codexCliVersion: string
  readonly methods: Readonly<Record<string, {
    readonly params: readonly string[]
    readonly response: readonly string[]
  }>>
}

const config: AdapterConfig = {
  executable: 'codex',
  env: {},
  modelCacheMs: 30_000,
  catalogTimeoutMs: 10_000,
  turnTimeoutMs: 600_000,
  disposeGraceMs: 3_000,
  stderrMaxBytes: 16_384,
  modelPageSize: 100,
}

describe('Codex 0.148 thread lifecycle protocol fixture', () => {
  it('pins the exact resume/fork/archive/unarchive/delete RPC surface', () => {
    expect(fixture.codexCliVersion).toBe('0.148.0')
    expect(Object.keys(fixture.methods).sort()).toEqual([
      'thread/archive',
      'thread/delete',
      'thread/fork',
      'thread/read',
      'thread/resume',
      'thread/unarchive',
    ])
    expect(fixture.methods['thread/archive']).toEqual({ params: ['threadId'], response: [] })
    expect(fixture.methods['thread/unarchive']).toEqual({ params: ['threadId'], response: ['thread'] })
    expect(fixture.methods['thread/delete']).toEqual({ params: ['threadId'], response: [] })
  })

  it('reads the remote head before destructive lifecycle management', async () => {
    const request = vi.fn(async () => ({
      thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'inProgress', items: [] }] },
    }))
    const connection = {
      initialize: vi.fn(async () => undefined),
      request,
      close: vi.fn(async () => undefined),
    } as unknown as CodexAppServerConnection
    const adapter = new CodexAppServerAdapter({} as never, config)
    ;(adapter as unknown as { openConnection: unknown }).openConnection = vi.fn(async () => connection)

    await expect(adapter.isThreadActive('thread-1')).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith(
      'thread/read',
      { threadId: 'thread-1', includeTurns: true },
      expect.any(AbortSignal),
    )
    expect(connection.close).toHaveBeenCalledOnce()
  })

  it('treats a remotely missing delete target as idempotent success only for delete', async () => {
    const request = vi.fn(async () => { throw new Error('Codex thread not found') })
    const connection = {
      initialize: vi.fn(async () => undefined),
      request,
      close: vi.fn(async () => undefined),
    } as unknown as CodexAppServerConnection
    const adapter = new CodexAppServerAdapter({} as never, config)
    ;(adapter as unknown as { openConnection: unknown }).openConnection = vi.fn(async () => connection)

    await expect(adapter.deleteThread('thread-1')).resolves.toBeUndefined()
    await expect(adapter.archiveThread('thread-1')).rejects.toThrow('not found')
  })

  it.each([
    'thread/archive',
    'thread/unarchive',
    'thread/delete',
  ] as const)('dispatches %s with the schema-pinned parameter', async method => {
    const request = vi.fn(async () => ({}))
    const connection = {
      initialize: vi.fn(async () => undefined),
      request,
      close: vi.fn(async () => undefined),
    } as unknown as CodexAppServerConnection
    const ctx = {} as never
    const adapter = new CodexAppServerAdapter(ctx, config)
    ;(adapter as unknown as { openConnection: unknown }).openConnection = vi.fn(async () => connection)

    if (method === 'thread/archive') await adapter.archiveThread('thread-1')
    else if (method === 'thread/unarchive') await adapter.unarchiveThread('thread-1')
    else await adapter.deleteThread('thread-1')

    expect(request).toHaveBeenCalledWith(method, { threadId: 'thread-1' }, expect.any(AbortSignal))
    expect(connection.close).toHaveBeenCalledOnce()
  })
})
