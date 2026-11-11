import type { TurnStepChunk, TurnStepResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { relayEvents } from '../hooks/acp/events'
import type { Norm } from '../hooks/acp/norm'
import { CHILD_CALL, type Job, type Mark, pump } from '../hooks/acp/steps'
import { type Children, childRun, closeChildren, route, woken } from '../hooks/children'

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

const world = (): Children => ({ channels: new Map(), nested: new Map() })
const of = (child: string, norm: Norm): Extract<Norm, { k: 'of' }> => ({ k: 'of', child, norm })

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
  w.nested.set('n1', 'a1/c#1')
  const { out, result } = await drain(
    childRun(w, 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false, () => new Promise(() => {})),
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
  w.nested.set('n1', 'a1/c#1')
  const { result } = await drain(
    childRun(w, 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, true, () => new Promise(() => {})),
  )
  expect(result.toolUses[0]?.name).toBe('SubagentHandback')
  expect(JSON.stringify(result.toolUses[0]?.input)).toContain('done')
})

test("a subagent's own subagent is spawned by its nested agent, not the run's", async () => {
  const w = world()
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', title: 'outer' })
  expect(route(w, 'a1', 'via:codex', { k: 'child', id: 'g', parent: 'c', title: 'inner' })).toEqual([])
  route(w, 'a1', 'via:codex', { k: 'child', id: 'c', parent: 'root', state: 'idle' })
  w.nested.set('n1', 'a1/c#1')
  const { out } = await drain(
    childRun(w, 'n1', 'codex', { turnId: 't1', index: 0 }, new AbortController().signal, false, () => new Promise(() => {})),
  )
  expect(out.filter((c) => c.kind === 'spawn')).toEqual([{ kind: 'spawn', child: 'a1/g#1', type: 'via:codex', title: 'inner' }])
})

test('a spawn mark ends the step with an Agent call in the background, remembered for its spawn', async () => {
  const gen = (async function* (): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
    yield { kind: 'spawn', child: 'a1/c#1', type: 'via:codex', title: 'List acp' }
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })()
  const job: Job = { turnId: 't1', gen, held: [], outputs: new Map(), abort: new AbortController(), count: 0 }
  const w = { tool: 'mcp__plugin_via_step__step', jobs: new Map([['a1', job]]), calls: new Map(), spawns: new Map<string, string>() }
  const step = pump(w, job, { turnId: 't1', index: 0, agentId: 'a1' }, new AbortController().signal, () => new Promise(() => {}))
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
