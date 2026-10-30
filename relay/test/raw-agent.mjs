// Deliberately bypass the SDK's outgoing schemas: a newer adapter can send variants our SDK lacks.
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } })
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.error) process.exit(125)
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })
  if (message.method === 'session/new') send({ id: message.id, result: { sessionId: 's1' } })
  if (message.method !== 'session/prompt') continue
  if (process.env.RAW_MALFORMED === '1') {
    update('s1', { sessionUpdate: 'tool_call', toolCallId: 42 })
  } else {
    update('s1', { sessionUpdate: 'future_update', payload: 'private payload must not be logged' })
    update('s1', { sessionUpdate: 'subagent_progress', subagentSessionId: 'child', progress: 1 })
    update('s1', {
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'child',
      name: 'helper',
      task: 'Inspect the source',
      capabilities: {},
    })
    update('child', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child answer' } })
    update('s1', { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: process.env.RAW_STATE || 'completed' })
    // The standard form must still work alongside the older AIR form.
    update('s1', { sessionUpdate: 'subagent_update', sessionId: 'standard', title: 'standard helper', state: { state: 'running' } })
  }
  update('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'parent answer' } })
  send({ id: message.id, result: { stopReason: 'end_turn' } })
}
