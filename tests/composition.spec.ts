import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, CODEX_APP_SERVER_PROVIDER, Config, inject, name } from '../src/index.ts'

/** Boot the plugin through the real cordis plugin entry point with every
 * declared injected service provided as a stub. */
async function bootContext(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const registered: Array<{ routes: string[]; adapter: unknown }> = []
  ctx.provide('llm', {
    registerAdapter: (routes: string[], adapter: unknown) => {
      registered.push({ routes, adapter })
    },
  })
  ctx.provide('subprocess', {})
  ctx.provide('sessions', {})
  ctx.provide('sessionPersistence', { list: async () => [], inspect: async () => { throw new Error('unexpected inspect') } })
  ctx.provide('attachments', {})
  ctx.provide('agents', { get: () => undefined })
  ctx.provide('userQuestions', { ask: () => { throw new Error('unexpected ask during composition test') } })
  const fiber = ctx.plugin({ name, inject, Config, apply }, { registryPath: ':memory:', ...config })
  await fiber
  return { ctx, registered, fiber }
}

describe('codex-plugin-dsh Loader entry form', () => {
  it('exports the function-plugin contract without a default export', async () => {
    const mod = await import('../src/index.ts')
    expect(typeof mod.apply).toBe('function')
    expect(mod.name).toBe('codex-plugin-dsh')
    expect(mod.inject).toEqual(['llm', 'subprocess', 'sessions', 'sessionPersistence', 'attachments', 'agents', 'userQuestions'])
    expect(mod.Config).toBeDefined()
    expect('default' in mod).toBe(false)
  })

  it('boots through a real cordis context and registers the adapter route', async () => {
    const { fiber, registered } = await bootContext()
    try {
      expect(registered).toHaveLength(1)
      expect(registered[0]!.routes).toContain(CODEX_APP_SERVER_PROVIDER)
      expect(registered[0]!.adapter).toBeDefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('materializes the long-turn and gpt-5.6-sol context defaults before registration', async () => {
    const { fiber, registered } = await bootContext()
    try {
      const adapter = registered[0]!.adapter as {
        readonly config: {
          readonly turnTimeoutMs: number
          readonly modelContextWindows: Record<string, number>
          readonly ephemeralOneShotSubagents: boolean
          readonly syncThreadNames: boolean
          readonly subagentSectionName: string
        }
      }
      expect(adapter.config.turnTimeoutMs).toBe(60 * 60_000)
      expect(adapter.config.modelContextWindows['gpt-5.6-sol']).toBe(1_048_576)
      expect(adapter.config.ephemeralOneShotSubagents).toBe(true)
      expect(adapter.config.syncThreadNames).toBe(true)
      expect(adapter.config.subagentSectionName).toBe('DSH 子代理')
    } finally {
      await fiber.dispose()
    }
  })

  it('routes the authoritative session disposal event to adapter cleanup', async () => {
    const { ctx, fiber, registered } = await bootContext()
    try {
      const adapter = registered[0]!.adapter as { disposeSession(sessionId: string): Promise<void> }
      const disposeSession = vi.spyOn(adapter, 'disposeSession').mockResolvedValue()

      await ctx.emit('session/disposed', { id: 'session-1' } as never)

      expect(disposeSession).toHaveBeenCalledWith('session-1')
    } finally {
      await fiber.dispose()
    }
  })

  it('disposes registered effects cleanly on plugin unload', async () => {
    const { fiber } = await bootContext()
    await expect(fiber.dispose()).resolves.toBeUndefined()
  })

  it('fails loudly on configuration that violates boundary validation', async () => {
    const ctx = new Context()
    ctx.provide('llm', { registerAdapter: () => undefined })
    ctx.provide('subprocess', {})
    ctx.provide('sessions', {})
    ctx.provide('sessionPersistence', { list: async () => [], inspect: async () => { throw new Error('unexpected inspect') } })
    ctx.provide('attachments', {})
    ctx.provide('agents', {})
    ctx.provide('userQuestions', {})
    const fiber = ctx.plugin({ name, inject, Config, apply }, { turnTimeoutMs: 0 })
    await expect(fiber).rejects.toThrow(/turnTimeoutMs/)
    await fiber.dispose()
  })
})
