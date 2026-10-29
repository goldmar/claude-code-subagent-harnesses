import { expect, mock, type TestBody, test } from 'claude-code/testing'

import { run, STEP, storage } from '../helpers'

type TestOn = Parameters<TestBody>[1]
type Spawn = { argv: string[]; input: string | undefined }

// Captured from agy 1.4.7 `--output-format stream-json` (2026-10-24), compacted: init's tool
// list, tool outputs and timings dropped; every field the adapter reads kept as captured.
const RUN = `${[
  '{"event":"init","conversation_id":"bcaf913f-b720-4789-919c-194b72343a9d","init":{"permission_mode":"always-proceed"}}',
  '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"PONG7"}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\\n","usage":{"input_tokens":7849,"output_tokens":293,"thinking_tokens":290,"cache_read_tokens":0,"total_tokens":8142}}}',
  '{"event":"result","result":{"status":"SUCCESS","num_turns":1,"usage":{"input_tokens":7849,"output_tokens":293,"thinking_tokens":290,"cache_read_tokens":0,"total_tokens":8142}}}',
].join('\n')}\n`
// A question that read a file, then answered; the last step read 17582 cached tokens.
const TOOLS = `${[
  '{"event":"init","conversation_id":"3cc9bc03-3f0a-499f-b17c-f701c893df9b","init":{"permission_mode":"always-proceed"}}',
  '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":8649,"output_tokens":639,"thinking_tokens":556,"cache_read_tokens":0,"total_tokens":9288}}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/w/seed"}}}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/w/seed"}}}}',
  '{"event":"step_update","step_update":{"step_index":23,"state":"ACTIVE","step_type":"agent_response","text_delta":"seed"}}',
  '{"event":"step_update","step_update":{"step_index":23,"state":"DONE","step_type":"agent_response","text_delta":"\\n","usage":{"input_tokens":3464,"output_tokens":868,"thinking_tokens":867,"cache_read_tokens":17582,"total_tokens":4332}}}',
  '{"event":"result","result":{"status":"SUCCESS","num_turns":1,"usage":{"input_tokens":139191,"output_tokens":3048,"thinking_tokens":2250,"cache_read_tokens":17582,"total_tokens":142239}}}',
].join('\n')}\n`
// Text, a tool, then text: two agent_response steps (agy's own result.response joins both).
const TWO = `${[
  '{"event":"init","conversation_id":"1c67bfa1-e8e9-427f-9649-abf2256322ac","init":{"permission_mode":"always-proceed"}}',
  '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Checking the file now"}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"."}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\\n","usage":{"input_tokens":7868,"output_tokens":1424,"thinking_tokens":1335,"cache_read_tokens":0,"total_tokens":9292}}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/w/seed2"}}}}',
  '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/w/seed2"}}}}',
  '{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"zebra-41"}}',
  '{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"\\n","usage":{"input_tokens":9381,"output_tokens":70,"thinking_tokens":66,"cache_read_tokens":0,"total_tokens":9451}}}',
  '{"event":"result","result":{"status":"SUCCESS","num_turns":1,"usage":{"input_tokens":17249,"output_tokens":1494,"thinking_tokens":1401,"cache_read_tokens":0,"total_tokens":18743}}}',
].join('\n')}\n`
// A follow-up resumed with --conversation: the same id comes back.
const RESUMED = `${[
  '{"event":"init","conversation_id":"f99e03a5-cc1d-480b-89df-72c64d19928d","init":{"permission_mode":"always-proceed"}}',
  '{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"step_index":5,"state":"DONE","step_type":"system_message"}}',
  '{"event":"step_update","step_update":{"step_index":6,"state":"ACTIVE","step_type":"agent_response","text_delta":"zebra-41"}}',
  '{"event":"step_update","step_update":{"step_index":6,"state":"DONE","step_type":"agent_response","text_delta":"\\n","usage":{"input_tokens":8593,"output_tokens":49,"thinking_tokens":45,"cache_read_tokens":0,"total_tokens":8642}}}',
  '{"event":"result","result":{"status":"SUCCESS","num_turns":2,"usage":{"input_tokens":24752,"output_tokens":485,"thinking_tokens":393,"cache_read_tokens":0,"total_tokens":25237}}}',
].join('\n')}\n`
const RESUMED_ID = 'f99e03a5-cc1d-480b-89df-72c64d19928d'
const RUN_ID = 'bcaf913f-b720-4789-919c-194b72343a9d'
const AGENT = { id: 'a1', description: 'x', type: 'via:agy', status: 'running' } as const
const MODEL = JSON.stringify({ status: 'SUCCESS', command: { name: 'model', data: { id: 'gemini-3.8-flash-high', effort: 'high' } } })

function arrange(
  on: TestOn,
  spawns: Spawn[],
  out: { stdout?: string; stderr?: string; code?: number } = { stdout: RUN },
  probes: string[][] = [],
  probe: { exitCode: number; stdout: string } | 'reject' = { exitCode: 0, stdout: MODEL },
) {
  storage(on)
  mock.env(on, {})
  on('agent.list', () => ({ value: [AGENT] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'node')
      return { value: { exitCode: 0, stdout: '26.12.1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    probes.push([...e.argv])
    if (probe === 'reject') throw new Error('timed out after 15000 ms')
    return { value: { exitCode: probe.exitCode, stdout: probe.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: [...e.argv], input: e.input })
    if (out.stdout) yield { stream: 'stdout' as const, text: out.stdout }
    if (out.stderr) yield { stream: 'stderr' as const, text: out.stderr }
    return { value: { code: out.code ?? 0, signal: null } }
  })
}

const NEW = ['agy', '--output-format', 'stream-json', '--disable-slash-commands', '--sandbox']

test('an agy agent sends its prompt on stdin and signs with the model agy says the flags select', async ($, on) => {
  const spawns: Spawn[] = []
  const probes: string[][] = []
  arrange(on, spawns, undefined, probes)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'say PONG7' })
  const { result } = await run($)
  expect(spawns[0]?.argv).toEqual(NEW)
  expect(spawns[0]?.input).toBe('say PONG7')
  expect(probes).toEqual([['agy', '--output-format', 'json', '-p=/model']])
  expect(result.answer).toBe('PONG7\n\n— answered by agy, gemini-3.8-flash-high')
  expect(result.usage).toEqual({
    model: 'gemini-3.8-flash-high',
    input_tokens: 7849,
    output_tokens: 293,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
})

test('a prompt that starts with /, @ or -- reaches agy as text on stdin', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '/model --help @README.md' })
  await run($)
  expect(spawns[0]?.argv).toEqual(NEW)
  expect(spawns[0]?.input).toBe('/model --help @README.md')
})

test('model and thinking lines become --model and --effort, for the run and for the model probe', async ($, on) => {
  const spawns: Spawn[] = []
  const probes: string[][] = []
  arrange(on, spawns, undefined, probes)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: gemini-3.8-flash\nthinking: low\ngo' })
  await run($)
  expect(spawns[0]?.argv).toEqual([...NEW, '--model', 'gemini-3.8-flash', '--effort', 'low'])
  expect(probes[0]).toEqual(['agy', '--output-format', 'json', '--model', 'gemini-3.8-flash', '--effort', 'low', '-p=/model'])
})

test('when the probe fails, a run with no model line says the model was not reported', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, [], { exitCode: 1, stdout: '' })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toBe('PONG7\n\n— answered by agy, model not reported')
  expect(result.usage).toBeNull()
})

test('a tools line is refused: agy has no read-only mode', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook around' })
  const { result } = await run($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('agy cannot enforce read-only tools, so a tools line is refused.')
})

test('a thinking level agy lacks is refused', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'thinking: off\ngo' })
  const { result } = await run($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('thinking must be one of low, medium, high, xhigh, max')
})

test('a tool step shows once, only the last message is the answer, and usage keeps cached reads apart', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, { stdout: TOOLS })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'what is in seed?' })
  const { chunks, result } = await run($)
  expect(chunks.filter((c) => c.kind === 'text' && c.text.includes('▸ read_file')).length).toBe(1)
  expect(result.answer).toBe('seed\n\n— answered by agy, gemini-3.8-flash-high')
  // The last step, not both steps summed.
  expect(result.usage).toEqual({
    model: 'gemini-3.8-flash-high',
    input_tokens: 3464,
    output_tokens: 868,
    cache_read_input_tokens: 17582,
    cache_creation_input_tokens: 0,
  })
})

test('the conversation id is saved, and a follow-up resumes it with --conversation', async ($, on) => {
  const spawns: Spawn[] = []
  const saved: unknown[] = []
  arrange(on, spawns)
  on('state.set', (_, e, next) => {
    if (e.key === 'sessions') saved.push(e.value)
    return next(e)
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'say PONG7' })
  await run($)
  expect(saved).toEqual([RUN_ID])
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'and again' })
  await run($, { ...STEP, turnId: 't2', messageCount: 2 })
  expect(spawns[1]?.argv).toEqual([...NEW, '--conversation', RUN_ID])
})

test('a resumed conversation that comes back with the same id carries no notice', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, { stdout: RESUMED })
  on('state.get', (_, e, next) => (e.key === 'sessions' ? { value: { value: RESUMED_ID, version: 1 } } : next(e)))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'what did you say?' })
  const { result } = await run($)
  expect(spawns[0]?.argv.slice(-2)).toEqual(['--conversation', RESUMED_ID])
  expect(result.answer).toBe('zebra-41\n\n— answered by agy, gemini-3.8-flash-high')
})

test('a lost conversation is said with the answer, since agy silently starts a new one', async ($, on) => {
  const spawns: Spawn[] = []
  const saved: unknown[] = []
  arrange(on, spawns, { stdout: RUN, stderr: 'warning: conversation "gone" not found\n' })
  on('state.get', (_, e, next) => (e.key === 'sessions' ? { value: { value: 'gone', version: 1 } } : next(e)))
  on('state.set', (_, e, next) => {
    if (e.key === 'sessions') saved.push(e.value)
    return next(e)
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'continue' })
  const { result } = await run($)
  expect(result.answer).toBe(
    "PONG7\n\nagy could not find this agent's earlier conversation, so this answer comes from a new one without that context.\n\n— answered by agy, gemini-3.8-flash-high",
  )
  expect(saved).toEqual([RUN_ID])
})

test('a result other than SUCCESS is a failure in agy words, unsigned', async ($, on) => {
  const spawns: Spawn[] = []
  const failed = [
    { event: 'init', conversation_id: RUN_ID },
    { event: 'result', result: { status: 'ERROR', error: 'quota exhausted' } },
  ]
  arrange(on, spawns, { stdout: `${failed.map((e) => JSON.stringify(e)).join('\n')}\n`, code: 3 })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toBe("agy's model call failed: quota exhausted")
  expect(result.usage).toBeNull()
})

test('text before a tool and text after it are two messages: only the last is the answer', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, { stdout: TWO })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'check seed2' })
  const { chunks, result } = await run($)
  expect(chunks.some((c) => c.kind === 'text' && c.text.includes('Checking the file now'))).toBe(true)
  expect(result.answer).toBe('zebra-41\n\n— answered by agy, gemini-3.8-flash-high')
})

test('a probe that rejects, as on its timeout, leaves the run to answer and the model unreported', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, [], 'reject')
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toBe('PONG7\n\n— answered by agy, model not reported')
})

test('a failed probe signs the model line as requested', async ($, on) => {
  arrange(on, [], undefined, [], { exitCode: 1, stdout: '' })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: gemini-3.8-flash\ngo' })
  expect((await run($)).result.answer).toBe('PONG7\n\n— answered by agy, gemini-3.8-flash (requested)')
})

test('a working probe signs the model it names, not the model line', async ($, on) => {
  arrange(on, [])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: gemini-3.8-flash\ngo' })
  expect((await run($)).result.answer).toBe('PONG7\n\n— answered by agy, gemini-3.8-flash-high')
})

test('a probe answer without a model id is not a model', async ($, on) => {
  arrange(on, [], undefined, [], { exitCode: 0, stdout: JSON.stringify({ status: 'SUCCESS', command: { name: 'model' } }) })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  expect((await run($)).result.answer).toBe('PONG7\n\n— answered by agy, model not reported')
})

test('a model named in the stream is believed over the probe', async ($, on) => {
  // Hypothetical: 1.4.7 leaves init.model empty; this pins the order should a version fill it.
  const named = RUN.replace('"init":{', '"init":{"model":"gemini-from-stream",')
  arrange(on, [], { stdout: named })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  expect((await run($)).result.answer).toBe('PONG7\n\n— answered by agy, gemini-from-stream')
})

test('a resumed run whose init carries no id raises no lost-conversation notice', async ($, on) => {
  const noId = RESUMED.split('\n')
    .map((l) => (l.startsWith('{"event":"init"') ? '{"event":"init","init":{}}' : l))
    .join('\n')
  arrange(on, [], { stdout: noId })
  on('state.get', (_, e, next) => (e.key === 'sessions' ? { value: { value: RESUMED_ID, version: 1 } } : next(e)))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'what did you say?' })
  expect((await run($)).result.answer).toBe('zebra-41\n\n— answered by agy, gemini-3.8-flash-high')
})

test("usage is the last step's, not agy's own result total", async ($, on) => {
  const total = JSON.parse(TWO.trim().split('\n').at(-1) ?? '{}').result.usage
  arrange(on, [], { stdout: TWO })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'check seed2' })
  const { result } = await run($)
  expect(result.usage).toEqual({
    model: 'gemini-3.8-flash-high',
    input_tokens: 9381,
    output_tokens: 70,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  })
  expect(total.input_tokens).toBe(17249)
})

test('the model probe runs alongside the run, not before it', async ($, on) => {
  let spawned!: () => void
  const started = new Promise<void>((resolve) => {
    spawned = resolve
  })
  storage(on)
  mock.env(on, {})
  on('agent.list', () => ({ value: [AGENT] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  // Answers only once the run has started: awaiting the probe first would never finish.
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'node')
      return { value: { exitCode: 0, stdout: '26.12.1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    await started
    return { value: { exitCode: 0, stdout: MODEL, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* () {
    spawned()
    yield { stream: 'stdout' as const, text: RUN }
    return { value: { code: 0, signal: null } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  expect((await run($)).result.answer).toBe('PONG7\n\n— answered by agy, gemini-3.8-flash-high')
})

test('plan mode refuses agy, which has no read-only mode via can enforce', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  on('state.get', (_, e, next) => (e.key === 'modes' ? { value: { value: 'plan', version: 1 } } : next(e)))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'look around' })
  const { result } = await run($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('agy cannot run in plan mode')
})
