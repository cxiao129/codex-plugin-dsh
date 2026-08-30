import { describe, expect, it } from 'vitest'
import { decideThreadContinuation } from '../src/thread-state.ts'

describe('Codex thread continuation state machine', () => {
  it('resumes only an exact completed checkpoint head', () => {
    expect(decideThreadContinuation('turn-2', {
      threadId: 'thread-1',
      headTurnId: 'turn-2',
      headTurnStatus: 'completed',
    })).toBe('resume')
  })

  it.each([
    ['different completed head', 'turn-3', 'completed'],
    ['failed checkpoint head', 'turn-2', 'failed'],
    ['interrupted checkpoint head', 'turn-2', 'interrupted'],
    ['running checkpoint head', 'turn-2', 'inProgress'],
    ['empty thread', undefined, undefined],
  ])('forks for %s', (_label, headTurnId, headTurnStatus) => {
    expect(decideThreadContinuation('turn-2', {
      threadId: 'thread-1',
      ...(headTurnId === undefined ? {} : { headTurnId }),
      ...(headTurnStatus === undefined ? {} : { headTurnStatus }),
    })).toBe('fork')
  })
})
