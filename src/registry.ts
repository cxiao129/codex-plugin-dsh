/** Durable, rebuildable DSH Session to Codex Thread reference index. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { codexReplayState, type CodexReplayState } from './history.ts'
import { thrown } from './validation.ts'

export const CODEX_THREAD_REGISTRY_SERVICE = 'codexThreadRegistry'
const REGISTRY_VERSION = 1 as const

export type CodexThreadRole = 'canonical' | 'branch' | 'pending'
export type CodexThreadExternalState = 'live' | 'archived' | 'deleted' | 'unknown'

export interface CodexThreadCreation {
  readonly sessionId: string
  readonly threadId: string
  readonly kind: 'start' | 'fork'
  readonly parentThreadId?: string
  readonly createdAt?: number
}

export interface CodexThreadRef {
  readonly threadId: string
  readonly role: CodexThreadRole
  readonly committedTurnId?: string
  readonly eventSeq?: number
  readonly ownedByPlugin: boolean
  readonly active: boolean
  readonly referenceCount: number
  readonly externalState: CodexThreadExternalState
  readonly createdBy?: 'start' | 'fork'
  readonly parentThreadId?: string
}

export interface CodexSessionThreadBinding {
  readonly sessionId: string
  readonly workspace?: string
  readonly released: boolean
  readonly canonicalThreadId?: string
  readonly refs: readonly CodexThreadRef[]
}

export interface CodexThreadRegistrySnapshot {
  readonly version: 1
  readonly storagePath: string
  readonly storageHealthy: boolean
  readonly lastError?: string
  readonly pendingManagement: readonly CodexThreadManagementIntent[]
  readonly sessions: readonly CodexSessionThreadBinding[]
}

export interface CodexThreadOperationDecision {
  readonly threadId: string
  readonly action: 'archived' | 'unarchived' | 'deleted' | 'skipped'
  readonly reason?: string
}

export interface CodexThreadLifecycleDriver {
  hasActiveSession(sessionId: string): boolean
  withLifecycleFence<T>(operation: () => Promise<T>): Promise<T>
  isThreadActive(threadId: string, signal?: AbortSignal): Promise<boolean>
  archiveThread(threadId: string, signal?: AbortSignal): Promise<void>
  unarchiveThread(threadId: string, signal?: AbortSignal): Promise<void>
  deleteThread(threadId: string, signal?: AbortSignal): Promise<void>
}

export interface CodexThreadRegistryService {
  snapshot(): CodexThreadRegistrySnapshot
  refsForSession(sessionId: string): readonly CodexThreadRef[]
  referenceCount(threadId: string): number
  reconcile(signal?: AbortSignal): Promise<CodexThreadRegistrySnapshot>
  archiveSessionThreads(sessionId: string, operationId: string, signal?: AbortSignal): Promise<readonly CodexThreadOperationDecision[]>
  restoreSessionThreads(sessionId: string, operationId: string, signal?: AbortSignal): Promise<readonly CodexThreadOperationDecision[]>
  releaseSession(sessionId: string, operationId: string): Promise<void>
  purgeUnreferencedThreads(
    threadIds: readonly string[],
    operationId: string,
    confirmed: boolean,
    signal?: AbortSignal,
  ): Promise<readonly CodexThreadOperationDecision[]>
}

interface MutableThreadRef {
  threadId: string
  role: CodexThreadRole
  committedTurnId?: string
  eventSeq?: number
  externalState: CodexThreadExternalState
}

interface MutableBinding {
  sessionId: string
  workspace?: string
  released: boolean
  refs: Map<string, MutableThreadRef>
}

interface CreationReceipt {
  threadId: string
  sessionId: string
  kind: 'start' | 'fork'
  parentThreadId?: string
  createdAt: number
  deleted: boolean
}

export interface CodexThreadManagementIntent {
  readonly operationId: string
  readonly threadId: string
  readonly action: 'archive' | 'unarchive' | 'delete'
  readonly sessionId?: string
  readonly createdAt: number
}

type ManagementIntent = CodexThreadManagementIntent

interface PersistedRegistry {
  version: 1
  updatedAt: number
  receipts: CreationReceipt[]
  intents: ManagementIntent[]
  sessions: Array<{
    sessionId: string
    workspace?: string
    released: boolean
    refs: MutableThreadRef[]
  }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexThreadRegistry: CodexThreadRegistryService
  }
}

export function defaultCodexThreadRegistryPath(): string {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(dshHome, 'codex-plugin-dsh', 'thread-registry.json')
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseRegistry(value: unknown): PersistedRegistry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('codex-plugin-dsh: thread registry root must be an object')
  }
  const root = value as Record<string, unknown>
  if (root.version !== REGISTRY_VERSION || !Array.isArray(root.receipts) || !Array.isArray(root.sessions)) {
    throw new Error('codex-plugin-dsh: unsupported or malformed thread registry')
  }
  const receipts = root.receipts.map((raw): CreationReceipt => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('codex-plugin-dsh: invalid thread creation receipt')
    const item = raw as Record<string, unknown>
    const threadId = optionalString(item.threadId)
    const sessionId = optionalString(item.sessionId)
    if (threadId === undefined || sessionId === undefined || (item.kind !== 'start' && item.kind !== 'fork')) {
      throw new Error('codex-plugin-dsh: invalid thread creation receipt')
    }
    const parentThreadId = optionalString(item.parentThreadId)
    return {
      threadId,
      sessionId,
      kind: item.kind,
      ...parentThreadId === undefined ? {} : { parentThreadId },
      createdAt: typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt) ? item.createdAt : 0,
      deleted: item.deleted === true,
    }
  })
  if (root.intents !== undefined && !Array.isArray(root.intents)) {
    throw new Error('codex-plugin-dsh: invalid thread management intents')
  }
  const intents = (root.intents ?? []).map((raw): ManagementIntent => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('codex-plugin-dsh: invalid thread management intent')
    const item = raw as Record<string, unknown>
    const operationId = optionalString(item.operationId)
    const threadId = optionalString(item.threadId)
    if (
      operationId === undefined
      || threadId === undefined
      || (item.action !== 'archive' && item.action !== 'unarchive' && item.action !== 'delete')
    ) throw new Error('codex-plugin-dsh: invalid thread management intent')
    const sessionId = optionalString(item.sessionId)
    return {
      operationId,
      threadId,
      action: item.action,
      ...sessionId === undefined ? {} : { sessionId },
      createdAt: typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt) ? item.createdAt : 0,
    }
  })
  const sessions = root.sessions.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('codex-plugin-dsh: invalid thread binding')
    const item = raw as Record<string, unknown>
    const sessionId = optionalString(item.sessionId)
    if (sessionId === undefined || !Array.isArray(item.refs)) throw new Error('codex-plugin-dsh: invalid thread binding')
    const refs = item.refs.map((rawRef): MutableThreadRef => {
      if (rawRef === null || typeof rawRef !== 'object' || Array.isArray(rawRef)) throw new Error('codex-plugin-dsh: invalid thread reference')
      const ref = rawRef as Record<string, unknown>
      const threadId = optionalString(ref.threadId)
      if (
        threadId === undefined
        || (ref.role !== 'canonical' && ref.role !== 'branch' && ref.role !== 'pending')
        || (ref.externalState !== 'live' && ref.externalState !== 'archived' && ref.externalState !== 'deleted' && ref.externalState !== 'unknown')
      ) throw new Error('codex-plugin-dsh: invalid thread reference')
      const committedTurnId = optionalString(ref.committedTurnId)
      return {
        threadId,
        role: ref.role,
        externalState: ref.externalState,
        ...committedTurnId === undefined ? {} : { committedTurnId },
        ...typeof ref.eventSeq === 'number' && Number.isSafeInteger(ref.eventSeq) && ref.eventSeq >= 0
          ? { eventSeq: ref.eventSeq }
          : {},
      }
    })
    const workspace = optionalString(item.workspace)
    return {
      sessionId,
      ...workspace === undefined ? {} : { workspace },
      released: item.released === true,
      refs,
    }
  })
  return {
    version: REGISTRY_VERSION,
    updatedAt: typeof root.updatedAt === 'number' && Number.isSafeInteger(root.updatedAt) ? root.updatedAt : 0,
    receipts,
    intents,
    sessions,
  }
}

function replayStateFromEvent(event: SessionEvent): CodexReplayState | undefined {
  if (event.type !== 'assistant/message') return undefined
  const data = event.data as { readonly message?: { readonly source?: { readonly kind?: string; readonly provider?: string; readonly replayState?: unknown } } }
  const source = data.message?.source
  if (source?.kind !== 'model' || source.provider !== 'codex-app-server') return undefined
  return codexReplayState(source.replayState)
}

/**
 * Registry sidecar. DSH session logs remain authoritative; this file is only a
 * rebuildable reference/ownership index and never authorizes a destructive action
 * without an owned creation receipt and a fresh reference-count check.
 */
export class CodexThreadRegistry implements CodexThreadRegistryService {
  private readonly bindings = new Map<string, MutableBinding>()
  private readonly receipts = new Map<string, CreationReceipt>()
  private readonly intents = new Map<string, ManagementIntent>()
  private stateTail: Promise<void> = Promise.resolve()
  private storageHealthy = true
  private lastError: string | undefined
  private writeTail: Promise<void> = Promise.resolve()
  private reconcileTask: Promise<CodexThreadRegistrySnapshot> | undefined
  private readonly operationTails = new Map<string, Promise<void>>()

  constructor(
    private readonly ctx: Context,
    private readonly driver: CodexThreadLifecycleDriver,
    storagePath = defaultCodexThreadRegistryPath(),
  ) {
    this.storagePath = storagePath === ':memory:' ? storagePath : resolve(storagePath)
  }

  readonly storagePath: string

  async initialize(): Promise<void> {
    if (this.storagePath === ':memory:') return
    try {
      const text = await readFile(this.storagePath, 'utf8')
      this.restore(parseRegistry(JSON.parse(text)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.storageHealthy = false
      this.lastError = thrown(error).message
    }
  }

  async recordCreated(creation: CodexThreadCreation): Promise<void> {
    await this.withStateLock(async () => {
      const receipt: CreationReceipt = {
        threadId: creation.threadId,
        sessionId: creation.sessionId,
        kind: creation.kind,
        ...creation.parentThreadId === undefined ? {} : { parentThreadId: creation.parentThreadId },
        createdAt: creation.createdAt ?? Date.now(),
        deleted: false,
      }
      this.receipts.set(receipt.threadId, receipt)
      const binding = this.binding(creation.sessionId)
      if (!binding.refs.has(creation.threadId)) {
        binding.refs.set(creation.threadId, {
          threadId: creation.threadId,
          role: 'pending',
          externalState: 'live',
        })
      }
      await this.persist()
    })
  }

  async observeSessionEvent(session: Session, event: SessionEvent): Promise<void> {
    const state = replayStateFromEvent(event)
    if (state === undefined) return
    await this.withStateLock(async () => {
      this.observeCheckpoint(String(session.id), session.header.cwd, event.seq, state)
      await this.persist()
    })
  }

  snapshot(): CodexThreadRegistrySnapshot {
    return {
      version: REGISTRY_VERSION,
      storagePath: this.storagePath,
      storageHealthy: this.storageHealthy,
      ...this.lastError === undefined ? {} : { lastError: this.lastError },
      pendingManagement: [...this.intents.values()]
        .sort((left, right) => left.threadId.localeCompare(right.threadId))
        .map(intent => ({ ...intent })),
      sessions: [...this.bindings.values()]
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
        .map(binding => this.bindingSnapshot(binding)),
    }
  }

  refsForSession(sessionId: string): readonly CodexThreadRef[] {
    const binding = this.bindings.get(sessionId)
    return binding === undefined ? [] : this.bindingSnapshot(binding).refs
  }

  referenceCount(threadId: string): number {
    let count = 0
    for (const binding of this.bindings.values()) {
      if (!binding.released && binding.refs.has(threadId)) count += 1
    }
    return count
  }

  reconcile(signal?: AbortSignal): Promise<CodexThreadRegistrySnapshot> {
    if (this.reconcileTask !== undefined) return this.reconcileTask
    const task = this.withStateLock(() => this.runReconcile(signal))
    this.reconcileTask = task
    void task.finally(() => {
      if (this.reconcileTask === task) this.reconcileTask = undefined
    }).catch(() => {})
    return task
  }

  async archiveSessionThreads(
    sessionId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<readonly CodexThreadOperationDecision[]> {
    return this.withOperation(`session:${sessionId}`, operationId, () =>
      this.driver.withLifecycleFence(() => this.withStateLock(async () => {
      this.assertManagementHealthy()
      if (this.driver.hasActiveSession(sessionId)) {
        throw new Error('codex-plugin-dsh: cannot archive Codex threads while the DSH session has an active App Server turn')
      }
      const binding = this.bindings.get(sessionId)
      if (binding === undefined) return []
      if (binding.released) {
        return [...binding.refs.values()].map(ref => ({
          threadId: ref.threadId,
          action: 'skipped' as const,
          reason: 'session binding is released',
        }))
      }
      const decisions: CodexThreadOperationDecision[] = []
      for (const ref of binding.refs.values()) {
        const reason = this.lifecycleBlockReason(ref.threadId)
        if (reason !== undefined) {
          decisions.push({ threadId: ref.threadId, action: 'skipped', reason })
          continue
        }
        if (ref.externalState === 'archived') {
          decisions.push({ threadId: ref.threadId, action: 'skipped', reason: 'already archived' })
          continue
        }
        if (await this.driver.isThreadActive(ref.threadId, signal)) {
          decisions.push({ threadId: ref.threadId, action: 'skipped', reason: 'thread has an active App Server turn' })
          continue
        }
        await this.performManagementIntent({
          operationId,
          threadId: ref.threadId,
          action: 'archive',
          sessionId,
          createdAt: Date.now(),
        }, () => this.driver.archiveThread(ref.threadId, signal), () => {
          ref.externalState = 'archived'
        })
        decisions.push({ threadId: ref.threadId, action: 'archived' })
      }
      await this.persist()
      return decisions
    })))
  }

  async restoreSessionThreads(
    sessionId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<readonly CodexThreadOperationDecision[]> {
    return this.withOperation(`session:${sessionId}`, operationId, () =>
      this.driver.withLifecycleFence(() => this.withStateLock(async () => {
      this.assertManagementHealthy()
      const binding = this.bindings.get(sessionId)
      if (binding === undefined) return []
      const decisions: CodexThreadOperationDecision[] = []
      for (const ref of binding.refs.values()) {
        const receipt = this.receipts.get(ref.threadId)
        if (receipt === undefined || receipt.deleted) {
          decisions.push({ threadId: ref.threadId, action: 'skipped', reason: 'thread ownership is not proven' })
          continue
        }
        if (ref.externalState !== 'archived') {
          decisions.push({ threadId: ref.threadId, action: 'skipped', reason: 'thread was not archived by this registry' })
          continue
        }
        await this.performManagementIntent({
          operationId,
          threadId: ref.threadId,
          action: 'unarchive',
          sessionId,
          createdAt: Date.now(),
        }, () => this.driver.unarchiveThread(ref.threadId, signal), () => {
          ref.externalState = 'live'
        })
        decisions.push({ threadId: ref.threadId, action: 'unarchived' })
      }
      // A restored DSH session owns its durable references again, including
      // recovery from a purge that released refs but preserved the payload.
      binding.released = false
      await this.persist()
      return decisions
    })))
  }

  async releaseSession(sessionId: string, operationId: string): Promise<void> {
    await this.withOperation(`session:${sessionId}`, operationId, () =>
      this.driver.withLifecycleFence(() => this.withStateLock(async () => {
      this.assertManagementHealthy()
      const binding = this.bindings.get(sessionId)
      if (binding === undefined) return
      if (this.driver.hasActiveSession(sessionId)) {
        throw new Error('codex-plugin-dsh: cannot release references for an active DSH session')
      }
      binding.released = true
      await this.persist()
    })))
  }

  async purgeUnreferencedThreads(
    threadIds: readonly string[],
    operationId: string,
    confirmed: boolean,
    signal?: AbortSignal,
  ): Promise<readonly CodexThreadOperationDecision[]> {
    if (!confirmed) throw new Error('codex-plugin-dsh: explicit purge confirmation is required')
    this.assertManagementHealthy()
    const decisions: CodexThreadOperationDecision[] = []
    for (const threadId of [...new Set(threadIds)]) {
      const result = await this.withOperation(`thread:${threadId}`, operationId, () =>
        this.driver.withLifecycleFence(() => this.withStateLock(async () => {
        this.assertManagementHealthy()
        const reason = this.lifecycleBlockReason(threadId, true)
        if (reason !== undefined) return { threadId, action: 'skipped', reason } as const
        if (await this.driver.isThreadActive(threadId, signal)) {
          return { threadId, action: 'skipped', reason: 'thread has an active App Server turn' } as const
        }
        await this.performManagementIntent({
          operationId,
          threadId,
          action: 'delete',
          createdAt: Date.now(),
        }, () => this.driver.deleteThread(threadId, signal), () => {
          const receipt = this.receipts.get(threadId)
          if (receipt !== undefined) receipt.deleted = true
          for (const binding of this.bindings.values()) {
            const ref = binding.refs.get(threadId)
            if (ref !== undefined) ref.externalState = 'deleted'
          }
        })
        return { threadId, action: 'deleted' } as const
      })))
      decisions.push(result)
    }
    return decisions
  }

  async dispose(): Promise<void> {
    await this.stateTail
    await this.writeTail
  }

  private async runReconcile(signal?: AbortSignal): Promise<CodexThreadRegistrySnapshot> {
    signal?.throwIfAborted()
    const headers = await this.ctx.sessionPersistence.list(signal)
    const materialized = new Set(headers.map(header => String(header.id)))
    for (const header of headers) {
      signal?.throwIfAborted()
      const inspection = await this.ctx.sessionPersistence.inspect(header.id, signal)
      const sessionId = String(inspection.meta.id)
      const binding = this.binding(sessionId, inspection.meta.cwd)
      const previousRelease = binding.released
      const previousRefs = new Map(binding.refs)
      binding.refs.clear()
      binding.released = previousRelease
      for (const [threadId, ref] of previousRefs) {
        if (ref.role === 'pending' && this.receipts.get(threadId)?.deleted !== true) {
          binding.refs.set(threadId, { ...ref })
        }
      }
      for (const event of inspection.events) {
        const state = replayStateFromEvent(event)
        if (state === undefined) continue
        this.observeCheckpoint(sessionId, inspection.meta.cwd, event.seq, state)
        const ref = binding.refs.get(state.threadId)
        const previous = previousRefs.get(state.threadId)
        if (ref !== undefined) {
          ref.externalState = previous?.externalState
            ?? (this.receipts.get(state.threadId)?.deleted === false ? 'live' : 'unknown')
        }
      }
    }
    for (const binding of this.bindings.values()) {
      if (!materialized.has(binding.sessionId) && !binding.released) {
        for (const ref of binding.refs.values()) {
          if (ref.role !== 'pending') ref.externalState = ref.externalState === 'deleted' ? 'deleted' : 'unknown'
        }
      }
    }
    await this.persist()
    return this.snapshot()
  }

  private observeCheckpoint(sessionId: string, workspace: string | undefined, eventSeq: number, state: CodexReplayState): void {
    const binding = this.binding(sessionId, workspace)
    for (const ref of binding.refs.values()) {
      if (ref.role === 'canonical') ref.role = 'branch'
    }
    const existing = binding.refs.get(state.threadId)
    binding.refs.set(state.threadId, {
      threadId: state.threadId,
      role: state.sessionId === sessionId ? 'canonical' : existing?.role === 'pending' ? 'pending' : 'branch',
      committedTurnId: state.turnId,
      eventSeq,
      externalState: existing?.externalState ?? 'unknown',
    })
  }

  private binding(sessionId: string, workspace?: string): MutableBinding {
    let binding = this.bindings.get(sessionId)
    if (binding === undefined) {
      binding = {
        sessionId,
        ...workspace === undefined ? {} : { workspace },
        released: false,
        refs: new Map(),
      }
      this.bindings.set(sessionId, binding)
    } else if (workspace !== undefined) {
      binding.workspace = workspace
    }
    return binding
  }

  private bindingSnapshot(binding: MutableBinding): CodexSessionThreadBinding {
    const refs = [...binding.refs.values()]
      .sort((left, right) => left.threadId.localeCompare(right.threadId))
      .map((ref): CodexThreadRef => {
        const receipt = this.receipts.get(ref.threadId)
        return {
          threadId: ref.threadId,
          role: ref.role,
          ...ref.committedTurnId === undefined ? {} : { committedTurnId: ref.committedTurnId },
          ...ref.eventSeq === undefined ? {} : { eventSeq: ref.eventSeq },
          ownedByPlugin: receipt !== undefined && !receipt.deleted,
          active: this.driver.hasActiveSession(binding.sessionId),
          referenceCount: this.referenceCount(ref.threadId),
          externalState: ref.externalState,
          ...receipt === undefined ? {} : {
            createdBy: receipt.kind,
            ...receipt.parentThreadId === undefined ? {} : { parentThreadId: receipt.parentThreadId },
          },
        }
      })
    return {
      sessionId: binding.sessionId,
      ...binding.workspace === undefined ? {} : { workspace: binding.workspace },
      released: binding.released,
      ...refs.find(ref => ref.role === 'canonical')?.threadId === undefined
        ? {}
        : { canonicalThreadId: refs.find(ref => ref.role === 'canonical')!.threadId },
      refs,
    }
  }

  private assertManagementHealthy(): void {
    if (!this.storageHealthy) {
      throw new Error(`codex-plugin-dsh: thread registry management is disabled because storage is unhealthy: ${this.lastError ?? 'unknown error'}`)
    }
  }

  private lifecycleBlockReason(threadId: string, requireUnreferenced = false): string | undefined {
    const receipt = this.receipts.get(threadId)
    if (receipt === undefined || receipt.deleted) return 'thread ownership is not proven'
    const references = this.referenceCount(threadId)
    if (requireUnreferenced ? references !== 0 : references > 1) {
      return requireUnreferenced
        ? `thread still has ${references} DSH session reference(s)`
        : `thread is shared by ${references} DSH sessions`
    }
    return undefined
  }

  private async performManagementIntent(
    intent: ManagementIntent,
    remote: () => Promise<void>,
    commit: () => void,
  ): Promise<void> {
    const existing = this.intents.get(intent.threadId)
    if (
      existing !== undefined
      && (existing.operationId !== intent.operationId || existing.action !== intent.action)
    ) {
      throw new Error(
        `codex-plugin-dsh: thread ${JSON.stringify(intent.threadId)} has pending ${existing.action} intent ${JSON.stringify(existing.operationId)}`,
      )
    }
    if (existing === undefined) {
      this.intents.set(intent.threadId, intent)
      // Write-ahead intent must commit before an external lifecycle RPC. If the
      // RPC succeeds but the final sidecar write fails, restart recovery retains
      // this intent instead of losing evidence of the remote mutation.
      await this.persist()
    }
    this.assertManagementHealthy()
    await remote()
    commit()
    this.intents.delete(intent.threadId)
    await this.persist()
  }

  private restore(persisted: PersistedRegistry): void {
    this.receipts.clear()
    this.intents.clear()
    this.bindings.clear()
    for (const receipt of persisted.receipts) this.receipts.set(receipt.threadId, receipt)
    for (const intent of persisted.intents) this.intents.set(intent.threadId, intent)
    for (const item of persisted.sessions) {
      this.bindings.set(item.sessionId, {
        sessionId: item.sessionId,
        ...item.workspace === undefined ? {} : { workspace: item.workspace },
        released: item.released,
        refs: new Map(item.refs.map(ref => [ref.threadId, { ...ref }])),
      })
    }
  }

  private serialized(): PersistedRegistry {
    return {
      version: REGISTRY_VERSION,
      updatedAt: Date.now(),
      receipts: [...this.receipts.values()].sort((left, right) => left.threadId.localeCompare(right.threadId)),
      intents: [...this.intents.values()].sort((left, right) => left.threadId.localeCompare(right.threadId)),
      sessions: [...this.bindings.values()]
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
        .map(binding => ({
          sessionId: binding.sessionId,
          ...binding.workspace === undefined ? {} : { workspace: binding.workspace },
          released: binding.released,
          refs: [...binding.refs.values()].sort((left, right) => left.threadId.localeCompare(right.threadId)),
        })),
    }
  }

  private persist(): Promise<void> {
    if (this.storagePath === ':memory:') return Promise.resolve()
    if (!this.storageHealthy) {
      return Promise.reject(new Error(`codex-plugin-dsh: thread registry storage is unhealthy: ${this.lastError ?? 'unknown error'}`))
    }
    const payload = JSON.stringify(this.serialized(), null, 2) + '\n'
    const task = this.writeTail.then(async () => {
      await mkdir(dirname(this.storagePath), { recursive: true, mode: 0o700 })
      const temporary = `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.storagePath)
    })
    this.writeTail = task.catch(() => {})
    return task.catch((error) => {
      this.storageHealthy = false
      this.lastError = thrown(error).message
      throw error
    })
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.stateTail
    const gate = Promise.withResolvers<void>()
    const tail = prior.then(() => gate.promise)
    this.stateTail = tail
    await prior
    try {
      return await operation()
    } finally {
      gate.resolve()
      if (this.stateTail === tail) this.stateTail = Promise.resolve()
    }
  }

  private async withOperation<T>(
    key: string,
    operationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (operationId.trim().length === 0) throw new Error('codex-plugin-dsh: operationId must be non-empty')
    const prior = this.operationTails.get(key) ?? Promise.resolve()
    const gate = Promise.withResolvers<void>()
    const tail = prior.then(() => gate.promise)
    this.operationTails.set(key, tail)
    await prior
    try {
      return await operation()
    } finally {
      gate.resolve()
      if (this.operationTails.get(key) === tail) this.operationTails.delete(key)
    }
  }
}
