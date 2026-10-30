import { expect, mock, test } from 'claude-code/testing'
import * as steps from '../hooks/acp/steps'
import { pi } from '../hooks/adapters/pi'
import { waitChild } from '../hooks/children'
import { attachChild, followRetained, keepSpawn, remember } from '../hooks/recovery'
import { run as runHook } from '../hooks/run'
import type { World } from '../hooks/world'
import { lines, NODE, run, STEP, storage } from './helpers'

test('a new process reconciles the existing run before calling it cut off, without submitting its prompt again', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'general-purpose', status: 'running' }] }))
  const store = new Map<string, unknown>([
    [
      'agents',
      {
        a1: {
          harness: 'pi',
          handback: false,
          run: { turnId: 'old-turn', path: '/home/u/.claude/via/runs/a1/old-turn/0', choice: {}, mode: 'default' },
        },
      },
    ],
  ])
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.messages', () => ({ value: [] }))
  const files = new Map<string, string>()
  on('fs.read', (_, e) => {
    if (!files.has(e.path)) throw new Error('ENOENT')
    return { value: files.get(e.path) ?? '' }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', () => ({ value: NODE }))
  const requests: { argv: readonly string[]; input?: string }[] = []
  on('process.spawn', async function* (_, e) {
    requests.push(e)
    yield { stream: 'stdout', text: lines }
    return { value: { code: 0, signal: null } }
  })
  const { result } = await run($, { ...STEP, turnId: 'new-turn' })
  expect(result.answer).toBe('all done\n\n— answered by pi, openrouter/kimi')
  expect(requests).toHaveLength(1)
  expect(requests[0]?.argv.slice(-2)).toEqual(['follow', '/home/u/.claude/via/runs/a1/old-turn/0'])
  expect(requests[0]?.input).toBeUndefined()
  expect(JSON.parse(files.get('/home/u/.claude/via/runs/a1/old-turn/0/answer.json') ?? '{}').signed).toBe(result.answer)
})

test('a terminal durable result wins over lost or stale engine report state, including on a wake turn', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'via:pi', status: 'running' }] }))
  on('session.messages', () => ({ value: [] }))
  on('state.get', (_, e, next) => (e.key === 'reports' ? { value: { value: 'an older run answer', version: 1 } } : next(e)))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('store.get', (_, e) => ({
    value:
      e.key === 'agents'
        ? { a1: { harness: 'pi', handback: false, run: { turnId: 'old', path: '/private/run', choice: {}, mode: 'default' } } }
        : undefined,
  }))
  on('fs.read', (_, e) => {
    if (e.path !== '/private/run/answer.json') throw new Error('ENOENT')
    return { value: JSON.stringify({ signed: 'the retained answer', aborted: false, usage: null, block: 0 }) }
  })
  let spawned = false
  on('process.spawn', async function* () {
    spawned = true
    yield { stream: 'stdout', text: lines }
    return { value: { code: 0, signal: null } }
  })
  const { result } = await run($)
  expect(result.answer).toBe('the retained answer')
  const wake = '<task-notification><tool-use-id>toolu_via_child_old_1</tool-use-id></task-notification>'
  await $.turn.start({ turnId: 'wake', agentId: 'a1', text: wake })
  expect((await run($, { ...STEP, turnId: 'wake' })).result.answer).toBe('the retained answer')
  expect(spawned).toBe(false)
})

for (const resumed of [false, true])
  test(`a nested view in a new process restores its mapping from the parent journal (spawn resume: ${resumed})`, async ($, on) => {
    mock.env(on, { HOME: '/home/u' })
    on('session.messages', () => ({ value: [] }))
    on('fs.read', () => {
      throw new Error('ENOENT')
    })
    on('fs.write', () => ({ value: undefined }))
    on('store.get', (_, e) => ({
      value:
        e.key === 'agents'
          ? {
              a1: { harness: 'codex', handback: false, run: { turnId: 'newer', path: '/private/new-parent', choice: {}, mode: 'default' } },
              n1: {
                harness: 'codex',
                handback: false,
                nested: { key: 'a1/child#1', parent: 'a1', run: { turnId: 'old', path: '/private/parent', choice: {}, mode: 'default' } },
              },
            }
          : undefined,
    }))
    const requests: string[][] = []
    on('process.spawn', async function* (_, e) {
      requests.push([...e.argv])
      const events = [
        { relay: 'session', sessionId: 'root' },
        { relay: 'steered' },
        {
          sessionId: 'root',
          update: { sessionUpdate: 'subagent_update', sessionId: 'child', title: 'Inspect', state: { state: 'running' } },
        },
        { sessionId: 'child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the child answer' } } },
        { sessionId: 'root', update: { sessionUpdate: 'subagent_update', sessionId: 'child', state: { state: 'idle' } } },
      ]
      yield { stream: 'stdout', text: `${events.map((event) => JSON.stringify(event)).join('\n')}\n` }
      return { value: { code: 0, signal: null } }
    })
    if (resumed) {
      on('agent.spawn', () => ({ model: 'codex', agentId: 'n1' }))
      await $.agent.spawn({
        tool_use_id: 'resume-child',
        subagentType: 'via:codex',
        prompt: '',
        description: 'Inspect',
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'haiku',
        background: true,
        fork: false,
        resume: { agentId: 'n1' },
      })
    }
    const { result } = await run($, { ...STEP, agentId: 'n1', turnId: 'resumed-child' })
    expect(result.answer).toBe('the child answer\n\n— answered by codex subagent')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.slice(-2)).toEqual(['follow', '/private/parent'])
  })

test('the signed result is durable before the renderer receives the final signature chunk', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'via:pi', status: 'running' }] }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('process.run', () => ({ value: NODE }))
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  let saved = ''
  on('fs.write', (_, e) => {
    if (e.path.endsWith('/answer.json')) saved = e.text
    return { value: undefined }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: lines }
    return { value: { code: 0, signal: null } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const stream = $.turn.step(STEP)
  for (;;) {
    const next = await stream.next()
    if (next.done) break
    if (next.value.kind === 'text' && next.value.text.includes('— answered by'))
      expect(JSON.parse(saved).signed).toBe('all done\n\n— answered by pi, openrouter/kimi')
  }
  expect(saved).not.toBe('')
})

test('a run whose durable mapping cannot be saved refuses to start the harness', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'via:pi', status: 'running' }] }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('process.run', () => ({ value: NODE }))
  on('fs.write', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => {
    throw new Error('storage unavailable')
  })
  let spawned = false
  on('process.spawn', async function* () {
    spawned = true
    yield { stream: 'stdout', text: lines }
    return { value: { code: 0, signal: null } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(spawned).toBe(false)
  expect(result.answer).toContain('via could not render its next step')
})

test('a late child replay and a new run using the same child session never share a channel', async ($, on) => {
  const clock = mock.clock(on)
  const files = storage(on, {
    get: (key) =>
      key === 'agents'
        ? {
            a1: { harness: 'codex', handback: false, run: receipt('new') },
            old: { harness: 'codex', handback: false, nested: { key: 'a1/old/child#1', parent: 'a1', run: receipt('old') } },
            new: { harness: 'codex', handback: false, nested: { key: 'a1/new/child#1', parent: 'a1', run: receipt('new') } },
          }
        : undefined,
  })
  mock.env(on, { HOME: '/home/u' })
  on('session.messages', () => ({ value: [] }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  const receipt = (name: string) => ({ turnId: name, path: `/private/${name}`, scope: `a1/${name}`, choice: {}, mode: 'default' })
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  on('process.spawn', async function* (_, e) {
    const name = e.argv.at(-1)?.endsWith('/old') ? 'old' : 'new'
    const event = (update: unknown) => ({ sessionId: 'root', update })
    const events = [
      { relay: 'session', sessionId: 'root' },
      { relay: 'steered' },
      event({ sessionUpdate: 'subagent_update', sessionId: 'child', title: name, state: { state: 'running' } }),
      { sessionId: 'child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${name} answer` } } },
    ]
    yield { stream: 'stdout', text: `${events.map((item) => JSON.stringify(item)).join('\n')}\n` }
    if (name === 'new') await released
    yield {
      stream: 'stdout',
      text: `${JSON.stringify(event({ sessionUpdate: 'subagent_update', sessionId: 'child', state: { state: 'idle' } }))}\n`,
    }
    return { value: { code: 0, signal: null } }
  })
  const newer = run($, { ...STEP, agentId: 'new', turnId: 'new-view' })
  await clock.settle()
  const older = await run($, { ...STEP, agentId: 'old', turnId: 'old-view' })
  expect(older.result.answer).toBe('old answer\n\n— answered by codex subagent')
  release()
  expect((await newer).result.answer).toBe('new answer\n\n— answered by codex subagent')
})

test('a handoff step with a new turn id preserves the existing job instead of aborting and rerunning it', async ($, on) => {
  const files = storage(on)
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'via:opencode', status: 'running' }] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: NODE }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  let requests = 0
  on('process.spawn', async function* () {
    requests += 1
    const events = [
      { relay: 'session', sessionId: 'root' },
      { relay: 'steered' },
      { update: { sessionUpdate: 'tool_call', toolCallId: 'call', status: 'in_progress', kind: 'read', title: 'Inspect' } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed' } },
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'retained job answer' } } },
    ]
    yield { stream: 'stdout', text: `${events.map((event) => JSON.stringify(event)).join('\n')}\n` }
    return { value: { code: 0, signal: null } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  expect((await run($)).result.stopReason).toBe('tool_use')
  const resumed = await run($, { ...STEP, turnId: 'handoff' })
  expect(resumed.result.answer).toBe('retained job answer\n\n— answered by opencode, model not reported')
  expect(requests).toBe(1)
})

test('an unreadable roster refuses the step without overwriting mappings or falling through to a provider', async ($, on) => {
  on('store.get', () => {
    throw new Error('unreadable store')
  })
  let writes = 0
  on('store.set', () => {
    writes += 1
    return { value: undefined }
  })
  let provider = false
  on('turn.step', async function* (_, e) {
    provider = true
    yield { kind: 'text', index: 0, text: 'provider' }
    return { turnId: e.turnId, index: e.index, answer: 'provider', stopReason: 'end_turn', toolUses: [], usage: null }
  })
  const { result } = await run($)
  expect(result.answer).toContain('could not read its retained run mappings')
  expect(writes).toBe(0)
  expect(provider).toBe(false)
})

test('a retained child result hands back once after a transition before its original handback', async ($, on) => {
  on('session.messages', () => ({ value: [] }))
  on('store.get', (_, e) => ({
    value:
      e.key === 'agents'
        ? {
            n1: {
              harness: 'codex',
              handback: true,
              nested: { key: 'a1/child#1', parent: 'a1', run: { turnId: 'old', path: '/private/old', choice: {}, mode: 'default' } },
            },
          }
        : undefined,
  }))
  on('fs.read', () => ({ value: JSON.stringify({ signed: 'the retained child answer', aborted: false, usage: null, block: 0 }) }))
  const step = { ...STEP, agentId: 'n1' }
  const first = await run($, step)
  expect(first.result.toolUses).toEqual([{ name: 'SubagentHandback', input: { message: 'the retained child answer' } }])
  const after = await run($, { ...step, index: 1 })
  expect(after.result.answer).toBe('the retained child answer')
  expect(after.result.toolUses).toEqual([])
})

test('a recovered interruption reports its unrun message instead of an empty final answer or another provider run', async ($, on) => {
  const clock = mock.clock(on)
  const files = storage(on, {
    get: (key) =>
      key === 'agents'
        ? {
            a1: {
              harness: 'pi',
              handback: false,
              run: { turnId: 'old', path: '/private/old', inbox: '/private/inbox', choice: {}, mode: 'default' },
            },
          }
        : undefined,
  })
  files.set('/private/inbox', '')
  mock.env(on, { HOME: '/home/u' })
  on('session.messages', () => ({ value: [] }))
  let interrupt!: () => void
  const interrupted = new Promise<void>((resolve) => {
    interrupt = resolve
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    if (e.path === '/private/inbox' && e.text.includes('interrupt')) interrupt()
    return { value: undefined }
  })
  let requests = 0
  on('process.spawn', async function* () {
    requests += 1
    yield {
      stream: 'stdout',
      text: `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } })}\n`,
    }
    await interrupted
    yield {
      stream: 'stdout',
      text: `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'This operation was aborted', usage: {} } })}\n`,
    }
    return { value: { code: 1, signal: null } }
  })
  const pending = run($)
  await clock.settle()
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'interrupt: the new task', tool_use_id: 'steer' })
  const { result } = await pending
  expect(result.answer).toContain('stopped before its pending interrupt could run')
  expect(result.answer).toContain('the new task')
  expect(requests).toBe(1)
})

test('a recovered compact-only run retains its successful compaction while suppressing old tool rows', async ($, on) => {
  storage(on, {
    get: (key) =>
      key === 'agents'
        ? {
            a1: {
              harness: 'codex',
              handback: false,
              run: { turnId: 'old', path: '/private/old', compact: true, choice: {}, mode: 'default' },
            },
          }
        : undefined,
  })
  mock.env(on, {})
  on('session.messages', () => ({ value: [] }))
  on('process.spawn', async function* () {
    const events = [
      { relay: 'session', sessionId: 'root' },
      { relay: 'steered' },
      { update: { sessionUpdate: 'compaction_update', compactionId: 'c', status: 'in_progress' } },
      { update: { sessionUpdate: 'compaction_update', compactionId: 'c', status: 'completed' } },
    ]
    yield { stream: 'stdout', text: `${events.map((event) => JSON.stringify(event)).join('\n')}\n` }
    return { value: { code: 0, signal: null } }
  })
  const { result } = await run($)
  expect(result.answer).toContain('Compacted the conversation.')
  expect(result.answer).not.toContain('ended with no answer')
  expect(result.toolUses).toEqual([])
})

test('detaching a durable follower preserves the producer inbox and its monotonic offsets', async () => {
  const inbox = { name: 'pi', path: '/private/inbox', lines: ['"a prior message with a long offset"'] }
  const files = new Map([[inbox.path, `${inbox.lines[0]}\n`]])
  const world = {
    descriptions: new Map(),
    activity: new Map(),
    channels: new Map(),
    nested: new Map(),
    inboxes: new Map([['a1', inbox]]),
    timeoutMinutes: 30,
  } as unknown as World
  const source = (async function* () {
    yield {
      stream: 'stdout' as const,
      text: `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'working' } })}\n`,
    }
    return { code: 0, signal: null }
  })()
  let cancelled = false
  const $ = {
    env: { get: async () => '/home/u' },
    plugin: { root: '/plugin' },
    fs: {
      write: async (path: string, text: string) => {
        files.set(path, text)
      },
    },
    clock: { after: () => ({ cancel: () => {} }) },
    process: {
      spawn: () => Object.assign(source, { result: Promise.resolve({ code: 0, signal: null }) }),
      run: async () => {
        cancelled = true
        return NODE
      },
    },
  } as unknown as Parameters<typeof runHook>[2]
  const stream = runHook(world, pi, $, {
    agentId: 'a1',
    choice: {},
    prompt: '',
    signal: new AbortController().signal,
    inbox,
    session: undefined,
    guard: undefined,
    mode: 'default',
    durable: { path: '/private/run', recover: false },
    probe: async () => undefined,
    save: async () => {},
  })
  expect((await stream.next()).done).toBe(false)
  await stream.return(undefined as never)
  expect(files.get(inbox.path)).toBe(`${inbox.lines[0]}\n`)
  expect(cancelled).toBe(false)
})

test('a roster write that fails once does not cancel the writes after it', async () => {
  let fail = true
  const saved = new Map<string, unknown>()
  const $ = {
    store: {
      get: async (key: string) => {
        if (fail) throw new Error('synthetic store hiccup')
        return saved.get(key)
      },
      set: async (key: string, value: unknown) => {
        saved.set(key, value)
      },
    },
  } as unknown as Parameters<typeof remember>[1]
  const world = {} as World
  const first = await remember(world, $, 'a1', { harness: 'pi', handback: false }).then(
    () => 'written',
    (error: unknown) => String(error),
  )
  expect(first).toContain('retained run mappings')
  fail = false
  await remember(world, $, 'a2', { harness: 'pi', handback: false })
  await keepSpawn(world, $, 'toolu_via_child_t_1', 'a2/t-0/child#1')
  expect(Object.keys(saved.get('agents') as object)).toEqual(['a2'])
})

test('a failed spawn mapping write still shows the child and keeps the run going', async () => {
  const job: steps.Job = {
    turnId: 't1',
    count: 0,
    abort: new AbortController(),
    outputs: new Map(),
    held: [{ kind: 'spawn', child: 'a1/t1-0/child#1', type: 'via:codex', title: 'child' }],
    // Never read: the held spawn ends the step first.
    gen: (async function* () {})() as steps.Job['gen'],
  }
  const world: steps.Steps = {
    tool: 'mcp__plugin_via_step__step',
    spawns: new Map(),
    jobs: new Map([['a1', job]]),
    calls: new Map(),
    keepSpawn: async () => {
      throw new Error('synthetic store failure')
    },
  }
  const stream = steps.pump(world, job, { turnId: 't1', index: 0, agentId: 'a1' }, new AbortController().signal)
  let result = await stream.next()
  while (!result.done) result = await stream.next()
  expect(result.value.stopReason).toBe('tool_use')
  expect(result.value.toolUses[0]?.name).toBe('Agent')
  expect(job.abort.signal.aborted).toBe(false)
  expect([...world.spawns.values()]).toEqual(['a1/t1-0/child#1'])
})

test('resumed children wait for the journal through engine waits, on a follower no caller owns', async () => {
  const lines: string[] = []
  let wakeStream = () => {}
  let finished = false
  let engineSpawns = 0
  let exit = (_: { code: number; signal: null }) => {}
  const stream = Object.assign(
    (async function* () {
      for (;;) {
        while (lines.length > 0) yield { stream: 'stdout' as const, text: lines.shift() as string }
        if (finished) return
        await new Promise<void>((resolve) => {
          wakeStream = resolve
        })
      }
    })(),
    {
      result: new Promise<{ code: number; signal: null }>((resolve) => {
        exit = resolve
      }),
    },
  )
  const plugin = { name: 'via', root: '/plugin' }
  const world = { channels: new Map(), nested: new Map() } as unknown as World
  const start = () => {
    engineSpawns += 1
    return stream as unknown as ReturnType<Parameters<typeof followRetained>[1]>
  }
  const adapter = { name: 'codex', events: () => (line: string) => [JSON.parse(line)] } as unknown as Parameters<typeof attachChild>[2]
  let waits = 0
  const caller = {
    plugin,
    // The engine nouns: bounded, and here never timing out, so only an arrival ends a wait.
    viaChildren: {
      follow: async (input: { type: string; parent: string; receipt: { path: string } }) =>
        followRetained(world, start, input.type, adapter, input.parent, input.receipt),
      wait: ({ key }: { key: string }) => {
        waits += 1
        return waitChild(world, key, () => ({ cancel: () => {} }))
      },
    },
  } as unknown as Parameters<typeof attachChild>[1]
  const receipt = { turnId: 'old', path: '/private/parent', choice: {}, mode: 'default' as const }
  const first = attachChild(world, caller, adapter, 'a1/child#1', 'a1', receipt)
  // A sibling that stops before its child shows up leaves the follower to the others.
  const stopped = new AbortController()
  stopped.abort()
  await attachChild(world, caller, adapter, 'a1/other#1', 'a1', receipt, stopped.signal)
  await Promise.resolve()
  expect(waits).toBeGreaterThanOrEqual(1)
  lines.push(`${JSON.stringify({ k: 'child', id: 'child', parent: 'root', title: 'Inspect', state: 'running' })}\n`)
  wakeStream()
  await first
  expect(world.channels.has('a1/child#1')).toBe(true)
  expect(world.channels.get('a1/child#1')?.closed).toBe(false)
  expect(engineSpawns).toBe(1)
  finished = true
  wakeStream()
  exit({ code: 0, signal: null })
})

for (const [type, model, passes] of [
  ['general-purpose', 'haiku', true],
  ['general-purpose', 'gpt-6.1-sol', false],
  ['via:pi', 'haiku', false],
] as const)
  test(`an unreadable roster lets only a plain Claude subagent through (${type}, ${model})`, async ($, on) => {
    on('store.get', () => {
      throw new Error('unreadable store')
    })
    on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type, status: 'running' }] }))
    let provider = false
    on('turn.step', async function* (_, e) {
      provider = true
      yield { kind: 'text', index: 0, text: 'provider' }
      return { turnId: e.turnId, index: e.index, answer: 'provider', stopReason: 'end_turn', toolUses: [], usage: null }
    })
    const { result } = await run($, { ...STEP, model })
    expect(provider).toBe(passes)
    if (!passes) expect(result.answer).toContain('could not read its retained run mappings')
  })

test('a session start prunes retained runs beside the session, without waiting on it', async ($, on) => {
  mock.env(on, { PATH: '/nowhere', HOME: '/home/u' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-haiku-5-5' }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { ...NODE } }
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await Promise.resolve()
  expect(runs.map((argv) => argv.slice(2))).toContainEqual(['prune', '/home/u/.claude/via/runs'])
})
