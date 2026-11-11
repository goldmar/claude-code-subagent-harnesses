// A synthetic ACP agent, not a provider call. This models codex-acp v2.6.0's standard v1
// subagent protocol when the root turn completes or fails while its helper is working.
// Non-AIR overload is ordinary message text followed by end_turn, not sessionFailure metadata.
import { fork } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk/unstable'

const evidence = process.env.CAPACITY_EVIDENCE
const overload = process.env.CAPACITY_OVERLOAD === '1'
const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value))

if (process.argv.includes('--helper')) {
  // A real child process in the adapter's process group, representing already-started work.
  process.send({ ready: true })
  setTimeout(() => {
    save('helper-done.json', { answer: 'DELAYED_HELPER_RESULT' })
    process.send({ answer: 'DELAYED_HELPER_RESULT' })
    process.disconnect()
  }, 1800)
} else {
  save('agent-started.json', { pid: process.pid })
  let offered
  process.on('SIGTERM', () => {
    save('agent-stopped.json', { signal: 'SIGTERM' })
    process.exit(0)
  })
  await acp
    .agent()
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      offered = ctx.params.clientCapabilities
      save('capabilities.json', offered)
      return { protocolVersion: ctx.params.protocolVersion, agentCapabilities: { sessionCapabilities: { subagents: {} } } }
    })
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'root' }))
    .onNotification(acp.methods.agent.session.cancel, () => {
      // The root has already failed/completed. No helper cancellation was requested by the client.
      save('root-cancelled.json', { sessionId: 'root' })
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const child = fork(new URL('./capacity-fake-agent.mjs', import.meta.url), ['--helper'], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      })
      const completed = new Promise((resolve, reject) => {
        child.on('message', (message) => {
          if (typeof message.answer === 'string') resolve(message.answer)
        })
        child.once('error', reject)
      })
      await new Promise((resolve, reject) => {
        child.once('message', resolve)
        child.once('error', reject)
      })
      save('helper-started.json', { pid: child.pid })
      const update = (sessionId, update) => ctx.client.notify(acp.methods.client.session.update, { sessionId, update })
      await update('root', {
        sessionUpdate: 'subagent_update',
        sessionId: 'helper',
        title: 'Synthetic helper',
        description: 'Finish independent delayed work.',
        state: { state: 'running' },
      })
      // Successful Codex turns wait for their native helpers before returning the prompt response;
      // failed turns do not. Mirror that response ordering without inventing an AIR capability.
      const finishHelper = async () => {
        const answer = await completed
        await update('helper', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } })
        await update('root', { sessionUpdate: 'subagent_update', sessionId: 'helper', state: { state: 'idle', stopReason: 'end_turn' } })
      }
      if (overload) {
        void finishHelper()
        await update('root', {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Model is overloaded. Please try again later.\n\n' },
        })
      } else await finishHelper()
      return { stopReason: 'end_turn' }
    })
    .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))).closed
}
