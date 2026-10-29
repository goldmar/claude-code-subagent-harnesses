import type { TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, mock, type TestBody, test } from 'claude-code/testing'
import { relayEvents } from '../hooks/acp/events'
import type { Norm } from '../hooks/acp/norm'
import { answerCall, CHILD_CALL, type Job, type Mark, pump } from '../hooks/acp/steps'
import { type Children, childRun, closeChildren, route, waitChild, woken } from '../hooks/children'
import { NODE, run, STEP, storage } from './helpers'

// This regression needs real elapsed time: the engine's hook budget uses the real clock.
declare function setTimeout(fn: () => void, ms: number): unknown

// Captured 2026-10-28 from relay/relay.mjs over codex-acp 2.3.1-preview.8 (codex-cli 0.165.0, gpt-6-luna),
// asked to spawn one subagent: the standard subagent_update flow of ACP's subagents RFD, trimmed.
const ROOT = '01a18155-81d4-7ba0-8246-5cba1d8adb3b'
const CHILD = `${ROOT}:subagent:01a18155-8b4f-7403-bb8f-f472976c48cd`
const MODEL = {
  configOptions: [{ currentValue: 'gpt-6-luna', type: 'select', id: 'model', name: 'Model', category: 'model', options: [] }],
}
const CAPTURED = [
  { relay: 'session', sessionId: ROOT, cwd: '/repo' },
  { relay: 'steered' },
  { sessionId: ROOT, update: { sessionId: CHILD, title: 'List acp', capabilities: {}, sessionUpdate: 'subagent_update' } },
  { sessionId: CHILD, update: { ...MODEL, sessionUpdate: 'config_option_update' } },
  { sessionId: ROOT, update: { sessionId: CHILD, state: { state: 'running' }, sessionUpdate: 'subagent_update' } },
  { sessionId: ROOT, update: { used: 21285, size: 258400, sessionUpdate: 'usage_update' } },
  { sessionId: ROOT, update: { toolCallId: 'w', title: 'wait', kind: 'other', status: 'in_progress', sessionUpdate: 'tool_call' } },
  {
    sessionId: CHILD,
    update: { toolCallId: 'x', title: "List files in 'acp'", kind: 'read', status: 'in_progress', sessionUpdate: 'tool_call' },
  },
  {
    sessionId: CHILD,
    update: {
      toolCallId: 'x',
      status: 'completed',
      rawOutput: { exit_code: 0 },
      _meta: { terminal_output_delta: { data: 'steps.ts\n' } },
      sessionUpdate: 'tool_call_update',
    },
  },
  { sessionId: CHILD, update: { used: 23763, size: 258400, sessionUpdate: 'usage_update' } },
  { sessionId: CHILD, update: { content: { text: 'steps.ts', type: 'text' }, messageId: 'm1', sessionUpdate: 'agent_message_chunk' } },
  { sessionId: ROOT, update: { sessionId: CHILD, state: { stopReason: 'end_turn', state: 'idle' }, sessionUpdate: 'subagent_update' } },
  { sessionId: ROOT, update: { toolCallId: 'w', status: 'completed', sessionUpdate: 'tool_call_update' } },
  {
    sessionId: ROOT,
    update: { content: { text: 'It found steps.ts.', type: 'text' }, messageId: 'm2', sessionUpdate: 'agent_message_chunk' },
  },
]

test("a subagent's session is parsed apart: its rows, model and message, never the run's answer or context", () => {
  const parse = relayEvents()
  const norms = CAPTURED.flatMap((line) => parse(JSON.stringify(line)))
  expect(norms.filter((n) => n.k === 'child')).toEqual([
    { k: 'child', id: CHILD, parent: ROOT, title: 'List acp' },
    { k: 'child', id: CHILD, parent: ROOT, state: 'running' },
    { k: 'child', id: CHILD, parent: ROOT, state: 'idle' },
  ])
  expect(norms.filter((n) => n.k === 'of').map((n) => (n.k === 'of' ? n.norm : n))).toEqual([
    { k: 'model', name: 'gpt-6-luna' },
    { k: 'call', id: 'x', kind: 'read', title: "List files in 'acp'" },
    { k: 'called', id: 'x', output: 'steps.ts', failed: false },
    { k: 'message' },
    { k: 'text', t: 'steps.ts' },
  ])
  // The run's own: its wait row, its context, and only its own message as the answer.
  expect(norms.filter((n) => n.k === 'usage')).toEqual([{ k: 'usage', usage: { input: 21285, cacheRead: 0, cacheWrite: 0, output: 0 } }])
  expect(norms.filter((n) => n.k === 'text')).toEqual([{ k: 'text', t: 'It found steps.ts.' }])
})

test('a failed subagent says why', () => {
  const parse = relayEvents()
  parse(JSON.stringify(CAPTURED[0]))
  parse(JSON.stringify(CAPTURED[1]))
  const failed = { stopReason: 'error', state: 'idle', error: { code: -32000, message: 'Authentication required' } }
  expect(parse(JSON.stringify({ sessionId: ROOT, update: { sessionId: CHILD, state: failed, sessionUpdate: 'subagent_update' } }))).toEqual(
    [{ k: 'child', id: CHILD, parent: ROOT, state: 'idle', failure: 'Authentication required' }],
  )
})

const engine = (w: Children) => ({
  viaChildren: { wait: ({ key }: { key: string }) => waitChild(w, key, () => ({ cancel: () => {} })) },
})

const world = (): Children => ({ channels: new Map(), nested: new Map() })
const of = (child: string, norm: Norm): Extract<Norm, { k: 'of' }> => ({ k: 'of', child, norm })

test("a child's thinking and plan reach its view, but its context stays apart", () => {
  const parse = relayEvents()
  parse(JSON.stringify(CAPTURED[0]))
  parse(JSON.stringify(CAPTURED[1]))
  const updates = [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking the call sites.' } },
    { sessionUpdate: 'plan', entries: [{ content: 'Read the code', status: 'in_progress', priority: 'medium' }] },
    { sessionUpdate: 'usage_update', used: 40, size: 100 },
  ]
  expect(updates.flatMap((update) => parse(JSON.stringify({ sessionId: CHILD, update })))).toEqual([
    of(CHILD, { k: 'thinking', t: 'Checking the call sites.' }),
    of(CHILD, { k: 'plan', entries: [{ content: 'Read the code', status: 'in_progress' }] }),
  ])
})

test("a child's progress and step rows stream before its final message", async () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'Read code' })
  w.nested.set('n1', { key: 'a1/c#1' })
  const send = (norm: Norm) => route(w, 'a1', 'via:codex', of('c', norm))
  send({ k: 'thinking', t: 'Checking the call sites.' })
  const plan: Norm = { k: 'plan', entries: [{ content: 'Read the code', status: 'in_progress' }] }
  send(plan)
  send(plan) // Repeated plan snapshots do not add rows.
  send({ k: 'message' })
  send({ k: 'text', t: 'Reading the implementation.' })
  send({ k: 'call', id: 'read', kind: 'read', title: 'Read hooks/children.ts' })
  send({ k: 'called', id: 'read', output: 'source', failed: false })
  const job: Job = {
    turnId: 't1',
    gen: childRun(w, engine(w), 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false),
    held: [],
    outputs: new Map(),
    abort: new AbortController(),
    count: 0,
  }
  const steps = { ...w, tool: 'mcp__plugin_via_step__step', jobs: new Map([['n1', job]]), calls: new Map(), spawns: new Map() }
  const step = { turnId: 't1', index: 0, agentId: 'n1' }
  const signal = new AbortController().signal
  const first = await drain(pump(steps, job, step, signal))
  expect(first.out[0]).toEqual({ kind: 'thinking', index: 0, text: 'Checking the call sites.' })
  expect(first.result.toolUses[0]?.input).toEqual({ kind: 'plan', title: 'Plan' })
  const planCall = first.out.find((c) => c.kind === 'tool')
  expect(await answerCall(steps, planCall?.kind === 'tool' ? planCall.id : undefined, signal)).toEqual({ result: '◐ Read the code' })
  const second = await drain(pump(steps, job, { ...step, index: 1 }, signal))
  expect(second.out[0]).toEqual({ kind: 'text', index: 0, text: 'Reading the implementation.' })
  expect(second.result.toolUses[0]?.input).toEqual({ kind: 'read', title: 'Read hooks/children.ts' })
  const readCall = second.out.find((c) => c.kind === 'tool')
  expect(await answerCall(steps, readCall?.kind === 'tool' ? readCall.id : undefined, signal)).toEqual({ result: 'source' })
  // Still live throughout both steps. Only the next message and idle event finish the child.
  expect(w.channels.get('a1/c#1')?.ended).toBe(false)
  send({ k: 'message' })
  send({ k: 'text', t: 'The implementation is correct.' })
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  const final = await drain(pump(steps, job, { ...step, index: 2 }, signal))
  expect(final.result.answer).toBe('The implementation is correct.\n\n— answered by codex subagent')
  expect(final.result.stopReason).toBe('end_turn')
})

test("a child's consecutive messages have separate text blocks and only the last is its answer", async () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'Read code' })
  for (const t of ['Reading the code.', 'The code is correct.']) {
    route(w, 'a1', 'via:codex', of('c', { k: 'message' }))
    route(w, 'a1', 'via:codex', of('c', { k: 'text', t }))
  }
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  w.nested.set('n1', { key: 'a1/c#1' })
  const { out, result } = await drain(
    childRun(w, engine(w), 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false),
  )
  expect(out.slice(0, 2)).toEqual([
    { kind: 'text', index: 0, text: 'Reading the code.' },
    { kind: 'text', index: 1, text: 'The code is correct.' },
  ])
  expect(result.answer).toBe('The code is correct.\n\n— answered by codex subagent')
})

async function drain(gen: AsyncGenerator<TurnStepChunk | Mark, TurnStepResult>) {
  const out: (TurnStepChunk | Mark)[] = []
  for (;;) {
    const r = await gen.next()
    if (r.done) return { out, result: r.value }
    out.push(r.value)
  }
}

test("a subagent's first event spawns its nested agent once, and its nested agent shows its rows then its signed answer", async () => {
  const w = world()
  expect(route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'List acp' })).toEqual([
    { kind: 'spawn', child: 'a1/c#1', type: 'via:codex', title: 'List acp' },
  ])
  expect(route(w, 'a1', 'via:codex', of('c', { k: 'model', name: 'gpt-6-luna' }))).toEqual([])
  route(w, 'a1', 'via:codex', of('c', { k: 'call', id: 'x', kind: 'read', title: 'List files' }))
  route(w, 'a1', 'via:codex', of('c', { k: 'called', id: 'x', output: 'steps.ts', failed: false }))
  route(w, 'a1', 'via:codex', of('c', { k: 'text', t: 'steps.ts' }))
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  w.nested.set('n1', { key: 'a1/c#1' })
  const { out, result } = await drain(
    childRun(w, engine(w), 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false),
  )
  expect(out.filter((c) => c.kind === 'call-start' || c.kind === 'call-end')).toEqual([
    { kind: 'call-start', id: 'x', input: { kind: 'read', title: 'List files' }, usage: null },
    { kind: 'call-end', id: 'x', output: 'steps.ts', failed: false },
  ])
  expect(result.answer).toBe('steps.ts\n\n— answered by codex subagent, gpt-6-luna')
  // Seen live 2026-10-28: codex-acp clears the child's cancel capability after it goes idle. A patch
  // is not a new child; only the parent's end lets the child go.
  expect(route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root' })).toEqual([])
  expect(route(w, 'a1', 'via:codex', of('c', { k: 'model', name: 'gpt-6-luna' }))).toEqual([])
  closeChildren(w, 'a1')
  expect(w.channels.size).toBe(0)
})

test('work after a subagent went idle is a new nested agent with the same title', () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'List acp' })
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  expect(route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'running' })).toEqual([
    { kind: 'spawn', child: 'a1/c#2', type: 'via:codex', title: 'List acp' },
  ])
  // Found by review: each assignment keeps its own queue, so two nested agents never split one.
  route(w, 'a1', 'via:codex', of('c', { k: 'text', t: 'second' }))
  expect(w.channels.get('a1/c#1')?.queue).toEqual([{ k: 'end' }])
  expect(w.channels.get('a1/c#2')?.queue).toEqual([{ k: 'text', t: 'second' }])
})

test("a subagent with no announcement (codex-acp 2.3.0's own form) still gets a nested agent, ended by its parent's run", async () => {
  const w = world()
  expect(route(w, 'a1', 'via:codex', of('c', { k: 'text', t: 'done' }))).toEqual([
    { kind: 'spawn', child: 'a1/c#1', type: 'via:codex', title: 'subagent' },
  ])
  // The parent's run ends before the nested agent's first step: its queue waits for it.
  closeChildren(w, 'a1')
  w.nested.set('n1', { key: 'a1/c#1' })
  const { result } = await drain(childRun(w, engine(w), 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, true))
  expect(result.toolUses[0]?.name).toBe('SubagentHandback')
  expect(JSON.stringify(result.toolUses[0]?.input)).toContain('done')
})

test("a subagent's own subagent is spawned by its nested agent, not the run's", async () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'outer' })
  expect(route(w, 'a1', 'via:codex', { k: 'child', id: 'g', parent: 'c', title: 'inner' })).toEqual([])
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  w.nested.set('n1', { key: 'a1/c#1' })
  const { out } = await drain(childRun(w, engine(w), 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false))
  expect(out.filter((c) => c.kind === 'spawn')).toEqual([{ kind: 'spawn', child: 'a1/g#1', type: 'via:codex', title: 'inner' }])
})

test('a spawn mark ends the step with an Agent call in the background, remembered for its spawn', async () => {
  const gen = (async function* (): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
    yield { kind: 'spawn', child: 'a1/c#1', type: 'via:codex', title: 'List acp' }
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })()
  const job: Job = { turnId: 't1', gen, held: [], outputs: new Map(), abort: new AbortController(), count: 0 }
  const w = { tool: 'mcp__plugin_via_step__step', jobs: new Map([['a1', job]]), calls: new Map(), spawns: new Map<string, string>() }
  const step = pump(w, job, { turnId: 't1', index: 0, agentId: 'a1' }, new AbortController().signal)
  const chunks: TurnStepChunk[] = []
  let r = await step.next()
  while (!r.done) {
    chunks.push(r.value)
    r = await step.next()
  }
  const input = { description: 'List acp', prompt: 'List acp', subagent_type: 'via:codex', run_in_background: true }
  expect(r.value.toolUses).toEqual([{ name: 'Agent', input }])
  const tool = chunks.find((c) => c.kind === 'tool')
  expect(tool?.kind === 'tool' && tool.name).toBe('Agent')
  const id = tool?.kind === 'tool' ? tool.id : ''
  expect(id.startsWith(CHILD_CALL)).toBe(true)
  expect(w.spawns.get(id)).toBe('a1/c#1')
})

test("a nested agent's end or message to its via parent is a wake, and a prompt beside one still runs", () => {
  const nested = new Map([['n1', { key: 'a1/c#1' }]])
  // Captured 2026-10-28, trimmed: the notification of a nested agent's end, framed as Claude Code frames it.
  const ended = `[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\nDo NOT interpret this as user acknowledgement, confirmation, or response to any pending question.\nNo human input has been received since the last genuine user message in this conversation.\n\n<task-notification>\n<tool-use-id>${CHILD_CALL}t1_1</tool-use-id>\n<status>completed</status>\n</task-notification>`
  expect(woken(ended, nested)).toBe('')
  // Sent as the nested agent after its handback, it woke the parent for a second run.
  const note =
    'Another Claude session sent a message while you were working:\n<agent-message from="n1">\n  Note: The server-side auto mode classifier was unavailable.\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.'
  expect(woken(note, nested)).toBe('')
  // Found by review: a real prompt batched with a wake is the turn's prompt, not swallowed.
  expect(woken(`${ended}\n\nReview the error handling in src/api.`, nested)).toBe('Review the error handling in src/api.')
  expect(woken('<agent-message from="someone-else">hi</agent-message>', nested)).toBeUndefined()
  expect(woken('<agent-message from="n1" summary="done">ok</agent-message>', nested)).toBe('')
  expect(woken('Review the error handling in src/api.', nested)).toBeUndefined()
})

// A parent's run pauses at its Agent call. Its next step supplies the child's answer, so the
// nested agent can sit on its queue without a mock process hook itself waiting ten seconds.
async function nestedChild(
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  failure?: string,
  refused?: 'wait' | 'state',
  realTime = false,
) {
  if (realTime) on('clock.after', { ms: 5_000 }, () => new Promise((resolve) => setTimeout(() => resolve({ value: undefined }), 5_000)))
  const clock = mock.clock(on)
  const files = storage(on)
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'parent', type: 'via:codex', status: 'running' }] }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', (_, e) => ({ agentId: 'n1', model: e.model ?? 'codex' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', () => ({ value: NODE }))
  const line = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: line(CAPTURED.slice(0, 5)) }
    yield {
      stream: 'stdout',
      text: line([
        CAPTURED[10],
        failure
          ? {
              sessionId: ROOT,
              update: {
                sessionId: CHILD,
                state: { state: 'idle', stopReason: 'error', error: { message: failure } },
                sessionUpdate: 'subagent_update',
              },
            }
          : CAPTURED[11],
        { relay: 'done', stopReason: 'end_turn' },
      ]),
    }
    return { value: { code: 0, signal: null } }
  })
  let requests = 0
  on('turn.step', async function* (_, e) {
    requests += 1
    yield { kind: 'text', index: 0, text: 'API fallback' }
    return { turnId: e.turnId, index: e.index, answer: 'API fallback', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  if (refused === 'wait') on('viaChildren.wait', () => ({ deny: 'wait unavailable' }))
  if (refused === 'state') on('state.get', { key: 'handbacks', id: 'n1' }, () => ({ deny: 'state unavailable' }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'List acp' })
  const parent = await run($)
  const tool = parent.chunks.find((c) => c.kind === 'tool')
  expect(tool?.kind === 'tool' && tool.name).toBe('Agent')
  await $.agent.spawn({
    tool_use_id: tool?.kind === 'tool' ? tool.id : '',
    subagentType: 'via:codex',
    prompt: 'List acp',
    description: 'List acp',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'codex',
    parentAgentId: 'a1',
    background: true,
    fork: false,
  })
  await $.turn.start({ turnId: 'nested', agentId: 'n1', text: 'List acp' })
  return { clock, requests: () => requests, finish: () => run($, { ...STEP, index: 1 }) }
}

test('a child silent for more than the real ten-second hook budget stays in via', { timeoutMs: 20_000 }, async ($, on) => {
  const child = await nestedChild($, on, undefined, undefined, true)
  const pending = run($, { ...STEP, turnId: 'nested', agentId: 'n1', model: 'gpt-6-luna' })
  await child.clock.settle()
  await new Promise<void>((resolve) => setTimeout(resolve, 11_000))
  await child.finish()
  const { result } = await pending
  expect(result.answer).toBe('steps.ts\n\n— answered by codex subagent, gpt-6-luna')
  expect(result.stopReason).toBe('end_turn')
  expect(result.toolUses).toEqual([])
  expect(child.requests()).toBe(0)
})

test('a failed ACP child preserves partial text, reports failure, and ends without an API request', async ($, on) => {
  const child = await nestedChild($, on, 'Authentication required')
  const pending = run($, { ...STEP, turnId: 'nested', agentId: 'n1', model: 'gpt-6-luna' })
  await child.clock.settle()
  await child.finish()
  const { chunks, result } = await pending
  expect(result.answer).toBe('steps.ts\n\nThe codex subagent failed: Authentication required')
  expect(
    chunks
      .filter((c) => c.kind === 'text')
      .map((c) => (c.kind === 'text' ? c.text : ''))
      .join(''),
  ).toBe(result.answer)
  expect(result.stopReason).toBe('end_turn')
  expect(result.toolUses).toEqual([])
  expect(child.requests()).toBe(0)
})

test('a refused child wait ends the via child instead of falling through to the API', async ($, on) => {
  const child = await nestedChild($, on, undefined, 'wait')
  const { result } = await run($, { ...STEP, turnId: 'nested', agentId: 'n1' })
  expect(result.answer).toBe('The codex subagent failed: could not wait for its next event')
  expect(result.stopReason).toBe('end_turn')
  expect(child.requests()).toBe(0)
})

test('a child renderer failure has an explicit end-turn catch, never an API fallback', async ($, on) => {
  const child = await nestedChild($, on, undefined, 'state')
  const { result } = await run($, { ...STEP, turnId: 'nested', agentId: 'n1' })
  expect(result.answer).toBe('The codex subagent failed: via could not render its next step.')
  expect(result.stopReason).toBe('end_turn')
  expect(result.toolUses).toEqual([])
  expect(child.requests()).toBe(0)
})

test('cancelling a quiet child removes its waiter and returns an unsigned failure', async () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'quiet' })
  w.nested.set('n1', { key: 'a1/c#1' })
  const abort = new AbortController()
  const pending = drain(childRun(w, engine(w), 'n1', 'codex', { turnId: 't1', index: 0 }, abort.signal, false))
  await Promise.resolve()
  expect(w.channels.get('a1/c#1')?.wake).toBeDefined()
  abort.abort()
  const { result } = await pending
  expect(result.answer).toBe('The codex subagent failed: it was stopped')
  expect(result.stopReason).toBe('end_turn')
  expect(w.channels.get('a1/c#1')?.wake).toBeUndefined()
  closeChildren(w, 'a1')
  expect(w.channels.size).toBe(0)
})

test('a child answers during a parent tool, whose continuation still delivers its eventual output', async ($, on) => {
  const clock = mock.clock(on)
  const files = storage(on)
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'parent', type: 'via:codex', status: 'running' }] }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', () => ({ value: NODE }))
  on('agent.spawn', (_, e) => ({ agentId: 'n1', model: e.model ?? 'codex' }))
  let requests = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const line = (events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  on('process.spawn', async function* () {
    requests += 1
    yield { stream: 'stdout', text: line([CAPTURED[0], CAPTURED[1], CAPTURED[6]]) }
    yield {
      stream: 'stdout',
      text: line([
        {
          sessionId: ROOT,
          update: { toolCallId: 'parallel', title: 'parallel', kind: 'execute', status: 'in_progress', sessionUpdate: 'tool_call' },
        },
        ...CAPTURED.slice(2, 5),
        CAPTURED[10],
        CAPTURED[11],
      ]),
    }
    await held
    yield {
      stream: 'stdout',
      text: line([
        {
          sessionId: ROOT,
          update: {
            toolCallId: 'parallel',
            status: 'completed',
            sessionUpdate: 'tool_call_update',
            _meta: { terminal_output_delta: { data: 'parallel output' } },
          },
        },
        {
          sessionId: ROOT,
          update: {
            toolCallId: 'w',
            status: 'completed',
            sessionUpdate: 'tool_call_update',
            _meta: { terminal_output_delta: { data: 'parent output' } },
          },
        },
        CAPTURED[13],
      ]),
    }
    return { value: { code: 0, signal: null } }
  })
  await $.turn.start({ turnId: 'parent', text: 'go', agentId: 'a1' })
  const step = { ...STEP, turnId: 'parent' }
  const first = await run($, step)
  const call = first.chunks.find((chunk) => chunk.kind === 'tool')
  let released = false
  const pending = $.tool
    .call({ tool: call?.kind === 'tool' ? call.name : '', tool_use_id: call?.kind === 'tool' ? call.id : '' } as never)
    .then((result) => {
      released = true
      return result
    })
  await clock.settle()
  const before = released
  let answer = ''
  let continued: unknown
  let continuation: Promise<unknown> | undefined
  try {
    if (before) {
      const spawn = await run($, { ...step, index: 1 })
      const tool = spawn.chunks.find((chunk) => chunk.kind === 'tool')
      expect(tool?.kind === 'tool' && tool.name).toBe('Agent')
      await $.agent.spawn({
        tool_use_id: tool?.kind === 'tool' ? tool.id : '',
        subagentType: 'via:codex',
        prompt: 'List acp',
        description: 'List acp',
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'codex',
        parentAgentId: 'a1',
        background: true,
        fork: false,
      })
      const child = run($, { ...STEP, turnId: 'nested', agentId: 'n1' })
      const wait = await run($, { ...step, index: 2 })
      expect(wait.result.toolUses[0]?.input).toEqual({ kind: 'wait', title: 'Waiting for wait' })
      const next = wait.chunks.find((chunk) => chunk.kind === 'tool')
      continuation = $.tool
        .call({ tool: next?.kind === 'tool' ? next.name : '', tool_use_id: next?.kind === 'tool' ? next.id : '' } as never)
        .then((result) => {
          continued = result
          return result
        })
      await clock.settle()
      answer = (await child).result.answer
      expect(continued).toBeUndefined()
    }
  } finally {
    release()
    await pending
    if (continuation) await continuation
  }
  expect(before).toBe(true)
  expect(answer).toBe('steps.ts\n\n— answered by codex subagent, gpt-6-luna')
  expect(continued).toEqual({ result: 'parent output' })
  // An earlier parallel call was held before the spawn: it did not delay the child or lose output.
  const parallel = await run($, { ...step, index: 3 })
  const parallelTool = parallel.chunks.find((chunk) => chunk.kind === 'tool')
  expect(
    await $.tool.call({
      tool: parallelTool?.kind === 'tool' ? parallelTool.name : '',
      tool_use_id: parallelTool?.kind === 'tool' ? parallelTool.id : '',
    } as never),
  ).toEqual({ result: 'parallel output' })
  const last = await run($, { ...step, index: 4 })
  expect(last.result.toolUses).toEqual([])
  expect(last.result.answer).toContain('It found steps.ts.')
  expect(requests).toBe(1)
})
