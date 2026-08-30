/** Pure continuation policy for one durable Codex App Server checkpoint. */

/** Minimal chronological thread state returned by thread/read. */
export interface CodexThreadSnapshot {
  readonly threadId: string
  readonly headTurnId?: string
  readonly headTurnStatus?: string
}

/** Safe action for a same-session, same-tool-signature checkpoint. */
export type CodexThreadContinuation = 'resume' | 'fork'

/**
 * Reuse a persistent thread only when the DSH checkpoint is exactly its completed
 * head. Any additional, failed, interrupted, or unknown head is a real divergence
 * and must fork from the last DSH-committed turn.
 */
export function decideThreadContinuation(
  checkpointTurnId: string,
  snapshot: CodexThreadSnapshot,
): CodexThreadContinuation {
  return snapshot.headTurnId === checkpointTurnId && snapshot.headTurnStatus === 'completed'
    ? 'resume'
    : 'fork'
}
