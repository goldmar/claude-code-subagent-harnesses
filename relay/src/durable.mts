// A harness run belongs to this worker, not to the Claude process following it. A follower can
// disappear during /background or reload; another reads the same journal without resubmitting work.
// Node runs this file with type stripping, like mcp/step.mts. No provider or shell is used here.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as sleep } from 'node:timers/promises'

type Request = { argv: string[]; cwd?: string; env?: Record<string, string>; input?: string; timeoutMs: number; maxBytes?: number }
type Piece = { stream: 'stdout' | 'stderr'; text: string } | { code: number | null; signal: string | null }
const [mode, directory] = process.argv.slice(2)
if (!directory || !['start', 'work', 'follow', 'cancel'].includes(mode ?? ''))
  throw new Error('expected start, follow or cancel and a run directory')
const dir = resolve(directory)
const events = `${dir}/events.jsonl`
const requestFile = `${dir}/request.json`
const ownerFile = `${dir}/owner.json`
const cancelled = `${dir}/cancel`
const MAX_BYTES = 64 * 1024 * 1024
let maxBytes = MAX_BYTES
let written = 0
let outputLimit = () => {}
const write = (piece: Piece, terminal = false) => {
  const text = `${JSON.stringify(piece)}\n`
  if (!terminal && 'stream' in piece && written + Buffer.byteLength(text) > maxBytes) return outputLimit()
  appendFileSync(events, text, { mode: 0o600 })
  written += Buffer.byteLength(text)
}
const unavailable = () => {
  process.stderr.write('via: the retained run is not available; no task was resubmitted.\n')
  process.exit(200)
}

if (mode === 'cancel') {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(cancelled, '', { mode: 0o600 })
  if (!existsSync(events)) process.exit(0)
}

if (mode === 'start') {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const request: Request = JSON.parse(input)
  if (
    !Array.isArray(request.argv) ||
    request.argv.length === 0 ||
    request.argv.some((arg) => typeof arg !== 'string') ||
    !Number.isFinite(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    (request.maxBytes !== undefined && (!Number.isFinite(request.maxBytes) || request.maxBytes <= 0))
  )
    throw new Error('invalid durable run request')
  request.cwd = resolve(request.cwd ?? '.')
  const identity = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 })
  let created = false
  try {
    mkdirSync(dir, { mode: 0o700 })
    created = true
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
  }
  // mkdir is the admission lock. Only its owner may start a command; a partial admission is held,
  // never retried as new work by an attaching process.
  if (created) {
    writeFileSync(`${dir}/admission`, identity, { mode: 0o600, flag: 'wx' })
    writeFileSync(requestFile, JSON.stringify(request), { mode: 0o600, flag: 'wx' })
    writeFileSync(events, '', { mode: 0o600, flag: 'wx' })
    const worker = spawn(process.execPath, [process.argv[1] as string, 'work', dir], { detached: true, stdio: 'ignore' })
    worker.unref()
  } else if (!existsSync(`${dir}/admission`) || readFileSync(`${dir}/admission`, 'utf8') !== identity) {
    unavailable()
  }
}

if (mode === 'work') {
  const request: Request = JSON.parse(readFileSync(requestFile, 'utf8'))
  unlinkSync(requestFile)
  if (existsSync(cancelled)) {
    write({ stream: 'stderr', text: 'via: the retained run was stopped (abort).\n' }, true)
    write({ code: 130, signal: null })
    process.exit(0)
  }
  maxBytes = Math.min(request.maxBytes ?? MAX_BYTES, MAX_BYTES)
  const timeoutMs = Math.min(request.timeoutMs, 2_147_000_000)
  writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, deadline: Date.now() + timeoutMs }), { mode: 0o600, flag: 'wx' })
  const [command, ...args] = request.argv
  const child = spawn(command as string, args, {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let reason: 'limit' | 'abort' | 'output' | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch {
      // Already ended.
    }
  }
  const stop = (why: 'limit' | 'abort' | 'output') => {
    if (reason) return
    reason = why
    kill('SIGTERM')
    killTimer = setTimeout(() => kill('SIGKILL'), 5000)
  }
  outputLimit = () => stop('output')
  process.on('SIGTERM', () => stop('abort'))
  process.on('SIGINT', () => stop('abort'))
  const timer = setTimeout(() => stop('limit'), timeoutMs)
  const control = setInterval(() => {
    if (existsSync(cancelled)) stop('abort')
  }, 100)
  child.stdout.setEncoding('utf8').on('data', (text: string) => write({ stream: 'stdout', text }))
  child.stderr.setEncoding('utf8').on('data', (text: string) => write({ stream: 'stderr', text }))
  child.stdin.on('error', () => {}) // A refused command can close stdin before it receives the prompt.
  child.stdin.end(request.input)
  child.on('error', (error) => write({ stream: 'stderr', text: `could not start the harness: ${error.message}\n` }))
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    clearInterval(control)
    if (killTimer) clearTimeout(killTimer)
    if (reason) write({ stream: 'stderr', text: `via: the retained run was stopped (${reason}).\n` }, true)
    write({ code: reason ? (reason === 'limit' ? 124 : reason === 'output' ? 125 : 130) : code, signal })
  })
} else {
  // Merely following is side effect free: even a missing receipt must never start another model call.
  if (!existsSync(events)) unavailable()
  const fd = openSync(events, 'r')
  const bytes = Buffer.alloc(64 * 1024)
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let offset = 0
  let quiet = 0
  try {
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.length, offset)
      offset += count
      pending += decoder.write(bytes.subarray(0, count))
      let end = pending.indexOf('\n')
      while (end !== -1) {
        const piece: Piece = JSON.parse(pending.slice(0, end))
        pending = pending.slice(end + 1)
        if ('stream' in piece && mode !== 'cancel') {
          if (!process[piece.stream].write(piece.text)) await once(process[piece.stream], 'drain')
        } else if ('code' in piece) process.exit(mode === 'cancel' ? 0 : (piece.code ?? 1))
        end = pending.indexOf('\n')
      }
      if (count > 0) continue
      quiet += 1
      if (quiet > 30) {
        if (!existsSync(ownerFile)) unavailable()
        const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as { pid: number; deadline: number }
        try {
          process.kill(owner.pid, 0)
        } catch {
          unavailable()
        }
        if (Date.now() > owner.deadline + 10_000) unavailable()
      }
      await sleep(100)
    }
  } finally {
    closeSync(fd)
  }
}
