import type * as acp from '@agentclientprotocol/sdk/unstable'

// ACP v1's SDK validates a closed union before invoking our handler (even with a custom parser).
// Keep known payload validation in the SDK, but discard future variants at the transport boundary.
// The exhaustive record makes an SDK schema change a type error until this list is updated.
const KNOWN: Record<acp.SessionUpdate['sessionUpdate'], true> = {
  user_message_chunk: true,
  agent_message_chunk: true,
  agent_thought_chunk: true,
  tool_call: true,
  tool_call_update: true,
  plan: true,
  plan_update: true,
  plan_removed: true,
  available_commands_update: true,
  current_mode_update: true,
  config_option_update: true,
  session_info_update: true,
  usage_update: true,
  notice: true,
  compaction_update: true,
  compaction_summary_chunk: true,
  subagent_update: true,
  session_message: true,
  session_message_chunk: true,
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// codex-acp's AIR dialect is selected when we advertise JetBrains sessionFailure support. It emits
// these two older subagent variants instead of the standard subagent_update. Never grant its child
// mutation capabilities: via only displays children. Unknown activity must not claim task completion.
const childUpdate = (update: Record<string, unknown>): acp.SessionUpdate | undefined => {
  if (typeof update.subagentSessionId !== 'string') return
  if (update.sessionUpdate === 'subagent_spawned') {
    if (typeof update.name !== 'string' || typeof update.task !== 'string') return
    return {
      sessionUpdate: 'subagent_update',
      sessionId: update.subagentSessionId,
      title: update.name,
      description: update.task,
      state: { state: 'running' },
    }
  }
  if (update.sessionUpdate !== 'subagent_state_update' || typeof update.state !== 'string') return
  let state: acp.StateUpdate
  switch (update.state) {
    case 'running':
      state = { state: 'running' }
      break
    case 'completed':
      state = { state: 'idle', stopReason: 'end_turn' }
      break
    case 'cancelled':
      state = { state: 'idle', stopReason: 'cancelled' }
      break
    case 'failed':
      state = { state: 'idle', stopReason: 'error', error: { code: -32603, message: 'Subagent failed' } }
      break
    default:
      state = { state: 'unknown' }
  }
  return { sessionUpdate: 'subagent_update', sessionId: update.subagentSessionId, state }
}

export const sessionUpdates = (stream: acp.Stream, ignored: (count: number) => void): acp.Stream => {
  let count = 0
  return {
    writable: stream.writable,
    readable: stream.readable.pipeThrough(
      new TransformStream<acp.AnyMessage, acp.AnyMessage>({
        transform(message, controller) {
          // Only notifications with a recognizable envelope; requests, responses, malformed
          // envelopes and known variants retain the SDK's normal validation and error handling.
          if ('method' in message && message.method === 'session/update' && !('id' in message)) {
            const params = message.params
            if (record(params) && typeof params.sessionId === 'string' && record(params.update)) {
              const update = params.update
              if (typeof update.sessionUpdate === 'string' && !Object.hasOwn(KNOWN, update.sessionUpdate)) {
                const child = childUpdate(update)
                if (child) controller.enqueue({ ...message, params: { ...params, update: child } })
                else ignored(++count)
                return
              }
            }
          }
          controller.enqueue(message)
        },
      }),
    ),
  }
}
