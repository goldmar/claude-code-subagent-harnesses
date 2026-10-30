import type { TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { relayEvents } from '../hooks/acp/events'
import type { Norm } from '../hooks/acp/norm'
import { type Job, type Mark, pump } from '../hooks/acp/steps'
import { type Children, childRun, route, waitChild } from '../hooks/children'
import { NODE, run, STEP } from './helpers'

// Invented messages; the envelopes and field names follow codex-acp 2.3.1-preview.9.
const ROOT = 'parent-thread'
const CHILD = `${ROOT}:subagent:helper-thread`
const PROMPT = `model: gpt-6-luna\nthinking: high\n\nReview the fictional orchard inventory.\n${'Keep every instruction. '.repeat(12)}`
const FOLLOW = 'Also check the pear counts.\nExplain any mismatch.'
const start = () => {
  const parse = relayEvents()
  parse(JSON.stringify({ relay: 'session', sessionId: ROOT }))
  parse(JSON.stringify({ relay: 'steered' }))
  return parse
}
const update = (parse: ReturnType<typeof start>, sessionId: string, update: unknown) => parse(JSON.stringify({ sessionId, update }))
const announce = (parse: ReturnType<typeof start>, title?: string) =>
  update(parse, ROOT, { sessionUpdate: 'subagent_update', sessionId: CHILD, description: PROMPT, ...(title ? { title } : {}) })
const world = (): Children => ({ channels: new Map(), nested: new Map() })
const engine = (w: Children) => ({ viaChildren: { wait: ({ key }: { key: string }) => waitChild(w, key, () => ({ cancel: () => {} })) } })
const routed = (w: Children, norms: Norm[]) => norms.flatMap((n) => (n.k === 'child' || n.k === 'of' ? route(w, 'a1', 'via:codex', n) : []))

async function drain(gen: AsyncGenerator<TurnStepChunk | Mark, TurnStepResult>) {
  const out: (TurnStepChunk | Mark)[] = []
  for (;;) {
    const next = await gen.next()
    if (next.done) return { out, result: next.value }
    out.push(next.value)
  }
}

for (const title of [undefined, 'Orchard reviewer']) {
  test(`a child's native prompt precedes narration and step rows (${title ?? 'fallback title'})`, async () => {
    const parse = start()
    const w = world()
    const marks = routed(w, announce(parse, title))
    const gen = (async function* (): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
      yield* marks
      return { turnId: 'parent', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })()
    const job: Job = { turnId: 'parent', gen, held: [], outputs: new Map(), abort: new AbortController(), count: 0 }
    const steps = { tool: 'step', jobs: new Map(), calls: new Map(), spawns: new Map() }
    const parent = await drain(pump(steps, job, { turnId: 'parent', index: 0 }, new AbortController().signal))
    expect(parent.result.toolUses).toEqual([
      { name: 'Agent', input: { description: title ?? 'subagent', prompt: PROMPT, subagent_type: 'via:codex', run_in_background: true } },
    ])
    routed(w, update(parse, CHILD, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking the orchard.' } }))
    routed(
      w,
      update(parse, CHILD, {
        sessionUpdate: 'tool_call',
        toolCallId: 'read',
        kind: 'read',
        title: 'Read orchard.ts',
        status: 'in_progress',
      }),
    )
    routed(
      w,
      update(parse, CHILD, { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: 'three pears' }),
    )
    routed(w, update(parse, ROOT, { sessionUpdate: 'subagent_update', sessionId: CHILD, state: { state: 'idle' } }))
    w.nested.set('n1', { key: 'a1/parent-thread:subagent:helper-thread#1' })
    const child = await drain(childRun(w, engine(w), 'n1', 'codex', { turnId: 'child', index: 0 }, new AbortController().signal, false))
    expect(child.out.slice(0, 3)).toEqual([
      { kind: 'text', index: 0, text: 'Checking the orchard.' },
      { kind: 'call-start', id: 'read', input: { kind: 'read', title: 'Read orchard.ts' }, usage: null },
      { kind: 'call-end', id: 'read', output: 'three pears', failed: false },
    ])
    expect(child.result.answer).not.toContain(PROMPT)
  })
}

test('Codex parent steering becomes one user message before the next child narration', () => {
  const parse = start()
  announce(parse)
  const steer = {
    toolCallId: 'steer-1',
    title: 'sendInput',
    kind: 'other',
    rawInput: { prompt: FOLLOW, receiverThreadIds: ['helper-thread'], senderThreadId: ROOT },
  }
  const norms = [
    ...update(parse, ROOT, { ...steer, sessionUpdate: 'tool_call', status: 'in_progress' }),
    ...update(parse, ROOT, { ...steer, sessionUpdate: 'tool_call_update', status: 'completed' }),
    ...update(parse, ROOT, { ...steer, sessionUpdate: 'tool_call_update', status: 'completed' }),
    ...update(parse, CHILD, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'reply',
      content: { type: 'text', text: 'Checking pears.' },
    }),
  ]
  expect(norms.filter((n) => n.k === 'of')).toEqual([
    { k: 'of', child: CHILD, norm: { k: 'user', t: FOLLOW } },
    { k: 'of', child: CHILD, norm: { k: 'message' } },
    { k: 'of', child: CHILD, norm: { k: 'text', t: 'Checking pears.' } },
  ])
})

test('child ACP user chunks keep their complete message and never echo a top-level prompt', () => {
  const parse = start()
  announce(parse)
  const norms = [
    ...update(parse, ROOT, {
      sessionUpdate: 'user_message_chunk',
      messageId: 'root-input',
      content: { type: 'text', text: 'Parent only.' },
    }),
    ...update(parse, CHILD, { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Also check ' } }),
    ...update(parse, CHILD, { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'the pears.' } }),
    ...update(parse, CHILD, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'reply',
      content: { type: 'text', text: 'Checking pears.' },
    }),
  ]
  expect(norms.filter((n) => n.k === 'of')).toEqual([
    { k: 'of', child: CHILD, norm: { k: 'user', t: 'Also check the pears.' } },
    { k: 'of', child: CHILD, norm: { k: 'message' } },
    { k: 'of', child: CHILD, norm: { k: 'text', t: 'Checking pears.' } },
  ])
  expect(norms.some((n) => n.k === 'user')).toBe(false)
})

test('a child emits a user row between assistant blocks without changing its signed answer', async () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: ROOT, title: 'Reviewer', description: PROMPT })
  for (const norm of [
    { k: 'message' },
    { k: 'text', t: 'Checking fruit.' },
    { k: 'user', t: FOLLOW },
    { k: 'text', t: 'Three pears.' },
  ] as Norm[])
    route(w, 'a1', 'via:codex', { k: 'of', child: 'c', norm })
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: ROOT, state: 'idle' })
  w.nested.set('n1', { key: 'a1/c#1' })
  const child = await drain(childRun(w, engine(w), 'n1', 'codex', { turnId: 'child', index: 0 }, new AbortController().signal, false))
  expect(child.out.slice(0, 3)).toEqual([
    { kind: 'text', index: 0, text: 'Checking fruit.' },
    { kind: 'user', text: FOLLOW },
    { kind: 'text', index: 1, text: 'Three pears.' },
  ])
  expect(child.result.answer).toBe('Three pears.\n\n— answered by codex subagent')
})

test('the nested turn appends steering as a native user row between narration blocks', async ($, on) => {
  mock.clock(on)
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.read', (_, e, next) => (files.has(e.path) ? { value: files.get(e.path) ?? '' } : next(e)))
  const rows: unknown[] = []
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
  on('session.append', (_, e, next) => {
    rows.push({ kind: 'user', agentId: e.agentId, message: e.message })
    return next(e)
  })
  on('process.spawn', async function* () {
    const updates = [
      { relay: 'session', sessionId: ROOT },
      { relay: 'steered' },
      { sessionId: ROOT, update: { sessionUpdate: 'subagent_update', sessionId: CHILD, description: PROMPT } },
      {
        sessionId: CHILD,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'one', content: { type: 'text', text: 'Checking fruit.' } },
      },
      { sessionId: CHILD, update: { sessionUpdate: 'user_message_chunk', messageId: 'steer', content: { type: 'text', text: FOLLOW } } },
      {
        sessionId: CHILD,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'two', content: { type: 'text', text: 'Three pears.' } },
      },
      { sessionId: ROOT, update: { sessionUpdate: 'subagent_update', sessionId: CHILD, state: { state: 'idle' } } },
      { relay: 'done', stopReason: 'end_turn' },
    ]
    yield { stream: 'stdout', text: `${updates.map((e) => JSON.stringify(e)).join('\n')}\n` }
    return { value: { code: 0, signal: null } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'Delegate the orchard review.' })
  const parent = await run($)
  const tool = parent.chunks.find((c) => c.kind === 'tool')
  await $.agent.spawn({
    tool_use_id: tool?.kind === 'tool' ? tool.id : '',
    subagentType: 'via:codex',
    prompt: PROMPT,
    description: 'subagent',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'codex',
    parentAgentId: 'a1',
    background: true,
    fork: false,
  })
  await $.turn.start({ turnId: 'child', agentId: 'n1', text: PROMPT })
  await run($, { ...STEP, index: 1 })
  const child = $.turn.step({ ...STEP, turnId: 'child', agentId: 'n1' })
  for (;;) {
    const next = await child.next()
    if (next.done) break
    if (next.value.kind === 'text') rows.push({ kind: 'text', text: next.value.text })
  }
  expect(rows.slice(0, 3)).toEqual([
    { kind: 'text', text: 'Checking fruit.' },
    { kind: 'user', agentId: 'n1', message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: FOLLOW }] } },
    { kind: 'text', text: 'Three pears.' },
  ])
})

test('initial and collaboration prompt echoes do not duplicate native user rows', () => {
  const parse = start()
  announce(parse)
  const user = (messageId: string, text: string) =>
    update(parse, CHILD, { sessionUpdate: 'user_message_chunk', messageId, content: { type: 'text', text } })
  const reply = () => update(parse, CHILD, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking.' } })
  expect([...user('initial', PROMPT), ...reply()].filter((n) => n.k === 'of' && n.norm.k === 'user')).toEqual([])
  const send = (id: string) =>
    update(parse, ROOT, {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: 'followupTask',
      status: 'completed',
      rawInput: { prompt: FOLLOW, receiverThreadIds: ['helper-thread', 'helper-thread'] },
    })
  const first = send('one')
  const echo = [...user('echo', FOLLOW), ...reply()]
  const second = send('two') // Identical text is still a distinct instruction when sent again.
  expect([...first, ...echo, ...second].filter((n) => n.k === 'of' && n.norm.k === 'user')).toEqual([
    { k: 'of', child: CHILD, norm: { k: 'user', t: FOLLOW } },
    { k: 'of', child: CHILD, norm: { k: 'user', t: FOLLOW } },
  ])
})

test('an ACP echo before collaboration completion is one row, and a later identical user prompt is new input', () => {
  const parse = start()
  announce(parse)
  const user = (text: string) => update(parse, CHILD, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
  const reply = () => update(parse, CHILD, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking.' } })
  reply()
  const norms = [
    ...user(FOLLOW),
    ...update(parse, ROOT, {
      sessionUpdate: 'tool_call',
      toolCallId: 'one',
      title: 'sendInput',
      status: 'completed',
      rawInput: { prompt: FOLLOW, receiverThreadIds: ['helper-thread'] },
    }),
    ...reply(),
    ...user(PROMPT),
    ...reply(),
  ]
  expect(norms.filter((n) => n.k === 'of' && n.norm.k === 'user')).toEqual([
    { k: 'of', child: CHILD, norm: { k: 'user', t: FOLLOW } },
    { k: 'of', child: CHILD, norm: { k: 'user', t: PROMPT } },
  ])
})

test('failed steering, unknown receivers, history and ordinary tool input create no user rows', () => {
  const parse = start()
  announce(parse)
  const norms = ['failed', 'unknown', 'ordinary'].flatMap((id) =>
    update(parse, ROOT, {
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: id === 'ordinary' ? 'execute' : 'sendInput',
      status: id === 'failed' ? 'failed' : 'completed',
      rawInput: { prompt: FOLLOW, receiverThreadIds: [id === 'unknown' ? 'unannounced' : 'helper-thread'] },
    }),
  )
  expect(norms.filter((n) => n.k === 'of')).toEqual([])
  const history = relayEvents()
  expect(update(history, ROOT, { sessionUpdate: 'subagent_update', sessionId: CHILD, description: PROMPT })).toEqual([])
  expect(update(history, CHILD, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: FOLLOW } })).toEqual([])
})

test('a follow-up after idle opens its own full prompt and keeps a grandchild under its parent', () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'outer', parent: ROOT, title: 'Orchard' })
  route(w, 'a1', 'via:codex', { k: 'child', id: 'inner', parent: 'outer', title: 'Pears', description: PROMPT })
  route(w, 'a1', 'via:codex', { k: 'child', id: 'inner', parent: 'outer', state: 'idle' })
  expect(route(w, 'a1', 'via:codex', { k: 'of', child: 'inner', norm: { k: 'user', t: FOLLOW } })).toEqual([])
  expect(w.channels.get('a1/outer#1')?.queue.at(-1)).toEqual({ k: 'spawn', child: 'a1/inner#2' })
  expect(w.channels.get('a1/inner#2')?.description).toBe(FOLLOW)
  expect(w.channels.get('a1/inner#2')?.queue).toEqual([])
  expect(w.channels.get('a1/inner#1')?.description).toBe(PROMPT)
})
