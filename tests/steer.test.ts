import { expect, mock, test } from 'claude-code/testing'
import { arrange, bottom, ENV, hang, hold, lines, node, requestOf, run, type Spawn, split, storage, type Write } from './helpers'

test('a SendMessage to a live pi agent is steered into its inbox', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  const delivered = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', tool_use_id: 't' })
  expect(delivered.result).toEqual({ success: true, message: 'Delivered to the running pi agent; pi reads it at its next step.' })
  expect(writes.at(-1)?.path).toBe('/home/u/.claude/via/inbox/pi-a1.jsonl')
  expect(writes.at(-1)?.text.split('\n')).toContain(JSON.stringify('also do B'))
  await clock.advance(30 * 60 * 1000)
  await pending
})

// Captured 2026-10-28: a message typed into a running via agent's view reaches it only as this attachment,
// at its next step, which no model reads.
const TYPED = (text: string) =>
  `<system-reminder>\nThe user sent a new message while you were working:\n${text}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>`
const QUEUED = (agentId: string, text: string) => ({
  message: {
    type: 'attachment' as const,
    name: 'queued_command',
    role: 'user' as const,
    isMeta: true as const,
    content: [{ type: 'text' as const, text: TYPED(text) }],
  },
  door: 'attachment' as const,
  origin: { kind: 'composer' as const },
  uuid: 'u1',
  agentId,
})

test("a message typed into a running pi agent's view is steered into its inbox, an interrupt too", async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  await $.session.append(QUEUED('a1', 'also do B\non two lines'))
  expect(writes.at(-1)?.path).toBe('/home/u/.claude/via/inbox/pi-a1.jsonl')
  expect(writes.at(-1)?.text.split('\n')).toContain(JSON.stringify('also do B\non two lines'))
  await $.session.append(QUEUED('a1', 'interrupt: stop and do C'))
  expect(writes.at(-1)?.text.split('\n')).toContain(JSON.stringify({ interrupt: 'stop and do C' }))
  await clock.advance(30 * 60 * 1000)
  await pending
})

test('an attachment for an agent with no live run, or of another kind, writes nothing', async ($, on) => {
  const writes: Write[] = []
  bottom(on, writes)
  await $.session.append(QUEUED('a1', 'later'))
  await $.session.append({ ...QUEUED('a1', 'x'), message: { ...QUEUED('a1', 'x').message, name: 'nested_memory' } })
  expect(writes).toEqual([])
})

test("a queued delivery the person did not type, or whose framing is not a typed message's, never steers", async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  const before = writes.length
  // Found by review: a nested agent's end, a peer's or a channel's message ride the same attachment.
  await $.session.append({ ...QUEUED('a1', 'from a notification'), origin: { kind: 'task-notification' } })
  const raw = { type: 'text' as const, text: '<task-notification>\n<status>completed</status>\n</task-notification>' }
  await $.session.append({ ...QUEUED('a1', 'x'), message: { ...QUEUED('a1', 'x').message, content: [raw] } })
  expect(writes.length).toBe(before)
  await clock.advance(30 * 60 * 1000)
  await pending
})

test('a SendMessage to an agent with no live run becomes a follow-up', async ($, on) => {
  const writes: Write[] = []
  bottom(on, writes)
  let called = false
  on('tool.call', { tool: 'SendMessage' }, (_, e) => {
    called = true
    return { result: { success: true, message: `queued for ${e.to}` } }
  })
  const answered = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'later', tool_use_id: 't' })
  expect(called).toBe(true)
  expect(answered.result).toEqual({ success: true, message: 'queued for a1' })
  expect(writes).toEqual([])
})

test('a SendMessage that asks for an idle notice goes on to the engine', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes)
  let called = false
  on('tool.call', { tool: 'SendMessage' }, () => {
    called = true
    return { result: { success: true, message: 'subscribed' } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  const before = writes.length
  const answered = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', notify_when_idle: true, tool_use_id: 't' })
  expect(called).toBe(true)
  expect(answered.result).toEqual({ success: true, message: 'subscribed' })
  expect(writes.length).toBe(before)
  await clock.advance(30 * 60 * 1000)
  await pending
})

test('the inbox is cleared when the pi run ends', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', tool_use_id: 't' })
  expect(writes.at(-1)?.text).toContain('also do B')
  await clock.advance(30 * 60 * 1000)
  await pending
  expect(writes.filter((write) => write.path === '/home/u/.claude/via/inbox/pi-a1.jsonl').at(-1)).toEqual({
    path: '/home/u/.claude/via/inbox/pi-a1.jsonl',
    text: '',
  })
})

test('a steer pi consumed is not reported as undelivered', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const prompt = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_end', message: { role: 'user' } },
  ]
  const steered = [
    { type: 'message_end', message: { role: 'user' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'all done' } },
    { type: 'message_end', message: { role: 'assistant', usage: {} } },
  ]
  const runControl = hold(on, spawns, writes, prompt, steered)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  for (let i = 0; i < 20 && spawns.length === 0; i += 1) await clock.settle()
  expect(spawns).toHaveLength(1)
  const delivered = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', tool_use_id: 't' })
  expect(delivered.result).toEqual({ success: true, message: 'Delivered to the running pi agent; pi reads it at its next step.' })
  expect(writes.at(-1)?.text).toContain('also do B')
  runControl.release()
  const { result } = await pending
  expect(result.answer).toContain('all done')
  expect(result.answer).not.toContain('Not delivered before pi finished')
})

test('a steer pi never took is named as undelivered', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const prompt = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_end', message: { role: 'user' } },
  ]
  const finished = [
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'all done' } },
    { type: 'message_end', message: { role: 'assistant', usage: {} } },
  ]
  const runControl = hold(on, spawns, writes, prompt, finished)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  for (let i = 0; i < 20 && spawns.length === 0; i += 1) await clock.settle()
  expect(spawns).toHaveLength(1)
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', tool_use_id: 't' })
  expect(writes.at(-1)?.text).toContain('also do B')
  runControl.release()
  const { result } = await pending
  expect(result.answer).toContain('Not delivered before pi finished (send again as a follow-up):')
  expect(result.answer).toContain('also do B')
  expect(result.answer.indexOf('Not delivered before pi finished')).toBeLessThan(result.answer.indexOf('— answered by pi'))
})

test('with no home folder there is no inbox, never the shared /tmp, and a SendMessage becomes a follow-up', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes, { TMPDIR: '/tmp' })
  let called = false
  on('tool.call', { tool: 'SendMessage' }, () => {
    called = true
    return { result: { success: true, message: 'queued' } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', tool_use_id: 't' })
  expect(called).toBe(true)
  expect(writes).toEqual([])
  expect(spawns[0]?.env).toEqual({ PI_INBOX: '' })
  await clock.advance(30 * 60 * 1000)
  await pending
})

test('an inbox that cannot be written means no steering, not a failed run', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, split(lines), 0, [], 'reject')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(spawns[0]?.env).toEqual({ PI_INBOX: '' })
  expect(result.answer.endsWith('all done\n\n— answered by pi, openrouter/kimi')).toBe(true)
})

test('USERPROFILE stands in for HOME', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  hang(on, spawns, [], { USERPROFILE: 'C:/Users/u' })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  expect(spawns[0]?.env).toEqual({ PI_INBOX: 'C:/Users/u/.claude/via/inbox/pi-a1.jsonl' })
  await clock.advance(30 * 60 * 1000)
  await pending
})

test('an interrupt: message aborts the running pi step, then runs on the same session after the steers it cut off', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const files = storage(on)
  mock.env(on, ENV)
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'via:pi', status: 'running' }] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  node(on)
  let interrupted!: () => void
  const asked = new Promise<void>((resolve) => {
    interrupted = resolve
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    files.set(e.path, e.text)
    if (e.text.includes('"interrupt"')) interrupted()
    return { value: undefined }
  })
  const start = { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } }
  on('process.spawn', async function* (_, e) {
    spawns.push(requestOf(e))
    if (spawns.length === 1) {
      yield {
        stream: 'stdout' as const,
        text: `${JSON.stringify(start)}\n${JSON.stringify({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'sleep 30' } })}\n`,
      }
      await asked
      // What pi prints when its extension aborts the step (captured from pi -p --mode json).
      const aborted = {
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'This operation was aborted', usage: { input: 1, output: 1 } },
      }
      yield { stream: 'stdout' as const, text: `${JSON.stringify(aborted)}\n` }
      return { value: { code: 0, signal: null } }
    }
    yield { stream: 'stdout' as const, text: lines }
    return { value: { code: 0, signal: null } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'also do B', tool_use_id: 's' })
  const sent = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'interrupt: stop and do C', tool_use_id: 'i' })
  expect(sent.result).toEqual({
    success: true,
    message: 'Interrupting the running pi agent: it stops its current step, then takes this message.',
  })
  expect(writes.find((w) => w.text.includes('"interrupt"'))?.text.split('\n')).toContain(JSON.stringify({ interrupt: 'stop and do C' }))
  const { chunks, result } = await pending
  expect(spawns).toHaveLength(2)
  // pi's session id is fixed per agent, so the same argv resumes the same session.
  expect(spawns[1]?.argv).toEqual(spawns[0]?.argv)
  expect(spawns[1]?.argv).toEqual(expect.arrayContaining(['--session-id', 'pi-a1']))
  expect(spawns[1]?.input).toBe('also do B\n\nstop and do C')
  expect(result.answer).toBe('all done\n\n— answered by pi, openrouter/kimi')
  expect(result.answer).not.toContain('aborted')
  const blocks = chunks.filter((c) => c.kind === 'text' || c.kind === 'thinking').map((c) => (c as { index: number }).index)
  expect(blocks).toEqual([...blocks].sort((a, b) => a - b))
  expect(chunks.some((c) => c.kind === 'text' && c.text.includes('▸ interrupted'))).toBe(true)
})

test('a plain steer is still a steer, and only steers are named as undelivered', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  hang(on, spawns, writes)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  const sent = await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'interruption is fine, carry on', tool_use_id: 's' })
  expect(sent.result).toEqual({ success: true, message: 'Delivered to the running pi agent; pi reads it at its next step.' })
  await clock.advance(30 * 60 * 1000)
  const { result } = await pending
  expect(result.answer).toContain('Not delivered before pi finished')
  expect(result.answer).toContain('interruption is fine, carry on')
})

test('an interrupt that lands after pi finished keeps the answer and names the interrupt as undelivered', async ($, on) => {
  const clock = mock.clock(on)
  const spawns: Spawn[] = []
  const writes: Write[] = []
  const done = [
    { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'all done' } },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 1, output: 1 } } },
  ]
  const { release } = hold(on, spawns, writes, done, [])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const pending = run($)
  await clock.settle()
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'interrupt: too late', tool_use_id: 'i' })
  release()
  const { result } = await pending
  expect(spawns).toHaveLength(1)
  expect(result.answer).toContain('all done')
  expect(result.answer).toContain('Not delivered before pi finished')
  expect(result.answer).toContain('too late')
})
