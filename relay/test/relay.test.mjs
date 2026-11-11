import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const relay = new URL('../relay.mjs', import.meta.url).pathname
const agent = new URL('./fake-agent.mjs', import.meta.url).pathname
// These tests can themselves run inside via: its live relay settings must not reach the fake agent.
const envFor = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RELAY_') && !key.startsWith('FAKE_'))),
  ...extra,
})

test("an agent's error keeps the cause its data carries, not only 'Internal error'", () => {
  const run = spawnSync('node', [relay, '--', 'node', agent], { input: 'hi', encoding: 'utf8', timeout: 20_000, env: envFor() })
  const events = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const error = events.find((e) => e.relay === 'error')
  assert.equal(error?.message, "Internal error: You've hit your usage limit. Try again at 10:04 PM.")
  assert.equal(run.status, 1)
})

const said = (input, cwd = process.cwd(), env = {}) => {
  const run = spawnSync('node', [relay, '--', 'node', agent], {
    input,
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    env: envFor({ FAKE_ECHO: '1', ...env }),
  })
  const text = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((e) => e.update?.sessionUpdate === 'agent_message_chunk')?.update.content.text
  return JSON.parse(text)
}

test('the relay offers streamed command output, no terminal of its own, and no plan capability', () => {
  const { offered } = said('hi')
  // With one, codex-acp sends a markdown plan as plan_update, which via does not draw, in place of text.
  assert.equal(offered.plan, undefined)
  assert.equal(offered._meta.terminal_output_delta, true)
  assert.equal(offered.terminal, false)
})

test('the relay sets fast mode and reasoning before prompting a new or resumed session', () => {
  for (const value of ['on', 'off']) {
    for (const session of ['', 's1']) {
      const { opened, config } = said('go', process.cwd(), {
        ...(session ? { RELAY_SESSION: session } : {}),
        RELAY_CONFIG: JSON.stringify({ 'fast-mode': value, reasoning_effort: 'high' }),
      })
      assert.equal(opened, session ? 'load' : 'new')
      assert.deepEqual(config, [
        { sessionId: 's1', configId: 'fast-mode', value },
        { sessionId: 's1', configId: 'reasoning_effort', value: 'high' },
      ])
    }
  }
})

test('a refused fast-mode option fails before the prompt instead of answering at another tier', () => {
  const run = spawnSync('node', [relay, '--', 'node', agent], {
    input: 'go',
    encoding: 'utf8',
    timeout: 20_000,
    env: envFor({ FAKE_ECHO: '1', FAKE_REFUSE_CONFIG: 'fast-mode', RELAY_CONFIG: '{"fast-mode":"on"}' }),
  })
  const events = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(run.status, 1)
  assert.match(events.find((e) => e.relay === 'error')?.message ?? '', /the agent refused fast-mode on:.*fast mode unavailable/)
  assert.equal(
    events.some((e) => e.update?.sessionUpdate === 'agent_message_chunk'),
    false,
  )
})

test('an image under the working folder goes along to an agent that takes images; a missing, fake or outside one stays text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-test-'))
  const outside = mkdtempSync(join(tmpdir(), 'relay-outside-'))
  const png = join(dir, 'shot.png')
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(dir, 'fake.png'), 'not a png')
  writeFileSync(join(outside, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const prompt = `Look at ${png}, ${join(dir, 'gone.png')}, ${join(dir, 'fake.png')}, ${join(outside, 'secret.png')} and docs${png}`
  assert.deepEqual(said(prompt, dir).blocks, ['text', 'image:image/png:8'])
})

test('a symlink or .. that leads out of the working folder stays text, and at most four images go along', () => {
  // Real paths (macOS's temp folder is itself a symlink), so only the link or the .. decides.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-test-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'relay-outside-')))
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  writeFileSync(join(outside, 'secret.png'), png)
  symlinkSync(join(outside, 'secret.png'), join(dir, 'link.png'))
  mkdirSync(join(dir, 'sub'))
  // Written out, not joined: join would resolve the .. before the relay sees it.
  const outOfRoots = `${dir}/sub/../../${outside.split('/').pop()}/secret.png`
  assert.deepEqual(said(`See ${join(dir, 'link.png')} and ${outOfRoots}`, dir).blocks, ['text'])
  const many = [1, 2, 3, 4, 5].map((n) => {
    const path = join(dir, `${n}.png`)
    writeFileSync(path, png)
    return path
  })
  assert.equal(said(`See ${many.join(' ')}`, dir).blocks.length, 1 + 4)
})
