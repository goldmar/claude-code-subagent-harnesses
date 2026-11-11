import { relayEvents } from '../acp/events'
import { isRecord } from '../acp/json'
import type { Norm } from '../acp/norm'

// Codex suppresses live child userMessage items. Its collaboration calls carry the complete input
// and receiver thread ids instead. Keep that dialect here; the shared ACP parser sees only ACP.
export function codexEvents(): (line: string) => Norm[] {
  const parse = relayEvents()
  let live = false
  let root: string | undefined
  const sessions = new Map<string, string>()
  const generations = new Map<string, number>()
  const described = new Set<string>()
  const inputs = new Map<string, { id: unknown; text: string }>()
  const echoes = new Map<string, string>()
  const epochs = new Map<string, number>()
  const collaboration = new Map<string, { title?: string; input?: Record<string, unknown>; shown?: Set<string>; narrated?: Set<string> }>()
  const sent = new Set<string>()
  const of = (child: string, text: string, preserveAnswer = false): Norm => ({
    k: 'of',
    child,
    norm: { k: 'user', t: text, ...(preserveAnswer ? { preserveAnswer: true } : {}) },
  })
  const fresh = (child: string) => epochs.set(child, (epochs.get(child) ?? 0) + 1)
  const flush = (session: string): Norm[] => {
    const input = inputs.get(session)
    if (!input) return []
    inputs.delete(session)
    const echo = echoes.get(session)
    echoes.delete(session)
    if (!input.text || input.text === echo) return []
    // Correlate a native input with the still-running collaboration call, even when the child
    // starts replying before that call's completion notification reaches the parent session.
    for (const pending of collaboration.values()) {
      const receivers = pending.input?.receiverThreadIds
      if (pending.input?.prompt !== input.text || !Array.isArray(receivers) || pending.shown?.has(session)) continue
      if (!receivers.some((receiver) => typeof receiver === 'string' && sessions.get(receiver) === session)) continue
      pending.shown ??= new Set()
      pending.shown.add(session)
      break
    }
    fresh(session)
    return [of(session, input.text)]
  }
  return (line) => {
    let e: unknown
    try {
      e = JSON.parse(line)
    } catch {
      return parse(line)
    }
    if (!isRecord(e)) return parse(line)
    if (e.relay === 'session' && typeof e.sessionId === 'string') root = e.sessionId
    if (e.relay === 'steered') live = true
    if (e.relay !== undefined || !live || !isRecord(e.update)) return parse(line)
    const u = e.update
    const session = typeof e.sessionId === 'string' ? e.sessionId : root
    const out: Norm[] = []
    if (u.sessionUpdate === 'subagent_update' && typeof u.sessionId === 'string') {
      // AIR reopens a thread as <thread>:generation:N; collaboration receivers keep <thread>.
      const resumed = /^(.*):generation:(\d+)$/.exec(u.sessionId)
      const id = resumed?.[1] ?? u.sessionId
      const thread = id.split(':subagent:').at(-1) ?? id
      const generation = resumed ? Number(resumed[2]) : 1
      if (typeof u.description === 'string' && !described.has(u.sessionId)) {
        echoes.set(u.sessionId, u.description)
        described.add(u.sessionId)
      }
      // An older session's late idle patch must not steal the mapping from its resumed view.
      if (generation >= (generations.get(thread) ?? 0)) {
        sessions.set(thread, u.sessionId)
        generations.set(thread, generation)
      }
      if (isRecord(u.state) && u.state.state === 'idle') out.push(...flush(u.sessionId))
    }
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
              if (!child || held.shown?.has(child)) continue
              if (inputs.get(child)?.text === input.prompt) inputs.delete(child)
              else out.push(...flush(child))
              const late = held.narrated?.has(child) === true
              out.push(of(child, input.prompt, late))
              echoes.set(child, input.prompt)
              if (!late) fresh(child)
            }
          }
        } else if (u.status === 'failed') collaboration.delete(key)
      }
    }
    if (root === undefined || session === undefined || session === root) return [...out, ...parse(line)]
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
    if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'].includes(String(u.sessionUpdate))) {
      out.unshift(...flush(session))
      echoes.delete(session)
    }
    if (u.sessionUpdate === 'agent_message_chunk') {
      for (const pending of collaboration.values()) {
        const receivers = pending.input?.receiverThreadIds
        if (!Array.isArray(receivers) || !receivers.some((receiver) => typeof receiver === 'string' && sessions.get(receiver) === session))
          continue
        pending.narrated ??= new Set()
        pending.narrated.add(session)
      }
    }
    // A steer starts a new reply even when Codex omits or reuses the message id.
    const next =
      u.sessionUpdate === 'agent_message_chunk'
        ? JSON.stringify({ ...e, update: { ...u, messageId: `${epochs.get(session) ?? 0}/${u.messageId ?? 'unnamed'}` } })
        : line
    return [...out, ...parse(next)]
  }
}
