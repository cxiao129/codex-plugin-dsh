import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexThreadRegistry,
  type CodexThreadLifecycleDriver,
} from '../src/registry.ts'

const temporaryRoots: string[] = []

function driver(): CodexThreadLifecycleDriver & {
  isThreadActive: ReturnType<typeof vi.fn>
  archiveThread: ReturnType<typeof vi.fn>
  unarchiveThread: ReturnType<typeof vi.fn>
  deleteThread: ReturnType<typeof vi.fn>
} {
  return {
    hasActiveSession: () => false,
    withLifecycleFence: async operation => operation(),
    isThreadActive: vi.fn(async () => false),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    deleteThread: vi.fn(async () => undefined),
  }
}

function session(id: string, cwd = '/tmp/workspace') {
  return { id, header: { id, cwd } }
}

function assistantEvent(
  seq: number,
  ownerSessionId: string,
  threadId: string,
  turnId: string,
) {
  return {
    seq,
    type: 'assistant/message',
    data: {
      message: {
        source: {
          kind: 'model',
          provider: 'codex-app-server',
          replayState: {
            response: {
              kind: 'codex-app-server',
              version: 1,
              sessionId: ownerSessionId,
              threadId,
              turnId,
              toolSignature: 'tools-v1',
            },
          },
        },
      },
    },
  }
}

function context(inspections: Array<{ meta: { id: string; cwd: string }; events: unknown[] }> = []) {
  return {
    sessionPersistence: {
      list: vi.fn(async () => inspections.map(item => item.meta)),
      inspect: vi.fn(async (id: string) => {
        const found = inspections.find(item => item.meta.id === id)
        if (found === undefined) throw new Error('missing inspection')
        return found
      }),
    },
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Codex thread registry', () => {
  it('tracks an owned creation receipt and promotes the committed thread to canonical', async () => {
    const registry = new CodexThreadRegistry(context() as never, driver(), ':memory:')
    await registry.initialize()
    await registry.recordCreated({ sessionId: 'session-1', threadId: 'thread-1', kind: 'start' })
    await registry.observeSessionEvent(
      session('session-1') as never,
      assistantEvent(7, 'session-1', 'thread-1', 'turn-1') as never,
    )

    const snapshot = registry.snapshot()
    expect(snapshot.sessions).toEqual([expect.objectContaining({
      sessionId: 'session-1',
      canonicalThreadId: 'thread-1',
      refs: [expect.objectContaining({
        threadId: 'thread-1',
        role: 'canonical',
        committedTurnId: 'turn-1',
        eventSeq: 7,
        ownedByPlugin: true,
        externalState: 'live',
      })],
    })])
  })

  it('exposes active state and distinct-session reference counts to lifecycle consumers', async () => {
    const lifecycle = driver()
    lifecycle.hasActiveSession = sessionId => sessionId === 'session-1'
    const registry = new CodexThreadRegistry(context() as never, lifecycle, ':memory:')
    await registry.recordCreated({ sessionId: 'session-1', threadId: 'thread-1', kind: 'start' })
    await registry.observeSessionEvent(session('session-1') as never, assistantEvent(1, 'session-1', 'thread-1', 'turn-1') as never)
    await registry.observeSessionEvent(session('session-2') as never, assistantEvent(2, 'session-1', 'thread-1', 'turn-1') as never)

    expect(registry.refsForSession('session-1')).toEqual([
      expect.objectContaining({ threadId: 'thread-1', active: true, referenceCount: 2 }),
    ])
    expect(registry.refsForSession('session-2')).toEqual([
      expect.objectContaining({ threadId: 'thread-1', active: false, referenceCount: 2 }),
    ])
  })

  it('keeps prior canonical threads as branches and counts references by DSH session', async () => {
    const registry = new CodexThreadRegistry(context() as never, driver(), ':memory:')
    await registry.recordCreated({ sessionId: 'session-1', threadId: 'thread-1', kind: 'start' })
    await registry.recordCreated({
      sessionId: 'session-1',
      threadId: 'thread-2',
      kind: 'fork',
      parentThreadId: 'thread-1',
    })
    await registry.observeSessionEvent(session('session-1') as never, assistantEvent(3, 'session-1', 'thread-1', 'turn-1') as never)
    await registry.observeSessionEvent(session('session-1') as never, assistantEvent(8, 'session-1', 'thread-2', 'turn-2') as never)
    await registry.observeSessionEvent(session('session-2') as never, assistantEvent(2, 'session-1', 'thread-1', 'turn-1') as never)

    expect(registry.refsForSession('session-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: 'thread-1', role: 'branch' }),
      expect.objectContaining({ threadId: 'thread-2', role: 'canonical', parentThreadId: 'thread-1' }),
    ]))
    expect(registry.referenceCount('thread-1')).toBe(2)
  })

  it('archives and restores only proven, unshared, inactive owned threads', async () => {
    const lifecycle = driver()
    const registry = new CodexThreadRegistry(context() as never, lifecycle, ':memory:')
    await registry.recordCreated({ sessionId: 'session-1', threadId: 'thread-1', kind: 'start' })
    await registry.observeSessionEvent(session('session-1') as never, assistantEvent(1, 'session-1', 'thread-1', 'turn-1') as never)

    await expect(registry.archiveSessionThreads('session-1', 'archive-1')).resolves.toEqual([
      { threadId: 'thread-1', action: 'archived' },
    ])
    expect(lifecycle.archiveThread).toHaveBeenCalledWith('thread-1', undefined)

    await registry.releaseSession('session-1', 'release-before-restore')
    expect(registry.referenceCount('thread-1')).toBe(0)
    await expect(registry.archiveSessionThreads('session-1', 'archive-released')).resolves.toEqual([
      { threadId: 'thread-1', action: 'skipped', reason: 'session binding is released' },
    ])
    expect(lifecycle.archiveThread).toHaveBeenCalledTimes(1)

    await expect(registry.restoreSessionThreads('session-1', 'restore-1')).resolves.toEqual([
      { threadId: 'thread-1', action: 'unarchived' },
    ])
    expect(lifecycle.unarchiveThread).toHaveBeenCalledWith('thread-1', undefined)
    expect(registry.referenceCount('thread-1')).toBe(1)
  })

  it('skips archive and purge when the remote App Server head is still active', async () => {
    const lifecycle = driver()
    lifecycle.isThreadActive.mockResolvedValue(true)
    const registry = new CodexThreadRegistry(context() as never, lifecycle, ':memory:')
    await registry.recordCreated({ sessionId: 'session-1', threadId: 'thread-1', kind: 'start' })
    await registry.observeSessionEvent(session('session-1') as never, assistantEvent(1, 'session-1', 'thread-1', 'turn-1') as never)

    await expect(registry.archiveSessionThreads('session-1', 'archive-active')).resolves.toEqual([
      expect.objectContaining({ action: 'skipped', reason: expect.stringContaining('active App Server turn') }),
    ])
    await registry.releaseSession('session-1', 'release-active')
    await expect(registry.purgeUnreferencedThreads(['thread-1'], 'purge-active', true)).resolves.toEqual([
      expect.objectContaining({ action: 'skipped', reason: expect.stringContaining('active App Server turn') }),
    ])
    expect(lifecycle.archiveThread).not.toHaveBeenCalled()
    expect(lifecycle.deleteThread).not.toHaveBeenCalled()
  })

  it('requires release, ownership, and explicit confirmation before delete', async () => {
    const lifecycle = driver()
    const registry = new CodexThreadRegistry(context() as never, lifecycle, ':memory:')
    await registry.recordCreated({ sessionId: 'session-1', threadId: 'thread-1', kind: 'start' })
    await registry.observeSessionEvent(session('session-1') as never, assistantEvent(1, 'session-1', 'thread-1', 'turn-1') as never)

    await expect(registry.purgeUnreferencedThreads(['thread-1'], 'purge-1', false)).rejects.toThrow('confirmation')
    await expect(registry.purgeUnreferencedThreads(['thread-1'], 'purge-2', true)).resolves.toEqual([
      expect.objectContaining({ action: 'skipped', reason: expect.stringContaining('still has 1') }),
    ])

    await registry.releaseSession('session-1', 'release-1')
    await expect(registry.purgeUnreferencedThreads(['thread-1'], 'purge-3', true)).resolves.toEqual([
      { threadId: 'thread-1', action: 'deleted' },
    ])
    expect(lifecycle.deleteThread).toHaveBeenCalledWith('thread-1', undefined)
  })

  it('never calls the remote lifecycle RPC when the write-ahead intent cannot persist', async () => {
    const lifecycle = driver()
    const registry = new CodexThreadRegistry(context() as never, lifecycle, ':memory:')
    await registry.recordCreated({ sessionId: 'session-1', threadId: 'thread-1', kind: 'start' })
    await registry.observeSessionEvent(session('session-1') as never, assistantEvent(1, 'session-1', 'thread-1', 'turn-1') as never)
    const privateRegistry = registry as unknown as { persist: () => Promise<void>; storageHealthy: boolean; lastError?: string }
    privateRegistry.persist = async () => {
      privateRegistry.storageHealthy = false
      privateRegistry.lastError = 'simulated intent failure'
      throw new Error('simulated intent failure')
    }

    await expect(registry.archiveSessionThreads('session-1', 'archive-no-intent')).rejects.toThrow('simulated intent failure')
    expect(lifecycle.archiveThread).not.toHaveBeenCalled()
  })

  it('serializes reconcile and management state without exposing partial references', async () => {
    const inspectGate = Promise.withResolvers<void>()
    const ctx = context([{
      meta: { id: 'session-1', cwd: '/tmp/workspace' },
      events: [assistantEvent(1, 'session-1', 'thread-1', 'turn-1')],
    }])
    const inspect = ctx.sessionPersistence.inspect
    inspect.mockImplementation(async id => {
      await inspectGate.promise
      return {
        meta: { id: String(id), cwd: '/tmp/workspace' },
        events: [assistantEvent(1, 'session-1', 'thread-1', 'turn-1')],
      }
    })
    const lifecycle = driver()
    const registry = new CodexThreadRegistry(ctx as never, lifecycle, ':memory:')
    await registry.recordCreated({ sessionId: 'session-1', threadId: 'thread-1', kind: 'start' })

    const reconciliation = registry.reconcile()
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce())
    const management = registry.archiveSessionThreads('session-1', 'archive-after-reconcile')
    await new Promise(resolve => setImmediate(resolve))
    expect(lifecycle.archiveThread).not.toHaveBeenCalled()

    inspectGate.resolve()
    await reconciliation
    await expect(management).resolves.toEqual([{ threadId: 'thread-1', action: 'archived' }])
    expect(lifecycle.archiveThread).toHaveBeenCalledOnce()
  })

  it('writes an intent before remote mutation and resumes it after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-thread-intent-'))
    temporaryRoots.push(root)
    const storagePath = join(root, 'registry.json')
    const firstDriver = driver()
    const first = new CodexThreadRegistry(context() as never, firstDriver, storagePath)
    await first.initialize()
    await first.recordCreated({ sessionId: 'session-1', threadId: 'thread-1', kind: 'start' })
    await first.observeSessionEvent(session('session-1') as never, assistantEvent(1, 'session-1', 'thread-1', 'turn-1') as never)

    const privateFirst = first as unknown as { persist: () => Promise<void>; storageHealthy: boolean; lastError?: string }
    const persist = privateFirst.persist.bind(first)
    let calls = 0
    privateFirst.persist = async () => {
      calls += 1
      if (calls === 1) return persist()
      privateFirst.storageHealthy = false
      privateFirst.lastError = 'simulated final commit failure'
      throw new Error('simulated final commit failure')
    }
    await expect(first.archiveSessionThreads('session-1', 'archive-recover')).rejects.toThrow('simulated final commit failure')
    expect(firstDriver.archiveThread).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(storagePath, 'utf8')).intents).toEqual([
      expect.objectContaining({ operationId: 'archive-recover', threadId: 'thread-1', action: 'archive' }),
    ])

    const secondDriver = driver()
    const second = new CodexThreadRegistry(context() as never, secondDriver, storagePath)
    await second.initialize()
    expect(second.snapshot().pendingManagement).toEqual([
      expect.objectContaining({ operationId: 'archive-recover', threadId: 'thread-1', action: 'archive' }),
    ])
    await expect(second.archiveSessionThreads('session-1', 'archive-recover')).resolves.toEqual([
      { threadId: 'thread-1', action: 'archived' },
    ])
    expect(secondDriver.archiveThread).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(storagePath, 'utf8')).intents).toEqual([])
  })

  it('persists creation receipts and bindings for restart recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-thread-registry-'))
    temporaryRoots.push(root)
    const storagePath = join(root, 'registry.json')
    const first = new CodexThreadRegistry(context() as never, driver(), storagePath)
    await first.initialize()
    await first.recordCreated({ sessionId: 'session-1', threadId: 'thread-1', kind: 'start' })
    await first.observeSessionEvent(session('session-1') as never, assistantEvent(5, 'session-1', 'thread-1', 'turn-1') as never)
    await first.dispose()

    const second = new CodexThreadRegistry(context() as never, driver(), storagePath)
    await second.initialize()
    expect(second.snapshot().sessions[0]).toMatchObject({
      canonicalThreadId: 'thread-1',
      refs: [expect.objectContaining({ ownedByPlugin: true, eventSeq: 5 })],
    })
    expect(JSON.parse(await readFile(storagePath, 'utf8'))).toMatchObject({ version: 1 })
  })

  it('fails management closed on a corrupt sidecar without overwriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-thread-registry-corrupt-'))
    temporaryRoots.push(root)
    const storagePath = join(root, 'registry.json')
    await writeFile(storagePath, '{broken', 'utf8')

    const lifecycle = driver()
    const registry = new CodexThreadRegistry(context() as never, lifecycle, storagePath)
    await registry.initialize()
    expect(registry.snapshot()).toMatchObject({ storageHealthy: false })
    await expect(registry.recordCreated({ sessionId: 'session-1', threadId: 'thread-1', kind: 'start' })).rejects.toThrow('storage is unhealthy')
    await expect(registry.archiveSessionThreads('session-1', 'archive-corrupt')).rejects.toThrow('storage is unhealthy')
    await expect(registry.releaseSession('session-1', 'release-corrupt')).rejects.toThrow('storage is unhealthy')
    await expect(registry.purgeUnreferencedThreads(['thread-1'], 'purge-corrupt', true)).rejects.toThrow('storage is unhealthy')
    expect(lifecycle.archiveThread).not.toHaveBeenCalled()
    expect(lifecycle.deleteThread).not.toHaveBeenCalled()
    await registry.dispose()
    expect(await readFile(storagePath, 'utf8')).toBe('{broken')
  })

  it('reconciles canonical and historical branch references from durable DSH logs', async () => {
    const ctx = context([{
      meta: { id: 'session-1', cwd: '/tmp/workspace' },
      events: [
        assistantEvent(1, 'session-1', 'thread-1', 'turn-1'),
        assistantEvent(4, 'session-1', 'thread-2', 'turn-2'),
      ],
    }])
    const registry = new CodexThreadRegistry(ctx as never, driver(), ':memory:')
    await registry.reconcile()

    expect(registry.snapshot().sessions[0]).toMatchObject({
      sessionId: 'session-1',
      canonicalThreadId: 'thread-2',
      refs: expect.arrayContaining([
        expect.objectContaining({ threadId: 'thread-1', role: 'branch', ownedByPlugin: false }),
        expect.objectContaining({ threadId: 'thread-2', role: 'canonical', ownedByPlugin: false }),
      ]),
    })
  })
})
