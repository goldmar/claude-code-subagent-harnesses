import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk/unstable'
import { isRecord } from './json'
import type { Ask, Norm } from './norm'

// An ACP agent runs behind relay/relay.mjs, which holds the connection open: the engine writes a
// spawn's stdin once and closes it. The relay prints ACP session updates and {"relay": ...} events.

// Paths under the working folder, as codex-acp's titles give them ("Read file '/abs/repo/a.ts'"), are
// shown relative to it: the rest of the title survives the clip, and reads as the agent's own.
// Only where a path starts (the title's start, a quote, a space, an opening parenthesis or =), so a path that merely
// contains the folder (/x/a/repo/y for /a/repo) stays whole.
export const relative = (title: string, cwd: string) =>
  cwd ? title.replace(new RegExp(`(^|[\\s'"(=])${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'g'), '$1') : title

export const clip = (text: string) => (text.length > 100 ? `${text.slice(0, 100)}…` : text)

export const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
export const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text)

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

// A harness's compaction as a row's output: its sizes on the line that stays when the row folds, as
// Claude Code shows its own in one line, and the summary below it, for ctrl+o.
export function compactionOutput(c: { before?: number; after?: number; why?: string; summary?: string }): string {
  const sizes = c.before !== undefined ? `${tokens(c.before)}${c.after !== undefined ? ` → ${tokens(c.after)}` : ''} tokens` : ''
  const head = [sizes, c.why].filter(Boolean).join(' · ')
  return [head, c.summary?.trim()].filter(Boolean).join('\n\n')
}

// A diff as a row shows it: the path, then its changed lines, the first 40 of them.
export const diffRows = (path: string, changed: string[]) =>
  changed.length > 40 ? `${[path, ...changed.slice(0, 40)].join('\n')}\n…` : [path, ...changed].join('\n')

// An edit as its changed lines: the path, then the lines it took out (-) and put in (+), past what both
// versions share at the start and the end. A new file has no old text.
export function diffOf(path: string, oldText: string, newText: string): string {
  const before = oldText ? oldText.split('\n') : []
  const after = newText ? newText.split('\n') : []
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }
  return diffRows(path, [...before.slice(start, endBefore).map((l) => `- ${l}`), ...after.slice(start, endAfter).map((l) => `+ ${l}`)])
}

// What a finished tool call returned, as the agent reported it: its text content, a diff of each file
// it edited, or its raw output. An exit code alone is not output (codex-acp reports one there): the
// parser keeps it apart. Kept short: it lands in the subagent's transcript.
function outputOf(u: { content?: ToolCallContent[] | null; rawOutput?: unknown }, cwd: string): string {
  const parts: string[] = []
  for (const item of Array.isArray(u.content) ? u.content.filter(isRecord) : []) {
    // Typed, but still an agent's JSON: a content item can come without its content.
    if (item.type === 'content' && isRecord(item.content) && item.content.type === 'text' && typeof item.content.text === 'string')
      parts.push(item.content.text)
    else if (item.type === 'diff' && typeof item.path === 'string' && typeof item.newText === 'string')
      parts.push(diffOf(relative(item.path, cwd), typeof item.oldText === 'string' ? item.oldText : '', item.newText))
  }
  const raw = u.rawOutput
  if (parts.length === 0 && raw !== undefined && raw !== null) {
    if (typeof raw === 'string') parts.push(raw)
    else if (isRecord(raw) && typeof raw.output === 'string') parts.push(raw.output)
    else if (!(isRecord(raw) && typeof raw.exit_code === 'number' && Object.keys(raw).length === 1)) parts.push(JSON.stringify(raw))
  }
  return cap(parts.join('\n').trim(), 2000)
}

function ask(e: Record<string, unknown>): Ask | undefined {
  if (typeof e.id !== 'string' || !Array.isArray(e.options)) return undefined
  const options = e.options
    .filter(isRecord)
    .flatMap((o) =>
      typeof o.optionId === 'string' && typeof o.name === 'string' && typeof o.kind === 'string'
        ? [{ optionId: o.optionId, name: o.name, kind: o.kind }]
        : [],
    )
  return {
    id: e.id,
    title: typeof e.title === 'string' ? e.title : '',
    kind: typeof e.kind === 'string' ? e.kind : 'other',
    ...(typeof e.command === 'string' ? { command: e.command } : {}),
    options,
  }
}

// One session's updates: the harness's own, or one of its subagents' (ACP's subagents RFD), each with its
// own calls, messages and context.
function sessionEvents(cwdOf: () => string) {
  let context = 0
  let speaking: unknown
  const shown = new Set<string>()
  const ended = new Set<string>()
  const titles = new Map<string, string>()
  const compactions = new Map<string, { before: number; summary: string }>()
  const kinds = new Map<string, string>()
  // A command's output, as codex-acp streams it (_meta.terminal_output_delta), and its exit code.
  const printed = new Map<string, string>()
  const exits = new Map<string, number>()
  const paths = new Map<string, string>()
  // What a call reported before it ended: codex-acp sends an edit's diff while it runs, not with its end.
  const reported = new Map<string, string>()
  const read = (u: SessionUpdate): Norm[] => {
    const cwd = cwdOf()
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = u.content
        const text = isRecord(content) && content.type === 'text' && typeof content.text === 'string' ? content.text : ''
        if (!text) return []
        // Each message is a new one; only the last is the answer.
        const out: Norm[] = []
        // An agent that sends no message id speaks one message per prompt.
        const id = u.messageId ?? 'unnamed'
        if (id !== speaking) {
          speaking = id
          out.push({ k: 'message' })
        }
        out.push({ k: 'text', t: text })
        return out
      }
      case 'agent_thought_chunk': {
        const content = u.content
        return isRecord(content) && content.type === 'text' && typeof content.text === 'string' && content.text
          ? [{ k: 'thinking', t: content.text }]
          : []
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (typeof u.toolCallId !== 'string') return []
        const id = u.toolCallId
        if (typeof u.title === 'string') titles.set(id, u.title)
        if (typeof u.kind === 'string') kinds.set(id, u.kind)
        const where = Array.isArray(u.locations) ? u.locations.find((l) => isRecord(l)) : undefined
        if (typeof where?.path === 'string') paths.set(id, where.path)
        const meta = isRecord(u._meta) ? u._meta : {}
        const delta = isRecord(meta.terminal_output_delta) ? meta.terminal_output_delta.data : undefined
        // The end of a long output is kept: that is where an error usually is.
        if (typeof delta === 'string') printed.set(id, tail((printed.get(id) ?? '') + delta, 2000))
        const raw = isRecord(u.rawOutput) ? (u.rawOutput as Record<string, unknown>).exit_code : undefined
        const exit = isRecord(meta.terminal_exit) ? meta.terminal_exit.exit_code : raw
        if (typeof exit === 'number') exits.set(id, exit)
        const now = Array.isArray(u.content) && u.content.length > 0 ? outputOf(u, cwd) : ''
        if (now) reported.set(id, now)
        const path = paths.get(id)
        const call = (): Norm => ({
          k: 'call',
          id,
          kind: kinds.get(id) ?? 'other',
          title: clip(relative(titles.get(id) ?? 'tool', cwd)),
          ...(path ? { path } : {}),
        })
        const out: Norm[] = []
        // Announced once, when it starts running: opencode names the command only in an update.
        if (u.status === 'in_progress' && !shown.has(id)) {
          shown.add(id)
          out.push(call())
        }
        if (u.status === 'completed' || u.status === 'failed') {
          // A call reported only once done is announced then.
          if (!shown.has(id)) {
            shown.add(id)
            out.push(call())
          }
          if (!ended.has(id)) {
            ended.add(id)
            const code = exits.get(id)
            const said = outputOf(u, cwd) || reported.get(id) || (printed.get(id) ?? '').trim()
            const output = code && !said.includes(`exit code ${code}`) ? `${said}${said ? '\n' : ''}exit code ${code}` : said
            out.push({ k: 'called', id, output, failed: u.status === 'failed' })
          }
        }
        return out
      }
      case 'plan': {
        const entries = (Array.isArray(u.entries) ? u.entries.filter((entry) => isRecord(entry)) : []).flatMap((entry) =>
          typeof entry.content === 'string'
            ? [{ content: entry.content, status: typeof entry.status === 'string' ? entry.status : 'pending' }]
            : [],
        )
        return entries.length > 0 ? [{ k: 'plan', entries }] : []
      }
      // The agent compacts its own context: a row, as Claude Code shows its own compaction. The relay
      // asks for these, so codex-acp sends them in place of a tool call or a line in the answer.
      case 'compaction_summary_chunk':
      case 'compaction_update': {
        if (typeof u.compactionId !== 'string') return []
        const id = `compaction:${u.compactionId}`
        const out: Norm[] = []
        if (!compactions.has(id)) {
          compactions.set(id, { before: context, summary: '' })
          out.push({ k: 'call', id, kind: 'compact', title: 'conversation' })
        }
        const c = compactions.get(id) ?? { before: context, summary: '' }
        const blocks = u.sessionUpdate === 'compaction_summary_chunk' ? [u.content] : (u.summary ?? [])
        const said = blocks.map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
        c.summary = u.sessionUpdate === 'compaction_summary_chunk' ? c.summary + said : u.summary === undefined ? c.summary : said
        if (u.sessionUpdate === 'compaction_update' && u.status !== 'in_progress' && !ended.has(id)) {
          ended.add(id)
          const failed = u.status !== 'completed'
          const output = failed
            ? u.error || `Compaction ${u.status}.`
            : compactionOutput({ before: c.before || undefined, summary: c.summary })
          out.push({ k: 'called', id, output, failed })
        }
        return out
      }
      case 'usage_update':
        // The agent's own count of its context, which is what Claude Code reads usage as.
        if (typeof u.used !== 'number') return []
        context = u.used
        return [{ k: 'usage', usage: { input: u.used, cacheRead: 0, cacheWrite: 0, output: 0 } }]
      default:
        return []
    }
  }
  return {
    read,
    context: () => context,
    // A steer starts a new prompt: its first message is a new one, even with the same id.
    steered: () => {
      speaking = undefined
    },
  }
}

// What a subagent's session says that its nested agent shows; its usage is its own context, not the run's.
const SHOWN: ReadonlySet<string> = new Set(['message', 'user', 'text', 'thinking', 'plan', 'call', 'called'])

// A parser per run. Updates before the first prompt are a resumed session's history, replayed by
// session/load: never part of this answer.
export function relayEvents(): (line: string) => Norm[] {
  let live = false
  let cwd = ''
  let root: string | undefined
  const own = sessionEvents(() => cwd)
  const children = new Map<string, ReturnType<typeof sessionEvents>>()
  const sessions = new Map<string, string>() // Codex thread id -> announced ACP child session id
  const inputs = new Map<string, { id: unknown; text: string }>()
  const echoes = new Map<string, string>()
  const collaboration = new Map<string, { title?: string; input?: Record<string, unknown> }>()
  const sent = new Set<string>()
  const of = (child: string, norm: Norm): Norm => ({ k: 'of', child, norm })
  const flush = (session: string): Norm[] => {
    const input = inputs.get(session)
    if (!input) return []
    inputs.delete(session)
    const echo = echoes.get(session)
    echoes.delete(session)
    if (!input.text || input.text === echo) return []
    children.get(session)?.steered()
    return [of(session, { k: 'user', t: input.text })]
  }
  return (line) => {
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      return []
    }
    if (!isRecord(e)) return []
    switch (e.relay) {
      case 'session':
        if (typeof e.cwd === 'string' && e.cwd) cwd = e.cwd.replace(/\/+$/, '')
        if (typeof e.sessionId === 'string') root = e.sessionId
        return typeof e.sessionId === 'string' ? [{ k: 'session', id: e.sessionId }] : []
      case 'model':
        return typeof e.name === 'string' ? [{ k: 'model', name: e.name }] : []
      case 'steered':
        live = true
        own.steered()
        return [{ k: 'steered' }]
      case 'interrupted':
        return [{ k: 'interrupted' }, { k: 'tool', t: '\n▸ interrupted\n' }]
      case 'ask': {
        const asked = ask(e)
        return asked ? [{ k: 'ask', ask: asked }] : []
      }
      case 'error':
        return [{ k: 'error', message: typeof e.message === 'string' ? e.message : 'the relay failed' }]
      case 'paused':
        return [
          {
            k: 'tool',
            t: `\n▸ ${typeof e.message === 'string' ? e.message : 'Codex is at capacity'}. Waiting for a follow-up; native helpers are retained.\n`,
          },
        ]
      case 'prompt_done': {
        // The prompt's own count of what it wrote, beside the context the last usage_update reported.
        const usage = isRecord(e.usage) ? e.usage : {}
        const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
        return [{ k: 'usage', usage: { input: own.context(), cacheRead: 0, cacheWrite: 0, output } }]
      }
      case undefined:
        break
      default:
        return []
    }
    // The agent's JSON, read through the SDK's types: a field the protocol renames fails the type check
    // here. Its values are still checked, as anything a process prints is.
    if (!live || !isRecord(e.update) || typeof e.update.sessionUpdate !== 'string') return []
    const u = e.update as SessionUpdate
    const session = typeof e.sessionId === 'string' ? e.sessionId : root
    if (u.sessionUpdate === 'subagent_update') {
      if (typeof u.sessionId !== 'string' || session === undefined) return []
      const thread = u.sessionId.split(':subagent:').at(-1) ?? u.sessionId
      if (!sessions.has(thread) && typeof u.description === 'string') echoes.set(u.sessionId, u.description)
      sessions.set(thread, u.sessionId)
      const now = isRecord(u.state) ? u.state : undefined
      const state = typeof now?.state === 'string' ? now.state : undefined
      // A child's work that ended in a failure says so only here: v1 has no prompt response for it.
      const idle = now?.state === 'idle' ? now : undefined
      const failure =
        idle?.stopReason === 'error'
          ? isRecord(idle.error) && typeof idle.error.message === 'string'
            ? idle.error.message
            : 'error'
          : undefined
      return [
        ...(state === 'idle' ? flush(u.sessionId) : []),
        {
          k: 'child',
          id: u.sessionId,
          parent: session,
          ...(typeof u.title === 'string' ? { title: u.title } : {}),
          ...(typeof u.description === 'string' ? { description: u.description } : {}),
          ...(state ? { state } : {}),
          ...(failure ? { failure } : {}),
        },
      ]
    }
    const out: Norm[] = []
    // codex-acp suppresses live child userMessage items. Its collaboration reporter carries the
    // complete steering prompt and receiver thread ids on sendInput/followupTask instead.
    if ((u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && typeof u.toolCallId === 'string') {
      const key = `${session}/${u.toolCallId}`
      const held = collaboration.get(key) ?? {}
      if (typeof u.title === 'string') held.title = u.title
      if (isRecord(u.rawInput)) held.input = u.rawInput
      if (held.title === 'sendInput' || held.title === 'followupTask') {
        collaboration.set(key, held)
        if (u.status === 'completed' && !sent.has(key)) {
          sent.add(key)
          collaboration.delete(key)
          const input = held.input
          if (typeof input?.prompt === 'string' && input.prompt && Array.isArray(input.receiverThreadIds)) {
            for (const receiver of new Set(input.receiverThreadIds)) {
              const child = typeof receiver === 'string' ? sessions.get(receiver) : undefined
              if (!child) continue
              // Some ACP producers echo input before the collaboration call completes.
              if (inputs.get(child)?.text === input.prompt) inputs.delete(child)
              else out.push(...flush(child))
              out.push(of(child, { k: 'user', t: input.prompt }))
              echoes.set(child, input.prompt)
              children.get(child)?.steered()
            }
          }
        } else if (u.status === 'failed') collaboration.delete(key)
      }
    }
    // The root already has its real user rows. Only child input needs a transcript copy.
    if (root === undefined || session === undefined || session === root) return [...out, ...own.read(u)]
    if (u.sessionUpdate === 'user_message_chunk') {
      const content = u.content
      if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') return out
      const previous = inputs.get(session)
      if (previous && previous.id !== u.messageId) out.push(...flush(session))
      const input = inputs.get(session) ?? { id: u.messageId, text: '' }
      input.text += content.text
      inputs.set(session, input)
      return out
    }
    if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(u.sessionUpdate)) {
      out.unshift(...flush(session))
      // An input echo precedes the reply. The same words sent again after work are new input.
      echoes.delete(session)
    }
    // The model a subagent runs on, as its session's config reports it (one select of category model).
    if (u.sessionUpdate === 'config_option_update') {
      const option = (Array.isArray(u.configOptions) ? u.configOptions : []).find((o) => isRecord(o) && o.category === 'model')
      const value = isRecord(option) && typeof option.currentValue === 'string' ? option.currentValue : undefined
      return value ? [...out, of(session, { k: 'model', name: value })] : out
    }
    let child = children.get(session)
    if (child === undefined) {
      child = sessionEvents(() => cwd)
      children.set(session, child)
    }
    return [...out, ...child.read(u).flatMap((norm): Norm[] => (SHOWN.has(norm.k) ? [of(session, norm)] : []))]
  }
}

// The relay's stderr, for an adapter's failure(): a resumed session the agent no longer has.
export const sessionLost = (stderr: string) => stderr.includes('acp relay: session lost:')
