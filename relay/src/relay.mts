// Holds an ACP (Agent Client Protocol) connection open for a Claude Code plugin, whose spawn writes stdin
// once and closes it. Built into relay/relay.mjs (pnpm build:relay), which ships with the SDK inlined.
//
// Usage: node relay.mjs -- <agent command...>, with the prompt on stdin.
// Env:
//   RELAY_INBOX       file of JSON lines the plugin appends: a string steers the running prompt (see
//                     RELAY_STEER) or queues a follow-up, {"interrupt": text} cancels the turn and runs text
//                     next, {"answer": id, "optionId": id|null} answers a question
//   RELAY_STEER       how a string reaches a running prompt: steering (codex-acp's _session/steering), prompt
//                     (a second session/prompt, which opencode takes at its next step); unset: queued
//   RELAY_SESSION     a session to resume (session/load)
//   RELAY_MODEL       the agent's `model` config option
//   RELAY_AGENT_MODE  the agent's own mode (session/set_mode), such as codex's workspace-write
//   RELAY_CONFIG      a JSON object of other config options to set, such as {"reasoning_effort": "high"}
//   RELAY_POLICY      how permission requests are answered: allow, deny (the default) or ask (every request
//                     goes to the plugin)
// Prints each ACP session update as received, and {"relay": ...} lines for its own events.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk/unstable'

type Policy = 'allow' | 'deny' | 'ask'
type Answer = (optionId: string | null) => void

const out = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`)
let agentPid: number | undefined
// busy: a prompt of the main loop is running. spokeIdle: the agent wrote an answer while none was.
let busy = false
let spokeIdle = false
const fail = (message: string): never => {
  out({ relay: 'error', message })
  process.stderr.write(`acp relay: ${message}\n`)
  try {
    if (agentPid !== undefined) process.kill(-agentPid, 'SIGTERM')
  } catch {
    // Already gone.
  }
  process.exit(1)
}
// An agent's JSON-RPC error can say only "Internal error" and carry the cause in its data (codex-acp
// puts Codex's own message there, such as a usage limit and when it resets): both are kept.
const reason = (error: unknown) => {
  const { message, data } = (error ?? {}) as { message?: unknown; data?: unknown }
  const said = String(message ?? error)
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined
  // Only the agent's own words, capped: a whole data record could echo a request, its env or a token.
  const words =
    typeof data === 'string'
      ? data
      : typeof record?.details === 'string'
        ? record.details
        : typeof record?.message === 'string'
          ? record.message
          : ''
  const cause = words.length > 500 ? `${words.slice(0, 500)}…` : words
  return cause && !said.includes(cause) ? `${said}: ${cause}` : said
}

// Claude hands a subagent a screenshot as a path in its prompt (often its own temp folder): an agent that
// takes images gets each existing one as an image block too, the path left in the text.
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
// The relay runs outside the agent's sandbox, so it reads an image only where the run already works:
// under the working folder, or Claude Code's own temp folder, where its screenshots are (/tmp/claude-<uid>).
// Symlinks are resolved first, and the bytes must be the image the name claims.
const realOrNone = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}
const IMAGE_ROOTS = [process.cwd(), `/tmp/claude-${process.getuid?.() ?? ''}`].flatMap((root) => realOrNone(root) ?? [])
const MAGIC: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  'image/jpeg': (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
}
// A path starts the text or follows a space, quote or bracket (not the tail of a relative path or of a
// URL), and at most four images go along.
const attached = (text: string): acp.ContentBlock[] => {
  const paths = new Set([...text.matchAll(/(?:^|[\s'"`(<])(\/[^\s'"`<>()]+\.(?:png|jpe?g|gif|webp))\b/gi)].map((m) => m[1] as string))
  const blocks: acp.ContentBlock[] = []
  for (const path of paths) {
    if (blocks.length >= 4) break
    const mimeType = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? '']
    const real = realOrNone(path)
    if (!mimeType || !real || !IMAGE_ROOTS.some((root) => real.startsWith(`${root}/`))) continue
    try {
      if (statSync(real).size > 5 * 1024 * 1024) continue
      const bytes = readFileSync(real)
      if (MAGIC[mimeType]?.(bytes)) blocks.push({ type: 'image', mimeType, data: bytes.toString('base64') })
    } catch {
      // Not readable: the path stays text.
    }
  }
  return blocks
}

// terminal_output_delta: command output in tool call updates, the Zed convention. No client terminal:
// commands stay in the agent's own sandbox. No plan capability: a to-do list comes as a plan update
// either way, and with it codex-acp sends a markdown plan as plan_update, which this client does not
// draw, in place of the message text it otherwise is. Compaction: codex-acp then reports the agent's
// compaction as compaction updates, not a tool call or a line in the answer. Subagents: a harness's own
// subagents come as child sessions (ACP's subagents RFD), not folded into the parent; the relay reads
// the SDK's unstable schema, which has them, still at protocol version 1.
const CAPABILITIES: acp.ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  session: { compaction: {} },
  subagents: {},
  _meta: {
    terminal_output_delta: true,
    // Codex otherwise renders terminal provider errors as ordinary answer text.
    ...(process.env.RELAY_STEER === 'steering' ? { jetbrains: { air: { version: 1, capabilities: ['sessionFailure'] } } } : {}),
  },
}
const dash = process.argv.indexOf('--')
const [bin, ...args] = dash < 0 ? [] : process.argv.slice(dash + 1)
if (bin === undefined) fail('usage: relay.mjs -- <agent command...>')
const policy = (process.env.RELAY_POLICY ?? 'deny') as Policy
if (!['allow', 'deny', 'ask'].includes(policy)) fail(`RELAY_POLICY must be allow, deny or ask, not ${policy}`)
const cwd = process.cwd()

const prompt = await new Promise<string>((resolve) => {
  let text = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => (text += chunk))
  process.stdin.on('end', () => resolve(text))
})

// Its own process group, so a stop also reaches what it started.
const agent = spawn(bin as string, args, { stdio: ['pipe', 'pipe', 'inherit'], detached: true })
agentPid = agent.pid
agent.on('error', (error) => fail(`could not start ${bin}: ${error.message}`))
// Set once a session exists. Cancelling ends the agent's running tool, which a kill does not: opencode
// runs commands in their own process group, so a group kill left a `sleep` running.
let cancel = async () => {}
const stop = async (code: number) => {
  await Promise.race([cancel(), new Promise((resolve) => setTimeout(resolve, 2000))])
  try {
    if (agent.pid !== undefined) process.kill(-agent.pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
  process.exit(code)
}
// The engine stops a run with SIGTERM: the agent must not outlive the relay.
process.on('SIGTERM', () => void stop(0))
process.on('SIGINT', () => void stop(0))
agent.on('exit', (code) => {
  out({ relay: 'agent_exit', code })
  process.exit(code ?? 1)
})

// Ids unique to this run: a late answer to an earlier run's question must never match one here.
const RUN = `${process.pid}-${Date.now().toString(36)}`
const asked = new Map<string, Answer>()
let asks = 0
const choose = (options: readonly acp.PermissionOption[], kind: acp.PermissionOptionKind): acp.RequestPermissionResponse => {
  const option = options.find((o) => o.kind === kind)
  return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(agent.stdin) as WritableStream<Uint8Array>,
  Readable.toWeb(agent.stdout) as ReadableStream<Uint8Array>,
)
const result = await acp
  .client({ name: 'via' })
  .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
    const { toolCall, options } = ctx.params
    if (policy === 'allow') return choose(options, 'allow_once')
    // With no inbox no answer can come back: deny rather than wait forever.
    if (policy === 'deny' || !process.env.RELAY_INBOX) return choose(options, 'reject_once')
    const id = `${RUN}-${++asks}`
    const raw = toolCall.rawInput as { command?: unknown } | undefined
    out({
      relay: 'ask',
      id,
      title: toolCall.title ?? '',
      kind: toolCall.kind ?? 'other',
      ...(typeof raw?.command === 'string'
        ? { command: raw.command }
        : Array.isArray(raw?.command)
          ? { command: raw.command.join(' ') }
          : {}),
      options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    })
    return new Promise<acp.RequestPermissionResponse>((resolve) =>
      asked.set(id, (optionId) =>
        resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } }),
      ),
    )
  })
  .onNotification(acp.methods.client.session.update, (ctx) => {
    if (!busy && ctx.params.update.sessionUpdate === 'agent_message_chunk') spokeIdle = true
    out(ctx.params as unknown as Record<string, unknown>)
  })
  .connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: CAPABILITIES,
    })
    const resume = process.env.RELAY_SESSION
    const opened = resume
      ? await ctx.request(acp.methods.agent.session.load, { sessionId: resume, cwd, mcpServers: [] }).catch((error: unknown) => {
          const message = reason(error)
          const data = JSON.stringify((error as { data?: unknown })?.data ?? '')
          // Only a session the agent no longer has is lost; anything else (auth, a crash) is a failure.
          if (!/not found/i.test(`${message} ${data}`)) return fail(`could not resume the session: ${message}`)
          out({ relay: 'session_lost', message })
          process.stderr.write(`acp relay: session lost: ${message}\n`)
          return process.exit(1)
        })
      : await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
    const sessionId = resume ?? (opened as acp.NewSessionResponse).sessionId
    // cwd: so a title's paths can be shown relative to it.
    out({ relay: 'session', sessionId, cwd })
    cancel = async () => {
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId })
      // A moment for the agent to abort its tool before the kill.
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    const modeId = process.env.RELAY_AGENT_MODE
    if (modeId)
      await ctx
        .request(acp.methods.agent.session.setMode, { sessionId, modeId })
        .catch((error: unknown) => fail(`the agent refused mode ${modeId}: ${String((error as { message?: unknown })?.message ?? error)}`))
    let configOptions = (opened as { configOptions?: acp.SessionConfigOption[] | null }).configOptions ?? []
    const model = process.env.RELAY_MODEL
    if (model) {
      // A model the agent refuses ends the run: carrying on would answer from its default model.
      const set = await ctx
        .request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: model })
        .catch((error: unknown) => fail(`the agent refused model ${model}: ${String((error as { message?: unknown })?.message ?? error)}`))
      configOptions = set.configOptions ?? configOptions
    }
    let extra: Record<string, unknown> = {}
    try {
      extra = JSON.parse(process.env.RELAY_CONFIG || '{}') as Record<string, unknown>
    } catch {
      fail('RELAY_CONFIG is not a JSON object')
    }
    for (const [configId, value] of Object.entries(extra)) {
      if (typeof value !== 'string') fail(`RELAY_CONFIG.${configId} must be a string`)
      const set = await ctx
        .request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value: value as string })
        .catch((error: unknown) => fail(`the agent refused ${configId} ${String(value)}: ${reason(error)}`))
      configOptions = set.configOptions ?? configOptions
    }
    const current = configOptions.find((o) => o.id === 'model')
    if (current && 'currentValue' in current && typeof current.currentValue === 'string')
      out({ relay: 'model', name: current.currentValue })

    const queue = [prompt]
    let interrupt: string | undefined
    const takeInterrupt = () => {
      if (interrupt === undefined) return
      out({ relay: 'interrupted' })
      queue.unshift(interrupt)
      interrupt = undefined
    }
    let last: acp.PromptResponse | undefined
    const promptDone = (r: acp.PromptResponse) =>
      // Not in the stable type, but codex-acp and opencode send it.
      out({ relay: 'prompt_done', stopReason: r.stopReason, usage: (r as { usage?: unknown }).usage ?? null })
    // Steers still in flight: the run is not over until each has returned. A steer counts as
    // `steered` only once the agent has taken it, or a requeued one would count twice.
    const steering = new Set<Promise<void>>()
    const images = init.agentCapabilities?.promptCapabilities?.image === true
    const prompted = (text: string): acp.PromptRequest => ({
      sessionId,
      prompt: [{ type: 'text', text }, ...(images ? attached(text) : [])],
    })
    const refused = (text: string, error: unknown) => {
      process.stderr.write(`acp relay: steer refused, queued: ${reason(error)}\n`)
      queue.push(text)
    }
    // Codex steers go one at a time: a later one must not land in a turn an earlier one's fallback cancels.
    let codexSteers: Promise<void> = Promise.resolve()
    const steerCodex = (text: string) =>
      (codexSteers = codexSteers.then(async () => {
        // The prompt ended, or is being interrupted, while this one waited.
        if (!busy || interrupt !== undefined) return void queue.push(text)
        const r = await ctx
          .request<{ outcome?: string }>('_session/steering', prompted(text))
          .catch((error: unknown) => refused(text, error))
        if (r === undefined) return
        if (r.outcome === 'injected') return void out({ relay: 'steered' })
        // No turn was left to steer, so codex-acp started one whose end this relay never hears:
        // cancel it and run the message as an ordinary prompt.
        if (r.outcome === 'startedNewTurn') await ctx.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {})
        queue.push(text)
      }))
    // opencode takes a second prompt at its next step and answers it when all its work is done.
    const steerOpencode = async (text: string) => {
      const r = await ctx.request(acp.methods.agent.session.prompt, prompted(text)).catch((error: unknown) => refused(text, error))
      // Cancelled by an interrupt before it was read: reported undelivered.
      if (r === undefined || r.stopReason === 'cancelled') return
      out({ relay: 'steered' })
      // It landed after the prompt ended, so it ran as its own answer.
      if (spokeIdle) {
        last = r
        promptDone(r)
      }
    }
    const steer = (text: string) => {
      const done: Promise<void> = (process.env.RELAY_STEER === 'steering' ? steerCodex(text) : steerOpencode(text)).finally(() =>
        steering.delete(done),
      )
      steering.add(done)
    }
    let offset = 0
    const inbox = process.env.RELAY_INBOX
    let paused = false
    if (inbox)
      setInterval(() => {
        if (!existsSync(inbox)) return
        const text = readFileSync(inbox, 'utf8')
        const end = text.lastIndexOf('\n')
        if (end < offset) return
        for (const line of text.slice(offset, end).split('\n')) {
          if (!line.trim()) continue
          const value = JSON.parse(line) as unknown
          if (typeof value === 'string') {
            // Not into a turn an interrupt is cancelling.
            if (busy && interrupt === undefined && process.env.RELAY_STEER) steer(value)
            else queue.push(value)
          } else if (typeof value === 'object' && value !== null && 'answer' in value) {
            const { answer, optionId } = value as { answer: string; optionId?: string | null }
            asked.get(answer)?.(optionId ?? null)
            asked.delete(answer)
          } else if (typeof value === 'object' && value !== null && 'interrupt' in value) {
            const text = String((value as { interrupt: unknown }).interrupt)
            if (paused && !busy) {
              paused = false
              queue.push(text)
              out({ relay: 'interrupted' })
              continue
            }
            interrupt = interrupt === undefined ? text : `${interrupt}\n\n${text}`
            // An unanswered question would hold the turn open past the cancel.
            for (const [id, answerIt] of asked) {
              answerIt(null)
              asked.delete(id)
            }
            void ctx.notify(acp.methods.agent.session.cancel, { sessionId })
          }
        }
        offset = end + 1
      }, 300).unref()

    while (queue.length > 0 || steering.size > 0 || paused) {
      if (queue.length === 0) {
        await Promise.all(steering)
        if (paused) await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
      paused = false
      const text = queue.shift() as string
      out({ relay: 'steered' })
      // Cleared here, not after: a resumed session's replayed history arrives before the first prompt.
      busy = true
      spokeIdle = false
      const r = await ctx.request(acp.methods.agent.session.prompt, prompted(text)).catch((error: unknown) => {
        // Legacy adapters can return the same error through JSON-RPC rather than typed metadata.
        if (inbox && process.env.RELAY_STEER === 'steering' && /selected model is at capacity/i.test(reason(error))) {
          paused = true
          out({ relay: 'paused', message: reason(error) })
          return undefined
        }
        return fail(reason(error))
      })
      busy = false
      if (!r) {
        takeInterrupt()
        continue
      }
      last = r
      promptDone(r)
      const failure = (
        r._meta as { jetbrains?: { air?: { sessionFailure?: { kind?: string; severity?: string; title?: string } } } } | undefined
      )?.jetbrains?.air?.sessionFailure
      if (failure?.severity === 'error') {
        const message = failure.title ?? `Codex failed: ${failure.kind ?? 'provider error'}`
        if (inbox && failure.kind === 'overloaded') {
          // Keep the runtime and its native children. Only a new inbox message submits another prompt;
          // the normal via deadline and explicit cancellation still stop this worker.
          paused = true
          out({ relay: 'paused', message })
        } else fail(message)
      }
      takeInterrupt()
    }
    return last
  })

out({ relay: 'done', stopReason: result?.stopReason ?? null })
cancel = async () => {}
await stop(0)
