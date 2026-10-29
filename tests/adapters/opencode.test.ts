import { expect, mock, type TestBody, test } from 'claude-code/testing'
import { relayEvents } from '../../hooks/acp/events'
import { opencode, opencodeRun } from '../../hooks/adapters/opencode'
import { run as runHook } from '../../hooks/run'
import type { World } from '../../hooks/world'
import { ROOT, requestOf, run, runTurn, STEP, storage } from '../helpers'

type TestOn = Parameters<TestBody>[1]
type Spawn = { argv: string[]; input: string | undefined; env?: Record<string, string> }
type Write = { path: string; text: string }

const SID = 'ses_e91343cb9ffesi5kO9k3QFHJV4'
const chunk = (messageId: string, text: string) => ({
  sessionId: SID,
  update: { content: { text, type: 'text' }, messageId, sessionUpdate: 'agent_message_chunk' },
})
// Captured from relay/relay.mjs over `opencode acp` (opencode 1.19.4, OpenRouter DeepSeek, 2026-10-24):
// opencode names a tool `bash` first and its command only in the update that starts it.
const CAPTURED = [
  { relay: 'session', sessionId: SID },
  { relay: 'model', name: 'openrouter/~deepseek/deepseek-flash-latest' },
  { relay: 'steered' },
  chunk('msg_1', 'Running it.'),
  { sessionId: SID, update: { toolCallId: 'call_1', title: 'bash', kind: 'execute', status: 'pending', sessionUpdate: 'tool_call' } },
  {
    sessionId: SID,
    update: {
      toolCallId: 'call_1',
      title: 'echo hi > asked.txt',
      kind: 'execute',
      status: 'in_progress',
      sessionUpdate: 'tool_call_update',
    },
  },
  {
    sessionId: SID,
    update: { toolCallId: 'call_1', title: 'echo hi > asked.txt', kind: 'execute', status: 'completed', sessionUpdate: 'tool_call_update' },
  },
  chunk('msg_2', 'DONE'),
  { sessionId: SID, update: { used: 11136, size: 1048576, cost: { amount: 0.00022576, currency: 'USD' }, sessionUpdate: 'usage_update' } },
  {
    relay: 'prompt_done',
    stopReason: 'end_turn',
    usage: { inputTokens: 9344, outputTokens: 12, totalTokens: 11148, cachedReadTokens: 1792 },
  },
  { relay: 'done', stopReason: 'end_turn' },
]
const lines = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
const AGENT = { id: 'a1', description: 'x', type: 'via:opencode', status: 'running' } as const

function arrange(
  on: TestOn,
  spawns: Spawn[],
  out: { stdout?: string; stderr?: string; code?: number } = { stdout: lines(CAPTURED) },
  o: { mode?: string; writes?: Write[] } = {},
) {
  mock.clock(on)
  const files = storage(on)
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [AGENT] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '24.11.0\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('state.get', (_, e, next) => (e.key === 'modes' && o.mode ? { value: { value: o.mode, version: 1 } } : next(e)))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    o.writes?.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.spawn', async function* (_, e) {
    spawns.push(requestOf(e))
    if (out.stdout) yield { stream: 'stdout' as const, text: out.stdout }
    if (out.stderr) yield { stream: 'stderr' as const, text: out.stderr }
    return { value: { code: out.code ?? 0, signal: null } }
  })
}

const injected = (spawn: Spawn | undefined) =>
  JSON.parse(spawn?.env?.OPENCODE_CONFIG_CONTENT ?? '{}') as {
    lsp?: boolean
    agent?: Record<string, { permission: Record<string, unknown> }>
  }

test('an opencode agent runs `opencode acp` behind the relay, with its prompt on stdin', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'run the tests' })
  await runTurn($)
  expect(spawns[0]?.argv).toEqual(['node', `${ROOT}/relay/relay.mjs`, '--', 'opencode', 'acp'])
  expect(spawns[0]?.input).toBe('run the tests')
})

test('only the last message is the answer, signed with the session model; a tool shows once, with its command', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { chunks, result, calls } = await runTurn($)
  expect(result.answer).toBe('DONE\n\n— answered by opencode, openrouter/~deepseek/deepseek-flash-latest')
  expect(result.usage?.input_tokens).toBe(11136)
  // The command is one call to via's tool, named once, and answered with what opencode reported.
  const inputs = chunks.flatMap((c) => (c.kind === 'input' ? [JSON.parse(c.json) as unknown] : []))
  expect(inputs).toEqual([{ kind: 'execute', title: 'echo hi > asked.txt' }])
  expect(calls).toHaveLength(1)
  expect(chunks.some((c) => c.kind === 'text' && c.text.includes('echo hi'))).toBe(false)
})

test("outside read-only via injects no agent: opencode runs with the person's own permissions, and its questions reach them", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(spawns[0]?.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  expect(spawns[0]?.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined()
  expect(spawns[0]?.env?.RELAY_POLICY).toBe('ask')
  expect(spawns[0]?.env?.RELAY_STEER).toBe('prompt')
})

test("only read-only injects an agent; otherwise the permission mode decides how opencode's own questions are answered", () => {
  expect(opencodeRun({}, 'default', 'a1')).toEqual({ policy: 'ask' })
  expect(opencodeRun({}, 'acceptEdits', 'a1')).toEqual({ policy: 'ask' })
  expect(opencodeRun({}, 'auto', 'a1')).toEqual({ policy: 'ask' })
  expect(opencodeRun({}, 'bypassPermissions', 'a1')).toEqual({ policy: 'allow' })
  expect(opencodeRun({}, 'dontAsk', 'a1')).toEqual({ policy: 'deny' })
  expect(opencodeRun({}, 'plan', 'a1')).toEqual({ agent: 'via-read-a1', policy: 'deny' })
  expect(opencodeRun({ tools: 'read' }, 'bypassPermissions', 'a1')).toEqual({ agent: 'via-read-a1', policy: 'deny' })
})

test('tools: read runs a deny-by-default agent with no project config, no LSP, no web, and .env unreadable', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  tree(on, () => undefined)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook' })
  await runTurn($)
  const config = injected(spawns[0])
  const permission = config.agent?.['via-read-a1']?.permission ?? {}
  expect(config.lsp).toBe(false)
  expect(permission['*']).toBe('deny')
  expect(permission.bash).toBeUndefined()
  expect(permission.webfetch).toBeUndefined()
  expect(permission.read).toEqual({ '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' })
  expect(spawns[0]?.env).toMatchObject({
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    RELAY_POLICY: 'deny',
    RELAY_CONFIG: JSON.stringify({ mode: 'via-read-a1' }),
  })
})

test("a bypass-mode run injects nothing, so the person's own opencode setup applies", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mode: 'bypassPermissions' })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(spawns[0]?.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  expect(spawns[0]?.env?.RELAY_CONFIG).toBeUndefined()
  expect(spawns[0]?.env?.RELAY_POLICY).toBe('allow')
})

test("a thinking line becomes opencode's effort config option", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'thinking: high\ngo' })
  await runTurn($)
  expect(JSON.parse(spawns[0]?.env?.RELAY_CONFIG ?? '{}')).toEqual({ effort: 'high' })
})

test('a lost session fails in plain words and is forgotten', async ($, on) => {
  const spawns: Spawn[] = []
  const saved: unknown[] = []
  arrange(on, spawns, {
    stdout: lines([{ relay: 'session_lost', message: 'Session not found' }]),
    stderr: 'acp relay: session lost: Session not found\n',
    code: 1,
  })
  on('state.set', (_, e, next) => {
    if (e.key === 'sessions') saved.push(e.value)
    return next(e)
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await runTurn($)
  expect(result.answer).toContain("opencode could not find this agent's earlier session")
  expect(saved).toEqual([''])
})

test('an aborted run saves a session id in an unterminated tail without showing its text', async () => {
  const saved: unknown[] = []
  const world: World = {
    adapters: new Map([['opencode', opencode]]),
    defaultModel: '',
    codexAcp: 'pinned',
    installs: new Map(),
    timeoutMinutes: 30,
    turns: new Map(),
    seeds: new Map(),
    handbacks: new Map(),
    modes: new Map(),
    agents: new Map(),
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
  const stop = new AbortController()
  let read!: () => void
  const readPiece = new Promise<void>((resolve) => {
    read = resolve
  })
  const child = async function* () {
    yield {
      stream: 'stdout' as const,
      text: `${JSON.stringify({ relay: 'steered' })}\n${JSON.stringify(chunk('m', 'trailing text'))}\n${JSON.stringify({ relay: 'session', sessionId: SID })}`,
    }
    read()
    await new Promise<void>((resolve) => stop.signal.addEventListener('abort', () => resolve(), { once: true }))
    return { code: 0, signal: null }
  }
  const $ = {
    env: { get: async () => undefined },
    fs: { write: async () => undefined },
    clock: { after: () => ({ cancel: () => {} }) },
    process: { spawn: child },
    plugin: { root: '/' },
  } as unknown as Parameters<typeof runHook>[2]
  const stream = runHook(world, opencode, $, {
    agentId: 'a1',
    choice: {},
    prompt: 'long job',
    signal: stop.signal,
    inbox: undefined,
    session: undefined,
    guard: undefined,
    mode: 'default',
    probe: async () => undefined,
    save: async (id) => {
      saved.push(id)
    },
  })
  const pending = (async () => {
    for (;;) if ((await stream.next()).done) return
  })()
  await readPiece
  stop.abort()
  await pending
  expect(saved).toEqual([SID])
})

function tree(on: TestOn, at: (cwd: string) => { path: string; holds: string[] } | undefined) {
  let cwd: string | undefined
  on('fs.stat', (_, e) => {
    cwd ??= e.path.replace(/\/\.opencode$/, '')
    if (e.path.endsWith('/.opencode') && e.path !== at(cwd)?.path) throw new Error('ENOENT')
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
  })
  on('fs.list', () => ({
    value: (at(cwd ?? '')?.holds ?? []).map((name) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
  }))
}
const parent = (path: string) => path.replace(/\/[^/]+$/, '') || '/'

test('tools: read is refused under a .opencode folder, which opencode runs code from on every run', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  tree(on, (cwd) => ({ path: `${parent(cwd)}/.opencode`, holds: ['agents', 'opencode.json'] }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook around' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('opencode cannot run read-only here')
  expect(result.answer).toContain('/.opencode)')
})

test('plan mode is refused under a .opencode folder too', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mode: 'plan' })
  tree(on, (cwd) => ({ path: `${parent(cwd)}/.opencode`, holds: ['plugins'] }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'look around' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('opencode cannot run read-only here')
})

test('~/.opencode as the installer and opencode leave it (bin, .gitignore) does not void read-only', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  tree(on, (cwd) => ({ path: `${parent(cwd)}/.opencode`, holds: ['bin', '.gitignore'] }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook around' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_CONFIG).toBe(JSON.stringify({ mode: 'via-read-a1' }))
})

test('a walk that cannot finish, as when a hook withholds realPath, refuses read-only rather than assuming it is safe', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  on('fs.stat', (_, e) => {
    if (e.path.endsWith('/.opencode')) throw new Error('ENOENT')
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook around' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('could not all be checked for .opencode')
})

test("opencode's command ends the step with a call to via's tool, which the next tool.call answers with its output", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const first = await run($)
  expect(first.result.stopReason).toBe('tool_use')
  expect(first.result.toolUses).toEqual([{ name: 'mcp__plugin_via_step__step', input: { kind: 'execute', title: 'echo hi > asked.txt' } }])
  const tool = first.chunks.find((c) => c.kind === 'tool')
  if (tool?.kind !== 'tool') throw new Error('no tool chunk')
  // Each step numbers its blocks from 0.
  expect(Math.min(...first.chunks.flatMap((c) => ('index' in c ? [c.index] : [])))).toBe(0)
  const answered = await $.tool.call({
    tool: 'mcp__plugin_via_step__step',
    tool_use_id: tool.id,
    kind: 'execute',
    title: 'echo hi > asked.txt',
  } as never)
  expect(answered).not.toHaveProperty('deny')
  const rest = await run($, { ...STEP, index: 1 })
  expect(rest.result.answer).toBe('DONE\n\n— answered by opencode, openrouter/~deepseek/deepseek-flash-latest')
  expect(spawns).toHaveLength(1)
})

test("a call to via's tool that no harness made is refused and runs nothing", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  const answered = await $.tool.call({
    tool: 'mcp__plugin_via_step__step',
    tool_use_id: 'toolu_made_up',
    kind: 'execute',
    title: 'rm -rf /',
  } as never)
  expect(answered).toHaveProperty('deny')
  expect(spawns).toHaveLength(0)
})

test('a finished call reports its text, a nonzero exit code, or nothing for exit code 0', () => {
  const parse = relayEvents()
  parse(JSON.stringify({ relay: 'steered' }))
  const done = (id: string, extra: Record<string, unknown>) =>
    parse(JSON.stringify({ sessionId: SID, update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', ...extra } }))
  expect(done('a', { rawOutput: { exit_code: 0 } }).at(-1)).toEqual({ k: 'called', id: 'a', output: '', failed: false })
  expect(done('b', { rawOutput: { exit_code: 2 } }).at(-1)).toEqual({ k: 'called', id: 'b', output: 'exit code 2', failed: false })
  expect(done('c', { content: [{ type: 'content', content: { type: 'text', text: 'hi' } }] }).at(-1)).toEqual({
    k: 'called',
    id: 'c',
    output: 'hi',
    failed: false,
  })
  // Reported only once done, it is still announced first.
  expect(done('d', { kind: 'execute', title: 'ls' })[0]).toEqual({ k: 'call', id: 'd', kind: 'execute', title: 'ls' })
})

test("a title's paths under the working folder are shown relative to it", () => {
  const parse = relayEvents()
  parse(JSON.stringify({ relay: 'session', sessionId: SID, cwd: '/work/repo' }))
  parse(JSON.stringify({ relay: 'steered' }))
  const update = {
    sessionUpdate: 'tool_call',
    toolCallId: 'r',
    status: 'in_progress',
    kind: 'read',
    title: "Read file '/work/repo/src/a.ts'",
  }
  expect(parse(JSON.stringify({ sessionId: SID, update }))).toEqual([{ k: 'call', id: 'r', kind: 'read', title: "Read file 'src/a.ts'" }])
  // A path that only contains the folder stays whole; so does a sibling folder's.
  const inside = { ...update, toolCallId: 'i', title: "Read file '/x/work/repo/a.ts' and '/work/repo2/b.ts'" }
  expect(parse(JSON.stringify({ sessionId: SID, update: inside }))).toEqual([
    { k: 'call', id: 'i', kind: 'read', title: "Read file '/x/work/repo/a.ts' and '/work/repo2/b.ts'" },
  ])
  // Elsewhere, a path stays whole.
  const outside = { ...update, toolCallId: 'o', title: "Read file '/etc/hosts'" }
  expect(parse(JSON.stringify({ sessionId: SID, update: outside }))).toEqual([
    { k: 'call', id: 'o', kind: 'read', title: "Read file '/etc/hosts'" },
  ])
})

test("a command's streamed output is its result, with its exit code when it failed", () => {
  const parse = relayEvents()
  parse(JSON.stringify({ relay: 'steered' }))
  const update = (extra: Record<string, unknown>) =>
    parse(JSON.stringify({ sessionId: SID, update: { sessionUpdate: 'tool_call_update', toolCallId: 'x', ...extra } }))
  update({ status: 'in_progress', kind: 'execute', title: 'make' })
  update({ _meta: { terminal_output_delta: { data: 'one\n', terminal_id: 'x' } } })
  const done = update({
    status: 'completed',
    _meta: { terminal_output_delta: { data: 'two\n', terminal_id: 'x' }, terminal_exit: { exit_code: 2 } },
  })
  expect(done.at(-1)).toEqual({ k: 'called', id: 'x', output: 'one\ntwo\nexit code 2', failed: false })
})

test('an edit is reported as its changed lines, and a plan as its entries', () => {
  const parse = relayEvents()
  parse(JSON.stringify({ relay: 'session', sessionId: SID, cwd: '/work/repo' }))
  parse(JSON.stringify({ relay: 'steered' }))
  const content = [{ type: 'diff', path: '/work/repo/notes.txt', oldText: 'a\nb\nc', newText: 'a\nB\nc' }]
  const edited = parse(
    JSON.stringify({
      sessionId: SID,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'e', status: 'completed', kind: 'edit', title: 'Edit', content },
    }),
  )
  expect(edited.at(-1)).toEqual({ k: 'called', id: 'e', output: 'notes.txt\n- b\n+ B', failed: false })
  const entries = [
    { content: 'read', status: 'completed', priority: 'medium' },
    { content: 'fix', status: 'in_progress', priority: 'high' },
  ]
  expect(parse(JSON.stringify({ sessionId: SID, update: { sessionUpdate: 'plan', entries } }))).toEqual([
    {
      k: 'plan',
      entries: [
        { content: 'read', status: 'completed' },
        { content: 'fix', status: 'in_progress' },
      ],
    },
  ])
})

test("an edit's diff sent while it runs is its result when it ends, as codex-acp sends it", () => {
  const parse = relayEvents()
  parse(JSON.stringify({ relay: 'steered' }))
  const content = [{ type: 'diff', path: 'notes.txt', oldText: 'a', newText: 'A' }]
  parse(
    JSON.stringify({
      sessionId: SID,
      update: { sessionUpdate: 'tool_call', toolCallId: 'p', status: 'in_progress', kind: 'edit', title: 'Editing files', content },
    }),
  )
  const done = parse(
    JSON.stringify({ sessionId: SID, update: { sessionUpdate: 'tool_call_update', toolCallId: 'p', status: 'completed' } }),
  )
  expect(done.at(-1)).toEqual({ k: 'called', id: 'p', output: 'notes.txt\n- a\n+ A', failed: false })
})

test('a failed command keeps its output, the end of a long one, and its exit code from either report', () => {
  const parse = relayEvents()
  parse(JSON.stringify({ relay: 'steered' }))
  const update = (id: string, extra: Record<string, unknown>) =>
    parse(JSON.stringify({ sessionId: SID, update: { sessionUpdate: 'tool_call_update', toolCallId: id, ...extra } }))
  update('f', { status: 'in_progress', kind: 'execute', title: 'make' })
  update('f', { _meta: { terminal_output_delta: { data: 'boom\n', terminal_id: 'f' } } })
  expect(update('f', { status: 'failed', rawOutput: { exit_code: 2 } }).at(-1)).toEqual({
    k: 'called',
    id: 'f',
    output: 'boom\nexit code 2',
    failed: true,
  })
  update('l', { status: 'in_progress', kind: 'execute', title: 'yes' })
  update('l', { _meta: { terminal_output_delta: { data: `${'x'.repeat(3000)}END`, terminal_id: 'l' } } })
  const long = update('l', { status: 'completed', rawOutput: { exit_code: 0 } }).at(-1) as { output: string }
  expect(long.output.endsWith('END')).toBe(true)
  expect(long.output.length).toBeLessThanOrEqual(2001)
})

test('a diff to or from an empty file has no blank changed line', () => {
  const parse = relayEvents()
  parse(JSON.stringify({ relay: 'steered' }))
  const content = [{ type: 'diff', path: 'gone.txt', oldText: 'a', newText: '' }]
  const done = parse(
    JSON.stringify({
      sessionId: SID,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'd', status: 'completed', kind: 'delete', title: 'Delete', content },
    }),
  )
  expect(done.at(-1)).toEqual({ k: 'called', id: 'd', output: 'gone.txt\n- a', failed: false })
})

test('malformed tool content from an agent is skipped, not a crash', () => {
  const parse = relayEvents()
  parse(JSON.stringify({ relay: 'steered' }))
  const content = [{ type: 'content' }, { type: 'content', content: null }, { type: 'content', content: { type: 'text', text: 'ok' } }]
  const done = parse(
    JSON.stringify({
      sessionId: SID,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'm', status: 'completed', kind: 'read', title: 'r', content },
    }),
  )
  expect(done.at(-1)).toEqual({ k: 'called', id: 'm', output: 'ok', failed: false })
})

// A harness's own subagent, as ACP's subagents RFD reports it (shape captured from codex-acp
// 2.3.1-preview.8, 2026-10-28): the parent's step calls the Agent tool, and the nested agent it starts
// shows the child's row and answer from the parent's run.
const CHILD = `${SID}:subagent:c1`
const NESTED = [
  { relay: 'session', sessionId: SID },
  { relay: 'steered' },
  { sessionId: SID, update: { sessionId: CHILD, title: 'List acp', sessionUpdate: 'subagent_update' } },
  { sessionId: CHILD, update: { toolCallId: 'x', title: 'ls', kind: 'execute', status: 'in_progress', sessionUpdate: 'tool_call' } },
  { sessionId: CHILD, update: { toolCallId: 'x', title: 'ls', kind: 'execute', status: 'completed', sessionUpdate: 'tool_call_update' } },
  { sessionId: CHILD, update: { content: { type: 'text', text: 'steps.ts' }, messageId: 'm1', sessionUpdate: 'agent_message_chunk' } },
  { sessionId: SID, update: { sessionId: CHILD, state: { state: 'idle', stopReason: 'end_turn' }, sessionUpdate: 'subagent_update' } },
  chunk('m2', 'It found steps.ts.'),
  { relay: 'prompt_done', stopReason: 'end_turn', usage: { outputTokens: 4 } },
  { relay: 'done', stopReason: 'end_turn' },
]
const SPAWN = {
  prompt: 'List acp',
  description: 'List acp',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'x',
  parentAgentId: 'a1',
  fork: false,
} as const

test("a harness's subagent is an agent nested under the via agent, with the child's row and answer", async ($, on) => {
  arrange(on, [], { stdout: lines(NESTED) })
  on('agent.spawn', () => ({ model: 'x', agentId: 'n1' }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const first = await runTurn($)
  expect(first.result.toolUses[0]?.name).toBe('Agent')
  const call = first.chunks.find((c) => c.kind === 'tool')
  const id = call?.kind === 'tool' ? call.id : ''
  // The rest of the parent's turn: its own answer, never the child's.
  const rest = await runTurn($, { ...STEP, index: 1 })
  expect(rest.result.answer).toContain('It found steps.ts.')
  expect(rest.result.answer).not.toContain('\nsteps.ts')
  // In the foreground the parent's step would wait on a nested agent that waits on the parent's run.
  expect(await $.agent.spawn({ ...SPAWN, tool_use_id: id, subagentType: 'via:opencode', background: false })).toEqual({
    deny: "via shows a harness's subagent only as a background agent, and background tasks are off",
  })
})

test('a background nested agent shows its harness subagent from the parent run', async ($, on) => {
  arrange(on, [], { stdout: lines(NESTED) })
  on('agent.spawn', () => ({ model: 'x', agentId: 'n1' }))
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const first = await runTurn($)
  const call = first.chunks.find((c) => c.kind === 'tool')
  const id = call?.kind === 'tool' ? call.id : ''
  await runTurn($, { ...STEP, index: 1 })
  expect(await $.agent.spawn({ ...SPAWN, tool_use_id: id, subagentType: 'via:opencode', background: true })).toEqual({
    model: 'x',
    agentId: 'n1',
  })
  await $.turn.start({ turnId: 't2', agentId: 'n1', text: 'List acp' })
  const nested = await runTurn($, { ...STEP, turnId: 't2', agentId: 'n1' })
  expect(nested.calls).toEqual([{ result: 'Done; no output reported.' }])
  expect(nested.result.answer).toBe('steps.ts\n\n— answered by opencode subagent')
})
