import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'

for (const legacy of [false, true])
  for (const interrupt of [false, true])
    test(`capacity keeps native helpers until an explicit follow-up (legacy=${legacy}, interrupt=${interrupt})`, {
      timeout: 10_000,
    }, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'via-capacity-'))
      const inbox = join(dir, 'inbox')
      writeFileSync(inbox, '')
      const child = spawn(
        'node',
        [new URL('../relay.mjs', import.meta.url).pathname, '--', 'node', new URL('./fake-agent.mjs', import.meta.url).pathname],
        {
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RELAY_') && !key.startsWith('FAKE_'))),
            RELAY_INBOX: inbox,
            RELAY_STEER: 'steering',
            FAKE_CAPACITY: '1',
            ...(legacy ? { FAKE_CAPACITY_LEGACY: '1' } : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      t.after(() => child.kill('SIGTERM'))
      const exited = once(child, 'exit')
      const events = []
      const progress = new Promise((resolve) => {
        createInterface({ input: child.stdout }).on('line', (line) => {
          const event = JSON.parse(line)
          events.push(event)
          if (event.sessionId === 'helper' && event.update?.content?.text === 'saved helper result') resolve('helper')
        })
      })
      child.stdin.end('initial task')
      assert.equal(await Promise.race([progress, exited.then(() => 'exit')]), 'helper')
      assert.equal(events.filter((event) => event.relay === 'steered').length, 1)
      assert.equal(
        events.some((event) => event.relay === 'paused'),
        true,
      )
      writeFileSync(
        inbox,
        `${JSON.stringify(interrupt ? { interrupt: 'continue with the saved result' } : 'continue with the saved result')}\n`,
      )
      const [code] = await exited
      assert.equal(code, 0)
      const answer = events.find((event) => event.sessionId === 's1' && event.update?.sessionUpdate === 'agent_message_chunk')
      assert.deepEqual(JSON.parse(answer.update.content.text), { prompts: 2, completedChild: true })
    })
