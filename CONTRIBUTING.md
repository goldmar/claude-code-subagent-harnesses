# Contributing

`mise install && pnpm install`, then `pnpm lint` (Biome), `pnpm test` and `pnpm validate`. CI runs all three; the last two need the `claude` CLI. `pnpm typecheck` needs the typings a logged-in Claude Code session writes to `.claude-plugin/types/`.

- Codex and OpenCode run over [ACP](https://agentclientprotocol.com) (Agent Client Protocol, a standard way to drive coding agents) through `relay/relay.mjs`, a committed bundle. Run `pnpm build:relay` after changing `relay/src/` or the SDK version; CI fails when the bundle doesn't match.
- `relay/codex-acp/` is the lockfile `codex-acp` installs from (`npm ci --ignore-scripts`); `hooks/install.ts` does the install.
- `hooks/acp/` is the generic ACP client; `pnpm lint` fails if it imports anything of `via`'s.
- `hooks/record.ts` keeps one record per agent in `$.store`, so an agent continued in a new process still has its session, mode and last answer.
- `hooks/writer.ts` writes a run's steps, for `via` agents and their nested ones.
- Harness tool calls reach Claude Code as calls to the MCP tool `step`, which runs nothing: `via` answers each with what the harness reported, and refuses a `step` call it didn't make.
- Nested agents need the harness to report subagents over ACP ([subagents RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/subagents.mdx)); `codex-acp` does.
- `pnpm test:relay` tests the relay against a fake agent; `relay/checks/` holds the live checks for each ACP agent.
