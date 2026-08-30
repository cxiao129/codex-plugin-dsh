/** Codex App Server implementation of the DeepSeek Harness LLM adapter API. */

import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  CallId,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ModelModality,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { AskUserQuestionItem, AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'
import {
  CodexAppServerConnection,
  type AppServerConnectionObserver,
  type AppServerNotification,
} from './app-server.ts'
import { prepareCodexHistory, type CodexReplayState } from './history.ts'
import { decideThreadContinuation } from './thread-state.ts'
import type { CodexThreadCreation } from './registry.ts'
import { attachmentDataUrl, generatedImageBlock } from './images.ts'
import {
  resolveThreadPresentation,
  type ThreadPresentation,
  type ThreadPresentationPolicy,
} from './presentation.ts'
import {
  codexDynamicToolCall,
  codexDynamicToolResult,
  codexDynamicTools,
  codexToolSignature,
  type CodexDynamicToolCall,
  type CodexToolImageUrlResolver,
} from './tools.ts'
import { object, string, thrown } from './validation.ts'

/** Provider route registered in the existing DSH model catalog. */
export const CODEX_APP_SERVER_PROVIDER = 'codex-app-server'

const CODEX_RETRY_POLICY = resolveRetryPolicy({
  mode: 'normal',
  maxRetries: 0,
}, 'codex-plugin-dsh.retry')

/** Provider instructions that separate DSH dynamic tools from Codex host capabilities. */
export const CODEX_APP_SERVER_DEVELOPER_INSTRUCTIONS = [
  'DeepSeek Harness owns tool selection, permission checks, execution, and durable tool logs.',
  'Use only tools in the dsh dynamic-tool namespace for shell, files, web, code changes, and other actions represented in the DSH tool catalog.',
  'Do not use built-in shell, apply_patch, web search, MCP, app, plugin, multi-agent, or view-image tools.',
  'The dsh skill tool loads only names listed in the DSH <available_skills> catalog included in the conversation; never use it to load Codex host skills or capabilities.',
  'For image creation or editing, use Codex host imagegen and native image generation directly; never call the dsh skill tool with the name imagegen.',
].join(' ')

const WINDOWS_EXECUTABLE_ENV = 'DSH_CODEX_APP_SERVER_EXECUTABLE'

/** Resolved process and timeout configuration owned by the plugin deployment. */
export interface AdapterConfig {
  readonly executable: string
  readonly env: Record<string, string>
  readonly modelCacheMs: number
  readonly catalogTimeoutMs: number
  readonly turnTimeoutMs: number
  readonly disposeGraceMs: number
  readonly stderrMaxBytes: number
  readonly modelPageSize: number
  /** Fallback model context capacity when App Server has not reported one yet; zero means unknown. */
  readonly contextWindowTokens?: number
  /** Exact per-model context capacities, overridden by authoritative runtime usage notifications. */
  readonly modelContextWindows?: Readonly<Record<string, number>>
  /** Keep one-shot DSH child Sessions out of the persistent Codex thread index. Defaults to true. */
  readonly ephemeralOneShotSubagents?: boolean
  /** Apply stable DSH-prefixed names to persistent App Server threads. Defaults to true. */
  readonly syncThreadNames?: boolean
  /** App Server section for persistent DSH child threads; empty disables grouping. */
  readonly subagentSectionName?: string
}

export interface CodexThreadCreationObserver {
  recordCreated(creation: CodexThreadCreation): Promise<void>
}

interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly defaultReasoningEffort?: string
  readonly supportedReasoningEfforts: readonly {
    readonly id: string
    readonly description?: string
  }[]
  readonly inputModalities: readonly ModelModality[]
}

interface ActiveBlock {
  readonly index: number
  type: 'text' | 'reasoning'
  phase: 'commentary' | 'final_answer' | null
  text: string
  ended: boolean
}

interface PendingDynamicToolCall {
  readonly call: CodexDynamicToolCall
  readonly response: PromiseWithResolvers<unknown>
}

type ActiveTurnEvent =
  | { readonly kind: 'notification'; readonly notification: AppServerNotification }
  | ({ readonly kind: 'dynamic-tool' } & PendingDynamicToolCall)

class ActiveTurnQueue {
  private readonly values: ActiveTurnEvent[] = []
  private readonly waiters: Array<PromiseWithResolvers<ActiveTurnEvent>> = []
  private terminal: Error | undefined

  push(event: ActiveTurnEvent): void {
    if (this.terminal !== undefined) {
      if (event.kind === 'dynamic-tool') event.response.reject(this.terminal)
      return
    }
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(event)
    else waiter.resolve(event)
  }

  fail(error: Error): void {
    if (this.terminal !== undefined) return
    this.terminal = error
    for (const event of this.values.splice(0)) {
      if (event.kind === 'dynamic-tool') event.response.reject(error)
    }
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  async next(signal: AbortSignal): Promise<ActiveTurnEvent> {
    signal.throwIfAborted()
    const value = this.values.shift()
    if (value !== undefined) return value
    if (this.terminal !== undefined) throw this.terminal
    const waiter = Promise.withResolvers<ActiveTurnEvent>()
    this.waiters.push(waiter)
    const onAbort = (): void => { waiter.reject(abortError(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await waiter.promise
    } finally {
      signal.removeEventListener('abort', onAbort)
      const index = this.waiters.indexOf(waiter)
      if (index >= 0) this.waiters.splice(index, 1)
    }
  }
}

interface StartingCodexTurn {
  readonly sessionId: string
  readonly controller: AbortController
  readonly promise: Promise<ActiveCodexTurn>
}

interface ActiveCodexTurn {
  readonly sessionId: string
  readonly model: string
  readonly toolSignature: string
  readonly connection: CodexAppServerConnection
  readonly events: ActiveTurnQueue
  readonly deadline: TurnIdleDeadline
  readonly signal: AbortSignal
  readonly threadId: string
  readonly turnId: string
  readonly replayState: CodexReplayState
  /** Whether this turn is retained across DSH provider steps for dynamic tools. */
  readonly retainForTools: boolean
  /** Persistent threads publish replay state and receive registry ownership receipts. */
  readonly persistentThread: boolean
  /** Auxiliary calls are isolated and never publish replay state or dynamic tools. */
  readonly purpose?: GenerateOptions['purpose']
  readonly onAbort: () => void
  readonly blocks: Map<string, ActiveBlock>
  readonly completedImages: Set<string>
  nextBlockIndex: number
  finalOutput: boolean
  usage?: TokenUsage
  awaiting?: PendingDynamicToolCall
  /** Token of the continuation that captured the pending call, serializing DSH tool-step continuations. */
  resuming?: PendingDynamicToolCall
  closing?: Promise<void>
}

/** Process invocation for one resolved Codex executable. */
export interface CodexAppServerInvocation {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/**
 * Build the fixed App Server command without allowing configured text into a Windows command tail.
 * @param executable - Absolute executable path resolved by the DSH subprocess provider.
 * @param env - Explicit child environment from plugin configuration.
 * @param platform - Host platform selecting the Windows batch-shim path.
 * @param commandInterpreter - Resolved Windows command interpreter.
 * @returns Child argv and environment for the managed subprocess.
 */
export function codexAppServerInvocation(
  executable: string,
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
  commandInterpreter = 'cmd.exe',
): CodexAppServerInvocation {
  const extension = extname(executable).toLowerCase()
  if (platform !== 'win32' || (extension !== '.cmd' && extension !== '.bat')) {
    return { argv: [executable, 'app-server', '--stdio'], env }
  }
  return {
    argv: [
      commandInterpreter,
      '/d',
      '/v:off',
      '/s',
      '/c',
      `%${WINDOWS_EXECUTABLE_ENV}%`,
      'app-server',
      '--stdio',
    ],
    env: { ...env, [WINDOWS_EXECUTABLE_ENV]: `"${executable}"` },
  }
}

function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout])
}

/** Resettable inactivity deadline for one retained App Server turn. */
class TurnIdleDeadline {
  private readonly controller = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private holds = 0

  constructor(private readonly timeoutMs: number) {
    this.touch()
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  touch(): void {
    if (this.controller.signal.aborted || this.holds > 0) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.controller.abort(new DOMException(
        `codex-plugin-dsh: App Server turn was idle for ${this.timeoutMs}ms`,
        'TimeoutError',
      ))
    }, this.timeoutMs)
    this.timer.unref?.()
  }

  /**
   * Suspend the inactivity deadline while an App Server request is waiting on
   * DSH or a human. The returned release function is idempotent and restarts a
   * fresh idle window after the final outstanding request settles.
   */
  hold(): () => void {
    if (this.controller.signal.aborted) return () => {}
    this.holds += 1
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds = Math.max(0, this.holds - 1)
      if (this.holds === 0) this.touch()
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.holds = 0
  }
}

/** Scope one DSH provider step without shortening the retained App Server turn. */
function stepSignal(turnSignal: AbortSignal, requestSignal: AbortSignal | undefined): AbortSignal {
  return requestSignal === undefined ? turnSignal : AbortSignal.any([turnSignal, requestSignal])
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`codex-plugin-dsh: operation aborted: ${String(signal.reason)}`)
}

function phaseOf(value: unknown): ActiveBlock['phase'] {
  if (value === undefined || value === null) return null
  if (value === 'commentary' || value === 'final_answer') return value
  throw new Error(`codex-plugin-dsh: App Server returned unknown agent message phase ${JSON.stringify(value)}`)
}

function blockType(phase: ActiveBlock['phase']): ActiveBlock['type'] {
  return phase === 'commentary' ? 'reasoning' : 'text'
}

/** Join the public reasoning-summary parts carried by one App Server item. */
function reasoningSummaryText(value: unknown, label: string): string {
  if (!Array.isArray(value)) {
    throw new Error(`codex-plugin-dsh: App Server returned invalid ${label}`)
  }
  return value.map((part, index) => {
    if (typeof part !== 'string') {
      throw new Error(`codex-plugin-dsh: App Server returned invalid ${label}[${index}]`)
    }
    return part
  }).join('')
}

/** Materialize one public reasoning-summary fragment as ordinary DSH stream chunks. */
function appendReasoningSummary(
  active: ActiveCodexTurn,
  itemId: string,
  text: string,
): readonly StreamChunk[] {
  if (text.length === 0) return []
  let block = active.blocks.get(itemId)
  const chunks: StreamChunk[] = []
  if (block === undefined) {
    block = {
      index: active.nextBlockIndex++,
      type: 'reasoning',
      phase: 'commentary',
      text: '',
      ended: false,
    }
    active.blocks.set(itemId, block)
    chunks.push({ type: 'block-start', index: block.index, blockType: 'reasoning' })
  }
  if (block.type !== 'reasoning' || block.ended) {
    throw new Error('codex-plugin-dsh: App Server emitted reasoning after its item completed')
  }
  block.text += text
  chunks.push({ type: 'reasoning-delta', index: block.index, text })
  return chunks
}

function messageText(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return String(value)
  const message = (value as Record<string, unknown>).message
  return typeof message === 'string' ? message : JSON.stringify(value)
}

function missingThread(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /thread.{0,80}(?:not found|does not exist|unknown|missing)|(?:not found|does not exist).{0,80}thread/i.test(message)
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Validate one App Server thread response and read its chronological head turn. */
function threadResponse(
  value: Record<string, unknown>,
  label: string,
  requireTurns = false,
): { readonly id: string; readonly headTurnId?: string; readonly headTurnStatus?: string } {
  const thread = object(value.thread, `${label} thread`)
  const id = string(thread.id, `${label} thread id`)
  if (thread.turns === undefined && !requireTurns) return { id }
  if (!Array.isArray(thread.turns)) throw new Error(`codex-plugin-dsh: App Server returned invalid ${label} thread turns`)
  const last = thread.turns.at(-1)
  if (last === undefined) return { id }
  const turn = object(last, `${label} head turn`)
  return {
    id,
    headTurnId: string(turn.id, `${label} head turn id`),
    headTurnStatus: string(turn.status, `${label} head turn status`),
  }
}

function turnFailure(turn: Record<string, unknown>): Error {
  const error = turn.error
  const detail = error === undefined || error === null ? '' : `: ${messageText(error)}`
  return new LlmError(`Codex App Server turn ended with status ${String(turn.status)}${detail}`, 'CODEX_APP_SERVER')
}

function contextWindowExceeded(turn: Record<string, unknown>): boolean {
  if (turn.status !== 'failed' || turn.error === null || typeof turn.error !== 'object' || Array.isArray(turn.error)) return false
  return (turn.error as Record<string, unknown>).codexErrorInfo === 'contextWindowExceeded'
}

function usageFrom(value: unknown): TokenUsage {
  const tokenUsage = object(value, 'token usage')
  const last = object(tokenUsage.last, 'last-turn token usage')
  const integer = (field: string): number => {
    const count = last[field]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`codex-plugin-dsh: App Server returned invalid ${field}`)
    }
    return count
  }
  const input = integer('inputTokens')
  const cached = integer('cachedInputTokens')
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: integer('outputTokens'),
    cacheReadTokens: cached,
    reasoningTokens: integer('reasoningOutputTokens'),
  }
}

/** Read the authoritative capacity reported with one App Server usage update. */
function contextWindowFromUsage(value: unknown): number | undefined {
  const tokenUsage = object(value, 'token usage')
  const contextWindow = tokenUsage.modelContextWindow
  if (contextWindow === undefined || contextWindow === null) return undefined
  if (!Number.isSafeInteger(contextWindow) || (contextWindow as number) <= 0) {
    throw new Error('codex-plugin-dsh: App Server returned invalid modelContextWindow')
  }
  return contextWindow as number
}

function availableDecisions(params: Record<string, unknown>): ReadonlySet<string> | undefined {
  if (!Array.isArray(params.availableDecisions)) return undefined
  return new Set(params.availableDecisions.filter((value): value is string => typeof value === 'string'))
}

function deniedDecision(params: Record<string, unknown>, cancelled: boolean): 'cancel' | 'decline' {
  const available = availableDecisions(params)
  if (cancelled && (available === undefined || available.has('cancel'))) return 'cancel'
  if (available === undefined || available.has('decline')) return 'decline'
  if (available.has('cancel')) return 'cancel'
  throw new Error('codex-plugin-dsh: App Server offered no fail-closed approval decision')
}

function catalogModel(value: unknown): CatalogModel | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.hidden === true) return undefined
  const efforts = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts.flatMap((item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return []
        const effort = item as Record<string, unknown>
        if (typeof effort.reasoningEffort !== 'string' || effort.reasoningEffort.length === 0) return []
        return [{
          id: effort.reasoningEffort,
          ...typeof effort.description === 'string' && effort.description.length > 0
            ? { description: effort.description }
            : {},
        }]
      })
    : []
  const inputModalities = Array.isArray(raw.inputModalities)
    ? raw.inputModalities.filter((item): item is ModelModality => item === 'text' || item === 'image')
    : ['text', 'image'] as const
  return {
    id: raw.id,
    name: typeof raw.displayName === 'string' && raw.displayName.length > 0 ? raw.displayName : raw.id,
    ...typeof raw.description === 'string' && raw.description.length > 0 ? { description: raw.description } : {},
    ...typeof raw.defaultReasoningEffort === 'string' && raw.defaultReasoningEffort.length > 0
      ? { defaultReasoningEffort: raw.defaultReasoningEffort }
      : {},
    supportedReasoningEfforts: efforts,
    inputModalities,
  }
}

/** Local Codex App Server route with session-aware history, permissions, and process ownership. */
export class CodexAppServerAdapter extends LlmAdapter {
  private cachedModels: { readonly expiresAt: number; readonly models: readonly CatalogModel[] } | undefined
  private pendingModels: Promise<readonly CatalogModel[]> | undefined
  private readonly observedContextWindows = new Map<string, number>()
  private readonly activeTurns = new Map<string, ActiveCodexTurn>()
  private readonly startingTurns = new Map<string, StartingCodexTurn>()
  /** Startup ownership exists before a turn is published into ownedTurns. */
  private readonly startingOwnedTurns = new Set<StartingCodexTurn>()
  private readonly disposingSessions = new Set<string>()
  private disposed = false
  private disposeTask: Promise<void> | undefined
  private lifecycleTail: Promise<void> = Promise.resolve()
  private managementFences = 0
  private threadCreationObserver: CodexThreadCreationObserver | undefined
  private lastThreadPresentationError: string | undefined
  private readonly appliedThreadSections = new Map<string, string>()
  /** Every owned process, including isolated auxiliary calls not keyed by session. */
  private readonly ownedTurns = new Set<ActiveCodexTurn>()

  constructor(
    private readonly ctx: Context,
    private readonly config: AdapterConfig,
  ) {
    super()
  }

  setThreadCreationObserver(observer: CodexThreadCreationObserver): void {
    this.threadCreationObserver = observer
  }

  /** Last best-effort naming/grouping failure, excluded from model routing. */
  threadPresentationError(): string | undefined {
    return this.lastThreadPresentationError
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Codex App Server (local)' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    // App Server turns are stateful and can already contain streamed content or
    // pending JSON-RPC tool requests. Replaying a failed DSH step would duplicate
    // that state, so retries are deliberately disabled at the provider boundary.
    return CODEX_RETRY_POLICY
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (await this.models()).map(model => ({
      provider,
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: model.inputModalities,
    }))
  }

  override async resolveModel(
    provider: string,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const model = (await this.models(signal)).find(candidate => candidate.id === modelId)
    const contextWindow = this.contextWindowFor(modelId)
    if (model === undefined) {
      return {
        provider,
        id: modelId,
        name: modelId,
        ...contextWindow === undefined ? {} : { context: { contextWindow } },
      }
    }
    return {
      provider,
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: model.inputModalities,
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      ...model.supportedReasoningEfforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: model.supportedReasoningEfforts.map(effort => ({
                id: ReasoningEffortId(effort.id),
                name: effort.id,
                ...effort.description === undefined ? {} : { description: effort.description },
              })),
              ...model.defaultReasoningEffort === undefined
                ? {}
                : { defaultEffort: ReasoningEffortId(model.defaultReasoningEffort) },
            },
          },
    }
  }

  private contextWindowFor(modelId: string): number | undefined {
    const observed = this.observedContextWindows.get(modelId)
    if (observed !== undefined) return observed
    const configured = this.config.modelContextWindows?.[modelId] ?? this.config.contextWindowTokens ?? 0
    return configured > 0 ? configured : undefined
  }

  private threadPresentationPolicy(): ThreadPresentationPolicy {
    const sectionName = this.config.subagentSectionName?.trim() ?? 'DSH 子代理'
    return {
      ephemeralOneShotSubagents: this.config.ephemeralOneShotSubagents !== false,
      syncThreadNames: this.config.syncThreadNames !== false,
      ...sectionName.length === 0 ? {} : { subagentSectionName: sectionName },
    }
  }

  /**
   * Bind exact model metadata and dispatch to this adapter generation, matching
   * the DSH 0.1.1 prepared-call contract. Configuration is immutable for the
   * instance, and the returned stream closure never reselects another adapter.
   */
  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model, signal)
    return {
      model: resolved,
      stream: (options) => this.stream(options),
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== CODEX_APP_SERVER_PROVIDER) {
      throw new Error(`codex-plugin-dsh: unexpected provider ${JSON.stringify(options.provider)}`)
    }
    const auxiliaryPurpose = options.purpose === 'compaction' || options.purpose === 'session-title'
    if (!auxiliaryPurpose && options.sessionId === undefined) {
      throw new Error('codex-plugin-dsh: conversational App Server calls require a live DSH session')
    }
    const unsupported = [
      options.temperature === undefined ? undefined : 'temperature',
      options.maxTokens === undefined || auxiliaryPurpose ? undefined : 'maxTokens',
      options.stop === undefined ? undefined : 'stop',
    ].filter((value): value is string => value !== undefined)
    if (unsupported.length > 0) {
      throw new Error(`codex-plugin-dsh: App Server does not support DSH request field(s): ${unsupported.join(', ')}`)
    }
    // DSH auxiliary producers always provide a bounded maxTokens value, while
    // App Server 0.148 has no corresponding turn/start field. The auxiliary
    // prompts are already constrained to short text output, so ignoring this
    // transport-only cap is preferable to making compaction and title generation
    // unusable. Ordinary conversation controls remain fail-closed above.
    const session = options.sessionId === undefined ? undefined : this.ctx.sessions.get(options.sessionId)
    if (options.sessionId !== undefined && session === undefined) {
      throw new Error(`codex-plugin-dsh: session ${JSON.stringify(options.sessionId)} is not live`)
    }
    const cwd = session?.header.cwd ?? (auxiliaryPurpose ? process.cwd() : undefined)
    if (cwd === undefined) {
      throw new Error('codex-plugin-dsh: the selected DSH session has no working directory')
    }
    const sessionId = options.sessionId === undefined
      ? `auxiliary:${options.purpose}`
      : String(options.sessionId)
    const presentation: ThreadPresentation = auxiliaryPurpose || session === undefined
      ? { kind: 'main', ephemeral: true }
      : resolveThreadPresentation({
          header: session.header,
          events: session.events ?? [],
        }, this.threadPresentationPolicy())
    // Auxiliary producers (compaction and session-title) and positively
    // identified one-shot child Sessions use ephemeral App Server threads.
    // One-shot children still retain an active turn across DSH dynamic-tool
    // steps; they only omit durable Codex sidebar state and replay checkpoints.
    const acquired = auxiliaryPurpose
      ? { active: await this.beginStartTurn(options, sessionId, cwd, false, presentation).promise, existing: false }
      : await this.acquireConversationalTurn(options, sessionId, cwd, presentation)
    const { active } = acquired
    const requestSignal = stepSignal(active.signal, options.signal)
    if (acquired.existing) {
      requestSignal.throwIfAborted()
      active.deadline.touch()
      const pending = active.awaiting
      if (pending === undefined) {
        throw new Error('codex-plugin-dsh: an App Server turn is already active for this DSH session')
      }
      // A DSH tool continuation must answer the already-open App Server request.
      // DSH reassembles GenerateOptions for every tool step, so a UI/provider
      // selection or a dynamic catalog may have changed since the prior step.
      // Those values apply after this outer turn closes; the pending call stays
      // pinned to the model and tool catalog that started it. The resuming token
      // serializes continuations: one provider step owns the pending call until
      // its result is answered, so a concurrent duplicate step fails loudly
      // instead of double-resolving the App Server RPC.
      if (active.resuming !== undefined) {
        throw new Error('codex-plugin-dsh: another DSH tool continuation is already answering this pending App Server call')
      }
      active.resuming = pending
      let continuation: Awaited<ReturnType<typeof codexDynamicToolResult>>
      try {
        const resolveContinuationImageUrl: CodexToolImageUrlResolver = attachment =>
          attachmentDataUrl(this.ctx.attachments, attachment, requestSignal)
        continuation = await codexDynamicToolResult(
          options.messages,
          pending.call.callId,
          resolveContinuationImageUrl,
        )
        if (continuation.steerInput.length > 0) {
          await active.connection.request('turn/steer', {
            threadId: active.threadId,
            expectedTurnId: active.turnId,
            input: continuation.steerInput,
          }, requestSignal)
        }
        pending.response.resolve(continuation.response)
        active.deadline.touch()
      } catch (error) {
        pending.response.reject(thrown(error))
        throw error
      } finally {
        if (active.awaiting === pending) delete active.awaiting
        if (active.resuming === pending) delete active.resuming
      }
      active.blocks.clear()
      active.nextBlockIndex = 0
      active.finalOutput = false
    }
    let keepAlive = false
    try {
      for (;;) {
        const event = await active.events.next(requestSignal)
        active.deadline.touch()
        if (event.kind === 'dynamic-tool') {
          if (!active.retainForTools) {
            throw new Error('codex-plugin-dsh: auxiliary App Server calls cannot invoke DSH tools')
          }
          const { call } = event
          if (call.threadId !== active.threadId || call.turnId !== active.turnId) continue
          if (active.awaiting !== undefined) {
            throw new Error('codex-plugin-dsh: App Server issued another dynamic tool call before DSH returned the first result')
          }
          if ([...active.blocks.values()].some(block => !block.ended)) {
            throw new Error('codex-plugin-dsh: App Server requested a dynamic tool with an open agent message')
          }
          const argumentsText = JSON.stringify(call.arguments)
          if (argumentsText === undefined) {
            throw new Error(`codex-plugin-dsh: App Server returned invalid arguments for DSH tool ${JSON.stringify(call.tool)}`)
          }
          const index = active.nextBlockIndex++
          const id = CallId(call.callId)
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: call.tool, argumentsDelta: argumentsText }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.tool, arguments: argumentsText } }
          active.awaiting = event
          active.blocks.clear()
          active.nextBlockIndex = 0
          active.finalOutput = false
          keepAlive = true
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const { method, params } = event.notification
        if (params.threadId !== active.threadId) continue
        const notificationTurnId = method === 'turn/completed'
          ? object(params.turn, 'turn/completed turn').id
          : params.turnId
        if (notificationTurnId !== active.turnId) continue
        if (method === 'item/started') {
          const item = object(params.item, 'started item')
          if (item.type === 'reasoning') {
            const itemId = string(item.id, 'reasoning item id')
            const summary = reasoningSummaryText(item.summary, 'reasoning item summary')
            for (const chunk of appendReasoningSummary(active, itemId, summary)) yield chunk
            continue
          }
          if (item.type !== 'agentMessage') continue
          const itemId = string(item.id, 'agent message item id')
          if (active.blocks.has(itemId)) continue
          const phase = phaseOf(item.phase)
          const block: ActiveBlock = {
            index: active.nextBlockIndex++,
            type: blockType(phase),
            phase,
            text: '',
            ended: false,
          }
          active.blocks.set(itemId, block)
          yield { type: 'block-start', index: block.index, blockType: block.type }
          continue
        }
        if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
          const itemId = string(params.itemId, 'reasoning item id')
          if (typeof params.delta !== 'string') {
            throw new Error('codex-plugin-dsh: App Server returned invalid reasoning delta')
          }
          for (const chunk of appendReasoningSummary(active, itemId, params.delta)) yield chunk
          continue
        }
        if (method === 'item/reasoning/summaryPartAdded') {
          // A summary-section boundary. The section index only marks where a
          // new summary section starts; the accumulated text is continuous, so
          // the running reasoning block needs no change here.
          continue
        }
        if (method === 'item/agentMessage/delta') {
          const itemId = string(params.itemId, 'agent message delta item id')
          let block = active.blocks.get(itemId)
          if (block === undefined) {
            block = { index: active.nextBlockIndex++, type: 'text', phase: null, text: '', ended: false }
            active.blocks.set(itemId, block)
            yield { type: 'block-start', index: block.index, blockType: block.type }
          }
          if (block.ended) throw new Error('codex-plugin-dsh: App Server emitted a delta after item/completed')
          const delta = typeof params.delta === 'string' ? params.delta : ''
          block.text += delta
          if (block.type === 'reasoning') yield { type: 'reasoning-delta', index: block.index, text: delta }
          else yield { type: 'text-delta', index: block.index, text: delta }
          continue
        }
        if (method === 'item/completed') {
          const item = object(params.item, 'completed item')
          if (item.type === 'imageGeneration') {
            const itemId = string(item.id, 'image generation item id')
            if (active.completedImages.has(itemId)) continue
            active.completedImages.add(itemId)
            const image = await generatedImageBlock(this.ctx.attachments, item)
            if (image === undefined) continue
            const index = active.nextBlockIndex++
            yield { type: 'block-start', index, blockType: 'image' }
            yield { type: 'block-end', index, block: image }
            active.finalOutput = true
            continue
          }
          if (item.type === 'reasoning') {
            const itemId = string(item.id, 'completed reasoning item id')
            const summary = reasoningSummaryText(item.summary, 'completed reasoning item summary')
            const block = active.blocks.get(itemId)
            const emitted = block?.text ?? ''
            if (!summary.startsWith(emitted)) {
              throw new Error('codex-plugin-dsh: completed reasoning summary did not match its streamed deltas')
            }
            for (const chunk of appendReasoningSummary(active, itemId, summary.slice(emitted.length))) yield chunk
            const completed = active.blocks.get(itemId)
            if (completed !== undefined) {
              completed.ended = true
              yield { type: 'block-end', index: completed.index, block: { type: 'reasoning', text: completed.text } }
            }
            continue
          }
          if (item.type !== 'agentMessage') continue
          const itemId = string(item.id, 'completed agent message item id')
          const phase = phaseOf(item.phase)
          let block = active.blocks.get(itemId)
          if (block === undefined) {
            block = { index: active.nextBlockIndex++, type: blockType(phase), phase, text: '', ended: false }
            active.blocks.set(itemId, block)
            yield { type: 'block-start', index: block.index, blockType: block.type }
          }
          const completedText = typeof item.text === 'string' ? item.text : ''
          if (!completedText.startsWith(block.text)) {
            throw new Error('codex-plugin-dsh: completed agent message did not match its streamed deltas')
          }
          const tail = completedText.slice(block.text.length)
          if (tail.length > 0) {
            if (block.type === 'reasoning') yield { type: 'reasoning-delta', index: block.index, text: tail }
            else yield { type: 'text-delta', index: block.index, text: tail }
            block.text = completedText
          }
          block.ended = true
          if (block.type === 'reasoning') {
            yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
          } else {
            yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
            if (block.phase !== 'commentary' && block.text.trim().length > 0) active.finalOutput = true
          }
          continue
        }
        if (method === 'thread/tokenUsage/updated') {
          active.usage = usageFrom(params.tokenUsage)
          const contextWindow = contextWindowFromUsage(params.tokenUsage)
          if (contextWindow !== undefined) this.observedContextWindows.set(active.model, contextWindow)
          continue
        }
        if (method === 'error' && params.willRetry !== true) {
          throw new LlmError(messageText(params.error), 'CODEX_APP_SERVER')
        }
        if (method !== 'turn/completed') continue
        const completedTurn = object(params.turn, 'turn/completed turn')
        if (contextWindowExceeded(completedTurn)) {
          throw new LlmError(
            'Codex App Server rejected the request because the model context window was exceeded',
            CONTEXT_WINDOW_EXCEEDED_CODE,
          )
        }
        if (completedTurn.status !== 'completed') throw turnFailure(completedTurn)
        if ([...active.blocks.values()].some(block => !block.ended)) {
          throw new Error('codex-plugin-dsh: App Server completed with an open agent message')
        }
        if (!active.finalOutput) throw new Error('codex-plugin-dsh: App Server completed without a final answer or image')
        if (active.usage !== undefined) yield { type: 'usage', usage: active.usage }
        yield {
          type: 'finish',
          reason: { kind: 'stop' },
          ...active.persistentThread ? { replayState: { response: active.replayState } } : {},
        }
        return
      }
    } finally {
      if (!keepAlive) await this.closeTurn(active)
    }
  }

  private beginStartTurn(
    options: GenerateOptions,
    sessionId: string,
    cwd: string,
    retainForTools: boolean,
    presentation: ThreadPresentation,
  ): StartingCodexTurn {
    if (this.disposed) throw new Error('codex-plugin-dsh: adapter is disposed')
    if (this.managementFences > 0) {
      throw new Error('codex-plugin-dsh: explicit thread lifecycle management is in progress')
    }
    if (this.disposingSessions.has(sessionId)) {
      throw new Error(`codex-plugin-dsh: session ${JSON.stringify(sessionId)} is being disposed`)
    }
    const controller = new AbortController()
    const promise = this.enqueueLifecycle(() =>
      this.startTurn(options, sessionId, cwd, retainForTools, presentation, controller.signal))
    const starting = { sessionId, controller, promise }
    this.startingOwnedTurns.add(starting)
    void promise.finally(() => this.startingOwnedTurns.delete(starting)).catch(() => {})
    return starting
  }

  private async acquireConversationalTurn(
    options: GenerateOptions,
    sessionId: string,
    cwd: string,
    presentation: ThreadPresentation,
  ): Promise<{ readonly active: ActiveCodexTurn; readonly existing: boolean }> {
    if (this.disposed) throw new Error('codex-plugin-dsh: adapter is disposed')
    if (this.disposingSessions.has(sessionId)) {
      throw new Error(`codex-plugin-dsh: session ${JSON.stringify(sessionId)} is being disposed`)
    }
    const current = this.activeTurns.get(sessionId)
    if (current !== undefined) return { active: current, existing: true }
    const starting = this.startingTurns.get(sessionId)
    if (starting !== undefined) {
      const active = await starting.promise
      return { active, existing: true }
    }
    const created = this.beginStartTurn(options, sessionId, cwd, true, presentation)
    this.startingTurns.set(sessionId, created)
    try {
      return { active: await created.promise, existing: false }
    } finally {
      if (this.startingTurns.get(sessionId) === created) this.startingTurns.delete(sessionId)
    }
  }

  private async startTurn(
    options: GenerateOptions,
    sessionId: string,
    cwd: string,
    retainForTools: boolean,
    presentation: ThreadPresentation,
    ownerSignal?: AbortSignal,
  ): Promise<ActiveCodexTurn> {
    // The DSH request signal is scoped to one provider step. An App Server
    // dynamic-tool RPC may legitimately outlive that step while DSH waits for
    // an interactive tool result, so the retained turn owns a resettable idle
    // deadline instead of an absolute wall-clock cap.
    const deadline = new TurnIdleDeadline(this.config.turnTimeoutMs)
    const turnSignal = deadline.signal
    const requestSignal = ownerSignal === undefined
      ? options.signal
      : options.signal === undefined
        ? ownerSignal
        : AbortSignal.any([options.signal, ownerSignal])
    const setupSignal = stepSignal(turnSignal, requestSignal)
    const imageUrls = new Map<string, Promise<string>>()
    const resolveImageUrl = (attachment: ImageAttachmentRef): Promise<string> => {
      const key = String(attachment.attachmentId)
      const existing = imageUrls.get(key)
      if (existing !== undefined) return existing
      const pending = attachmentDataUrl(this.ctx.attachments, attachment, setupSignal)
      imageUrls.set(key, pending)
      return pending
    }
    const turnTools = retainForTools ? options.tools : undefined
    let history = await prepareCodexHistory(
      options.messages,
      CODEX_APP_SERVER_PROVIDER,
      resolveImageUrl,
      !retainForTools || presentation.ephemeral,
      sessionId,
    )
    const toolSignature = codexToolSignature(turnTools)
    if (history.checkpoint !== undefined && history.checkpoint.toolSignature !== toolSignature) {
      history = await prepareCodexHistory(options.messages, CODEX_APP_SERVER_PROVIDER, resolveImageUrl, true, sessionId)
    }
    const availableTools = new Set((turnTools ?? []).map(tool => tool.name))
    const events = new ActiveTurnQueue()
    let threadId: string | undefined
    let turnId: string | undefined
    let connection: CodexAppServerConnection | undefined
    const observer: AppServerConnectionObserver = {
      notification: notification => {
        deadline.touch()
        events.push({ kind: 'notification', notification })
      },
      failure: error => { events.fail(error) },
    }
    const liveAgent = !retainForTools || options.sessionId === undefined
      ? undefined
      : this.ctx.agents.get(options.sessionId)
    try {
      connection = await this.openConnection(
        cwd,
        setupSignal,
        (method, params) => {
          deadline.touch()
          const releaseDeadline = deadline.hold()
          if (method !== 'item/tool/call') {
            const response = this.handleServerRequest(method, params, liveAgent, turnSignal)
            void response.then(releaseDeadline, releaseDeadline)
            return response
          }
          if (!retainForTools) {
            releaseDeadline()
            return Promise.reject(new Error('codex-plugin-dsh: auxiliary App Server calls cannot invoke DSH tools'))
          }
          const response = Promise.withResolvers<unknown>()
          void response.promise.then(releaseDeadline, releaseDeadline)
          try {
            events.push({
              kind: 'dynamic-tool',
              call: codexDynamicToolCall(params, availableTools),
              response,
            })
          } catch (error) {
            response.reject(thrown(error))
          }
          return response.promise
        },
        observer,
        turnSignal,
      )
      await connection.initialize(setupSignal)
      const isolationConfig = await this.isolationConfig(connection, setupSignal)
      const dynamicTools = !retainForTools || history.checkpoint?.toolSignature === toolSignature
        ? undefined
        : codexDynamicTools(turnTools)
      if (history.checkpoint === undefined) {
        const started = threadResponse(await connection.request(
          'thread/start',
          this.threadParams(options, cwd, isolationConfig, presentation.ephemeral, dynamicTools ?? []),
          setupSignal,
        ), 'thread/start')
        threadId = started.id
        if (retainForTools && !presentation.ephemeral) {
          await this.threadCreationObserver?.recordCreated({
            sessionId,
            threadId,
            kind: 'start',
          })
        }
      } else {
        // Read before resume: resume is not a rollback operation and an unseen
        // failed/external turn may already have moved the remote head. Only the
        // exact completed DSH checkpoint may reuse the canonical thread.
        try {
          const read = threadResponse(await connection.request('thread/read', {
            threadId: history.checkpoint.threadId,
            includeTurns: true,
          }, setupSignal), 'thread/read', true)
          const action = decideThreadContinuation(history.checkpoint.turnId, {
            threadId: read.id,
            ...read.headTurnId === undefined ? {} : { headTurnId: read.headTurnId },
            ...read.headTurnStatus === undefined ? {} : { headTurnStatus: read.headTurnStatus },
          })
          if (action === 'resume') {
            const resumed = threadResponse(await connection.request('thread/resume', {
              ...this.resumeThreadParams(options, cwd, isolationConfig),
              threadId: history.checkpoint.threadId,
            }, setupSignal), 'thread/resume')
            threadId = resumed.id
          } else {
            const forked = threadResponse(await connection.request('thread/fork', {
              ...this.threadParams(options, cwd, isolationConfig, presentation.ephemeral),
              threadId: history.checkpoint.threadId,
              lastTurnId: history.checkpoint.turnId,
            }, setupSignal), 'thread/fork')
            threadId = forked.id
            if (!presentation.ephemeral) {
              await this.threadCreationObserver?.recordCreated({
                sessionId,
                threadId,
                kind: 'fork',
                parentThreadId: history.checkpoint.threadId,
              })
            }
          }
        } catch (error) {
          if (!missingThread(error)) throw error
          // A deleted or externally missing thread is recoverable because the DSH
          // session log remains authoritative. Rebuild all representable history
          // in a new owned thread instead of starting with an empty context.
          history = await prepareCodexHistory(
            options.messages,
            CODEX_APP_SERVER_PROVIDER,
            resolveImageUrl,
            true,
            sessionId,
          )
          const started = threadResponse(await connection.request(
            'thread/start',
            this.threadParams(options, cwd, isolationConfig, presentation.ephemeral, codexDynamicTools(turnTools)),
            setupSignal,
          ), 'thread/start')
          threadId = started.id
          if (!presentation.ephemeral) {
            await this.threadCreationObserver?.recordCreated({
              sessionId,
              threadId,
              kind: 'start',
            })
          }
        }
      }
      await this.applyThreadPresentation(connection, threadId, presentation, setupSignal)
      if (history.injectItems.length > 0) {
        await connection.request('thread/inject_items', {
          threadId,
          items: history.injectItems,
        }, setupSignal)
      }
      const turnResult = await connection.request('turn/start', {
        threadId,
        input: history.turnInput,
        model: options.model,
        // Request the model's official reasoning summary explicitly; without
        // this the App Server default may suppress reasoning entirely.
        summary: 'concise',
        ...options.reasoningEffort === undefined ? {} : { effort: options.reasoningEffort },
      }, setupSignal)
      const turn = object(turnResult.turn, 'turn/start turn')
      turnId = string(turn.id, 'turn id')
      let active!: ActiveCodexTurn
      active = {
        sessionId,
        model: options.model,
        toolSignature,
        connection,
        events,
        deadline,
        signal: turnSignal,
        threadId,
        turnId,
        replayState: {
          kind: 'codex-app-server',
          version: 1,
          threadId,
          turnId,
          sessionId,
          toolSignature,
        },
        retainForTools,
        persistentThread: !presentation.ephemeral,
        ...options.purpose === undefined ? {} : { purpose: options.purpose },
        onAbort: () => {
          connection?.interrupt(threadId as string, turnId as string)
          void this.closeTurn(active)
        },
        blocks: new Map(),
        completedImages: new Set(),
        nextBlockIndex: 0,
        finalOutput: false,
      }
      // A retained App Server turn may outlive the DSH step that started it.
      // Ordinary turn/end is deliberately not a teardown boundary: interactive
      // dynamic tools legitimately suspend and resume through a later provider
      // step. The root session/disposed listener registered by apply() owns the
      // true terminal lifecycle boundary.
      turnSignal.addEventListener('abort', active.onAbort, { once: true })
      this.ownedTurns.add(active)
      if (retainForTools) this.activeTurns.set(active.sessionId, active)
      return active
    } catch (error) {
      deadline.dispose()
      events.fail(thrown(error))
      await connection?.close()
      throw error
    }
  }

  private async closeTurn(active: ActiveCodexTurn, reason?: Error): Promise<void> {
    if (active.closing !== undefined) return active.closing
    const closing = this.finishCloseTurn(active, reason)
    active.closing = closing
    return closing
  }

  private async finishCloseTurn(active: ActiveCodexTurn, reason?: Error): Promise<void> {
    if (this.activeTurns.get(active.sessionId) === active) this.activeTurns.delete(active.sessionId)
    this.ownedTurns.delete(active)
    active.signal.removeEventListener('abort', active.onAbort)
    active.deadline.dispose()
    const closed = reason
      ?? (active.signal.aborted
        ? abortError(active.signal)
        : new Error('codex-plugin-dsh: App Server turn closed before a pending DSH tool result was returned'))
    active.awaiting?.response.reject(closed)
    active.events.fail(closed)
    await active.connection.close()
  }

  hasActiveSession(sessionId: string): boolean {
    return this.activeTurns.has(sessionId)
      || this.startingTurns.has(sessionId)
      || [...this.startingOwnedTurns].some(starting => starting.sessionId === sessionId)
  }

  /** Reject new startup while serializing one explicit lifecycle mutation. */
  async withLifecycleFence<T>(operation: () => Promise<T>): Promise<T> {
    this.managementFences += 1
    try {
      return await this.enqueueLifecycle(operation)
    } finally {
      this.managementFences = Math.max(0, this.managementFences - 1)
    }
  }

  private async enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.lifecycleTail
    const gate = Promise.withResolvers<void>()
    const tail = prior.then(() => gate.promise)
    this.lifecycleTail = tail
    await prior
    try {
      return await operation()
    } finally {
      gate.resolve()
      if (this.lifecycleTail === tail) this.lifecycleTail = Promise.resolve()
    }
  }

  async isThreadActive(threadId: string, parentSignal?: AbortSignal): Promise<boolean> {
    if ([...this.activeTurns.values()].some(turn => turn.threadId === threadId)) return true
    if (threadId.length === 0) throw new Error('codex-plugin-dsh: threadId must be non-empty')
    const signal = combinedSignal(parentSignal, this.config.catalogTimeoutMs)
    const connection = await this.openConnection(process.cwd(), signal, requestMethod =>
      Promise.reject(new Error(`codex-plugin-dsh: unexpected App Server request during thread/read: ${requestMethod}`)))
    try {
      await connection.initialize(signal)
      const snapshot = threadResponse(await connection.request(
        'thread/read',
        { threadId, includeTurns: true },
        signal,
      ), 'thread/read', true)
      return snapshot.headTurnStatus === 'inProgress'
    } catch (error) {
      if (missingThread(error)) return false
      throw error
    } finally {
      await connection.close()
    }
  }

  async archiveThread(threadId: string, parentSignal?: AbortSignal): Promise<void> {
    await this.manageThread('thread/archive', threadId, parentSignal)
  }

  async unarchiveThread(threadId: string, parentSignal?: AbortSignal): Promise<void> {
    await this.manageThread('thread/unarchive', threadId, parentSignal)
  }

  async deleteThread(threadId: string, parentSignal?: AbortSignal): Promise<void> {
    await this.manageThread('thread/delete', threadId, parentSignal)
  }

  private async manageThread(
    method: 'thread/archive' | 'thread/unarchive' | 'thread/delete',
    threadId: string,
    parentSignal?: AbortSignal,
  ): Promise<void> {
    if (threadId.length === 0) throw new Error('codex-plugin-dsh: threadId must be non-empty')
    const signal = combinedSignal(parentSignal, this.config.catalogTimeoutMs)
    const connection = await this.openConnection(process.cwd(), signal, requestMethod =>
      Promise.reject(new Error(`codex-plugin-dsh: unexpected App Server request during ${method}: ${requestMethod}`)))
    try {
      await connection.initialize(signal)
      await connection.request(method, { threadId }, signal)
    } catch (error) {
      // A delete may have committed remotely just before the caller or registry
      // crashed. Missing is therefore the idempotent success state for delete,
      // while archive/unarchive continue to fail closed.
      if (method !== 'thread/delete' || !missingThread(error)) throw error
    } finally {
      await connection.close()
    }
  }

  /** Apply non-semantic sidebar presentation without touching DSH conversation state. */
  private async applyThreadPresentation(
    connection: CodexAppServerConnection,
    threadId: string,
    presentation: ThreadPresentation,
    signal: AbortSignal,
  ): Promise<void> {
    if (presentation.ephemeral) return
    try {
      if (presentation.name !== undefined) {
        await connection.request('thread/name/set', { threadId, name: presentation.name }, signal)
      }
      if (
        presentation.sectionName === undefined
        || this.appliedThreadSections.get(threadId) === presentation.sectionName
      ) return
      const sectionId = await this.ensureThreadSection(connection, presentation.sectionName, signal)
      await connection.request('thread/section/move', {
        threadId,
        sectionId,
        beforeThreadId: null,
      }, signal)
      this.appliedThreadSections.set(threadId, presentation.sectionName)
    } catch (error) {
      // Naming and grouping are presentation-only. An older or temporarily
      // unavailable App Server must not make the DSH model route unusable.
      this.lastThreadPresentationError = thrown(error).message
    }
  }

  /** Reuse one exact custom section name, creating it once when absent. */
  private async ensureThreadSection(
    connection: CodexAppServerConnection,
    sectionName: string,
    signal: AbortSignal,
  ): Promise<string> {
    let cursor: string | null = null
    const seen = new Set<string>()
    for (;;) {
      const response = object(await connection.request('threadSection/list', {
        cursor,
        limit: 100,
      }, signal), 'threadSection/list response')
      if (!Array.isArray(response.data)) {
        throw new Error('codex-plugin-dsh: App Server returned invalid threadSection/list data')
      }
      for (const raw of response.data) {
        const section = object(raw, 'thread section')
        if (section.name === sectionName) return string(section.id, 'thread section id')
      }
      if (response.nextCursor === null) break
      const nextCursor = string(response.nextCursor, 'thread section cursor')
      if (seen.has(nextCursor)) {
        throw new Error('codex-plugin-dsh: App Server repeated a thread section cursor')
      }
      seen.add(nextCursor)
      cursor = nextCursor
    }
    const created = object(await connection.request('threadSection/create', {
      name: sectionName,
      appearance: null,
    }, signal), 'threadSection/create response')
    const section = object(created.section, 'created thread section')
    return string(section.id, 'created thread section id')
  }

  /** Close every startup or turn owned by one DSH session. */
  async disposeSession(sessionId: string): Promise<void> {
    const reason = new Error('codex-plugin-dsh: owning DSH session was disposed')
    this.disposingSessions.add(sessionId)
    try {
      const starting = [...this.startingOwnedTurns].filter(item => item.sessionId === sessionId)
      for (const item of starting) item.controller.abort(reason)
      await Promise.allSettled(starting.map(item => item.promise))
      await Promise.all([...this.ownedTurns]
        .filter(active => active.sessionId === sessionId)
        .map(active => this.closeTurn(active, reason)))
    } finally {
      this.disposingSessions.delete(sessionId)
    }
  }

  /** Dispose every App Server startup and process owned by this adapter. */
  async dispose(): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.disposed = true
    const task = (async () => {
      const reason = new Error('codex-plugin-dsh: plugin was disposed')
      const starting = [...this.startingOwnedTurns]
      for (const item of starting) item.controller.abort(reason)
      await Promise.allSettled(starting.map(item => item.promise))
      await Promise.all([...this.ownedTurns].map(active => this.closeTurn(active, reason)))
    })()
    this.disposeTask = task
    return task
  }

  private resumeThreadParams(
    options: GenerateOptions,
    cwd: string,
    isolationConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      cwd,
      model: options.model,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: isolationConfig,
      ...options.system === undefined ? {} : { baseInstructions: options.system },
      developerInstructions: CODEX_APP_SERVER_DEVELOPER_INSTRUCTIONS,
    }
  }

  private threadParams(
    options: GenerateOptions,
    cwd: string,
    isolationConfig: Record<string, unknown>,
    ephemeral: boolean,
    dynamicTools?: readonly unknown[],
  ): Record<string, unknown> {
    return {
      ...this.resumeThreadParams(options, cwd, isolationConfig),
      ephemeral,
      ...dynamicTools === undefined ? {} : { dynamicTools },
    }
  }

  private async isolationConfig(
    connection: CodexAppServerConnection,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = await connection.request('config/read', { includeLayers: false }, signal)
    const current = recordValue(result.config)
    const disabledMcpServers = Object.fromEntries(
      Object.keys(recordValue(current.mcp_servers)).map(name => [name, { enabled: false }]),
    )
    const disabledApps = Object.fromEntries(
      Object.keys(recordValue(current.apps))
        .filter(name => name !== '_default')
        .map(name => [name, { enabled: false }]),
    )
    return {
      features: {
        shell_tool: false,
        unified_exec: false,
        multi_agent: false,
        plugins: false,
      },
      agents: { enabled: false },
      web_search: 'disabled',
      tools: { view_image: false },
      apps: { _default: { enabled: false }, ...disabledApps },
      mcp_servers: disabledMcpServers,
    }
  }

  private async models(parentSignal?: AbortSignal): Promise<readonly CatalogModel[]> {
    if (this.cachedModels !== undefined && this.cachedModels.expiresAt > Date.now()) return this.cachedModels.models
    if (this.pendingModels !== undefined) return this.pendingModels
    const signal = combinedSignal(parentSignal, this.config.catalogTimeoutMs)
    const pending = this.loadModels(signal)
    this.pendingModels = pending
    try {
      const models = await pending
      this.cachedModels = { expiresAt: Date.now() + this.config.modelCacheMs, models }
      return models
    } finally {
      if (this.pendingModels === pending) this.pendingModels = undefined
    }
  }

  private async loadModels(signal: AbortSignal): Promise<readonly CatalogModel[]> {
    const connection = await this.openConnection(process.cwd(), signal, (method) =>
      Promise.reject(new Error(`codex-plugin-dsh: unexpected App Server request during model discovery: ${method}`)))
    try {
      await connection.initialize(signal)
      const accountResult = await connection.request('account/read', { refreshToken: false }, signal)
      if (accountResult.requiresOpenaiAuth === true && accountResult.account == null) {
        throw new LlmError('Codex login is required; run `codex login` on the DSH host', 'AUTH')
      }
      const models: CatalogModel[] = []
      let cursor: string | null = null
      do {
        const result = await connection.request('model/list', {
          cursor,
          includeHidden: false,
          limit: this.config.modelPageSize,
        }, signal)
        if (!Array.isArray(result.data)) throw new Error('codex-plugin-dsh: App Server returned invalid model list')
        models.push(...result.data.flatMap(value => {
          const parsed = catalogModel(value)
          return parsed === undefined ? [] : [parsed]
        }))
        cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null
      } while (cursor !== null)
      if (models.length === 0) throw new Error('codex-plugin-dsh: App Server returned no available models')
      return models
    } finally {
      await connection.close()
    }
  }

  private async openConnection(
    cwd: string,
    signal: AbortSignal,
    requestHandler: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    observer?: AppServerConnectionObserver,
    lifetimeSignal: AbortSignal = signal,
  ): Promise<CodexAppServerConnection> {
    const executable = await this.ctx.subprocess.resolveExecutable(this.config.executable, this.config.env, signal)
    const batchShim = process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(executable).toLowerCase())
    const commandInterpreter = batchShim
      ? await this.ctx.subprocess.resolveExecutable('cmd.exe', this.config.env, signal)
      : undefined
    const invocation = codexAppServerInvocation(executable, this.config.env, process.platform, commandInterpreter)
    const child: SubprocessHandle = this.ctx.subprocess.spawn({
      argv: [...invocation.argv],
      cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: this.config.stderrMaxBytes },
      },
      graceMs: this.config.disposeGraceMs,
      env: invocation.env,
      signal: lifetimeSignal,
    })
    return new CodexAppServerConnection(
      child,
      requestHandler,
      observer,
      Math.max(5_000, this.config.disposeGraceMs * 2),
    )
  }

  private async handleServerRequest(
    method: string,
    params: Record<string, unknown>,
    agent: Agent | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision: deniedDecision(params, false) }
      case 'item/permissions/requestApproval':
        return { permissions: {}, scope: 'turn' }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null }
      case 'item/tool/requestUserInput':
        return this.bridgeUserInput(params, agent, signal)
      default:
        throw new Error(`codex-plugin-dsh: unsupported App Server request ${JSON.stringify(method)}`)
    }
  }

  /**
   * Bridge an App Server `item/tool/requestUserInput` request to the DSH
   * user-questions UI, then answer the pending JSON-RPC request with the
   * human's selection. Questions are mapped to the DSH ask format; secret
   * questions and agentless calls fail explicitly instead of being shown
   * unmasked or guessed.
   */
  private async bridgeUserInput(
    params: Record<string, unknown>,
    agent: Agent | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const request = object(params, 'item/tool/requestUserInput params')
    if (!Array.isArray(request.questions)) {
      throw new Error('codex-plugin-dsh: App Server requested user input without a questions array')
    }
    if (agent === undefined) {
      throw new Error('codex-plugin-dsh: App Server requested interactive user input, but no live DSH agent session is available to answer')
    }
    const questions: AskUserQuestionItem[] = []
    for (const raw of request.questions) {
      const question = object(raw, 'requestUserInput question')
      const id = string(question.id, 'requestUserInput question id')
      if (question.isSecret === true) {
        throw new Error('codex-plugin-dsh: App Server requested secret user input, which the DSH question bridge refuses to show unmasked')
      }
      const text = string(question.question, 'requestUserInput question text')
      const header = typeof question.header === 'string' && question.header.length > 0 ? question.header : undefined
      const options: AskUserQuestionOption[] | undefined = Array.isArray(question.options)
        ? question.options.map(value => {
            const option = object(value, 'requestUserInput option')
            const label = string(option.label, 'requestUserInput option label')
            const description = typeof option.description === 'string' ? option.description : undefined
            return description === undefined ? { label } : { label, description }
          })
        : undefined
      questions.push({
        id,
        question: text,
        ...header === undefined ? {} : { header },
        ...options === undefined ? {} : { options },
        // Codex App Server 0.148 does not expose a multi-select capability bit.
        // Default to the safer single-selection DSH control; the wire response
        // remains an array as required by the App Server protocol.
        multiSelect: false,
      })
    }
    const answer = await this.ctx.userQuestions.ask({ questions, agent, signal })
    const answers: Record<string, { readonly answers: string[] }> = {}
    for (const item of answer.answers) {
      const selected = [...item.selected]
      if (item.custom !== undefined) selected.push(item.custom)
      if (selected.length > 0) answers[item.id] = { answers: selected }
    }
    return { answers }
  }
}
