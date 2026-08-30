/** Presentation policy for DSH-owned Codex threads. */

import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'

export type DshThreadKind = 'main' | 'one-shot-subagent' | 'continuable-subagent' | 'unknown-subagent'

export interface ThreadPresentationPolicy {
  /** One-shot child sessions keep their durable DSH log but do not persist a Codex sidebar thread. */
  readonly ephemeralOneShotSubagents: boolean
  /** Apply a stable DSH-prefixed name through App Server thread/name/set. */
  readonly syncThreadNames: boolean
  /** Custom App Server section for persistent child threads; undefined disables grouping. */
  readonly subagentSectionName?: string
}

export interface ThreadPresentation {
  readonly kind: DshThreadKind
  readonly ephemeral: boolean
  readonly name?: string
  readonly sectionName?: string
}

export interface SessionPresentationSource {
  readonly header: Pick<SessionHeader, 'origin' | 'seedLength'>
  readonly events: readonly SessionEvent[]
}

const MAIN_PREFIX = '[DSH]'
const SUBAGENT_PREFIX = '[DSH 子代理]'
const BACKGROUND_PREFIX = '[DSH 后台]'
const TITLE_LIMIT = 80

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizedTitle(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) return undefined
  const points = Array.from(normalized)
  return points.length <= TITLE_LIMIT
    ? normalized
    : `${points.slice(0, TITLE_LIMIT - 1).join('')}…`
}

/** Read the latest durable DSH title without requiring the optional title service at runtime. */
function loggedSessionTitle(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as unknown as { readonly type?: unknown; readonly data?: unknown }
    if (event.type !== 'session/title') continue
    const title = record(event.data)?.title
    if (typeof title === 'string') return normalizedTitle(title)
  }
  return undefined
}

/** Fall back to the first direct human message, excluding synthetic DSH user context. */
function firstHumanTitle(events: readonly SessionEvent[]): string | undefined {
  for (const raw of events) {
    const event = raw as unknown as { readonly type?: unknown; readonly data?: unknown }
    if (event.type !== 'user/message') continue
    const message = record(event.data)
    if (record(message?.source)?.kind !== 'user' || !Array.isArray(message?.content)) continue
    const text = message.content
      .map(block => {
        const item = record(block)
        return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
      })
      .filter(Boolean)
      .join(' ')
    const title = normalizedTitle(text)
    if (title !== undefined) return title
  }
  return undefined
}

function displayName(prefix: string, title: string | undefined, fallback: string): string {
  return `${prefix} ${title ?? fallback}`
}

/** Exclude inherited fork-seed events when classifying the current Session. */
function ownSessionEvents(session: SessionPresentationSource): readonly SessionEvent[] {
  const seedLength = session.header.seedLength
  if (seedLength === undefined || !Number.isSafeInteger(seedLength) || seedLength <= 0) return session.events
  return session.events.filter(event => event.seq >= seedLength)
}

/**
 * Resolve a fail-closed presentation policy from durable Session metadata.
 * Unknown or unsupported subagent descriptors stay persistent and grouped:
 * only a positively identified one-shot child is eligible for ephemeral mode.
 */
export function resolveThreadPresentation(
  session: SessionPresentationSource,
  policy: ThreadPresentationPolicy,
): ThreadPresentation {
  const ownEvents = ownSessionEvents(session)
  const title = loggedSessionTitle(ownEvents) ?? firstHumanTitle(ownEvents)
  if (session.header.origin !== 'subagent') {
    return {
      kind: 'main',
      ephemeral: false,
      ...policy.syncThreadNames ? { name: displayName(MAIN_PREFIX, title, '会话') } : {},
    }
  }

  const descriptor = foldSubagentDescriptor(ownEvents)
  const sectionName = policy.subagentSectionName?.trim() || undefined
  if (descriptor?.mode === 'one-shot') {
    const ephemeral = policy.ephemeralOneShotSubagents
    return {
      kind: 'one-shot-subagent',
      ephemeral,
      ...!ephemeral && policy.syncThreadNames
        ? { name: displayName(BACKGROUND_PREFIX, descriptor.label ?? title, '一次性任务') }
        : {},
      ...!ephemeral && sectionName !== undefined ? { sectionName } : {},
    }
  }

  if (descriptor?.mode === 'continuable') {
    return {
      kind: 'continuable-subagent',
      ephemeral: false,
      ...policy.syncThreadNames
        ? { name: displayName(SUBAGENT_PREFIX, descriptor.label || title, '可继续任务') }
        : {},
      ...sectionName === undefined ? {} : { sectionName },
    }
  }

  return {
    kind: 'unknown-subagent',
    ephemeral: false,
    ...policy.syncThreadNames ? { name: displayName(SUBAGENT_PREFIX, title, '任务') } : {},
    ...sectionName === undefined ? {} : { sectionName },
  }
}
