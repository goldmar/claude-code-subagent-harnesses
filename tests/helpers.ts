import type { SessionMessage, TurnStepChunk } from 'claude-code'
import { expect, mock, type TestBody } from 'claude-code/testing'
import type { AgentRecord } from '../hooks/record'
import type { World } from '../hooks/world'

type TestDollar = Parameters<TestBody>[0]
type TestOn = Parameters<TestBody>[1]

export const STEP = { turnId: 't1', index: 0, model: 'haiku', messageCount: 1, agentId: 'a1' }
export const ROOT = new URL('..', (import.meta as ImportMeta & { url: string }).url).pathname.replace(/\/$/, '')
export const STUB = {
  name: 'stub',
  bin: 'stub',
  about: 'stub CLI agent.',
  readOnly: 'none',
  thinking: ['low', 'high'],
  steer: false,
  defaultModel: false,
} as const
export type Spawn = { argv: string[]; input: string | undefined; env?: Record<string, string> }
export type Write = { path: string; text: string }
const AGENT = { id: 'a1', description: 'x', type: 'via:pi', status: 'running' } as const
const EVENTS = [
  { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
  { type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'all ' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } },
  { type: 'message_end', message: { role: 'assistant', usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2 } } },
]

export async function run($: TestDollar, step: typeof STEP = STEP) {
  const chunks: TurnStepChunk[] = []
  const stream = $.turn.step(step)
  for (;;) {
    const step = await stream.next()
    if (step.done) return { chunks, result: step.value }
    chunks.push(step.value)
  }
}

// Runs a turn to its end as the engine would: each step that ends with a call to via's tool gets the
// call answered through tool.call, then the next step. calls: what each answer said.
export async function runTurn($: TestDollar, step: typeof STEP = STEP) {
  const chunks: TurnStepChunk[] = []
  const calls: unknown[] = []
  for (let index = step.index; ; index += 1) {
    const done = await run($, { ...step, index })
    chunks.push(...done.chunks)
    const tool = done.chunks.find((c) => c.kind === 'tool')
    if (done.result.stopReason !== 'tool_use' || tool?.kind !== 'tool' || tool.name !== 'mcp__plugin_via_step__step')
      return { chunks, result: done.result, calls }
    const input = done.chunks.find((c) => c.kind === 'input')
    const args = input?.kind === 'input' ? (JSON.parse(input.json) as Record<string, unknown>) : {}
    calls.push(await $.tool.call({ tool: tool.name, tool_use_id: tool.id, ...args } as never))
  }
}

export function expectPiSpawn(spawn: Spawn | undefined, root: string, extra: string[] = []) {
  expect(spawn?.argv).toEqual(['pi', '-p', '--mode', 'json', '--session-id', 'pi-a1', '-e', `${root}/pi-extension/inbox.ts`, ...extra])
  expect(spawn?.env).toEqual({ PI_INBOX: '/home/u/.claude/via/inbox/pi-a1.jsonl' })
}

export const ENV = { TMPDIR: '/tmp', HOME: '/home/u' }

export function bottom(on: TestOn, writes?: Write[] | 'reject', env: Record<string, string> = ENV, version = NODE.stdout) {
  mock.env(on, env)
  on('agent.list', () => ({ value: [AGENT] }))
  on('fs.write', (_, e) => {
    if (writes === 'reject') throw new Error('EROFS')
    writes?.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  node(on, version)
  // The record a1's spawn left: an agent with none would run read-only, its mode unknown.
  return agentStore(on, { a1: { harness: 'pi' } })
}

// Every harness checks Node first, for the step server: a current one, and anything else run passes on.
export const NODE = { exitCode: 0, stdout: '26.12.1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
export function node(on: TestOn, version = NODE.stdout) {
  on('process.run', (_, e, next) => (e.argv[0] === 'node' ? { value: { ...NODE, stdout: version } } : next(e)))
}

export function arrange(
  on: TestOn,
  spawns: Spawn[],
  pieces: { stream: 'stdout' | 'stderr'; text: string }[],
  code = 0,
  rows: SessionMessage[] = [],
  writes?: Write[] | 'reject',
  version = NODE.stdout,
) {
  const store = bottom(on, writes, ENV, version)
  on('session.messages', () => ({ value: rows }))
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    yield* pieces
    return { value: { code, signal: null } }
  })
  return store
}

export const split = (text: string) => [
  { stream: 'stdout' as const, text: text.slice(0, 40) },
  { stream: 'stdout' as const, text: text.slice(40) },
]
export const lines = `${EVENTS.map((e) => JSON.stringify(e)).join('\n')}\n`

const HALF = [
  { type: 'message_start', message: { role: 'assistant', provider: 'openrouter', model: 'kimi' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'half an answer' } },
]

export function hang(on: TestOn, spawns: Spawn[], writes?: Write[], env: Record<string, string> = ENV, events: unknown[] = HALF) {
  bottom(on, writes, env)
  on('session.messages', () => ({ value: [] }))
  on('process.spawn', async function* (_, e, next) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    yield { stream: 'stdout' as const, text: `${events.map((event) => JSON.stringify(event)).join('\n')}\n` }
    await new Promise<void>((resolve) => {
      if (next.signal.aborted) resolve()
      else next.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    return { value: { code: 0, signal: null } }
  })
}

export function hold(on: TestOn, spawns: Spawn[], writes: Write[], before: unknown[], after: unknown[], env: Record<string, string> = ENV) {
  bottom(on, writes, env)
  on('session.messages', () => ({ value: [] }))
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    yield { stream: 'stdout' as const, text: `${before.map((event) => JSON.stringify(event)).join('\n')}\n` }
    await released
    yield { stream: 'stdout' as const, text: `${after.map((event) => JSON.stringify(event)).join('\n')}\n` }
    return { value: { code: 0, signal: null } }
  })
  return { release }
}

// A World for a test that drives via's functions without the engine: what a fresh register makes.
export function testWorld(given: Partial<World> = {}): World {
  return {
    adapters: new Map(),
    defaultModel: '',
    latest: new Set(),
    timeoutMinutes: 30,
    turns: new Map(),
    seeds: new Map(),
    records: new Map(),
    installs: new Map(),
    others: new Set(),
    inboxes: new Map(),
    activity: new Map(),
    channels: new Map(),
    nested: new Map(),
    spawns: new Map(),
    tool: 'mcp__plugin_via_step__step',
    jobs: new Map(),
    calls: new Map(),
    ...given,
  }
}

// Agent records as the store holds them, for a test that starts where another process left off. Writes
// to the store are kept in `written`, by key.
export function agentStore(on: TestOn, records: Record<string, Partial<AgentRecord> & { harness: string }> = {}) {
  const held = new Map<string, unknown>(
    Object.entries(records).map(([id, record]) => [`agent:${id}`, { handback: false, mode: 'default', ...record }]),
  )
  // Only via's agent keys: a model list or anything else goes on to the test's own hooks, or none.
  const ours = (key: string) => key.startsWith('agent')
  on('store.get', (_, e, next) => (ours(e.key) ? { value: held.get(e.key) } : next(e)))
  on('store.set', (_, e, next) => {
    if (!ours(e.key)) return next(e)
    held.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e, next) => {
    if (!ours(e.key)) return next(e)
    held.delete(e.key)
    return { value: undefined }
  })
  return {
    record: (id: string) => held.get(`agent:${id}`) as AgentRecord | undefined,
    // What another process, or the spawn, left for this agent.
    seed: (id: string, record: Partial<AgentRecord>) => {
      held.set(`agent:${id}`, { handback: false, mode: 'default', harness: 'pi', ...(held.get(`agent:${id}`) as object), ...record })
    },
    held,
  }
}
