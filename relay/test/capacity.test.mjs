// Retention experiment for #28. This is intentionally red on upstream 0.9.0: preserving a native
// helper after its own Codex parent's overload is an optional policy request, not a parent Claude
// usage-limit regression. No host shutdown, login switch, AIR extension or provider is involved.
// Producer references (tag v2.6.0; paths below are relative to):
// https://github.com/agentclientprotocol/codex-acp/tree/v2.6.0/src
// CodexEventHandler.ts:1098-1157: non-AIR terminal serverOverloaded -> agent_message_chunk.
// CodexAcpServer.ts:5243-5263,5451-5455: failed root skips helper wait and returns end_turn.
// subagents/StandardSubagentEventRouter.ts:631-639: finishOutstanding('failed') leaves helpers running.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'

const relay = new URL('../relay.mjs', import.meta.url).pathname
const agent = new URL('./capacity-fake-agent.mjs', import.meta.url).pathname

for (const overload of [false, true])
  test(`a native helper's delayed result survives its Codex parent's turn end (overloaded: ${overload})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'via-capacity-'))
    const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'))
    try {
      const run = spawnSync(process.execPath, [relay, '--', process.execPath, agent], {
        input: 'Start independent helper work.',
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, CAPACITY_EVIDENCE: dir, CAPACITY_OVERLOAD: overload ? '1' : '0' },
      })
      assert.ifError(run.error)
      assert.equal(run.status, 0, run.stderr)
      const events = run.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      // The real relay negotiated standard subagents, with no typed AIR sessionFailure capability.
      assert.deepEqual(read('capabilities.json').subagents, {})
      assert.deepEqual(read('capabilities.json')._meta, { terminal_output_delta: true })
      assert.equal(existsSync(join(dir, 'helper-started.json')), true)
      assert.equal(existsSync(join(dir, 'root-cancelled.json')), false)
      for (let attempt = 0; attempt < 50 && !existsSync(join(dir, 'agent-stopped.json')); attempt += 1) await setTimeout(20)
      assert.deepEqual(read('agent-stopped.json'), { signal: 'SIGTERM' })
      assert.equal(
        events.some((event) => event.relay === 'done' && event.stopReason === 'end_turn'),
        true,
      )
      if (overload) {
        assert.equal(
          events.some(
            (event) => event.sessionId === 'root' && event.update?.content?.text === 'Model is overloaded. Please try again later.\n\n',
          ),
          true,
        )
        console.log(
          `observed overload: relay exited normally; adapter SIGTERM; delayed helper completed=${existsSync(join(dir, 'helper-done.json'))}`,
        )
      }
      // Desired optional retention: the host/client stays alive long enough to collect the helper.
      assert.equal(
        events.some(
          (event) =>
            event.sessionId === 'helper' &&
            event.update?.sessionUpdate === 'agent_message_chunk' &&
            event.update.content.text === 'DELAYED_HELPER_RESULT',
        ),
        true,
        'the relay closed the ACP process group before the already-running helper delivered its result',
      )
      assert.deepEqual(read('helper-done.json'), { answer: 'DELAYED_HELPER_RESULT' })
    } finally {
      // Own process group only: also contain a timeout or assertion before relay cleanup.
      if (existsSync(join(dir, 'agent-started.json'))) {
        try {
          process.kill(-read('agent-started.json').pid, 'SIGKILL')
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
