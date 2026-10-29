// The server behind via's step tool. A tool.call hook answers every call with what the harness reported,
// so a call that reaches this server is one nobody answered: it fails, it never runs anything.
// A real MCP server, not $.tool.register. Claude Code can group a server's calls; the render hook
// keeps via-only groups expanded so completed rows are not replaced by a count as calls arrive.
// Node runs it as is: type stripping is on by default from Node 22.18.
import { createInterface } from 'node:readline'

type Request = { id?: number | string; method?: string; params?: { protocolVersion?: string } }

const step = {
  name: 'step',
  description:
    "One step of this agent's work, already done: kind is what it did (execute, read, edit, search, fetch), title what it acted on. Calling it does nothing.",
  inputSchema: { type: 'object', properties: { kind: { type: 'string' }, title: { type: 'string' } } },
}

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

const answers: Record<string, (params: Request['params']) => object> = {
  initialize: (params) => ({
    protocolVersion: params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'via', version: '0' },
  }),
  ping: () => ({}),
  'tools/list': () => ({ tools: [step] }),
  'tools/call': () => ({ isError: true, content: [{ type: 'text', text: 'via could not report this harness tool call.' }] }),
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let request: Request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request?.id === undefined) return
  const answer = request.method !== undefined && Object.hasOwn(answers, request.method) ? answers[request.method] : undefined
  send(
    answer
      ? { id: request.id, result: answer(request.params) }
      : { id: request.id, error: { code: -32601, message: `no method ${request.method}` } },
  )
})
