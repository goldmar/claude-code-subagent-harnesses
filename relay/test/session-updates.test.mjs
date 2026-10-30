import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const relay = new URL('../relay.mjs', import.meta.url).pathname
const agent = new URL('./raw-agent.mjs', import.meta.url).pathname
const run = (extra = {}) => {
  const result = spawnSync('node', [relay, '--', 'node', agent], {
    input: 'go',
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RELAY_') && !key.startsWith('RAW_'))),
      ...extra,
    },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  return { events: result.stdout.trim().split('\n').map(JSON.parse), stderr: result.stderr }
}

test('unknown session updates are counted and ignored before SDK validation; AIR children use existing rows', () => {
  const { events, stderr } = run()
  assert.doesNotMatch(stderr, /Invalid params|Error handling notification|private payload/)
  assert.deepEqual(
    events.filter((e) => e.relay === 'ignored_session_update'),
    [
      { relay: 'ignored_session_update', count: 1 },
      { relay: 'ignored_session_update', count: 2 },
    ],
  )
  assert.deepEqual(
    events.filter((e) => e.update?.sessionUpdate === 'subagent_update'),
    [
      {
        sessionId: 's1',
        update: {
          sessionUpdate: 'subagent_update',
          sessionId: 'child',
          title: 'helper',
          description: 'Inspect the source',
          state: { state: 'running' },
        },
      },
      {
        sessionId: 's1',
        update: { sessionUpdate: 'subagent_update', sessionId: 'child', state: { state: 'idle', stopReason: 'end_turn' } },
      },
      {
        sessionId: 's1',
        update: { sessionUpdate: 'subagent_update', sessionId: 'standard', title: 'standard helper', state: { state: 'running' } },
      },
    ],
  )
  assert.deepEqual(
    events.filter((e) => e.update?.sessionUpdate === 'agent_message_chunk').map((e) => [e.sessionId, e.update.content.text]),
    [
      ['child', 'child answer'],
      ['s1', 'parent answer'],
    ],
  )
  assert.ok(events.some((e) => e.relay === 'prompt_done' && e.stopReason === 'end_turn'))
})

test('AIR failures and cancellation retain their outcome; disconnected or future states do not claim completion', () => {
  for (const [state, expected] of [
    ['failed', { state: 'idle', stopReason: 'error', error: { code: -32603, message: 'Subagent failed' } }],
    ['cancelled', { state: 'idle', stopReason: 'cancelled' }],
    ['disconnected', { state: 'unknown' }],
    ['future_state', { state: 'unknown' }],
  ]) {
    const { events, stderr } = run({ RAW_STATE: state })
    assert.doesNotMatch(stderr, /Invalid params|Error handling notification/)
    const child = events.filter((e) => e.update?.sessionId === 'child')
    assert.deepEqual(child.at(-1)?.update.state, expected)
  }
})

test('malformed known updates still go through SDK validation', () => {
  const { events, stderr } = run({ RAW_MALFORMED: '1' })
  assert.match(stderr, /Invalid params/)
  assert.equal(
    events.some((e) => e.update?.sessionUpdate === 'tool_call'),
    false,
  )
  assert.equal(
    events.some((e) => e.relay === 'ignored_session_update'),
    false,
  )
})
