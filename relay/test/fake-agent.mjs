// A fake ACP agent for the relay's tests, on the SDK's own agent side. By default its prompt fails as
// codex-acp's does when Codex hits its usage limit, with the cause in the error's data. With FAKE_ECHO
// set it takes images and answers with what it was offered: the client's capabilities, as the SDK
// hands them to an agent, the prompt's block types, and config requests received before the prompt;
// FAKE_STOP is the stop reason it ends with. With FAKE_REOPEN set it can close and resume a session, its
// first prompt runs until cancelled, and it logs each call to stderr.
import { Readable, Writable } from 'node:stream'
// The unstable schema, as codex-acp's: the stable one has no plan capability and drops it.
import * as acp from '@agentclientprotocol/sdk/unstable'

const echo = process.env.FAKE_ECHO === '1'
const reopen = process.env.FAKE_REOPEN === '1'
// Answers a call with an empty result, once logged.
const log = (method) => {
  if (reopen) process.stderr.write(`fake: ${method}\n`)
  return {}
}
let offered
let opened
const config = []
let cancelled = () => {}
let prompts = 0
await acp
  .agent()
  .onRequest(acp.methods.agent.initialize, (ctx) => {
    offered = ctx.params.clientCapabilities
    const sessionCapabilities = reopen ? { close: {}, resume: {} } : {}
    return { protocolVersion: ctx.params.protocolVersion, agentCapabilities: { promptCapabilities: { image: echo }, sessionCapabilities } }
  })
  .onRequest(acp.methods.agent.session.new, () => {
    opened = 'new'
    return { sessionId: 's1' }
  })
  .onRequest(acp.methods.agent.session.load, () => {
    opened = 'load'
    return {}
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    if (process.env.FAKE_REFUSE_CONFIG === ctx.params.configId) throw acp.RequestError.internalError({ details: 'fast mode unavailable' })
    config.push(ctx.params)
    return { configOptions: [] }
  })
  .onRequest(acp.methods.agent.session.setMode, () => log('set_mode'))
  .onRequest(acp.methods.agent.session.close, () => log('close'))
  .onRequest(acp.methods.agent.session.resume, () => log('resume'))
  .onNotification(acp.methods.agent.session.cancel, () => {
    log('cancel')
    cancelled()
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    log('prompt')
    if (reopen) {
      if (++prompts === 1) {
        await new Promise((resolve) => (cancelled = resolve))
        return { stopReason: 'cancelled' }
      }
      return { stopReason: 'end_turn' }
    }
    if (!echo) throw acp.RequestError.internalError({ details: "You've hit your usage limit. Try again at 10:04 PM." })
    const blocks = ctx.params.prompt.map((b) => (b.type === 'image' ? `image:${b.mimeType}:${b.data.length}` : b.type))
    const text = JSON.stringify({ offered, blocks, opened, config })
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    })
    return { stopReason: process.env.FAKE_STOP || 'end_turn' }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))).closed
