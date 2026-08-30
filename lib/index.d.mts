import z from "@deepseek-ai/schemastery";
import { AssistantMessage, CallId, GenerateOptions, LlmAdapter, LlmCallConfig, LlmCallConfigAdapterDefaults, LlmFailure, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, Message, PreparedAdapterCall, ResolvedRetryPolicy, StreamChunk, TokenUsage, ToolResultMessage, ToolSchema, UserMessage } from "@deepseek-ai/dsh-llm";
import { Context, Service } from "@deepseek-ai/cordis";
import { Scoped } from "@deepseek-ai/dsh-scope";
//#region node_modules/.pnpm/@deepseek-ai+dsh-brand@0.1.1-rc.2_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-invariants_3e44d2fa059acce7e8d42499f421fc7a/node_modules/@deepseek-ai/dsh-brand/lib/types/index.d.ts
/**
 * The `Branded<B>` nominal-typing primitive — a type-only utility (no runtime
 * code, no harness-package dependency) shared by every package that owns a
 * cross-boundary id.
 *
 * A brand makes structurally-identical strings non-interchangeable at the type
 * level: a `SessionId` cannot be passed where a `CallId` is expected, even
 * though both are plain strings at runtime. Construction goes through a per-id
 * factory in the OWNING package (a plain cast inside — zero runtime cost);
 * comparison, logging, and serialization all behave as ordinary strings.
 *
 * Policy: a package brands the ids it owns — `CallId` in dsh-llm (tool-call
 * correlation), the shared agent/session `SessionId` in dsh-session, and
 * `JobId` in dsh-jobs. Branding is for ids that cross package boundaries and
 * could plausibly be confused; not every string needs a brand.
 * This package owns ONLY the primitive — no concrete id, no runtime code beyond
 * the (erased) type — so the brand vocabulary stays dependency-free and a
 * package can brand its ids without depending on an unrelated capability
 * package.
 *
 * @module @deepseek-ai/dsh-brand
 */
declare const BRAND: unique symbol;
/** A string carrying a compile-time-only brand `B`. */
type Branded<B extends string> = string & {
  readonly [BRAND]: B;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.1-rc.2_a4e4bb24a1f3580ac25e11cfa3c6b8cc/node_modules/@deepseek-ai/dsh-session/lib/types/json.d.ts
/** Lossless-JSON validation and detached snapshots for durable session data. @module @deepseek-ai/dsh-session/json */
/**
 * A value that round-trips losslessly through JSON: `null`, a boolean, a finite
 * number other than negative zero, a string, an array of such values, or a
 * plain object whose values are such values. Arrays may carry only their dense
 * indexed elements; extra own properties would be discarded by JSON. TypeScript
 * cannot distinguish `-0` from `number`, so {@link isJsonValue} and
 * {@link snapshotJsonValue} enforce these details at runtime. Use this type for
 * a payload that must survive session-log persistence and replay byte-identically
 * — e.g. a tool's private presentation `meta`.
 */
type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.1-rc.2_a4e4bb24a1f3580ac25e11cfa3c6b8cc/node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts
/** Identifies one session in the store (and its persistence artifacts). */
type SessionId = Branded<'SessionId'>;
/**
 * Brand a string as a {@link SessionId}.
 * @param id - the raw session id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
declare function SessionId(id: string): SessionId;
/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
interface SessionHeader {
  /**
   * On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the
   * session is created. A persistence backend rejects any other version on load
   * (no migration — see the constant).
   */
  readonly version: number;
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId;
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number;
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string;
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId;
  /**
   * How many leading events were inherited through a seed. Persisting this
   * boundary lets resume and replay distinguish parent history from child work.
   */
  readonly seedLength?: number;
  /**
   * Coarse product classification for a session created as a subagent child.
   * This is presentation metadata, not proof that the child is continuable.
   */
  readonly origin?: 'subagent';
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number;
  /**
   * Id of the agent preset this session's agent was composed from, when the
   * deployment composes per session. Durable because the preset decides the
   * session's tools and prompt: a resume that restored a different composition
   * would replay history the model can no longer act on.
   */
  readonly agentPreset?: string;
}
/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[];
  /**
   * Storage metadata read once before publication. `seedLength` is explicit
   * because a resumed seed contains the full stored log, not only its inherited prefix.
   */
  readonly meta?: {
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly createdAt?: number;
    readonly seedLength?: number;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
  };
}
/**
 * Fresh storage values transferred to {@link SessionStore.prepare} without a
 * second serialization copy. Callers retain no mutable aliases.
 */
interface RestoredSessionOptions {
  /** Fresh detached storage events to validate and freeze in place. */
  readonly seed: SessionEvent[];
  /** Fresh detached storage metadata to validate and freeze in place. */
  readonly meta: SessionHeader;
  /** Select the persistence ownership-transfer path. */
  readonly seedSource: 'persistence';
}
/** Inputs accepted while constructing an unpublished Session. */
type PrepareSessionOptions = (CreateSessionOptions & {
  readonly seedSource?: undefined;
}) | RestoredSessionOptions;
/** Why an active agent driver was cancelled. */
type AgentCancelCause = {
  readonly kind: 'user';
} | {
  readonly kind: 'parent';
} | {
  readonly kind: 'hook';
  readonly reason: string;
} | {
  readonly kind: 'disposed';
};
/** Durable cancellation cause, including imports whose original coarse record carried no cause. */
type TurnEndCancelCause = AgentCancelCause | {
  readonly kind: 'legacy';
};
/**
 * Why a turn ended. Merge-extensible sum type.
 */
interface TurnEndReasonMap {
  completed: {
    kind: 'completed';
  };
  /** A cancellation request interrupted the live turn. */
  aborted: {
    kind: 'aborted';
    reason: TurnEndCancelCause;
  };
  blocked: {
    kind: 'blocked';
  };
  /**
   * The turn failed. `error` is always a structured failure: the `LlmError`
   * facts verbatim, or `{ message: errorChain(error), code: 'UNKNOWN' }`
   * flattened from any other error.
   */
  error: {
    kind: 'error';
    error: LlmFailure;
  };
  /** At least one step reached its output-token ceiling, even if a plugin continued the turn. */
  'max-tokens': {
    kind: 'max-tokens';
  };
  /**
   * A persistence backend closed a crash-orphaned turn on reload. The loop never
   * emits this marker, and the events recorded before the crash remain intact.
   */
  interrupted: {
    kind: 'interrupted';
  };
}
/** The union over {@link TurnEndReasonMap} — why a turn ended; plugins extend it by merging variants into the map. */
type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap];
/**
 * One entry in an agent's todo list — the unit of the `todo/write`
 * {@link SessionEventMap} event's whole-list snapshot.
 *
 * Deliberately minimal: a human-readable `content` line and a three-state
 * `status`. No id, priority, or `activeForm` — the list is replaced wholesale
 * on every write (last-write-wins), so entries need no stable identity. The
 * three statuses describe the complete portable lifecycle needed by model and
 * UI consumers.
 */
interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string;
  /** Lifecycle state. `in_progress` marks a task being worked now; parallel work may mark several. */
  status: 'pending' | 'in_progress' | 'completed';
}
/**
 * Logged request state outside derived history: call config, system prompt, and
 * tools. The latest full `request/header` snapshot reconstructs it; canonical
 * empty optional fields are absent.
 */
interface EpochHeader {
  /** The conversation's call configuration (provider, model, reasoning effort, and sampling scalars). */
  config: LlmCallConfig;
  /** Effective config fields materialized from the exact adapter rather than proposed by a caller. */
  adapterDefaults?: LlmCallConfigAdapterDefaults;
  /** Rendered system prompt text; absent for a system-less request. */
  system?: string;
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: ToolSchema[];
}
/** Registration-bound metadata for one resolved model route. */
interface RequestContext {
  /** Registered provider route the metadata belongs to. */
  provider: string;
  /** Provider-owned model id the metadata belongs to. */
  model: string;
  /** Maximum combined request and response context in tokens, when advertised. */
  contextWindow?: number;
}
/**
 * Why a `request/header` snapshot was appended: `'initial'` — the log's first
 * header (a new conversation); `'resume'` — a loop instance's first request
 * over a log that already has header events (process restart, fork seed);
 * `'change'` — a later request used a different header.
 */
type RequestHeaderReason = 'initial' | 'resume' | 'change';
/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous, including raw chunks, so persistence can
 * store the canonical log verbatim.
 */
interface SessionEventMap {
  /**
   * Opens turn `turn` before the loop claims queued input or runs pre-step.
   * Rejection, empty input, cancellation, or failure may close it with no
   * step; otherwise the following identified `user/message` event or batch
   * records the messages entering the step.
   */
  'turn/start': {
    turn: number;
  };
  /**
   * Closes turn `turn` with the {@link TurnEndReason} that ended it. A turn
   * with no entered step has no `step/start` or `step/end`. The loop does not await a
   * flush at turn boundaries: `dsh-session-checkpoint-policy` owns the
   * per-request durability checkpoint, and consumers that read storage after
   * `whenIdle()` flush themselves. Success commits the turn; rejection is
   * reported live and does not prevent later work.
   */
  'turn/end': {
    turn: number;
    reason: TurnEndReason;
  };
  /** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
  'step/start': {
    turn: number;
    step: number;
  };
  /** Closes step `step` of turn `turn`. */
  'step/end': {
    turn: number;
    step: number;
  };
  /**
   * A user-role message on the model-visible surface: a direct human prompt
   * (the queued message claimed for this turn), a synthetic `agent.inject()`
   * context (file-change notices, subdir AGENTS.md, skill content, cron
   * notifications, …), or an entered goal continuation round. All three
   * project their `content` verbatim; `source` tells them apart.
   */
  'user/message': UserMessage;
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': {
    turn: number;
    step: number;
    chunk: StreamChunk;
  };
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none. A turn
   * cancelled mid-stream finalizes its delivered text/reasoning prefix as this
   * event with `interrupted: true`; undispatched tool calls are absent. The
   * marker distinguishes that prefix without re-deriving interruption from turn
   * boundaries. An aborted turn with no such event streamed no visible content.
   */
  'assistant/message': {
    turn: number;
    step: number;
    message: AssistantMessage;
    usage?: TokenUsage;
    interrupted?: true;
  };
  /**
   * The model requested one tool invocation: `name` with the raw `arguments`
   * JSON string exactly as the model produced it (unparsed). `callId` pairs the
   * call with its `tool/result`.
   */
  'tool/call': {
    turn: number;
    step: number;
    callId: CallId;
    name: string;
    arguments: string;
  };
  /**
   * A completed tool call's model-facing result, optional internal failure
   * identity, and optional tool-private `meta` presentation payload. `meta` is
   * opaque to the core (the producing tool owns its shape and reads it back in
   * `presentResult`) but MUST be JSON-serializable: `Session.append`
   * runtime-validates all event data with `isJsonValue`, so a non-serializable
   * `meta` is rejected at the source, and the durable log reproduces the
   * identical card on replay. Absent
   * unless the tool attaches one (e.g. `dsh-tool-fs` carries its result-time
   * contextual diff here).
   */
  'tool/result': {
    turn: number;
    step: number;
    message: ToolResultMessage;
    error?: {
      name: string;
      code: string;
    };
    meta?: JsonValue;
  };
  /** Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history. */
  'todo/write': {
    todos: TodoItem[];
  };
  /**
   * Full header for the next request, appended inside its step before dispatch.
   * It is log-only; the latest snapshot reconstructs the request header.
   */
  'request/header': {
    header: EpochHeader;
    reason: RequestHeaderReason;
  };
  /**
   * Route metadata for the next request, logged only when the route or capacity
   * changes. It does not participate in request reconstruction or header equality.
   */
  'request/context': RequestContext;
  /**
   * Marks the end of a constructor seed. Events before it have smaller seq
   * values and came from the seed (resume, fork, or replay); this lifecycle
   * produced none of them. This log-only event is the durable projection of
   * {@link Session.firstLiveSeq}. Its payload is empty — position and `time`
   * carry the meaning.
   *
   * Locate the LAST one in stored history. A seed already ending in one is not
   * re-marked, so reopening an untouched session does not grow its log per
   * pickup and the event need not be at the current `firstLiveSeq`.
   *
   * `Session`'s constructor is the only legitimate writer. The invariant
   * companion deliberately constrains nothing here, so a plugin appending one
   * would silently classify every live bracket before it as seed history.
   *
   * An owner of a standalone open/close bracket (`compaction/start` …
   * `compaction/end`) reads it because seed history and live work are otherwise
   * byte-identical: an unmatched opening marker before this event belongs to
   * an ended lifecycle, whatever ended it. NOT a liveness signal about other
   * writers — a concurrently live session holds its own boundary elsewhere,
   * so tolerating concurrent writers needs a signal beyond the log.
   */
  'session/end-seed': Record<string, never>;
}
/** The appendable event-type keys of {@link SessionEventMap}, plugin-merged extensions included. */
type SessionEventType = keyof SessionEventMap;
/**
 * The subset of {@link SessionEventType} values whose events produce LLM
 * messages and are eligible to appear on the ordered surface. Only these
 * event types may carry {@link SurfaceOp} and {@link SessionEvent.sourceEventSeqs}.
 */
type SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result';
/**
 * How a session event entered the ordered surface. Only valid on
 * {@link SurfaceEventType} events.
 *
 * - `'append'`: added to the tail — normal path for user/assistant/tool
 *   messages.
 * - `{ op: 'replace', start, end }`: replaces surface nodes from `start`
 *   (inclusive) through `end` (inclusive) with this node. Both must exist as
 *   surface nodes in the current surface. `start === end` replaces a single
 *   node. The node's {@link SessionEvent.sourceEventSeqs} must include every
 *   shadowed surface node. Used by compaction; any surface-replacing producer
 *   may use it.
 */
type SurfaceOp = 'append' | {
  op: 'replace';
  start: number;
  end: number;
};
/**
 * Surface placement and cited source-event seqs for {@link Session.append}. Required on
 * message-producing events and forbidden on log-only events.
 */
interface SurfaceIntent {
  surfaceOp: SurfaceOp;
  /**
   * Complete set of known source-event seqs. `assistant/message` may use a
   * present empty array for a known empty provider stream; when the field is
   * absent, the event does not record which earlier events produced the message.
   * Other surface events require a non-empty set when this field is present.
   */
  sourceEventSeqs?: number[];
}
/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 *
 * The {@link sourceEventSeqs} and {@link surfaceOp} fields are conditional:
 * they only exist on {@link SurfaceEventType} variants (`user/message`,
 * `assistant/message`, `tool/result`).
 * Non-surface events (boundary markers, chunks, usage, errors) never carry
 * surface metadata — the compiler enforces this at `Session.append()`
 * call sites.
 */
type SessionEvent<T extends SessionEventType = SessionEventType> = { [K in SessionEventType]: {
  type: K;
  /** Monotonic sequence number within the session. */
  seq: number;
  /** Unix epoch milliseconds. */
  time: number;
  data: SessionEventMap[K];
  /**
   * Marks an event a reader may safely skip when it does not recognize
   * `type`. Absent means required: a reader meeting an unrecognized type
   * without this marker MUST refuse to reconstruct the session instead of
   * silently dropping the event, because an unrecognized required event may
   * change how the rest of the log is interpreted. A writer sets `true` only
   * on purely informational records whose loss cannot affect reconstruction;
   * defaulting to required means a forgotten marker over-refuses (an
   * inconvenience) rather than silently resuming a gutted session.
   */
  ignorable?: true;
} & (K extends SurfaceEventType ? {
  /**
   * Seq numbers of earlier events that this event cites as sources
   * (e.g. the `assistant/chunk` seqs that built an `assistant/message`,
   * or the surface nodes shadowed by a compaction replace node). An
   * `assistant/message` may carry a present empty array for a known empty
   * provider stream; when the field is absent, the event does not record which
   * earlier events produced the message.
   */
  sourceEventSeqs?: number[];
  /** How this event entered the surface; absent for non-surface events. */
  surfaceOp?: SurfaceOp;
} : object); }[T];
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-typert-protocol@0.1.1-rc.2_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-_d8a93c1e0226dfbdafa801afa2319239/node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/types.d.ts
declare const LOOKUP_HOST: unique symbol;
declare const LOOKUP_WIRE: unique symbol;
declare const CONTEXT_WIRE: unique symbol;
/** Type-level association between a Host object and its wire identity. */
interface TypertLookup<Host, Wire> {
  readonly [LOOKUP_HOST]: Host;
  readonly [LOOKUP_WIRE]: Wire;
}
/** Extract the Host object associated with one lookup declaration. */
type TypertLookupHost<Lookup> = Lookup extends TypertLookup<infer Host, infer _Wire> ? Host : never;
/** Extract the wire identity associated with one lookup declaration. */
type TypertLookupWire<Lookup> = Lookup extends TypertLookup<infer _Host, infer Wire> ? Wire : never;
/** Type-level association between a scoped Context kind and its wire identity. */
interface TypertContext<Wire> {
  readonly [CONTEXT_WIRE]: Wire;
}
/** Extract the wire identity associated with one scoped Context declaration. */
type TypertContextWire<ContextType> = ContextType extends TypertContext<infer Wire> ? Wire : never;
/** Merge-extensible Host object lookup declarations. */
interface TypertLookupMap {}
/** Merge-extensible scoped Context declarations. */
interface TypertContextMap {}
/** Awaitable disposer returned by Cordis-owned Typert registrations. */
type TypertDisposer = () => Promise<void>;
type StringKeyOf<Value> = Extract<keyof Value, string>;
/** Minimal runtime-schema capability carried by strict generated codecs. */
interface TypertSchema<Output = unknown> {
  /**
   * Parse and validate one boundary value.
   * @param value - untrusted boundary value.
   * @returns the validated value.
   */
  parse(value: unknown): Output;
}
/** Codec attached to one invocation parameter or result. */
type TypertCodec = {
  readonly mode: 'strict';
  readonly typeSymbol: string;
  readonly schema: TypertSchema;
} | {
  readonly mode: 'src-json';
};
/** One ordered business parameter in a Remote invocation. */
interface InvocationParameterDescriptor {
  /** Source-level parameter name. */
  readonly name: string;
  /** Required key in the wire `args` object. */
  readonly wire: string;
  /** Whether the value is JSON or requires a registered Host lookup. */
  readonly source: 'json' | 'lookup';
  /** Lookup key when `source` is `lookup`. */
  readonly lookup?: string;
  /** Boundary codec for the wire representation. */
  readonly codec: TypertCodec;
  /** Missing wire fields decode to `undefined` only for an explicitly declared `T | undefined`. */
  readonly acceptsUndefined?: true;
}
/** Source position retained for diagnostics from generated definitions. */
interface InvocationSourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}
/** Carrier-independent description of one exported method invocation. */
interface InvocationDescriptor {
  /** Globally stable generated identity. */
  readonly id: string;
  /** Cordis service key owning the method. */
  readonly service: string;
  /** Wire namespace, defaulting to the service key. */
  readonly namespace: string;
  /** Public instance method name. */
  readonly method: string;
  /** Service member invoked when the exported method name is an alias. */
  readonly implementation?: string;
  /** Receiver selection mode. */
  readonly invocation: {
    readonly kind: 'direct';
  } | {
    readonly kind: 'context';
    readonly context: string;
    readonly wire: string;
    readonly codec: TypertCodec;
  };
  /** Optional consuming-Context projection for one direct lookup parameter. */
  readonly scope?: {
    /** Context kind whose Client binder supplies the identity. */
    readonly context: string;
    /** Lookup parameter wire field replaced by the Context identity. */
    readonly wire: string;
  };
  /** Ordered business parameters. */
  readonly parameters: readonly InvocationParameterDescriptor[];
  /** Transport cancellation injected after business parameters instead of entering wire args. */
  readonly cancellation?: {
    /** Reserved final Host method parameter. */
    readonly parameter: 'signal';
  };
  /** Codec for the resolved method result. */
  readonly result: TypertCodec;
  /** Source declaration used only for diagnostics. */
  readonly sourceLocation?: InvocationSourceLocation;
}
/** Generated Host contract selected explicitly by a Client assembly. */
interface TypertRemoteContribution {
  /** npm package that owns the Remote methods. */
  readonly package: string;
  /** Consumer-side invocation descriptors generated from that package. */
  readonly descriptors: readonly InvocationDescriptor[];
}
/**
 * Resolve one validated wire identity, synchronously or asynchronously.
 * @param id - validated wire identity.
 * @returns the Host object, or `undefined` when unavailable.
 */
type TypertLookupResolver<Host = unknown, Wire = unknown> = (id: Wire) => Host | undefined | Promise<Host | undefined>;
/** Runtime provider for one declared Host object lookup. */
interface TypertLookupProvider<Host = unknown, Wire = unknown> {
  /** Source parameter name recognized by the SRC weak parser. */
  readonly parameter: string;
  /** Wire field replacing the Host object parameter. */
  readonly wire: string;
  /** Canonical Host type symbol used by strict generation. */
  readonly hostTypeSymbol: string;
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string;
  /**
   * Resolve a wire identity through the provider's default policy.
   * @param id - validated wire identity.
   * @returns the object, `undefined` when unavailable, or either asynchronously.
   */
  resolve(id: Wire): Host | undefined | Promise<Host | undefined>;
}
/** Stable wire declaration retained after a lookup provider unloads. */
interface TypertLookupDefinition {
  /** Merge-declared lookup key. */
  readonly key: string;
  /** Source parameter name recognized by the SRC weak parser. */
  readonly parameter: string;
  /** Wire field replacing the Host object parameter. */
  readonly wire: string;
  /** Canonical Host type symbol used by strict generation. */
  readonly hostTypeSymbol: string;
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string;
}
/** Host resolver for one scoped Remote kind. */
interface TypertHostContextProvider<Wire = unknown> {
  /** Wire field carrying the Context identity. */
  readonly wire: string;
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string;
  /**
   * Resolve a wire identity to its live scoped Context.
   * @param id - validated wire identity.
   * @returns the scoped Context, or `undefined` when unavailable.
   */
  resolve(id: Wire): Context | undefined | Promise<Context | undefined>;
}
/** Composition-owned resolver replacing one Host Context provider's default lookup policy. */
type TypertHostContextResolver<Wire = unknown> = (id: Wire) => Context | undefined | Promise<Context | undefined>;
/** Client resolver for the identity carried by the calling scoped Context. */
interface TypertClientContextBinder<Wire = unknown> {
  /**
   * Read the Remote identity represented by a calling Context.
   * @param ctx - Context rebound by the Cordis service tracker.
   * @returns the wire identity, or `undefined` when the Context has the wrong scope.
   */
  identity(ctx: Context): Wire | undefined;
}
/** Notification emitted after a Typert runtime registry changes. */
interface TypertRegistryChange {
  readonly kind: 'local' | 'remote' | 'lookup' | 'host-context' | 'client-context';
  readonly key: string;
}
/** Listener for one Typert runtime registry. */
type TypertRegistryListener = (change: TypertRegistryChange) => void;
/** Current-environment invocation definitions. */
interface TypertLocalRegistry {
  /**
   * Look up one invocation by `<namespace>/<method>`.
   * @param endpoint - canonical endpoint.
   * @returns the live descriptor, or `undefined` when absent.
   */
  get(endpoint: string): InvocationDescriptor | undefined;
  /**
   * Report whether a strict definition has existed during this Typert Service lifetime.
   * @param endpoint - canonical endpoint.
   * @returns `true` after the endpoint has been registered at least once, even if withdrawn.
   */
  hasSeen(endpoint: string): boolean;
  /** @returns a registration-order snapshot of local descriptors. */
  list(): readonly InvocationDescriptor[];
  /**
   * Observe later local-definition changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Consumer-selected Remote contribution registry. */
interface TypertRemoteRegistry {
  /**
   * Register one generated contribution for the calling Cordis fiber.
   * @param contribution - generated Remote descriptors.
   * @returns disposer withdrawing the exact contribution.
   */
  register(contribution: TypertRemoteContribution): TypertDisposer;
  /**
   * Look up one Remote descriptor by endpoint.
   * @param endpoint - canonical endpoint.
   * @returns the descriptor, or `undefined` when unmounted.
   */
  get(endpoint: string): InvocationDescriptor | undefined;
  /** @returns a registration-order snapshot of Remote descriptors. */
  list(): readonly InvocationDescriptor[];
  /**
   * Observe later Remote contribution changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Runtime registry for Host object lookup providers. */
interface TypertLookupRegistry {
  /**
   * Register one provider under its merge-declared key.
   * @param key - lookup key.
   * @param provider - owning package's live resolver.
   * @returns disposer withdrawing the exact provider.
   */
  register<K extends StringKeyOf<TypertLookupMap>>(key: K, provider: TypertLookupProvider<TypertLookupHost<TypertLookupMap[K]>, TypertLookupWire<TypertLookupMap[K]>>): TypertDisposer;
  /**
   * Replace one provider's default resolution policy while this contribution is active.
   * Configuration may precede provider registration; without a live provider, `get()` remains unavailable.
   * @param key - lookup key whose wire declaration remains provider-owned.
   * @param resolver - composition-owned resolver used by every lookup of this key.
   * @returns disposer restoring the provider's default resolver.
   */
  configure<K extends StringKeyOf<TypertLookupMap>>(key: K, resolver: TypertLookupResolver<TypertLookupHost<TypertLookupMap[K]>, TypertLookupWire<TypertLookupMap[K]>>): TypertDisposer;
  /**
   * Look up one provider by runtime key.
   * @param key - descriptor lookup key.
   * @returns the live provider, or `undefined` when absent.
   */
  get(key: string): TypertLookupProvider | undefined;
  /** @returns lookup declarations observed during this Typert Service lifetime. */
  definitions(): readonly TypertLookupDefinition[];
  /** @returns a snapshot of registered provider keys. */
  keys(): readonly string[];
  /**
   * Observe later lookup changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Runtime registry for Host Context resolvers and Client Context binders. */
interface TypertContextRegistry {
  /**
   * Register a Host Context resolver.
   * @param key - merge-declared Context key.
   * @param provider - owning package's Host resolver.
   * @returns disposer withdrawing the exact provider.
   */
  registerHost<K extends StringKeyOf<TypertContextMap>>(key: K, provider: TypertHostContextProvider<TypertContextWire<TypertContextMap[K]>>): TypertDisposer;
  /**
   * Override one Host Context key's identity policy for the calling fiber.
   * Configuration may precede provider registration and restores the provider's default resolver on disposal.
   * @param key - merge-declared Context key.
   * @param resolver - composition-owned resolver used by every Host Context lookup of this key.
   * @returns disposer restoring the provider's default resolver.
   */
  configureHost<K extends StringKeyOf<TypertContextMap>>(key: K, resolver: TypertHostContextResolver<TypertContextWire<TypertContextMap[K]>>): TypertDisposer;
  /**
   * Register a Client Context identity binder.
   * @param key - merge-declared Context key.
   * @param binder - Client scope identity resolver.
   * @returns disposer withdrawing the exact binder.
   */
  registerClient<K extends StringKeyOf<TypertContextMap>>(key: K, binder: TypertClientContextBinder<TypertContextWire<TypertContextMap[K]>>): TypertDisposer;
  /**
   * Look up a Host Context resolver.
   * @param key - descriptor Context key.
   * @returns the provider, or `undefined` when absent.
   */
  getHost(key: string): TypertHostContextProvider | undefined;
  /**
   * Look up a Client Context binder.
   * @param key - descriptor Context key.
   * @returns the binder, or `undefined` when absent.
   */
  getClient(key: string): TypertClientContextBinder | undefined;
  /**
   * Observe later Context provider changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer;
}
/** Minimal Typert runtime consumed through dependency inversion. */
interface TypertRegistryContract {
  readonly local: TypertLocalRegistry;
  readonly remotes: TypertRemoteRegistry;
  readonly lookups: TypertLookupRegistry;
  readonly contexts: TypertContextRegistry;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    typert: TypertRegistryContract;
  }
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.1-rc.2_a4e4bb24a1f3580ac25e11cfa3c6b8cc/node_modules/@deepseek-ai/dsh-session/lib/types/surface.d.ts
/** Readonly live projection of the message-producing session events. */
interface SessionSurface {
  /** Current surface event sequences in model-visible order. */
  readonly nodes: readonly number[];
  /** Monotonic count of committed positional replacements. */
  readonly replaceGeneration: number;
}
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0.1.1-rc.2_a4e4bb24a1f3580ac25e11cfa3c6b8cc/node_modules/@deepseek-ai/dsh-session/lib/types/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionStore;
  }
  interface Events {
    /**
     * Creation announcement during session publication. A synchronous throw vetoes and rolls
     * back with a paired disposal; detach requested during dispatch is deferred.
     * A returned-promise rejection is logged but cannot retroactively veto this
     * synchronous boundary.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only sessions entered through that agent's context.
     * @param session - the session just entered and announced.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/created'(this: Scoped<Session>, session: Session): void;
    /**
     * Emitted once when an announced session leaves the store, including
     * publication rollback, but never for an entry whose creation announcement
     * did not begin. Listener failures are logged and contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`) reuses the owner scope.
     * @param session - the session that is no longer live in the store.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/disposed'(this: Scoped<Session>, session: Session): void;
    /**
     * Post-commit, fire-and-forget append feed. The listener snapshot resolves
     * before the log push, but callbacks run after it; observer failures are
     * logged and contained without making the committed append fail.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only events from sessions entered through that agent's context.
     * @param session - the session whose log grew.
     * @param event - the appended event, exactly as recorded.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;
    /**
     * Awaited parallel durability checkpoint: every listener runs and the
     * caller awaits all of them, with no waterfall veto. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`) reuses the session's owner scope.
     * @param session - the session whose buffered events must reach durable storage.
     * @dshScopeScan unsupported
     * @mode parallel
     */
    'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void;
  }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    session: TypertLookup<Session, SessionId>;
  }
}
/**
 * An event-sourced session: an append-only log of {@link SessionEvent}s.
 *
 * Plain class (not a Service) — create live instances via
 * `ctx.sessions.create()` and detached instances via {@link create}.
 * Seeding with an existing event log replays/forks a session.
 * @typert object
 */
declare class Session {
  private log;
  /** Single incremental owner of surface acceptance and projection state. */
  private readonly surfaceManager;
  /** The ordered surface over this session's event log. */
  get surface(): SessionSurface;
  /**
   * Detached, deep-frozen creation metadata (format version, cwd, lineage,
   * seed boundary). Supplied by the store via `ctx.sessions.create()`. When a
   * `Session` is created without a store-owned header, a minimal header is
   * synthesized (stamped with the current {@link SESSION_FORMAT_VERSION}) so
   * `session.header` is always present. Kept out of the event log — it is a
   * storage concern, not replayable conversation state.
   */
  readonly header: SessionHeader;
  /** The session identity, derived from its durable header's single copy. */
  get id(): SessionId;
  /**
   * The first seq appended IN THIS PROCESS: the length of the constructor
   * seed (0 without one). Events with smaller seq values entered through
   * construction — replay, fork, or resume — and were never published on the
   * `session/event` firehose (constructor seeds do not emit), so consumers
   * that replay the log as a publication substitute (telemetry adoption)
   * start here. Distinct from `header.seedLength`, the DURABLE fork-lineage
   * boundary: a resumed session's constructor seed is its full stored log,
   * while its header keeps the original fork value — this field is the
   * in-process construction fact.
   *
   * Not persisted itself: a seeded session projects it into the log as the
   * `session/end-seed` event, which is what a consumer reading STORED history
   * reads. Locate the LAST such event, not necessarily one at this seq — a
   * seed already ending in one is not re-marked, so reopening an untouched
   * session leaves that event at a smaller seq than `firstLiveSeq`. Prefer
   * this field in-process: it is exact before the marker reaches storage.
   *
   * When this lifecycle appends the marker, it occupies this seq before the
   * store attaches and therefore does not publish either. Otherwise this seq
   * holds an ordinary published write.
   */
  readonly firstLiveSeq: number;
  /**
   * Create a detached session by validating and snapshotting borrowed seed
   * events and storage metadata.
   * @param id - session identity.
   * @param seed - optional borrowed replay or fork events.
   * @param header - optional borrowed storage metadata.
   * @returns a detached session.
   */
  static create(id: SessionId, seed?: readonly SessionEvent[], header?: SessionHeader): Session;
  /**
   * Restore a detached session by taking ownership of fresh persistence values.
   * The storage format, event envelopes, sequence continuity, surface transitions,
   * and header fields are validated before the restored objects are frozen.
   * @param id - restored session identity.
   * @param seed - fresh detached events whose ownership is transferred.
   * @param header - fresh detached metadata whose ownership is transferred.
   * @returns a restored detached session.
   */
  static fromRestore(id: SessionId, seed: readonly SessionEvent[], header: SessionHeader): Session;
  private constructor();
  /** Cached immutable public snapshot of the private append-only log. */
  private eventsSnapshot;
  /**
   * An immutable snapshot of the append-only event log. The snapshot is reused
   * until the next append; a previously returned array does not grow later.
   * Events and their nested data are deep-frozen at acceptance, so neither a
   * cast nor ordinary JavaScript can rewrite durable history.
   */
  get events(): readonly SessionEvent[];
  /** The next event's sequence number — always the log length (the `seq = log.length` contiguity contract). */
  get seq(): number;
  /**
   * Append one typed event to the log and synchronously notify observers via
   * the store-owned, module-private publication hooks. The hot path never blocks
   * on I/O — persistence plugins buffer asynchronously. Once the event enters
   * the log, the append is committed: observer failures are logged and
   * contained per listener, so they do not change the return value or prevent
   * later listeners from observing the same accepted event.
   *
   * @param type - The event type (key of {@link SessionEventMap}).
   * @param data - The event payload; must be JSON-serializable.
   * @param opts - Surface metadata: `surfaceOp` controls how the event enters
   *   the ordered surface; `sourceEventSeqs` lists the seq numbers of earlier
   *   events this one derives from. REQUIRED for
   *   {@link SurfaceEventType} events (every message-producing event must
   *   declare how it joins the surface, the sole source of derived model
   *   history) and
   *   rejected by the compiler for non-surface types like `turn/start` or
   *   `assistant/chunk`.
   * @returns the logged event — its assigned `seq`/`time` plus the SNAPSHOT of
   *   `data` that entered the log, so reading `event.data` back sees the logged
   *   value, never the caller's still-mutable input.
   * @throws if `data` or surface metadata is not losslessly JSON-serializable
   *   (BigInt, function, symbol, undefined, negative zero, non-finite number,
   *   circular reference, sparse array, or an exotic object such as
   *   Map/Set/Date/class instance), or when the candidate violates the
   *   canonical surface contract (marker shape and eligibility, unique
   *   earlier source-event references, positional replacement validity, and complete
   *   shadowed-node coverage). One recursive pass reads, validates, and
   *   copies each nested value once, so a stateful getter cannot supply one value
   *   to validation and another to storage. The event log is the durable source
   *   of truth, so a bad event fails at the append site rather than later during
   *   a backend flush. A synchronous internal dispatch validation failure or an
   *   append reentered while this acceptance/publication boundary is open also
   *   rejects before the log changes.
   */
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []): SessionEvent<T>;
  /** Cached fold of the request-header events — see {@link requestHeader}. */
  private headerFold;
  /** Log position (events consumed) the header fold has reached. */
  private headerFoldSeq;
  /**
   * The {@link EpochHeader} in force after the log's last header event — the
   * header the NEXT request will be compared against — or undefined before
   * the first `request/header` snapshot. The live, incrementally-maintained
   * form of `foldRequestHeader(session.events)`: each header event is folded
   * once, when first seen, so a per-step read costs O(new events).
   * @returns the folded header, or undefined when no header event exists yet.
   */
  requestHeader(): EpochHeader | undefined;
  /** Cached fold of `request/context` events. */
  private contextFold;
  private contextFoldSeq;
  /**
   * Return the latest resolved route metadata, or `undefined` before the first
   * `request/context` event. Each event is folded once.
   * @returns the latest immutable route metadata.
   */
  requestContext(): RequestContext | undefined;
  /** The derived-message cache: frozen projections, extended per unseen node. */
  private derived;
  /** Surface position (nodes projected) the cache has reached. */
  private derivedNodes;
  /** {@link SurfaceManager.replaceGeneration} the cache was built under. */
  private derivedGeneration;
  /**
   * Derive the LLM message history by walking the ordered sequences of
   * message-producing events maintained by `surfaceOp` markers. The
   * surface is the single source of derived history: every message-producing
   * append records its `surfaceOp`, so a raw event with no marker (a chunk, a
   * turn boundary) is correctly absent, and a compaction `replace` deletes the
   * shadowed nodes from the derivation. The projection rules are
   * {@link deriveEventMessage}, folded per node.
   *
   * CACHED: each surface node is projected exactly once, when first seen — a
   * call costs O(new nodes), and a surface rewrite (a `replace`;
   * {@link SessionSurface.replaceGeneration}) rebuilds. The returned array is
   * a fresh snapshot per call (later appends never grow an array a caller
   * already holds); the `Message` objects in it are SHARED and **deep-frozen**.
   * Their content reuses the already frozen durable event data, so the cache
   * needs no second deep clone and consumers still cannot mutate the log.
   * @returns a fresh array of the shared, frozen derived history.
   */
  deriveMessages(): Message[];
  /**
   * Instance face of the pure per-node `deriveEventMessage` export from
   * `surface.ts`.
   * @param event - the event to project.
   * @returns the derived message, or null when the event produces none.
   */
  deriveEventMessage(event: SessionEvent): Message | null;
}
/** A fork source: either the live session object or its live store id. */
type SessionForkSource = Session | SessionId;
/**
 * In-memory session store (`ctx.sessions`).
 *
 * Persistence is intentionally not implemented here — persistence plugins
 * subscribe to `session/event` and flush on `session/flush` / dispose.
 */
declare class SessionStore extends Service {
  private store;
  private counter;
  constructor(ctx: Context);
  /**
   * Create a session owned by the calling fiber: disposing that fiber stops
   * event notification and removes the session from the store. `options.seed`
   * populates the session with a copy of those events (replay/fork);
   * `options.meta` attaches creation metadata (validated absolute `cwd`, seed
   * and parent lineage, and delegation depth) as the immutable
   * {@link SessionHeader} (the store fills `version`/`id`/`createdAt`).
   *
   * For an agent whose session must be torn down IN ORDER with its loop (so the
   * loop's final events are published before the store attachment ends), do NOT use this
   * — fold the session lifecycle into the agent's own effect via
   * {@link prepare} + {@link enter} + {@link announce} (see
   * `dsh-agent-loop`'s creation transaction).
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header.
   * @returns the live session, already entered and announced.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path (storage backends key directories off it).
   */
  create(id?: SessionId, options?: CreateSessionOptions): Session;
  /**
   * Build a session WITHOUT entering it into the store — validate the id/cwd and
   * construct the {@link Session} (with its immutable {@link SessionHeader}).
   * Pairs with {@link enter} + {@link announce}: a caller that owns a composite
   * `ctx.effect` (the agent factory) folds the session lifecycle into that ONE
   * effect so a fiber unload tears the session + agent down as a single ORDERED
   * chain rather than as racing sibling effects — which would remove the publication hooks
   * before the driver's closing events commit, dropping them.
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header. With
   *   `seedSource: 'persistence'`, metadata and events must be fresh detached
   *   graphs whose ownership transfers to this call: they are validated and
   *   frozen in place through {@link Session.fromRestore}, so the caller must
   *   retain no mutable aliases.
   * @returns the constructed session, NOT yet in the store.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path.
   */
  prepare(id?: SessionId, options?: PrepareSessionOptions): Session;
  /**
   * Enter a {@link prepare}d session into the store: install the module-private
   * append publication hooks and add it to the store. Returns the DETACH
   * disposer (hooks + store removal). Does NOT emit `session/created` —
   * the caller yields this disposer inside its effect and THEN calls
   * {@link announce}, so a throwing `session/created` listener rolls the attach
   * back instead of leaking it.
   *
   * Re-checks the id for a duplicate: `prepare` and `enter` are public
   * cross-package primitives and a caller may interleave arbitrary work (or
   * another create) between them, so a stale prepared session must NOT overwrite
   * a live store entry of the same id — its detach disposer would later delete
   * the REAL session. The {@link create} convenience and the agent factory call
   * the two back-to-back so they never trip this, but the public API cannot
   * assume that.
   *
   * @param session - a {@link prepare}d session not yet in the store.
   * @returns the detach disposer (publication hooks + store removal). When called from
   *   a synchronous `session/created` listener, removal and disposal wait until
   *   that creation dispatch unwinds.
   * @throws if a session with this id is already in the store.
   */
  enter(session: Session): () => void;
  /** Remove one exact entered session and emit its paired disposal when announced. */
  private detachEntered;
  /** Emit `session/created` exactly once for an {@link enter}ed session (with
   * the carrier {@link enter} captured). Separate from {@link enter} so the
   * caller can yield the detach disposer first (rollback safety — see
   * {@link enter}).
   * @param session - the entered session to announce to listeners.
   * @throws if the session is not live or its announcement already began,
   *   including a reentrant call from a creation listener. */
  announce(session: Session): void;
  /** Emit the paired teardown notification with per-listener containment. */
  private emitDisposed;
  /**
   * Dispatch the awaited `session/flush` durability checkpoint for `session`,
   * with the carrier captured at {@link enter}. THE flush entry point: the
   * store owns the carrier, so callers (the checkpoint policy's per-request
   * barrier, goal-round-driver's idle checkpoint, teardown drains, and consumers
   * that flush themselves before reading storage) must come through here
   * rather than dispatch a raw `ctx.parallel('session/flush', …)` — one owner,
   * one spelling, and the scoped-dispatch invariant can pin it.
   * @param session - the session whose buffered events must reach durable storage.
   * @returns whether at least one durability listener participated, after every
   *   listener has settled successfully.
   * @throws the first registered listener failure after every listener settles.
   */
  flush(session: Session): Promise<boolean>;
  /** Return the exact live entry; detached/prepared objects reject. */
  private liveEntryFor;
  /**
   * Look up a live session.
   * @param id - the session id to look up.
   * @returns the session, or undefined when no live session has that id.
   */
  get(id: SessionId): Session | undefined;
  /**
   * All live sessions, in creation order.
   * @returns a fresh array; mutating it does not affect the store.
   */
  list(): Session[];
  /**
   * Create a live child session from a stable prefix of a live source.
   * `boundary` is an inclusive source event seq; omitted means the source's
   * current last event. The selected slice may end with a between-turn event
   * but must not end inside an open turn.
   *
   * @param source - Live source session object or id.
   * @param boundary - Inclusive source event seq to fork through; omitted means
   *   the source's current last event, and omitted on an empty source forks an
   *   empty child.
   * @param childSessionId - Optional child session id; omitted delegates to
   *   `SessionStore`'s id policy.
   * @returns The created live child session.
   */
  fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session;
  private _forkSeed;
  private _resolveForkSource;
}
//#endregion
//#region src/registry.d.ts
declare const CODEX_THREAD_REGISTRY_SERVICE = "codexThreadRegistry";
type CodexThreadRole = 'canonical' | 'branch' | 'pending';
type CodexThreadExternalState = 'live' | 'archived' | 'deleted' | 'unknown';
interface CodexThreadCreation {
  readonly sessionId: string;
  readonly threadId: string;
  readonly kind: 'start' | 'fork';
  readonly parentThreadId?: string;
  readonly createdAt?: number;
}
interface CodexThreadRef {
  readonly threadId: string;
  readonly role: CodexThreadRole;
  readonly committedTurnId?: string;
  readonly eventSeq?: number;
  readonly ownedByPlugin: boolean;
  readonly active: boolean;
  readonly referenceCount: number;
  readonly externalState: CodexThreadExternalState;
  readonly createdBy?: 'start' | 'fork';
  readonly parentThreadId?: string;
}
interface CodexSessionThreadBinding {
  readonly sessionId: string;
  readonly workspace?: string;
  readonly released: boolean;
  readonly canonicalThreadId?: string;
  readonly refs: readonly CodexThreadRef[];
}
interface CodexThreadRegistrySnapshot {
  readonly version: 1;
  readonly storagePath: string;
  readonly storageHealthy: boolean;
  readonly lastError?: string;
  readonly pendingManagement: readonly CodexThreadManagementIntent[];
  readonly sessions: readonly CodexSessionThreadBinding[];
}
interface CodexThreadOperationDecision {
  readonly threadId: string;
  readonly action: 'archived' | 'unarchived' | 'deleted' | 'skipped';
  readonly reason?: string;
}
interface CodexThreadLifecycleDriver {
  hasActiveSession(sessionId: string): boolean;
  withLifecycleFence<T>(operation: () => Promise<T>): Promise<T>;
  isThreadActive(threadId: string, signal?: AbortSignal): Promise<boolean>;
  archiveThread(threadId: string, signal?: AbortSignal): Promise<void>;
  unarchiveThread(threadId: string, signal?: AbortSignal): Promise<void>;
  deleteThread(threadId: string, signal?: AbortSignal): Promise<void>;
}
interface CodexThreadRegistryService {
  snapshot(): CodexThreadRegistrySnapshot;
  refsForSession(sessionId: string): readonly CodexThreadRef[];
  referenceCount(threadId: string): number;
  reconcile(signal?: AbortSignal): Promise<CodexThreadRegistrySnapshot>;
  archiveSessionThreads(sessionId: string, operationId: string, signal?: AbortSignal): Promise<readonly CodexThreadOperationDecision[]>;
  restoreSessionThreads(sessionId: string, operationId: string, signal?: AbortSignal): Promise<readonly CodexThreadOperationDecision[]>;
  releaseSession(sessionId: string, operationId: string): Promise<void>;
  purgeUnreferencedThreads(threadIds: readonly string[], operationId: string, confirmed: boolean, signal?: AbortSignal): Promise<readonly CodexThreadOperationDecision[]>;
}
interface CodexThreadManagementIntent {
  readonly operationId: string;
  readonly threadId: string;
  readonly action: 'archive' | 'unarchive' | 'delete';
  readonly sessionId?: string;
  readonly createdAt: number;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    codexThreadRegistry: CodexThreadRegistryService;
  }
}
/**
 * Registry sidecar. DSH session logs remain authoritative; this file is only a
 * rebuildable reference/ownership index and never authorizes a destructive action
 * without an owned creation receipt and a fresh reference-count check.
 */
declare class CodexThreadRegistry implements CodexThreadRegistryService {
  private readonly ctx;
  private readonly driver;
  private readonly bindings;
  private readonly receipts;
  private readonly intents;
  private stateTail;
  private storageHealthy;
  private lastError;
  private writeTail;
  private reconcileTask;
  private readonly operationTails;
  constructor(ctx: Context, driver: CodexThreadLifecycleDriver, storagePath?: string);
  readonly storagePath: string;
  initialize(): Promise<void>;
  recordCreated(creation: CodexThreadCreation): Promise<void>;
  observeSessionEvent(session: Session, event: SessionEvent): Promise<void>;
  snapshot(): CodexThreadRegistrySnapshot;
  refsForSession(sessionId: string): readonly CodexThreadRef[];
  referenceCount(threadId: string): number;
  reconcile(signal?: AbortSignal): Promise<CodexThreadRegistrySnapshot>;
  archiveSessionThreads(sessionId: string, operationId: string, signal?: AbortSignal): Promise<readonly CodexThreadOperationDecision[]>;
  restoreSessionThreads(sessionId: string, operationId: string, signal?: AbortSignal): Promise<readonly CodexThreadOperationDecision[]>;
  releaseSession(sessionId: string, operationId: string): Promise<void>;
  purgeUnreferencedThreads(threadIds: readonly string[], operationId: string, confirmed: boolean, signal?: AbortSignal): Promise<readonly CodexThreadOperationDecision[]>;
  dispose(): Promise<void>;
  private runReconcile;
  private observeCheckpoint;
  private binding;
  private bindingSnapshot;
  private assertManagementHealthy;
  private lifecycleBlockReason;
  private performManagementIntent;
  private restore;
  private serialized;
  private persist;
  private withStateLock;
  private withOperation;
}
//#endregion
//#region src/adapter.d.ts
/** Provider route registered in the existing DSH model catalog. */
declare const CODEX_APP_SERVER_PROVIDER = "codex-app-server";
/** Resolved process and timeout configuration owned by the plugin deployment. */
interface AdapterConfig {
  readonly executable: string;
  readonly env: Record<string, string>;
  readonly modelCacheMs: number;
  readonly catalogTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly disposeGraceMs: number;
  readonly stderrMaxBytes: number;
  readonly modelPageSize: number;
  /** Fallback model context capacity when App Server has not reported one yet; zero means unknown. */
  readonly contextWindowTokens?: number;
  /** Exact per-model context capacities, overridden by authoritative runtime usage notifications. */
  readonly modelContextWindows?: Readonly<Record<string, number>>;
  /** Keep one-shot DSH child Sessions out of the persistent Codex thread index. Defaults to true. */
  readonly ephemeralOneShotSubagents?: boolean;
  /** Apply stable DSH-prefixed names to persistent App Server threads. Defaults to true. */
  readonly syncThreadNames?: boolean;
  /** App Server section for persistent DSH child threads; empty disables grouping. */
  readonly subagentSectionName?: string;
}
interface CodexThreadCreationObserver {
  recordCreated(creation: CodexThreadCreation): Promise<void>;
}
/** Local Codex App Server route with session-aware history, permissions, and process ownership. */
declare class CodexAppServerAdapter extends LlmAdapter {
  private readonly ctx;
  private readonly config;
  private cachedModels;
  private pendingModels;
  private readonly observedContextWindows;
  private readonly activeTurns;
  private readonly startingTurns;
  /** Startup ownership exists before a turn is published into ownedTurns. */
  private readonly startingOwnedTurns;
  private readonly disposingSessions;
  private disposed;
  private disposeTask;
  private lifecycleTail;
  private managementFences;
  private threadCreationObserver;
  private lastThreadPresentationError;
  private readonly appliedThreadSections;
  /** Every owned process, including isolated auxiliary calls not keyed by session. */
  private readonly ownedTurns;
  constructor(ctx: Context, config: AdapterConfig);
  setThreadCreationObserver(observer: CodexThreadCreationObserver): void;
  /** Last best-effort naming/grouping failure, excluded from model routing. */
  threadPresentationError(): string | undefined;
  providerInfo(provider: string): LlmProviderInfo;
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, modelId: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  private contextWindowFor;
  private threadPresentationPolicy;
  /**
   * Bind exact model metadata and dispatch to this adapter generation, matching
   * the DSH 0.1.1 prepared-call contract. Configuration is immutable for the
   * instance, and the returned stream closure never reselects another adapter.
   */
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  private beginStartTurn;
  private acquireConversationalTurn;
  private startTurn;
  private closeTurn;
  private finishCloseTurn;
  hasActiveSession(sessionId: string): boolean;
  /** Reject new startup while serializing one explicit lifecycle mutation. */
  withLifecycleFence<T>(operation: () => Promise<T>): Promise<T>;
  private enqueueLifecycle;
  isThreadActive(threadId: string, parentSignal?: AbortSignal): Promise<boolean>;
  archiveThread(threadId: string, parentSignal?: AbortSignal): Promise<void>;
  unarchiveThread(threadId: string, parentSignal?: AbortSignal): Promise<void>;
  deleteThread(threadId: string, parentSignal?: AbortSignal): Promise<void>;
  private manageThread;
  /** Apply non-semantic sidebar presentation without touching DSH conversation state. */
  private applyThreadPresentation;
  /** Reuse one exact custom section name, creating it once when absent. */
  private ensureThreadSection;
  /** Close every startup or turn owned by one DSH session. */
  disposeSession(sessionId: string): Promise<void>;
  /** Dispose every App Server startup and process owned by this adapter. */
  dispose(): Promise<void>;
  private resumeThreadParams;
  private threadParams;
  private isolationConfig;
  private models;
  private loadModels;
  private openConnection;
  private handleServerRequest;
  /**
   * Bridge an App Server `item/tool/requestUserInput` request to the DSH
   * user-questions UI, then answer the pending JSON-RPC request with the
   * human's selection. Questions are mapped to the DSH ask format; secret
   * questions and agentless calls fail explicitly instead of being shown
   * unmasked or guessed.
   */
  private bridgeUserInput;
}
//#endregion
//#region src/presentation.d.ts
type DshThreadKind = 'main' | 'one-shot-subagent' | 'continuable-subagent' | 'unknown-subagent';
interface ThreadPresentationPolicy {
  /** One-shot child sessions keep their durable DSH log but do not persist a Codex sidebar thread. */
  readonly ephemeralOneShotSubagents: boolean;
  /** Apply a stable DSH-prefixed name through App Server thread/name/set. */
  readonly syncThreadNames: boolean;
  /** Custom App Server section for persistent child threads; undefined disables grouping. */
  readonly subagentSectionName?: string;
}
interface ThreadPresentation {
  readonly kind: DshThreadKind;
  readonly ephemeral: boolean;
  readonly name?: string;
  readonly sectionName?: string;
}
interface SessionPresentationSource {
  readonly header: Pick<SessionHeader, 'origin' | 'seedLength'>;
  readonly events: readonly SessionEvent[];
}
/**
 * Resolve a fail-closed presentation policy from durable Session metadata.
 * Unknown or unsupported subagent descriptors stay persistent and grouped:
 * only a positively identified one-shot child is eligible for ephemeral mode.
 */
declare function resolveThreadPresentation(session: SessionPresentationSource, policy: ThreadPresentationPolicy): ThreadPresentation;
//#endregion
//#region src/index.d.ts
declare const name = "codex-plugin-dsh";
declare const inject: string[];
/** Deployment configuration for the local Codex CLI process. */
interface Config {
  /** Bare command or absolute path resolved in the DSH subprocess execution world. */
  executable?: string;
  /** Explicit environment layered over DSH's credential-scrubbed child environment. */
  env?: Record<string, string>;
  /** Milliseconds to retain one successful App Server model catalog. */
  modelCacheMs?: number;
  /** Milliseconds allowed for login and model discovery. */
  catalogTimeoutMs?: number;
  /** Milliseconds allowed for one Codex turn. */
  turnTimeoutMs?: number;
  /** Grace between managed subprocess termination tiers. */
  disposeGraceMs?: number;
  /** Maximum App Server stderr bytes retained for a failure diagnostic. */
  stderrMaxBytes?: number;
  /** Number of models requested per App Server catalog page. */
  modelPageSize?: number;
  /** Fallback context capacity for models until App Server reports one; zero keeps it unknown. */
  contextWindowTokens?: number;
  /** Exact model-id to context-capacity overrides. */
  modelContextWindows?: Record<string, number>;
  /** Rebuildable Session-to-Thread sidecar path; empty uses $DSH_HOME. */
  registryPath?: string;
  /** Keep one-shot DSH child Sessions out of the persistent Codex thread index. */
  ephemeralOneShotSubagents?: boolean;
  /** Apply stable DSH-prefixed names to persistent Codex threads. */
  syncThreadNames?: boolean;
  /** Custom App Server section for persistent DSH child threads; empty disables grouping. */
  subagentSectionName?: string;
}
declare const Config: z<Config>;
/** Register the adapter, rebuildable thread registry, and owned lifecycles. */
declare function apply(ctx: Context, config: Config): Promise<void>;
//#endregion
export { CODEX_APP_SERVER_PROVIDER, CODEX_THREAD_REGISTRY_SERVICE, CodexAppServerAdapter, type CodexSessionThreadBinding, type CodexThreadManagementIntent, type CodexThreadOperationDecision, type CodexThreadRef, CodexThreadRegistry, type CodexThreadRegistryService, type CodexThreadRegistrySnapshot, Config, type DshThreadKind, type SessionPresentationSource, type ThreadPresentation, type ThreadPresentationPolicy, apply, inject, name, resolveThreadPresentation };