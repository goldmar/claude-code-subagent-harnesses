import type { TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { answerCall, CHILD_CALL, pump, waitStep } from '../hooks/acp/steps'
import { pi } from '../hooks/adapters/pi'
import { turnStep } from '../hooks/turn'
import type { World } from '../hooks/world'
import {
  arrange,
  bottom,
  ENV,
  expectPiSpawn,
  hang,
  lines,
  NODE,
  node,
  ROOT,
  requestOf,
  run,
  type Spawn,
  STEP,
  split,
  storage,
} from './helpers'

test('a pi run past the default 30 minutes is stopped with its partial answer, unsigned', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  hang(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  await clock.advance(30 * 60 * 1000)
  const { chunks, result } = await pending
  expectPiSpawn(spawns[0], ROOT)
  expect(spawns[0]?.input).toBe('go')
  expect(result.answer).toContain('half an answer')
  expect(result.answer).toContain('pi ran past 30 minutes and was stopped.')
  expect(result.answer).not.toContain('answered by pi')
  expect(result.usage).toEqual({
    model: 'openrouter/kimi',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  expect(chunks.some((chunk) => chunk.kind === 'text' && chunk.text.includes('pi ran past 30 minutes and was stopped.'))).toBe(true)
})

test('a timeoutMinutes setting stops a silent pi at its own limit', { options: { timeoutMinutes: 5 } }, async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  hang(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  let finished = false
  const pending = run($).then((outcome) => {
    finished = true
    return outcome
  })
  await clock.settle()
  await clock.advance(4 * 60 * 1000)
  expect(finished).toBe(false)
  expect(spawns).toHaveLength(1)
  await clock.advance(60 * 1000)
  const { result } = await pending
  expect(result.answer).toContain('half an answer')
  expect(result.answer).toContain('pi ran past 5 minutes and was stopped.')
  expect(result.answer).not.toContain('answered by pi')
})

test('a pi that finishes before the limit is unaffected', { options: { timeoutMinutes: 1 } }, async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  await clock.advance(60 * 60 * 1000)
  expect(result.answer.endsWith('all done\n\n— answered by pi, openrouter/kimi')).toBe(true)
  expect(result.answer).not.toContain('pi ran past')
})

test('a pi agent streams pi, names its model and reports pi usage even when pieces split lines', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-model: openrouter/kimi\nlist files' })
  const { chunks, result } = await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi'])
  expect(spawns[0]?.input).toBe('list files')
  expect(result.answer.endsWith('all done\n\n— answered by pi, openrouter/kimi')).toBe(true)
  expect(chunks.at(-1)).toEqual({
    kind: 'stop',
    stopReason: 'end_turn',
    usage: { model: 'openrouter/kimi', input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
  })
})

test(
  'a defaultModel setting supplies --model when the prompt has no pi-model line',
  { options: { defaultModel: 'openrouter/kimi' } },
  async ($, on) => {
    const spawns: Spawn[] = []
    arrange(on, spawns, split(lines))
    await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
    await run($)
    expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi'])
    expect(spawns[0]?.input).toBe('go')
  },
)

test('a pi-model line overrides the defaultModel setting', { options: { defaultModel: 'openrouter/kimi' } }, async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'pi-model: other/x\ngo' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'other/x'])
  expect(spawns[0]?.input).toBe('go')
})

test('an empty defaultModel setting passes no --model', { options: { defaultModel: '' } }, async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await run($)
  expectPiSpawn(spawns[0], ROOT)
  expect(spawns[0]?.input).toBe('go')
})

test('an invalid defaultModel setting answers without spawning pi', { options: { defaultModel: 'a b' } }, async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(spawns).toEqual([])
  expect(result.answer).toBe('The via plugin\'s defaultModel setting "a b" is not a pi --model pattern.')
})

test('a choice stored before a reload still applies to a follow-up', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  on('state.get', () => ({ value: { value: { model: 'openrouter/kimi', tools: 'read', thinking: 'high' }, version: 1 } }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await run($)
  expectPiSpawn(spawns[0], ROOT, ['--model', 'openrouter/kimi', '--tools', 'read', '-na', '--thinking', 'high'])
  expect(spawns[0]?.input).toBe('go')
})

test('a pi agent whose first turn carries no text runs the spawn prompt', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await $.agent.spawn({
    tool_use_id: 'toolu_pi_spawn',
    subagentType: 'via:pi',
    prompt: 'from the spawn',
    description: 'd',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    background: true,
    fork: false,
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  await run($)
  expect(spawns[0]?.input).toBe('from the spawn')
})

test('a spawn teaches the harness before agent.list catches up', async ($, on) => {
  const spawns: Spawn[] = []
  const files = storage(on)
  mock.env(on, { TMPDIR: '/tmp', HOME: '/home/u' })
  on('agent.list', () => ({ value: [] }))
  node(on)
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  on('process.spawn', async function* (_, e) {
    spawns.push(requestOf(e))
    yield* split(lines)
    return { value: { code: 0, signal: null } }
  })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await $.agent.spawn({
    tool_use_id: 'toolu_pi_spawn',
    subagentType: 'via:pi',
    prompt: 'from the spawn',
    description: 'd',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    background: true,
    fork: false,
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const { result } = await run($)
  expect(spawns[0]?.input).toBe('from the spawn')
  expect(result.answer.endsWith('— answered by pi, openrouter/kimi')).toBe(true)
})

test('a pi agent hands its report back through SubagentHandback when the session asks for it', async ($, on) => {
  arrange(on, [], split(lines), 0, [{ role: 'user', text: 'report via SubagentHandback', toolUses: [] }])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.stopReason).toBe('tool_use')
  expect(result.toolUses[0]?.name).toBe('SubagentHandback')
  // A later step, as after a compaction, repeats the report as text: Claude Code takes the last text as the result.
  const again = await run($)
  expect(again.result.answer).toBe(result.answer)
  expect(again.result.toolUses).toEqual([])
})

async function spawnPi(
  $: Parameters<typeof run>[0],
  permissionMode: string,
  fork = false,
  agent: { isTeammate?: true; workflow?: { runId: string; agentIndex: number } } = {},
) {
  await $.agent.spawn({
    tool_use_id: 'toolu_pi_spawn',
    subagentType: 'via:pi',
    prompt: 'go',
    description: 'd',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    permissionMode,
    background: true,
    fork,
    ...agent,
  })
}

test('an auto-mode spawned agent hands back on its first step even without a session reminder', async ($, on) => {
  const persisted: unknown[] = []
  arrange(on, [], split(lines))
  on('state.set', (_, e, next) => {
    persisted.push({ key: e.key, id: e.id, value: e.value })
    return next(e)
  })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawnPi($, 'auto')
  expect(persisted).toContainEqual({ key: 'handbacks', id: 'a1', value: true })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.stopReason).toBe('tool_use')
  expect(result.toolUses[0]?.name).toBe('SubagentHandback')
})

test('a default-mode spawned agent answers in plain text', async ($, on) => {
  arrange(on, [], split(lines))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawnPi($, 'default')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.stopReason).toBe('end_turn')
  expect(result.toolUses).toEqual([])
  expect(result.answer.endsWith('— answered by pi, openrouter/kimi')).toBe(true)
})

test('a fork in auto mode answers in plain text', async ($, on) => {
  arrange(on, [], split(lines))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawnPi($, 'auto', true)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.stopReason).toBe('end_turn')
  expect(result.toolUses).toEqual([])
  expect(result.answer.endsWith('— answered by pi, openrouter/kimi')).toBe(true)
})

test('a fresh world hands back from the persisted decision alone', async ($, on) => {
  arrange(on, [], split(lines))
  // Nothing in this world's map and no session reminder: only what a reload kept.
  on('state.get', (_, e, next) => (e.key === 'handbacks' ? { value: { value: true, version: 1 } } : next(e)))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.stopReason).toBe('tool_use')
  expect(result.toolUses[0]?.name).toBe('SubagentHandback')
})

test('a step that never saw turn.start answers with the last signed report, not the stub', async ($, on) => {
  arrange(on, [], split(lines))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const first = await run($)
  const again = await run($, { ...STEP, turnId: 't2' })
  expect(again.result.answer).toBe(first.result.answer)
  expect(again.result.answer).not.toContain('did not run this task')
})

test('a step with no turn after a handback repeats the report as text, never a second handback', async ($, on) => {
  arrange(on, [], split(lines))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawnPi($, 'auto')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const first = await run($)
  expect(first.result.toolUses[0]?.name).toBe('SubagentHandback')
  const again = await run($, { ...STEP, turnId: 't2' })
  expect(again.result.toolUses).toEqual([])
  expect(again.result.answer).toBe(first.result.answer)
})

test('a step with no turn hands back a saved report that was never delivered', async ($, on) => {
  const sets: unknown[] = []
  arrange(on, [], split(lines))
  const kept: Record<string, unknown> = { handbacks: true, reports: 'the report', handedBack: false }
  on('state.get', (_, e, next) => (e.key in kept ? { value: { value: kept[e.key], version: 1 } } : next(e)))
  on('state.set', (_, e, next) => {
    sets.push({ key: e.key, value: e.value })
    if (e.key in kept) kept[e.key] = e.value
    return next(e)
  })
  const first = await run($, { ...STEP, turnId: 't2' })
  expect(first.result.toolUses[0]).toEqual({ name: 'SubagentHandback', input: { message: 'the report' } })
  expect(sets).toContainEqual({ key: 'handedBack', value: true })
  const again = await run($, { ...STEP, turnId: 't3' })
  expect(again.result.answer).toBe('the report')
  expect(again.result.toolUses).toEqual([])
})

// Captured 2026-10-28: /background right after a via:opencode spawn. The new process resumed the agent
// with no turn.start, and via answered "check the plugin is loaded" while loaded (third-cut session 858bcc0d).
test('a step with no turn and no saved report says the run was cut off, not that via is missing', async ($, on) => {
  arrange(on, [], split(lines))
  const { result } = await run($, { ...STEP, turnId: 't3' })
  expect(result.answer).toContain('pi run was cut off before it answered')
  expect(result.answer).not.toContain('did not run this task')
})

test('a spawn keeps its harness in the store, and parallel spawns keep each other', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('agent.spawn', (_, e) => ({ model: 'haiku', agentId: e.prompt === 'two' ? 'a2' : 'a1' }))
  const spawn = (prompt: string) =>
    $.agent.spawn({
      tool_use_id: `toolu_${prompt}`,
      subagentType: 'via:pi',
      prompt,
      description: 'd',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'haiku',
      background: true,
      fork: false,
    })
  await Promise.all([spawn('one'), spawn('two')])
  expect(store.get('agents')).toEqual({ a1: { harness: 'pi', handback: false }, a2: { harness: 'pi', handback: false } })
})

// Seen 2026-10-28 after /background: the new process saw no spawn and resumed the agent as general-purpose.
test("a step from an agent the old process spawned is still via's, not passed to Claude", async ($, on) => {
  mock.env(on, ENV)
  node(on)
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'general-purpose', status: 'running' }] }))
  on('store.get', (_, e) => ({ value: e.key === 'agents' ? { a1: { harness: 'pi', handback: true } } : undefined }))
  on('session.messages', () => ({ value: [] }))
  let passed = false
  // biome-ignore lint/correctness/useYield: a streaming hook must be an async generator, even one that answers at once
  on('turn.step', async function* (_, e) {
    passed = true
    return { turnId: e.turnId, index: e.index, answer: 'from Claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const { result } = await run($)
  expect(passed).toBe(false)
  // An auto-mode spawn's handback holds in the new process too, or Claude Code asks for it three times.
  expect(result.toolUses[0]?.name).toBe('SubagentHandback')
  expect(JSON.stringify(result.toolUses[0]?.input)).toContain('pi run was cut off before it answered')
  // The step after the handback's tool result has no turn either.
  const after = await run($, { ...STEP, index: 1 })
  expect(after.result.toolUses).toEqual([])
  expect(after.result.answer).toContain('pi run was cut off before it answered')
})

async function drain(stream: AsyncGenerator<TurnStepChunk, TurnStepResult>): Promise<{ chunks: TurnStepChunk[]; result: TurnStepResult }> {
  const chunks: TurnStepChunk[] = []
  for (;;) {
    const next = await stream.next()
    if (next.done) return { chunks, result: next.value }
    chunks.push(next.value)
  }
}

function fakeWorld(): World {
  const world: World = {
    adapters: new Map([['pi', pi]]),
    defaultModel: '',
    codexAcp: 'pinned',
    installs: new Map(),
    timeoutMinutes: 30,
    turns: new Map(),
    seeds: new Map(),
    handbacks: new Map(),
    modes: new Map(),
    agents: new Map([['a1', pi]]),
    others: new Set(),
    inboxes: new Map(),
    descriptions: new Map(),
    activity: new Map(),
    channels: new Map(),
    nested: new Map(),
    spawns: new Map(),
    tool: 'mcp__plugin_via_step__step',
    jobs: new Map(),
    calls: new Map(),
  }
  return world
}

test('an aborted follow-up leaves no report for a step with no turn to repeat', async () => {
  const world = fakeWorld()
  const state = new Map<string, unknown>()
  const stop = new AbortController()
  let started!: () => void
  const spawned = new Promise<void>((resolve) => {
    started = resolve
  })
  let runs = 0
  const $ = {
    env: { get: async (name: string) => (name === 'HOME' ? ENV.HOME : undefined) },
    fs: { write: async () => undefined },
    clock: { after: () => ({ cancel: () => {} }) },
    viaSteps: { wait: ({ agentId }: { agentId: string }) => waitStep(world, agentId, () => ({ cancel: () => {} })) },
    process: {
      run: async () => NODE,
      spawn: () => {
        runs += 1
        const child = (async function* () {
          if (runs === 1) {
            yield { stream: 'stdout' as const, text: lines }
            return
          }
          started()
          await new Promise<void>((resolve) => {
            if (stop.signal.aborted) resolve()
            else stop.signal.addEventListener('abort', () => resolve(), { once: true })
          })
        })()
        return Object.assign(child, { result: Promise.resolve({ code: 0, signal: null }) })
      },
    },
    plugin: { root: '/' },
    session: { messages: async () => [] },
    store: { get: async () => undefined, set: async () => {} },
    state: {
      get: async (ref: { key: string; id: string }) => ({ value: state.get(`${ref.key}:${ref.id}`), version: 1 }),
      set: async (ref: { key: string; id: string }, value: unknown) => {
        state.set(`${ref.key}:${ref.id}`, value)
        return { value: true, version: 1 }
      },
    },
  } as unknown as Parameters<typeof turnStep>[1]
  const next = { signal: stop.signal } as Parameters<typeof turnStep>[3]
  const e = { ...STEP, agentId: 'a1' }

  world.turns.set('t1', { prompt: 'go', delivered: false })
  const first = await drain(turnStep(world, $, { ...e, turnId: 't1' }, next))
  expect(first.result.answer).toContain('all done')
  expect(state.get('reports:a1')).toBe(first.result.answer)

  world.turns.set('t2', { prompt: 'go', delivered: false })
  const pending = drain(turnStep(world, $, { ...e, turnId: 't2' }, next))
  await spawned
  stop.abort()
  const second = await pending
  expect(second.result.answer).toBe('')
  expect(state.get('reports:a1')).toBe('')

  const third = await drain(turnStep(world, $, { ...e, turnId: 't3' }, next))
  expect(third.result.answer).toContain('was cut off before it answered')
  expect(third.result.answer).not.toContain('all done')
})

test("a second turn's run clears the first turn's report before spawning", async ($, on) => {
  const order: string[] = []
  bottom(on)
  on('session.messages', () => ({ value: [] }))
  on('state.set', (_, e, next) => {
    order.push(`set:${e.key}=${String(e.value)}`)
    return next(e)
  })
  on('process.spawn', async function* () {
    order.push('spawn')
    yield* split(lines)
    return { value: { code: 0, signal: null } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await run($)
  expect(order.at(-2)).toContain('all done')
  order.length = 0
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'go' })
  await run($, { ...STEP, turnId: 't2' })
  expect(order.slice(0, 3)).toEqual(['set:reports=', 'set:handedBack=false', 'spawn'])
})

test('an auto-mode teammate answers in plain text', async ($, on) => {
  arrange(on, [], split(lines))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawnPi($, 'auto', false, { isTeammate: true })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.stopReason).toBe('end_turn')
  expect(result.toolUses).toEqual([])
})

test('an auto-mode workflow agent answers in plain text', async ($, on) => {
  arrange(on, [], split(lines))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await spawnPi($, 'auto', false, { workflow: { runId: 'wf_1', agentIndex: 0 } })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.stopReason).toBe('end_turn')
  expect(result.toolUses).toEqual([])
})

test('a pi that is missing answers in text, never as a Claude model', async ($, on) => {
  bottom(on)
  on('session.messages', () => ({ value: [] }))
  // biome-ignore lint/correctness/useYield: a streaming hook must be an async generator, even one that answers at once
  on('process.spawn', async function* () {
    throw new Error('spawn pi ENOENT')
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toContain('pi could not run')
})

test('a model call pi reports as failed is named in the answer', async ($, on) => {
  const failed = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '402: more credits needed', usage: {} } },
  ]
  arrange(on, [], [{ stream: 'stdout', text: `${failed.map((e) => JSON.stringify(e)).join('\n')}\n` }])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toContain("pi's model call failed: 402: more credits needed")
})

test('a retry that recovers does not read as a failed model call', async ($, on) => {
  const recovered = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '429 retry', usage: {} } },
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'recovered' } },
    { type: 'message_end', message: { role: 'assistant', usage: {} } },
  ]
  arrange(on, [], [{ stream: 'stdout', text: `${recovered.map((e) => JSON.stringify(e)).join('\n')}\n` }])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toContain('recovered')
  expect(result.answer).not.toContain('model call failed')
})

test('a pi that exits non-zero reports its stderr', async ($, on) => {
  arrange(on, [], [{ stream: 'stderr', text: '\u001b[31mno key\u001b[0m' }], 1)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toContain('pi exited with 1.\nno key')
})

test('only the last assistant message is the answer', async ($, on) => {
  const two = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'first' } },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1 } } },
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi-2' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'second' } },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 2, output: 2 } } },
  ]
  arrange(on, [], [{ stream: 'stdout', text: `${two.map((e) => JSON.stringify(e)).join('\n')}\n` }])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toBe('second\n\n— answered by pi, openrouter/kimi-2')
  expect(result.answer).not.toContain('first')
  // The last model call alone: 2 in, 2 out, not the run's 3 and 3.
  expect(result.usage).toEqual({
    model: 'openrouter/kimi-2',
    input_tokens: 2,
    output_tokens: 2,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
})

test('two usage events report only the last model call', async ($, on) => {
  const two = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'first' } },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } } },
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'second' } },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } },
  ]
  arrange(on, [], [{ stream: 'stdout', text: `${two.map((e) => JSON.stringify(e)).join('\n')}\n` }])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.usage).toEqual({
    model: 'openrouter/kimi',
    input_tokens: 1,
    output_tokens: 2,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4,
  })
})

test('a choice line is stored under via.agents', async ($, on) => {
  const spawns: Spawn[] = []
  const refs: unknown[] = []
  arrange(on, spawns, split(lines))
  on('state.set', (_, e, next) => {
    refs.push({ plugin: e.plugin, key: e.key, id: e.id })
    return next(e)
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: openrouter/kimi\ngo' })
  await run($)
  expect(refs).toEqual([
    { plugin: 'via', key: 'agents', id: 'a1' },
    { plugin: 'via', key: 'reports', id: 'a1' },
    { plugin: 'via', key: 'handedBack', id: 'a1' },
    { plugin: 'via', key: 'reports', id: 'a1' },
    { plugin: 'via', key: 'handedBack', id: 'a1' },
  ])
})

test('a model line never signs for pi: a stream that names no model says so', async ($, on) => {
  const spawns: Spawn[] = []
  const unnamed = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'all done' } },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 3, output: 4 } } },
  ]
  arrange(on, spawns, [{ stream: 'stdout', text: `${unnamed.map((e) => JSON.stringify(e)).join('\n')}\n` }])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: openrouter/*kimi*\ngo' })
  const { result } = await run($)
  expect(result.answer).toBe('all done\n\n— answered by pi, model not reported')
  expect(result.answer).not.toContain('kimi')
  expect(result.usage).toBeNull()
})

test('an agent that is not a via agent is looked up once, not on every step', async ($, on) => {
  storage(on)
  let lists = 0
  on('agent.list', () => {
    lists += 1
    return { value: [{ id: 'x1', description: 'x', type: 'Explore', status: 'running' }] }
  })
  // biome-ignore lint/correctness/useYield: a streaming hook must be an async generator, even one that answers at once
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await run($, { ...STEP, agentId: 'x1' })
  await run($, { ...STEP, agentId: 'x1' })
  expect(lists).toBe(1)
})

test('plan mode runs pi with only its reading tools, which also skips the project .pi extensions', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  on('state.get', (_, e, next) => (e.key === 'modes' ? { value: { value: 'plan', version: 1 } } : next(e)))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'look around' })
  await run($)
  expect(spawns[0]?.argv).toEqual(expect.arrayContaining(['--tools', 'read,grep,find,ls', '-na']))
})

test('plan mode overrides a pi tools line that could write, so pi still gets only its reading tools', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  on('state.get', (_, e, next) => (e.key === 'modes' ? { value: { value: 'plan', version: 1 } } : next(e)))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: bash,edit\nlook around' })
  await run($)
  expect(spawns[0]?.argv).toEqual(expect.arrayContaining(['--tools', 'read,grep,find,ls', '-na']))
  expect(spawns[0]?.argv).not.toContain('bash,edit')
})

test('an Esc that finds the run parked between steps ends the run, so its harness stops, not only the wait', async () => {
  let cleaned = false
  const gen = (async function* () {
    try {
      yield { kind: 'call-start' as const, id: 'c1', input: { kind: 'execute', title: 'sleep 60' }, usage: null }
      yield { kind: 'call-start' as const, id: 'c2', input: { kind: 'execute', title: 'never' }, usage: null }
    } finally {
      // Where run stops the harness.
      cleaned = true
    }
    return { stopReason: 'end_turn' } as never
  })()
  // Parked at its first yield, as after the step that issued the call.
  await gen.next()
  const job = { turnId: 't1', gen, held: [], outputs: new Map(), abort: new AbortController(), count: 0 }
  const w = {
    tool: 'mcp__plugin_via_step__step',
    jobs: new Map([['a1', job]]),
    calls: new Map([['toolu_1', { agentId: 'a1', id: 'c1' }]]),
    spawns: new Map(),
  }
  const esc = new AbortController()
  esc.abort()
  expect(await answerCall(w, 'toolu_1', esc.signal)).toEqual({ result: 'The harness run ended before this call finished.' })
  await Promise.resolve()
  expect(cleaned).toBe(true)
  // A step that still reads the ended run ends the turn, never spins on it.
  const next = pump(w, job, { turnId: 't1', index: 1, agentId: 'a1' }, new AbortController().signal)
  let r = await next.next()
  while (!r.done) r = await next.next()
  expect(r.value.stopReason).toBe('end_turn')
})

test("a nested agent's end that wakes its via parent after the parent's run runs nothing and repeats the report", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  on('state.get', (_, e, next) => (e.key === 'reports' ? { value: { value: 'the report', version: 1 } } : next(e)))
  const text = `<task-notification>\n<task-id>n1</task-id>\n<tool-use-id>${CHILD_CALL}t1_1</tool-use-id>\n<status>completed</status>\n</task-notification>`
  await $.turn.start({ turnId: 't2', agentId: 'a1', text })
  const { result } = await run($, { ...STEP, turnId: 't2' })
  expect(spawns).toHaveLength(0)
  expect(result.answer).toBe('the report')
})

test('a child-call id via never issued is an ordinary via spawn, whose step runs its harness', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines))
  on('agent.spawn', () => ({ model: 'gpt-6-luna', agentId: 'n1' }))
  await $.agent.spawn({
    tool_use_id: `${CHILD_CALL}t1_1`,
    subagentType: 'via:pi',
    prompt: 'List acp',
    description: 'List acp',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'pi',
    parentAgentId: 'a1',
    background: true,
    fork: false,
  })
  await $.turn.start({ turnId: 't1', agentId: 'n1', text: 'List acp' })
  await run($, { ...STEP, agentId: 'n1' })
  expect(spawns).toHaveLength(1)
})

// via's own Agent call for a harness subagent: auto mode's classifier gives no verdict on a call no model
// request made (seen live 2026-10-28), so via settles the mode's ask, and only that.
test("via settles only the mode's ask on its own Agent call: a deny or a rule's ask still stands", async ($, on) => {
  arrange(on, [], split(lines))
  on('agent.spawn', () => ({ model: 'pi', agentId: 'a1' }))
  let verdict: { decision: 'allow' | 'ask' | 'deny'; rule?: string } = { decision: 'ask' }
  on('tool.check', () => verdict)
  await spawnPi($, 'auto')
  const check = (tool_use_id: string, agentId = 'a1') => $.tool.check({ tool: 'Agent', input: {}, tool_use_id, agentId })
  expect((await check(`${CHILD_CALL}t1_1`)).decision).toBe('allow')
  // Not via's own call, or not in a via agent's loop: the engine's verdict.
  expect((await check('toolu_model_1')).decision).toBe('ask')
  expect((await check(`${CHILD_CALL}t1_1`, 'x1')).decision).toBe('ask')
  verdict = { decision: 'deny' }
  expect((await check(`${CHILD_CALL}t1_1`)).decision).toBe('deny')
  verdict = { decision: 'ask', rule: 'Agent(*)' }
  expect((await check(`${CHILD_CALL}t1_1`)).decision).toBe('ask')
})
