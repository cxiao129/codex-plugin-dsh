import { describe, expect, it } from 'vitest'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { resolveThreadPresentation } from '../src/presentation.ts'

const policy = {
  ephemeralOneShotSubagents: true,
  syncThreadNames: true,
  subagentSectionName: 'DSH 子代理',
} as const

function event(seq: number, type: string, data: unknown) {
  return { seq, time: seq + 1, type, data } as never
}

function directUser(seq: number, text: string) {
  return event(seq, 'user/message', {
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

describe('DSH Codex thread presentation policy', () => {
  it('uses the latest logged DSH title for a main thread', () => {
    const result = resolveThreadPresentation({
      header: {},
      events: [
        directUser(0, 'raw first prompt'),
        event(1, 'session/title', { title: 'Clean DSH title' }),
      ],
    }, policy)

    expect(result).toEqual({
      kind: 'main',
      ephemeral: false,
      name: '[DSH] Clean DSH title',
    })
  })

  it('falls back to the first direct human message and ignores synthetic user context', () => {
    const result = resolveThreadPresentation({
      header: {},
      events: [
        event(0, 'user/message', {
          source: { kind: 'synthetic', reason: 'runtime-context' },
          content: [{ type: 'text', text: '<system-reminder>noisy context</system-reminder>' }],
        }),
        directUser(1, 'Review the OpenAPI implementation'),
      ],
    }, policy)

    expect(result.name).toBe('[DSH] Review the OpenAPI implementation')
  })

  it('marks only a positively identified one-shot child as ephemeral', () => {
    const descriptor = snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: 'session',
      label: 'Snapshot review',
    })
    const result = resolveThreadPresentation({
      header: { origin: 'subagent' },
      events: [event(0, 'subagent/descriptor', descriptor)],
    }, policy)

    expect(result).toEqual({
      kind: 'one-shot-subagent',
      ephemeral: true,
    })
  })

  it('classifies the child own descriptor instead of an inherited parent descriptor', () => {
    const inherited = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'session',
      label: 'Parent worker',
    })
    const own = snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: 'session',
      label: 'Nested snapshot',
    })
    const result = resolveThreadPresentation({
      header: { origin: 'subagent', seedLength: 1 },
      events: [
        event(0, 'subagent/descriptor', inherited),
        event(1, 'subagent/descriptor', own),
      ],
    }, policy)

    expect(result).toEqual({
      kind: 'one-shot-subagent',
      ephemeral: true,
    })
  })

  it('keeps continuable children persistent, named, and grouped', () => {
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'session',
      label: 'Architecture reviewer',
    })
    const result = resolveThreadPresentation({
      header: { origin: 'subagent' },
      events: [event(0, 'subagent/descriptor', descriptor)],
    }, policy)

    expect(result).toEqual({
      kind: 'continuable-subagent',
      ephemeral: false,
      name: '[DSH 子代理] Architecture reviewer',
      sectionName: 'DSH 子代理',
    })
  })

  it('fails closed when a subagent descriptor is absent or unsupported', () => {
    const result = resolveThreadPresentation({
      header: { origin: 'subagent' },
      events: [directUser(0, 'Legacy child task')],
    }, policy)

    expect(result).toEqual({
      kind: 'unknown-subagent',
      ephemeral: false,
      name: '[DSH 子代理] Legacy child task',
      sectionName: 'DSH 子代理',
    })
  })

  it('can keep one-shot children persistent when the feature is disabled', () => {
    const descriptor = snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: 'session',
      label: 'Compatibility worker',
    })
    const result = resolveThreadPresentation({
      header: { origin: 'subagent' },
      events: [event(0, 'subagent/descriptor', descriptor)],
    }, {
      ...policy,
      ephemeralOneShotSubagents: false,
    })

    expect(result).toEqual({
      kind: 'one-shot-subagent',
      ephemeral: false,
      name: '[DSH 后台] Compatibility worker',
      sectionName: 'DSH 子代理',
    })
  })
})
