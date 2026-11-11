import { expect, mock, type TestBody, test } from 'claude-code/testing'
import { agentStore, NODE, run, runTurn, STEP } from './helpers'

type On = Parameters<TestBody>[1]

// What the engine does when via's turn.step hook is skipped: the request goes to the model.
function fallback(on: On) {
  let requests = 0
  on('turn.step', async function* (_, e) {
    requests += 1
    yield { kind: 'text', index: 0, text: 'API fallback' }
    return { turnId: e.turnId, index: e.index, answer: 'API fallback', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return () => requests
}

// Captured 2026-10-28 from relay/relay.mjs over codex-acp 2.3.1-preview.8, trimmed
// (copied from tests/children.test.ts).
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
  { sessionId: CHILD, update: { content: { text: 'steps.ts', type: 'text' }, messageId: 'm1', sessionUpdate: 'agent_message_chunk' } },
  { sessionId: ROOT, update: { sessionId: CHILD, state: { stopReason: 'end_turn', state: 'idle' }, sessionUpdate: 'subagent_update' } },
]

// A parent's run pauses at its Agent call; its next step supplies the child's answer, so the nested agent sits
// on its empty queue until then (from #24's fixture).
async function nestedChild(
  $: Parameters<TestBody>[0],
  on: On,
  failure?: string,
  refused?: 'transcript',
  auto?: boolean,
  afterText: unknown[] = [],
) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  // The record the parent's spawn left.
  const store = agentStore(on, { a1: { harness: 'codex' } })
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'parent', type: 'via:codex', status: 'running' }] }))
  // A refused transcript read throws inside via's step: any throw there does the same.
  on('session.messages', (_, e) => (refused === 'transcript' && e.agentId === 'n1' ? { deny: 'transcript unavailable' } : { value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', (_, e) => ({ agentId: 'n1', model: e.model ?? 'codex' }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: NODE }))
  const line = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: line(CAPTURED.slice(0, 5)) }
    yield {
      stream: 'stdout',
      text: line([
        CAPTURED[5],
        ...afterText,
        failure
          ? {
              sessionId: ROOT,
              update: {
                sessionId: CHILD,
                state: { state: 'idle', stopReason: 'error', error: { message: failure } },
                sessionUpdate: 'subagent_update',
              },
            }
          : CAPTURED[6],
        { relay: 'done', stopReason: 'end_turn' },
      ]),
    }
    return { value: { code: 0, signal: null } }
  })
  const requests = fallback(on)
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
    ...(auto ? { permissionMode: 'auto' as const } : {}),
  })
  await $.turn.start({ turnId: 'nested', agentId: 'n1', text: 'List acp' })
  return { clock, requests, store, finish: () => run($, { ...STEP, index: 1 }) }
}

test('a failed nested child keeps its partial text and ends with the failure, never a signature', async ($, on) => {
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
  expect(child.requests()).toBe(0)
})

test("a nested step whose hook throws ends in via, never as a model request with the harness's model", async ($, on) => {
  const child = await nestedChild($, on, undefined, 'transcript')
  const { result } = await run($, { ...STEP, turnId: 'nested', agentId: 'n1' })
  expect(result.answer).toBe('The codex subagent failed: via could not render its next step.')
  expect(result.stopReason).toBe('end_turn')
  expect(result.toolUses).toEqual([])
  expect(child.requests()).toBe(0)
})

test('a step whose hook throws says why in the log, not only in the answer', async ($, on) => {
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  const child = await nestedChild($, on, undefined, 'transcript')
  await run($, { ...STEP, turnId: 'nested', agentId: 'n1' })
  expect(logged.some((line) => line.includes("via's step for codex failed") && line.includes('transcript unavailable'))).toBe(true)
  expect(child.requests()).toBe(0)
})

test("a nested agent's spawn and answer are kept for a new process", async ($, on) => {
  const child = await nestedChild($, on)
  expect(child.store.record('n1')).toMatchObject({ harness: 'codex', handback: false, nested: true })
  const pending = run($, { ...STEP, turnId: 'nested', agentId: 'n1', model: 'gpt-6-luna' })
  await child.clock.settle()
  await child.finish()
  const { result } = await pending
  expect(child.store.record('n1')?.report).toBe(result.answer)
})

// A new process (a session sent to the background) resumes a nested agent as general-purpose, with no
// spawn and no parent run: its saved answer, or the cut-off, and never a request to the model.
function newProcess(on: On, report?: string, handback?: { handedBack: boolean }) {
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [{ id: 'n1', description: 'List acp', type: 'general-purpose', status: 'running' }] }))
  agentStore(on, {
    n1: {
      harness: 'codex',
      nested: true,
      handback: handback !== undefined,
      ...(report ? { report } : {}),
      handedBack: handback?.handedBack,
    },
  })
  let spawned = 0
  // biome-ignore lint/correctness/useYield: a streaming hook must be an async generator, even one that answers at once
  on('process.spawn', async function* () {
    spawned += 1
    return { value: { code: 0, signal: null } }
  })
  on('session.messages', () => ({ value: [] }))
  return { requests: fallback(on), spawned: () => spawned }
}

test('a nested agent in a new process answers with its saved answer', async ($, on) => {
  const fresh = newProcess(on, 'steps.ts\n\n— answered by codex subagent, gpt-6-luna')
  const { result } = await run($, { ...STEP, turnId: 'resumed', agentId: 'n1' })
  expect(result.answer).toBe('steps.ts\n\n— answered by codex subagent, gpt-6-luna')
  expect(fresh.requests()).toBe(0)
  expect(fresh.spawned()).toBe(0)
})

test('a nested agent in a new process with no saved answer says it was cut off, and runs nothing', async ($, on) => {
  const fresh = newProcess(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  // Even with a turn: the nested agent's prompt is its parent's harness's to run, not a new run's.
  await $.turn.start({ turnId: 'resumed', agentId: 'n1', text: 'List acp' })
  const { result } = await run($, { ...STEP, turnId: 'resumed', agentId: 'n1' })
  expect(result.answer).toContain('codex run was cut off before it answered')
  expect(fresh.requests()).toBe(0)
  expect(fresh.spawned()).toBe(0)
})

test('an auto-mode nested agent its old process handed back is not handed back again in a new process', async ($, on) => {
  const report = 'steps.ts\n\n— answered by codex subagent, gpt-6-luna'
  newProcess(on, report, { handedBack: true })
  const { result } = await run($, { ...STEP, turnId: 'resumed', agentId: 'n1' })
  expect(result.toolUses).toEqual([])
  expect(result.answer).toBe(report)
})

test('an auto-mode nested agent never handed back hands its saved answer back in a new process', async ($, on) => {
  newProcess(on, 'steps.ts', { handedBack: false })
  const { result } = await run($, { ...STEP, turnId: 'resumed', agentId: 'n1' })
  expect(result.toolUses[0]?.name).toBe('SubagentHandback')
})

test('a nested agent whose step failed is saved as failed, not left to read as cut off', async ($, on) => {
  const child = await nestedChild($, on, undefined, 'transcript')
  await run($, { ...STEP, turnId: 'nested', agentId: 'n1' })
  expect(child.store.record('n1')?.report).toBe('The codex subagent failed: via could not render its next step.')
})

test("an auto-mode nested agent's handback is marked done once it hands back, for a new process to see", async ($, on) => {
  const child = await nestedChild($, on, undefined, undefined, true)
  const pending = run($, { ...STEP, turnId: 'nested', agentId: 'n1', model: 'gpt-6-luna' })
  await child.clock.settle()
  await child.finish()
  const { result } = await pending
  expect(result.toolUses[0]?.name).toBe('SubagentHandback')
  expect(child.store.record('n1')?.handedBack).toBe(true)
})

// The same as a top-level run: a child that answers and then makes one last call ends in a step of its own,
// and Claude Code takes that step's text as the nested agent's answer.
test("a nested child's answer said before its last call is said again in its last step", async ($, on) => {
  const child = await nestedChild($, on, undefined, undefined, false, [
    { sessionId: CHILD, update: { toolCallId: 'x', title: 'ls', kind: 'read', status: 'in_progress', sessionUpdate: 'tool_call' } },
    { sessionId: CHILD, update: { toolCallId: 'x', status: 'failed', sessionUpdate: 'tool_call_update' } },
  ])
  const pending = runTurn($, { ...STEP, turnId: 'nested', agentId: 'n1', model: 'gpt-6-luna' })
  await child.clock.settle()
  await child.finish()
  const { chunks, result } = await pending
  expect(result.answer).toBe('steps.ts\n\n— answered by codex subagent, gpt-6-luna')
  const lastCall = chunks.findLastIndex((c) => c.kind === 'tool')
  const after = chunks.slice(lastCall + 1).map((c) => (c.kind === 'text' ? c.text : ''))
  expect(after.join('')).toBe(result.answer)
})
