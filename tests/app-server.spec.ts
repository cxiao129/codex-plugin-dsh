import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerConnection } from '../src/app-server.ts'

function fakeChild(): {
  readonly child: SubprocessHandle
  readonly stdin: PassThrough
  readonly stdout: PassThrough
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const outcome = Promise.withResolvers<SubprocessOutcome>()
  let terminated = false
  const child: SubprocessHandle = {
    pid: 123,
    stdin,
    stdout,
    stderr: undefined,
    collected: {},
    done: outcome.promise,
    terminate: () => {
      if (terminated) return
      terminated = true
      outcome.resolve({ exitCode: null, signal: 'SIGTERM' })
    },
    waitForExit: async () => true,
  }
  return { child, stdin, stdout }
}

function startTransport(connection: CodexAppServerConnection): void {
  const internal = connection as unknown as {
    readonly transport: { start(): void }
  }
  internal.transport.start()
}

describe('CodexAppServerConnection teardown', () => {
  it('contains a late JSON-RPC response after child stdin has ended', async () => {
    const { child, stdout } = fakeChild()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<unknown>()
    const failure = vi.fn()
    const connection = new CodexAppServerConnection(
      child,
      async () => {
        entered.resolve()
        return release.promise
      },
      { notification: vi.fn(), failure },
    )
    startTransport(connection)

    stdout.write('{"jsonrpc":"2.0","id":1,"method":"item/tool/requestUserInput","params":{}}\n')
    await entered.promise
    await connection.close()

    release.reject(new Error('question cancelled during teardown'))
    await new Promise(resolve => setImmediate(resolve))

    expect(failure).not.toHaveBeenCalled()
  })

  it('bounds process-tree quiescence when a subprocess provider cannot confirm exit', async () => {
    const { child } = fakeChild()
    const waitForExit = vi.fn(async () => false)
    const connection = new CodexAppServerConnection(
      { ...child, waitForExit } as SubprocessHandle,
      async () => ({}),
      { notification: vi.fn(), failure: vi.fn() },
      1,
    )

    await connection.close()

    expect(waitForExit).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('reports a child stdin failure while the connection is live', async () => {
    const { child, stdin } = fakeChild()
    const failure = vi.fn()
    const connection = new CodexAppServerConnection(
      child,
      async () => ({}),
      { notification: vi.fn(), failure },
    )

    const error = new Error('stdin failed')
    stdin.emit('error', error)

    expect(failure).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledWith(error)
    await connection.close()
  })
})
