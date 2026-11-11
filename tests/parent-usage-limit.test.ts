import { expect, mock, type TestBody, test } from 'claude-code/testing'
import { NODE, run, STEP } from './helpers'

type On = Parameters<TestBody>[1]

async function runningCodex($: Parameters<TestBody>[0], on: On) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'synthetic worker', type: 'via:codex', status: 'running' }] }))
  on('session.messages', () => ({ value: [] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.StopFailure', () => ({}))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: NODE }))
  let requests = 0
  let closed = false
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const line = (events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  on('process.spawn', async function* () {
    requests += 1
    try {
      yield {
        stream: 'stdout',
        text: line([
          { relay: 'session', sessionId: 'synthetic-codex-session' },
          { relay: 'steered' },
          {
            update: { sessionUpdate: 'tool_call', toolCallId: 'work', kind: 'execute', title: 'synthetic work', status: 'in_progress' },
          },
        ]),
      }
      await held
      yield {
        stream: 'stdout',
        text: line([
          { update: { sessionUpdate: 'tool_call_update', toolCallId: 'work', status: 'completed', rawOutput: 'WORK_DONE' } },
          { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CODEX_DONE' } } },
        ]),
      }
      return { value: { code: 0, signal: null } }
    } finally {
      closed = true
    }
  })
  let fallback = 0
  on('turn.step', async function* (_, e) {
    fallback += 1
    yield { kind: 'text', index: 0, text: 'unexpected provider request' }
    return { turnId: e.turnId, index: e.index, answer: 'unexpected provider request', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  // The main loop and a background subagent own different turn ids. A parent's API failure is NOT
  // a completion/abort of the Codex turn, nor a session.end. See the engine's TurnCompleteInput.
  await $.turn.start({ turnId: 'parent', text: 'synthetic parent task' })
  await $.turn.start({ turnId: 'codex-work', agentId: 'a1', text: 'synthetic worker task' })
  const step = { ...STEP, turnId: 'codex-work' }
  const first = await run($, step)
  const tool = first.chunks.find((chunk) => chunk.kind === 'tool')
  expect(tool?.kind === 'tool' && tool.name).toBe('mcp__plugin_via_step__step')
  return { clock, step, tool, release, requests: () => requests, closed: () => closed, fallback: () => fallback }
}

for (const message of ['API Error: 429 Too Many Requests', "You've hit your limit"])
  test(`a parent's usage-limit turn end leaves a running Codex job alive (${message})`, async ($, on) => {
    const worker = await runningCodex($, on)
    await $.classic.StopFailure({ error: 'rate_limit', error_details: message, last_assistant_message: message })
    await $.turn.complete({ turnId: 'parent', reason: 'error', answer: message, durationMs: 1, isAborted: false })
    await worker.clock.settle()
    expect(worker.closed()).toBe(false)
    expect(worker.requests()).toBe(1)
    // The user can return to the parent while the original worker still owns its turn and relay.
    await $.turn.start({ turnId: 'parent-after-limit', text: 'continue after the limit' })
    worker.release()
    const tool = worker.tool
    expect(await $.tool.call({ tool: 'mcp__plugin_via_step__step', tool_use_id: tool?.kind === 'tool' ? tool.id : '' } as never)).toEqual({
      result: 'WORK_DONE',
    })
    const { result } = await run($, { ...worker.step, index: 1 })
    expect(result.answer).toBe('CODEX_DONE\n\n— answered by codex, model not reported')
    expect(result.stopReason).toBe('end_turn')
    expect(worker.requests()).toBe(1)
    expect(worker.fallback()).toBe(0)
  })

test('ending the Codex turn itself stops its run; a later step reports cut-off instead of replaying it', async ($, on) => {
  const worker = await runningCodex($, on)
  await $.turn.complete({ turnId: 'codex-work', agentId: 'a1', reason: 'aborted', answer: '', durationMs: 1, isAborted: true })
  await worker.clock.settle()
  expect(worker.closed()).toBe(true)
  const { result } = await run($, { ...worker.step, turnId: 'after-stopped-worker', index: 1 })
  expect(result.answer).toContain('codex run was cut off before it answered')
  expect(worker.requests()).toBe(1)
  expect(worker.fallback()).toBe(0)
})
