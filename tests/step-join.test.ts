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

test('a later step joins one retained producer read through bounded waits, advancing the producer once', async () => {
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
  const world: steps.Steps = {
    tool: 'mcp__plugin_via_step__step',
    spawns: new Map(),
    jobs: new Map([['fixture', job]]),
    calls: new Map(),
    handed: new Map(),
  }
  const timers: { wake: () => void; cancelled: boolean }[] = []
  let waits = 0
  // Production registers this as an engine noun: each bounded wait is one timer, and returns when it fires.
  const wait = () => {
    waits += 1
    return steps.waitStep(world, 'fixture', 't1', (wake) => {
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

test('an aborted run ends its step instead of waiting again for a read that never settles', async () => {
  const job: steps.Job = {
    turnId: 't1',
    count: 0,
    abort: new AbortController(),
    outputs: new Map(),
    held: [],
    gen: (async function* () {
      await new Promise<never>(() => {})
      yield { kind: 'text' as const, index: 0, text: 'never' }
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })(),
  }
  const world: steps.Steps = {
    tool: 'mcp__plugin_via_step__step',
    spawns: new Map(),
    jobs: new Map([['fixture', job]]),
    calls: new Map(),
    handed: new Map(),
  }
  let waits = 0
  const wait = () => {
    waits += 1
    if (waits > 3) throw new Error('waited again on an aborted run')
    return steps.waitStep(world, 'fixture', 't1', (wake) => {
      if (job.abort.signal.aborted) void Promise.resolve().then(wake)
      else job.abort.signal.addEventListener('abort', wake, { once: true })
      return { cancel: () => {} }
    })
  }
  const first = finish(steps.pump(world, job, { turnId: 't1', index: 0, agentId: 'fixture' }, new AbortController().signal, wait))
  await settle()
  steps.endJob(world, 'fixture')
  const result = await first
  expect(result.stopReason).toBe('end_turn')
  expect(waits).toBeLessThanOrEqual(2)
})

test('a replaced run is never read by the step that held the old one', async () => {
  let newerReads = 0
  const job: steps.Job = {
    turnId: 't1',
    count: 0,
    abort: new AbortController(),
    outputs: new Map(),
    held: [],
    gen: (async function* () {
      await new Promise<never>(() => {})
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })(),
  }
  const newer: steps.Job = {
    turnId: 't2',
    count: 0,
    abort: new AbortController(),
    outputs: new Map(),
    held: [],
    gen: (async function* () {
      newerReads += 1
      yield* []
      return { turnId: 't2', index: 0, answer: 'new turn', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })(),
  }
  const world: steps.Steps = {
    tool: 'mcp__plugin_via_step__step',
    spawns: new Map(),
    jobs: new Map([['fixture', job]]),
    calls: new Map(),
    handed: new Map(),
  }
  const old = finish(
    steps.pump(world, job, { turnId: 't1', index: 0, agentId: 'fixture' }, new AbortController().signal, () =>
      steps.waitStep(world, 'fixture', 't1', (wake) => {
        void Promise.resolve().then(wake)
        return { cancel: () => {} }
      }),
    ),
  )
  await settle()
  steps.endJob(world, 'fixture')
  world.jobs.set('fixture', newer)
  expect((await old).stopReason).toBe('end_turn')
  // The new turn's wait for its own turn reads only its own run.
  expect(world.jobs.get('fixture')).toBe(newer)
  expect(newerReads).toBe(0)
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
    handed: new Map(),
  }
  await steps.waitStep(world, 'fixture', 't1', (wake) => {
    void Promise.resolve().then(wake)
    return { cancel: () => {} }
  })
  const answer = steps.answerCall(world, 'toolu_one', new AbortController().signal, (agentId, turnId) =>
    steps.waitStep(world, agentId, turnId, (wake) => {
      void Promise.resolve().then(wake)
      return { cancel: () => {} }
    }),
  )
  await settle()
  release()
  expect(await answer).toEqual({ result: 'first' })
})

test('a read that threw ends its step with an explicit answer, and is not kept', async () => {
  const job: steps.Job = {
    turnId: 't1',
    count: 0,
    abort: new AbortController(),
    outputs: new Map(),
    held: [],
    gen: (async function* () {
      yield* []
      throw new Error('producer failed')
    })(),
  }
  const world: steps.Steps = {
    tool: 'mcp__plugin_via_step__step',
    spawns: new Map(),
    jobs: new Map([['fixture', job]]),
    calls: new Map(),
    handed: new Map(),
  }
  const event = { turnId: 't1', index: 0, agentId: 'fixture' }
  const never = () => new Promise<void>(() => {})
  // A failed producer ends the step with an explicit answer, not a hook error.
  const first = await finish(steps.pump(world, job, event, new AbortController().signal, never))
  expect(first.stopReason).toBe('end_turn')
  expect(first.answer).toContain('could not be followed')
  const second = await finish(steps.pump(world, job, { ...event, index: 1 }, new AbortController().signal, never))
  expect(second.stopReason).toBe('end_turn')
})

// A harness command that runs past the hook's ten-second budget (a lint then a typecheck in one call) must be
// followed through the engine's bounded wait, not one unbounded read inside the tool.call hook.
test('a tool call waits on a silent harness through the bounded wait, and a failed wait answers it', async () => {
  const job: steps.Job = {
    turnId: 't1',
    count: 0,
    abort: new AbortController(),
    outputs: new Map(),
    held: [],
    gen: (async function* () {
      await new Promise<never>(() => {})
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })(),
  }
  const world: steps.Steps = {
    tool: 'mcp__plugin_via_step__step',
    spawns: new Map(),
    jobs: new Map([['fixture', job]]),
    calls: new Map([['toolu_one', { agentId: 'fixture', id: 'one' }]]),
    handed: new Map(),
  }
  let waits = 0
  const wait = () => {
    waits += 1
    return waits < 3 ? Promise.resolve() : Promise.reject(new Error('engine wait failed'))
  }
  const answer = await steps.answerCall(world, 'toolu_one', new AbortController().signal, wait)
  expect(waits).toBe(3)
  expect(answer).toEqual({ result: 'The harness run could not be followed: its producer or its wait failed.' })
  expect(job.abort.signal.aborted).toBe(true)
})

test('a tool call still running at the hold ends its step and waits on in the next, before what the run said meanwhile', async () => {
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
      yield { kind: 'text' as const, index: 0, text: 'meanwhile' }
      await pending
      yield { kind: 'call-end' as const, id: 'one', output: 'suite passed', failed: false }
      return { turnId: 't1', index: 0, answer: 'done', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })(),
  }
  const world: steps.Steps = {
    tool: 'mcp__plugin_via_step__step',
    spawns: new Map(),
    jobs: new Map([['fixture', job]]),
    calls: new Map([['toolu_one', { agentId: 'fixture', id: 'one', input: { kind: 'execute', title: 'pytest' } }]]),
    handed: new Map(),
  }
  let clock = 0
  const now = () => clock
  const wait = () => {
    clock += 60_000
    return Promise.resolve()
  }
  const first = await steps.answerCall(world, 'toolu_one', new AbortController().signal, wait, now)
  expect(first).toEqual({ result: 'The harness tool is still running after 15 minutes; waiting on in the next step.' })
  expect(clock).toBe(steps.CALL_HOLD_MS)
  expect(job.abort.signal.aborted).toBe(false)
  expect(world.calls.has('toolu_one')).toBe(false)
  expect(job.held).toEqual([
    { kind: 'call-start', id: 'one', input: { kind: 'wait', title: 'Waiting for pytest' }, usage: null },
    { kind: 'text', index: 0, text: 'meanwhile' },
  ])
  const event = { turnId: 't1', index: 1, agentId: 'fixture' }
  const next = await finish(steps.pump(world, job, event, new AbortController().signal, wait))
  expect(next.stopReason).toBe('tool_use')
  expect(next.toolUses).toEqual([{ name: world.tool, input: { kind: 'wait', title: 'Waiting for pytest' } }])
  const [again] = [...world.calls.keys()]
  release()
  expect(await steps.answerCall(world, again, new AbortController().signal, wait, now)).toEqual({ result: 'suite passed' })
  expect(job.held).toEqual([{ kind: 'text', index: 0, text: 'meanwhile' }])
})
