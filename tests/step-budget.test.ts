import type { TurnStepResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import * as steps from '../hooks/acp/steps'

async function finish(stream: ReturnType<typeof steps.pump>): Promise<TurnStepResult> {
  for (;;) {
    const next = await stream.next()
    if (next.done) return next.value
  }
}

const settle = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}

test('a later step joins one retained producer read through bounded engine waits', async () => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let starts = 0
  const job: steps.Job = {
    turnId: 't1',
    count: 0,
    abort: new AbortController(),
    outputs: new Map(),
    held: [{ kind: 'call-start', id: 'one', input: { kind: 'execute', title: 'synthetic command' }, usage: null }],
    gen: (async function* () {
      starts += 1
      await pending
      yield { kind: 'text' as const, index: 0, text: 'finished after silence' }
      return { turnId: 't1', index: 1, answer: 'finished after silence', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })(),
  }
  const world: steps.Steps = { tool: 'mcp__plugin_via_step__step', spawns: new Map(), jobs: new Map([['fixture', job]]), calls: new Map() }
  const timers: { wake: () => void; cancelled: boolean }[] = []
  let waits = 0
  // Production registers this callback as an engine noun, pausing the current hook's
  // budget. A timer reply must join the same read, rather than advance the generator.
  const wait = () => {
    waits += 1
    return steps.waitStep(world, 'fixture', (wake) => {
      const timer = { wake, cancelled: false }
      timers.push(timer)
      return {
        cancel: () => {
          timer.cancelled = true
        },
      }
    })
  }
  const event = { turnId: 't1', index: 0, agentId: 'fixture' }
  expect((await finish(steps.pump(world, job, event, job.abort.signal, wait))).stopReason).toBe('tool_use')
  const answer = finish(steps.pump(world, job, { ...event, index: 1 }, job.abort.signal, wait))
  await settle()
  expect(waits).toBe(1)
  expect(starts).toBe(1)
  for (let i = 0; i < 3; i += 1) {
    timers[i]?.wake()
    await settle()
    expect(waits).toBe(i + 2)
    expect(starts).toBe(1)
    expect(timers[i]?.cancelled).toBe(true)
  }
  release()
  expect((await answer).answer).toBe('finished after silence')
  expect(starts).toBe(1)
  expect(timers.every((timer) => timer.cancelled)).toBe(true)
})

test('an aborted run ends its step instead of waiting again and again for a read that never settles', async () => {
  let starts = 0
  const job: steps.Job = {
    turnId: 't1',
    count: 0,
    abort: new AbortController(),
    outputs: new Map(),
    held: [],
    gen: (async function* () {
      starts += 1
      await new Promise<never>(() => {})
      yield { kind: 'text' as const, index: 0, text: 'never' }
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })(),
  }
  const newer: steps.Job = { ...job, turnId: 't2', abort: new AbortController(), gen: (async function* () {})() as steps.Job['gen'] }
  const world: steps.Steps = { tool: 'mcp__plugin_via_step__step', spawns: new Map(), jobs: new Map([['fixture', job]]), calls: new Map() }
  let waits = 0
  // An aborted job makes the engine wait return at once; the step must not loop on it.
  const wait = async () => {
    waits += 1
    if (waits > 3) throw new Error('waited again on an aborted run')
    // The engine's bounded timer: it fires once the old run is aborted, at once after that.
    await steps.waitStep(world, 'fixture', (wake) => {
      if (job.abort.signal.aborted) queueMicrotask(wake)
      else job.abort.signal.addEventListener('abort', wake, { once: true })
      return { cancel: () => {} }
    })
  }
  const stream = steps.pump(world, job, { turnId: 't1', index: 0, agentId: 'fixture' }, new AbortController().signal, wait)
  const first = stream.next()
  await settle()
  // A new turn replaces the job: the old step ends and leaves the newer job in place.
  steps.endJob(world, 'fixture')
  world.jobs.set('fixture', newer)
  const result = await first
  expect(result.done).toBe(true)
  expect((result.value as TurnStepResult).stopReason).toBe('end_turn')
  expect(waits).toBeLessThanOrEqual(2)
  expect(starts).toBe(1)
  expect(world.jobs.get('fixture')).toBe(newer)
})

test('a tool call joins the read an earlier step left pending, in order', async () => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const job: steps.Job = {
    turnId: 't1',
    count: 0,
    abort: new AbortController(),
    outputs: new Map(),
    held: [],
    gen: (async function* () {
      await pending
      yield { kind: 'call-end' as const, id: 'one', output: 'first', failed: false }
      yield { kind: 'call-end' as const, id: 'one', output: 'second', failed: false }
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })(),
  }
  const world: steps.Steps = {
    tool: 'mcp__plugin_via_step__step',
    spawns: new Map(),
    jobs: new Map([['fixture', job]]),
    calls: new Map([['toolu_one', { agentId: 'fixture', id: 'one' }]]),
  }
  // A step's bounded wait ends while the producer read is still pending: the read is retained.
  await steps.waitStep(world, 'fixture', (wake) => {
    queueMicrotask(wake)
    return { cancel: () => {} }
  })
  const answer = steps.answerCall(world, 'toolu_one', new AbortController().signal)
  await settle()
  release()
  expect(await answer).toEqual({ result: 'first' })
})
