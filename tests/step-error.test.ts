import { expect, mock, test } from 'claude-code/testing'
import { bottom, run } from './helpers'

for (const unavailable of [false, true])
  test(`a step failure records its message and surfaced stack without exposing them in the answer (sinks unavailable: ${unavailable})`, async ($, on) => {
    mock.clock(on)
    bottom(on)
    const original = new Error('synthetic step failure')
    on('session.messages', () => {
      throw original
    })
    const logs: string[] = []
    const saved: unknown[] = []
    on('ui.log', (_, e) => {
      logs.push(JSON.stringify(e))
      if (unavailable) throw new Error('synthetic log unavailable')
      return { value: undefined }
    })
    on('state.set', (_, e, next) => {
      if (e.key !== 'stepErrors') return next(e)
      saved.push(e.value)
      if (unavailable) throw new Error('synthetic state unavailable')
      return next(e)
    })
    await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'synthetic task' })
    const { result } = await run($)
    expect(result.answer).toBe('The pi failed: via could not render its next step.')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('session.messages')
    expect(saved).toHaveLength(1)
    const diagnostic = saved[0] as { kind: string; message: string; stack: string; stackOrigin: string; turnId: string; index: number }
    expect(diagnostic.kind).toBe('throw')
    expect(diagnostic.message).toContain('session.messages')
    expect(diagnostic.stack).toContain(diagnostic.message)
    expect(diagnostic.stackOrigin).toBe('throw')
    expect(diagnostic.turnId).toBe('t1')
    expect(diagnostic.index).toBe(0)
  })
