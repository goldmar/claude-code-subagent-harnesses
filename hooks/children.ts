import type { EngineInterface, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Norm } from './acp/norm'
import { CHILD_CALL, type Mark } from './acp/steps'
import { deliver, respond } from './handback'

// A harness's own subagents (ACP's subagents RFD) as Claude Code agents nested under the via agent: the
// via agent's step calls the Agent tool, and via drives the nested agent's steps from what the child's
// session says. Its events reach via only through the parent's run, which a parent step is always
// reading while the harness runs, so the nested agent waits on a queue the parent's run fills.

type Queued = Norm | { readonly k: 'end'; readonly failure?: string } | { readonly k: 'spawn'; readonly child: string }
export type Channel = {
  readonly key: string // this assignment's: a child's work after an end is a new nested agent
  readonly type: string // the nested agent's subagent_type
  title: string
  description?: string
  readonly parent?: string
  model?: string
  readonly queue: Queued[]
  wake?: () => void
  spawned: boolean
  ended: boolean
  read: boolean // its nested agent has shown it all
  closed: boolean // the via agent's run ended
}
export type Children = {
  // By `${via agent id}/${child session id}`, the child's current assignment, and by each assignment's key.
  channels: Map<string, Channel>
  nested: Map<string, { key: string; report?: string }> // by the nested agent's id
  // By assignment key: a resumed nested agent waiting for its parent's journal to name its child.
  arrivals?: Map<string, Promise<boolean>>
}

// Served as an engine noun: the caller's own-time budget pauses. Each call is bounded below
// the noun's ten-second reply deadline; a quiet child can take as many waits as it needs.
// Clock sleeps directly in the renderer would instead spend its own-time budget.
export async function waitChild(
  w: Children,
  key: string,
  after: (wake: () => void) => ReturnType<EngineInterface['clock']['after']>,
): Promise<void> {
  const channel = w.channels.get(key)
  const arriving = channel === undefined ? w.arrivals?.get(key) : undefined
  if (arriving) {
    let timer: ReturnType<EngineInterface['clock']['after']> | undefined
    try {
      await Promise.race([arriving, new Promise<void>((resolve) => (timer = after(resolve)))])
    } finally {
      timer?.cancel()
    }
    return
  }
  if (!channel || channel.read || channel.queue.length > 0) return
  let wake: (() => void) | undefined
  let timer: ReturnType<EngineInterface['clock']['after']> | undefined
  try {
    await new Promise<void>((resolve) => {
      wake = resolve
      channel.wake = wake
      timer = after(resolve)
    })
  } finally {
    if (channel.wake === wake) channel.wake = undefined
    timer?.cancel()
  }
}

const put = (channel: Channel, item: Queued) => {
  channel.queue.push(item)
  channel.wake?.()
}

// A child's event, from the via agent's run: a spawn mark for the first one of a child of the harness's
// own session; a nested child's spawn goes to its parent's queue, whose agent makes it.
export function route(w: Children, agentId: string, type: string, event: Extract<Norm, { k: 'child' | 'of' }>): Mark[] {
  const key = (session: string) => `${agentId}/${session}`
  const id = event.k === 'child' ? event.id : event.child
  let channel = w.channels.get(key(id))
  const marks: Mark[] = []
  // A child is shown on its first sign of work or its announcement, never on a patch alone (codex-acp
  // clears its cancel capability after it goes idle). Work after an end is a new assignment of the same
  // child: a new nested agent, as Claude Code shows one; its model snapshot is not work.
  const working = (event.k === 'of' && event.norm.k !== 'model') || (event.k === 'child' && event.state === 'running')
  const announced = event.k === 'child' && (event.title !== undefined || event.description !== undefined)
  if (channel === undefined ? working || announced || event.k === 'of' : channel.ended && working) {
    const title = (event.k === 'child' ? event.title : undefined) ?? channel?.title ?? 'subagent'
    const description =
      event.k === 'child' ? (event.description ?? channel?.description) : event.norm.k === 'user' ? event.norm.t : channel?.description
    const parentId = event.k === 'child' ? event.parent : channel?.parent
    const assignment = `${key(id)}#${channel ? Number(channel.key.slice(channel.key.lastIndexOf('#') + 1)) + 1 : 1}`
    channel = {
      key: assignment,
      type,
      title,
      ...(parentId ? { parent: parentId } : {}),
      ...(description ? { description } : {}),
      queue: [],
      spawned: true,
      ended: false,
      read: false,
      closed: false,
    }
    w.channels.set(key(id), channel)
    w.channels.set(assignment, channel)
    const parent = parentId ? w.channels.get(key(parentId)) : undefined
    if (parent !== undefined) put(parent, { k: 'spawn', child: assignment })
    else marks.push({ kind: 'spawn', child: assignment, type, title, ...(description ? { description } : {}) })
    // The opening user message is already the native Agent prompt for this assignment.
    if (event.k === 'of' && event.norm.k === 'user') return marks
  }
  if (channel === undefined) return marks
  if (event.k === 'of') {
    if (event.norm.k === 'model') channel.model = event.norm.name
    put(channel, event.norm)
  } else {
    if (event.title) channel.title = event.title
    if (event.description !== undefined) channel.description = event.description
    if (event.state === 'idle' && !channel.ended) {
      channel.ended = true
      put(channel, { k: 'end', ...(event.failure ? { failure: event.failure } : {}) })
    }
  }
  return marks
}

// Claude Code's own framing around a notification or an agent's message, line by line.
const FRAMING = [
  '[SYSTEM NOTIFICATION',
  'This is an automated background-task event',
  'Do NOT interpret this as user',
  'No human input has been received',
  'Another Claude session sent a message',
  'That "other Claude session" is an agent',
]

// A nested agent's end, or a message sent as it (auto mode's note on its work), can reach its via parent
// as a turn after the parent's run. Without them and Claude Code's framing, what is left is the turn's
// prompt: '' for a wake, which runs nothing; undefined when the turn has none of them.
export function woken(text: string, nested: ReadonlyMap<string, unknown>): string | undefined {
  let found = false
  const rest = text
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, (block) => {
      if (!block.includes(CHILD_CALL)) return block
      found = true
      return ''
    })
    .replace(/<agent-message\s+from="([^"]+)"[^>]*>[\s\S]*?<\/agent-message>/g, (block, from: string) => {
      if (!nested.has(from)) return block
      found = true
      return ''
    })
  if (!found) return undefined
  return rest
    .split('\n')
    .filter((line) => !FRAMING.some((frame) => line.startsWith(frame)))
    .join('\n')
    .trim()
}

// The via agent's run ended: its harness's subagents can say nothing more. Their queues stay for their
// nested agents, whose first step can come after the parent's last; each drops its own once read.
export function closeChildren(w: Children, agentId: string, failure?: string): void {
  for (const [key, channel] of w.channels) {
    if (!key.startsWith(`${agentId}/`)) continue
    channel.closed = true
    if (channel.read) w.channels.delete(key)
    else if (!channel.ended) {
      channel.ended = true
      put(channel, { k: 'end', ...(failure ? { failure } : {}) })
    }
  }
}

// A nested agent's run: its child's rows and messages, then its last message as the answer, signed with
// the model the child's session reported.
const PLAN_MARKS: Record<string, string> = { pending: '☐', in_progress: '◐', completed: '☑' }

export async function* childRun(
  w: Children,
  $: Pick<EngineInterface, 'viaChildren'>,
  agentId: string,
  name: string,
  e: { turnId: string; index: number },
  signal: AbortSignal,
  handback: boolean,
  complete?: (signed: string) => Promise<void>,
): AsyncGenerator<TurnStepChunk | Mark, TurnStepResult> {
  const nested = w.nested.get(agentId)
  const channel = nested === undefined ? undefined : w.channels.get(nested.key)
  let index = -1
  let kind: 'text' | 'thinking' | undefined
  let report = ''
  let plan = ''
  let plans = 0
  let failure: string | undefined = channel === undefined ? 'its event channel is no longer available' : undefined
  const push = (k: 'text' | 'thinking', text: string): TurnStepChunk => {
    if (kind !== k) {
      kind = k
      index += 1
    }
    return { kind: k, index, text }
  }
  for (;;) {
    if (signal.aborted) {
      failure = 'it was stopped'
      break
    }
    const item = channel?.queue.shift() ?? (channel === undefined ? ({ k: 'end' } as const) : undefined)
    if (item === undefined) {
      const wake = () => {
        if (signal.aborted && channel) channel.read = true
        channel?.wake?.()
      }
      signal.addEventListener('abort', wake, { once: true })
      try {
        await $.viaChildren.wait({ key: (channel as Channel).key })
      } catch {
        failure = signal.aborted ? 'it was stopped' : 'could not wait for its next event'
        break
      } finally {
        wake()
        signal.removeEventListener('abort', wake)
      }
      continue
    }
    if (item.k === 'end') {
      failure = item.failure ?? failure
      // Kept while the run goes on, so its late patches are known as this child's, not a new one.
      if (channel) channel.read = true
      if (channel?.closed) for (const [key, held] of w.channels) if (held === channel) w.channels.delete(key)
      break
    }
    if (item.k === 'spawn') {
      const grand = w.channels.get(item.child)
      kind = undefined
      if (grand)
        yield {
          kind: 'spawn',
          child: item.child,
          type: grand.type,
          title: grand.title,
          ...(grand.description ? { description: grand.description } : {}),
        }
    } else if (item.k === 'user') {
      report = ''
      kind = undefined
      yield { kind: 'user', text: item.t }
    } else if (item.k === 'message') {
      report = ''
      kind = undefined
    } else if (item.k === 'text') {
      report += item.t
      yield push('text', item.t)
    } else if (item.k === 'thinking') yield push('thinking', item.t)
    else if (item.k === 'plan') {
      // The same changed-plan row the top-level run shows, separate from the child's answer.
      const listed = item.entries.map((entry) => `${PLAN_MARKS[entry.status] ?? '☐'} ${entry.content}`).join('\n')
      if (listed === plan) continue
      plan = listed
      kind = undefined
      plans += 1
      const id = `plan-${plans}`
      yield { kind: 'call-start', id, input: { kind: 'plan', title: 'Plan' }, usage: null }
      yield { kind: 'call-end', id, output: listed, failed: false }
    } else if (item.k === 'call') {
      kind = undefined
      yield {
        kind: 'call-start',
        id: item.id,
        input: { kind: item.kind, title: item.title, ...(item.path ? { path: item.path } : {}) },
        usage: null,
      }
    } else if (item.k === 'called') yield { kind: 'call-end', id: item.id, output: item.output, failed: item.failed }
  }
  const tail = failure
    ? `The ${name} subagent failed: ${failure}`
    : `— answered by ${name} subagent${channel?.model ? `, ${channel.model}` : ''}`
  const said = report.trim() || (failure ? '' : `The ${name} subagent ended without a message.`)
  const signed = [said, tail].filter(Boolean).join('\n\n')
  if (nested) nested.report = signed
  await complete?.(signed).catch(() => undefined)
  if (channel) channel.read = true
  if (channel?.closed) for (const [key, held] of w.channels) if (held === channel) w.channels.delete(key)
  yield push('text', `${report.trim() ? '\n\n' : ''}${said && !report.trim() ? `${said}\n\n` : ''}${tail}`)
  if (handback) return yield* deliver(name, e, { prompt: '', report: signed, delivered: false }, index + 1, signed, null)
  return yield* respond(e, [{ kind: 'stop', stopReason: 'end_turn', usage: null }], signed)
}
