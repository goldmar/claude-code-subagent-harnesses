import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const helper = new URL('../src/durable.mts', import.meta.url).pathname
const start = (mode, dir, request) => {
  const child = spawn(process.execPath, [helper, mode, dir], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (text) => (stdout += text))
  child.stderr.setEncoding('utf8').on('data', (text) => (stderr += text))
  child.stdin.end(request ? JSON.stringify(request) : undefined)
  const result = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr })))
  return { child, result, output: () => stdout }
}
const until = async (check) => {
  for (let n = 0; n < 200; n += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('the durable run did not reach the expected state')
}

test('a fresh process follows the same running job and recovers its terminal answer without rerunning it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'via-durable-'))
  const run = join(dir, 'run')
  const marker = join(dir, 'starts')
  const request = {
    argv: [
      process.execPath,
      '-e',
      `require('fs').appendFileSync(${JSON.stringify(marker)}, 'start\\n'); console.log('working'); setTimeout(() => console.log('the answer'), 500)`,
    ],
    timeoutMs: 5000,
  }
  try {
    const first = start('start', run, request)
    await until(() => first.output().includes('working'))
    first.child.kill('SIGTERM')
    await first.result
    const recoveredRun = start('follow', run)
    const duplicate = start('start', run, request)
    const recovered = await recoveredRun.result
    assert.equal((await duplicate.result).stdout, recovered.stdout)
    assert.equal(recovered.code, 0, recovered.stderr)
    assert.equal(recovered.stdout, 'working\nthe answer\n')
    assert.equal(await readFile(marker, 'utf8'), 'start\n')
    const mismatch = await start('start', run, { ...request, input: 'a different task' }).result
    assert.notEqual(mismatch.code, 0)
    assert.equal(mismatch.stdout, '')
    const again = await start('follow', run).result
    assert.equal(again.stdout, recovered.stdout)
    assert.equal(await readFile(marker, 'utf8'), 'start\n')
    assert.equal((await stat(run)).mode & 0o777, 0o700)
    assert.equal((await stat(join(run, 'events.jsonl'))).mode & 0o777, 0o600)
    await assert.rejects(readFile(join(run, 'request.json')), { code: 'ENOENT' })
  } finally {
    await start('cancel', run).result
    await start('follow', run).result
    await rm(dir, { recursive: true, force: true })
  }
})

test('an explicit cancellation stops the worker, while attaching to an absent run never starts a command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'via-durable-'))
  const run = join(dir, 'run')
  try {
    const first = start('start', run, {
      argv: [process.execPath, '-e', "console.log('working'); setInterval(() => {}, 1000)"],
      timeoutMs: 5000,
    })
    await until(() => first.output().includes('working'))
    assert.equal((await start('cancel', run).result).code, 0)
    assert.notEqual((await first.result).code, 0)
    const absent = await start('follow', join(dir, 'absent')).result
    assert.notEqual(absent.code, 0)
    assert.match(absent.stderr, /not available/)
  } finally {
    await start('cancel', run).result
    await start('follow', run).result
    await rm(dir, { recursive: true, force: true })
  }
})

test('the worker enforces its deadline even after its follower exits, and retains stderr and the nonzero receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'via-durable-'))
  const run = join(dir, 'run')
  try {
    const first = start('start', run, {
      argv: [process.execPath, '-e', "console.log('working'); console.error('résumé 🦀'); setInterval(() => {}, 1000)"],
      timeoutMs: 400,
    })
    await until(() => first.output().includes('working'))
    first.child.kill('SIGKILL')
    await first.result
    const recovered = await start('follow', run).result
    assert.equal(recovered.code, 124)
    assert.match(recovered.stderr, /résumé 🦀/)
    assert.match(recovered.stderr, /stopped \(limit\)/)
  } finally {
    await start('cancel', run).result
    await start('follow', run).result
    await rm(dir, { recursive: true, force: true })
  }
})

test('an incomplete admission is held instead of rerunning an unverified command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'via-durable-'))
  const run = join(dir, 'run')
  try {
    await mkdir(run, { mode: 0o700 })
    await writeFile(join(run, 'events.jsonl'), '', { mode: 0o600 })
    const recovered = await start('start', run, { argv: [process.execPath, '-e', "console.log('must not run')"], timeoutMs: 5000 }).result
    assert.notEqual(recovered.code, 0)
    assert.equal(recovered.stdout, '')
    assert.match(recovered.stderr, /not available; no task was resubmitted/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('output beyond the journal bound stops the command and retains a failure receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'via-durable-'))
  const run = join(dir, 'run')
  try {
    const result = await start('start', run, {
      argv: [process.execPath, '-e', "console.log('x'.repeat(4096)); setInterval(() => {}, 1000)"],
      timeoutMs: 5000,
      maxBytes: 1024, // The private worker protocol may lower, never raise, the production 64 MiB bound.
    }).result
    assert.equal(result.code, 125)
    assert.match(result.stderr, /stopped \(output\)/)
    assert.ok((await stat(join(run, 'events.jsonl'))).size < 1024)
  } finally {
    await start('cancel', run).result
    await start('follow', run).result
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancellation before admission leaves a tombstone and never launches a late start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'via-durable-'))
  const run = join(dir, 'run')
  const marker = join(dir, 'must-not-start')
  try {
    assert.equal((await start('cancel', run).result).code, 0)
    const result = await start('start', run, {
      argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      timeoutMs: 5000,
    }).result
    assert.notEqual(result.code, 0)
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
