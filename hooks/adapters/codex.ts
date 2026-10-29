import type { ModelReasoningEffort } from '@openai/codex-sdk'
import type { Choice } from '../../types'
import { relayEvents, sessionLost } from '../acp/events'
import { isRecord } from '../acp/json'
import { type AcpMode, type AcpSpec, acpMode, acpStart } from '../acp/spec'
import type { Adapter, Mode } from '../adapter'

const THINKING = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'persistent',
] as const satisfies readonly ModelReasoningEffort[]
// Fails the type check when the SDK adds an effort level this list lacks.
export const everyEffort: [Exclude<ModelReasoningEffort, (typeof THINKING)[number]>] extends [never] ? true : never = true

// Read-only is the one mode via defends. Otherwise codex works in its workspace sandbox and asks before
// going past it, as codex exec did; the question reaches the person, except in bypass (approved) and
// dontAsk (denied). Never codex-acp's own default, auto review: its reviewer approved a network
// escalation itself, and nobody was asked (reproduced).
export const CODEX: AcpSpec = {
  name: 'codex',
  // Replaced by the installed codex-acp at each run.
  command: ['codex-acp'],
  // The person's own Codex, not the copy codex-acp bundles.
  env: { CODEX_PATH: 'codex' },
  steer: 'steering',
  modes: {
    readOnly: { agentMode: 'read-only', policy: 'deny' },
    bypassPermissions: { agentMode: 'workspace-write', policy: 'allow' },
    dontAsk: { agentMode: 'workspace-write', policy: 'deny' },
    default: { agentMode: 'workspace-write', policy: 'ask' },
  },
  thinking: 'reasoning_effort',
}

export function codexMode(choice: Choice, mode: Mode): AcpMode {
  return acpMode(CODEX, choice.tools === 'read', mode)
}

export const codex = {
  name: 'codex',
  bin: 'codex',
  about: "Codex CLI agent: OpenAI's models, own tools in Codex's sandbox; asks you before going past it.",
  // The models Codex's own picker lists, best first; hidden ones are internal.
  catalogue: {
    argv: ['codex', 'debug', 'models'],
    ids: (stdout: string) => {
      try {
        const { models } = JSON.parse(stdout) as { models?: { slug?: unknown; visibility?: unknown; priority?: unknown }[] }
        return (models ?? [])
          .filter((m) => m.visibility === 'list' && typeof m.slug === 'string')
          .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
          .map((m) => m.slug as string)
      } catch {
        return []
      }
    },
  },
  readOnly: 'enforced',
  tools: ['read', 'write'], // write: the same as no tools line, which an agent may not think to leave out
  thinking: THINKING,
  steer: true,
  defaultModel: false,
  // codex-acp and its whole dependency tree, locked with integrity hashes in relay/codex-acp.
  relay: {
    install: {
      dir: 'codex-acp-2.3.1-preview.9',
      package: '@agentclientprotocol/codex-acp',
      files: ['relay/codex-acp/package.json', 'relay/codex-acp/package-lock.json'],
      entry: 'node_modules/@agentclientprotocol/codex-acp/dist/index.js',
    },
  },
  // codex-acp trusts the working folder, overriding any config (hard-coded in its createSessionConfig),
  // so codex loads a project's .codex/config.toml, whose MCP servers and hooks run outside the
  // sandbox (reproduced: a project MCP server ran during a read-only run). A read-only run is refused
  // under one.
  unsafeReadOnly: {
    folder: '.codex',
    harmless: [],
    own: true,
    why: "codex-acp trusts the working folder, so codex would load this project's .codex config, whose MCP servers and hooks run outside its sandbox",
  },
  // MCP servers run outside Codex's sandbox (openai/codex#7635), so a read-only run lists them and
  // switches each off, with plugins, in the session config codex-acp merges (CODEX_CONFIG).
  readOnlyGuard: {
    argv: ['codex', 'mcp', 'list', '--json', '--disable', 'plugins'],
    why: 'the MCP servers it would run outside its sandbox could not all be listed and switched off',
    env: (stdout) => {
      try {
        const parsed: unknown = JSON.parse(stdout)
        if (!Array.isArray(parsed)) return undefined
        const names = parsed.map((server: unknown) => (isRecord(server) && typeof server.name === 'string' ? server.name : undefined))
        if (names.some((name) => name === undefined)) return undefined
        const servers = Object.fromEntries(names.map((name) => [name, { enabled: false }]))
        return { CODEX_CONFIG: JSON.stringify({ mcp_servers: servers, features: { plugins: false } }) }
      } catch {
        return undefined
      }
    },
  },
  start: ({ choice, prompt, session, root, inbox, guard, mode, installed }) => {
    const readOnly = codexMode(choice, mode).agentMode === 'read-only'
    // Fail closed: without the guard, MCP servers would run outside the read-only sandbox.
    if (readOnly && guard === undefined) throw new Error('codex cannot prove read-only without its MCP guard')
    if (installed === undefined) throw new Error('codex-acp is not installed')
    return acpStart(CODEX, {
      root,
      prompt,
      readOnly: choice.tools === 'read',
      mode,
      inbox,
      session,
      model: choice.model,
      thinking: choice.thinking,
      config: choice.tier ? { 'fast-mode': choice.tier === 'fast' ? 'on' : 'off' } : undefined,
      command: ['node', installed],
      ...(readOnly ? { env: guard } : {}),
    })
  },
  events: () => relayEvents(),
  // The relay names the model the session runs on.
  model: () => undefined,
  failure: (_exit, stderr) =>
    sessionLost(stderr)
      ? {
          message:
            "codex could not find this agent's earlier session, so this message did not run. Send it again to start a new codex session.",
          sessionLost: true,
        }
      : undefined,
} as const satisfies Adapter
