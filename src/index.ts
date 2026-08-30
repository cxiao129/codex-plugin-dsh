/** External DSH plugin that registers local Codex App Server as a native model provider. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  CODEX_APP_SERVER_PROVIDER,
  CodexAppServerAdapter,
  type AdapterConfig,
} from './adapter.ts'
import {
  CODEX_THREAD_REGISTRY_SERVICE,
  CodexThreadRegistry,
  defaultCodexThreadRegistryPath,
} from './registry.ts'

export const name = 'codex-plugin-dsh'
export const inject = ['llm', 'subprocess', 'sessions', 'sessionPersistence', 'attachments', 'agents', 'userQuestions']

/** Deployment configuration for the local Codex CLI process. */
export interface Config {
  /** Bare command or absolute path resolved in the DSH subprocess execution world. */
  executable?: string
  /** Explicit environment layered over DSH's credential-scrubbed child environment. */
  env?: Record<string, string>
  /** Milliseconds to retain one successful App Server model catalog. */
  modelCacheMs?: number
  /** Milliseconds allowed for login and model discovery. */
  catalogTimeoutMs?: number
  /** Milliseconds allowed for one Codex turn. */
  turnTimeoutMs?: number
  /** Grace between managed subprocess termination tiers. */
  disposeGraceMs?: number
  /** Maximum App Server stderr bytes retained for a failure diagnostic. */
  stderrMaxBytes?: number
  /** Number of models requested per App Server catalog page. */
  modelPageSize?: number
  /** Fallback context capacity for models until App Server reports one; zero keeps it unknown. */
  contextWindowTokens?: number
  /** Exact model-id to context-capacity overrides. */
  modelContextWindows?: Record<string, number>
  /** Rebuildable Session-to-Thread sidecar path; empty uses $DSH_HOME. */
  registryPath?: string
  /** Keep one-shot DSH child Sessions out of the persistent Codex thread index. */
  ephemeralOneShotSubagents?: boolean
  /** Apply stable DSH-prefixed names to persistent Codex threads. */
  syncThreadNames?: boolean
  /** Custom App Server section for persistent DSH child threads; empty disables grouping. */
  subagentSectionName?: string
}

export const Config: z<Config> = z.object({
  executable: z.string().default('codex'),
  env: z.dict(z.string()).default({}),
  modelCacheMs: z.number().default(30_000),
  catalogTimeoutMs: z.number().default(10_000),
  turnTimeoutMs: z.number().default(60 * 60_000),
  disposeGraceMs: z.number().default(3_000),
  stderrMaxBytes: z.number().default(16_384),
  modelPageSize: z.number().default(100),
  contextWindowTokens: z.number().default(0),
  modelContextWindows: z.dict(z.number()).default({ 'gpt-5.6-sol': 1_048_576 }),
  registryPath: z.string().default(''),
  ephemeralOneShotSubagents: z.boolean().default(true),
  syncThreadNames: z.boolean().default(true),
  subagentSectionName: z.string().default('DSH 子代理'),
})

function resolvedConfig(config: Config): AdapterConfig {
  const resolved = config as Required<Config>
  if (resolved.executable.trim().length === 0) throw new Error('codex-plugin-dsh: executable must be non-empty')
  const positive = [
    ['catalogTimeoutMs', resolved.catalogTimeoutMs],
    ['turnTimeoutMs', resolved.turnTimeoutMs],
    ['disposeGraceMs', resolved.disposeGraceMs],
    ['stderrMaxBytes', resolved.stderrMaxBytes],
  ] as const
  for (const [field, value] of positive) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`codex-plugin-dsh: ${field} must be positive and finite`)
  }
  if (!Number.isFinite(resolved.modelCacheMs) || resolved.modelCacheMs < 0) {
    throw new Error('codex-plugin-dsh: modelCacheMs must be non-negative and finite')
  }
  if (!Number.isSafeInteger(resolved.modelPageSize) || resolved.modelPageSize <= 0) {
    throw new Error('codex-plugin-dsh: modelPageSize must be a positive safe integer')
  }
  if (!Number.isSafeInteger(resolved.contextWindowTokens) || resolved.contextWindowTokens < 0) {
    throw new Error('codex-plugin-dsh: contextWindowTokens must be a non-negative safe integer')
  }
  for (const [model, contextWindow] of Object.entries(resolved.modelContextWindows)) {
    if (model.length === 0 || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      throw new Error('codex-plugin-dsh: modelContextWindows must map non-empty model ids to positive safe integers')
    }
  }
  const subagentSectionName = resolved.subagentSectionName.trim()
  if (Array.from(subagentSectionName).length > 100) {
    throw new Error('codex-plugin-dsh: subagentSectionName must not exceed 100 characters')
  }
  return {
    executable: resolved.executable,
    env: resolved.env,
    modelCacheMs: resolved.modelCacheMs,
    catalogTimeoutMs: resolved.catalogTimeoutMs,
    turnTimeoutMs: resolved.turnTimeoutMs,
    disposeGraceMs: resolved.disposeGraceMs,
    stderrMaxBytes: resolved.stderrMaxBytes,
    modelPageSize: resolved.modelPageSize,
    contextWindowTokens: resolved.contextWindowTokens,
    modelContextWindows: { ...resolved.modelContextWindows },
    ephemeralOneShotSubagents: resolved.ephemeralOneShotSubagents,
    syncThreadNames: resolved.syncThreadNames,
    subagentSectionName,
  }
}

/** Register the adapter, rebuildable thread registry, and owned lifecycles. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const adapter = new CodexAppServerAdapter(ctx, resolvedConfig(config))
  const registryPath = config.registryPath?.trim() || defaultCodexThreadRegistryPath()
  const registry = new CodexThreadRegistry(ctx, adapter, registryPath)
  await registry.initialize()
  adapter.setThreadCreationObserver(registry)
  ctx.provide(CODEX_THREAD_REGISTRY_SERVICE, registry)
  ctx.llm.registerAdapter([CODEX_APP_SERVER_PROVIDER], adapter)
  ctx.on('session/event', (session, event) => registry.observeSessionEvent(session, event))
  // A DSH turn may end while an interactive dynamic tool waits for a human
  // response. Only the authoritative session disposal boundary, the resettable
  // idle deadline, normal completion, or plugin disposal closes the retained
  // App Server turn.
  ctx.on('session/disposed', session => adapter.disposeSession(String(session.id)))
  // Reconciliation reads durable DSH logs and repairs the sidecar. It is kept
  // off the plugin activation critical path; failures remain visible in the
  // registry snapshot and never disable the model route.
  void registry.reconcile().catch(() => {})
  ctx.effect(() => async () => {
    await adapter.dispose()
    await registry.dispose()
  }, 'codex-plugin-dsh: close App Server turns and flush thread registry')
}

export {
  CODEX_APP_SERVER_PROVIDER,
  CODEX_THREAD_REGISTRY_SERVICE,
  CodexAppServerAdapter,
  CodexThreadRegistry,
}
export { resolveThreadPresentation } from './presentation.ts'
export type {
  DshThreadKind,
  SessionPresentationSource,
  ThreadPresentation,
  ThreadPresentationPolicy,
} from './presentation.ts'
export type {
  CodexSessionThreadBinding,
  CodexThreadOperationDecision,
  CodexThreadManagementIntent,
  CodexThreadRef,
  CodexThreadRegistryService,
  CodexThreadRegistrySnapshot,
} from './registry.ts'
