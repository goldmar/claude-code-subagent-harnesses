# via

Hand Claude Code's work to your ChatGPT or Google plan, without leaving Claude Code.

`via` runs Codex, Antigravity, OpenCode and pi as native Claude Code subagents, each through its own CLI and login. Claude plans, they work, you watch and steer.

![A via:codex agent view in Claude Code: its steps folded into lines such as "Ran 4 commands", and the agent panel row "via:codex Checking budget counts in home.ts"](https://github.com/user-attachments/assets/e36113c3-b375-4f0d-99ae-5851e73105e9)

Codex's tool calls stay as individual rows as commands finish and later calls arrive, avoiding the flicker of replacing them with a counted group. ctrl+o shows each call's full output. The screenshot above predates this display change.

## Is this for you?

Yes, if all three hold:

- You work in Claude Code.
- You also pay for ChatGPT or Google AI, or want OpenCode's free models.
- You want to hand off tasks, or get another model's review, without switching windows.

Otherwise:

| If | Use |
| --- | --- |
| Claude Code isn't your main window | A harness that switches models itself: OpenCode, pi, Cursor |
| You want Codex's reviews, a review gate before Claude stops, or to move the session into Codex | OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc), alongside `via` |
| You're on API keys | [claude-code-router](https://github.com/musistudio/claude-code-router): any model, under Claude Code's permissions |

## What I've used it for

- **Codex, to spend my ChatGPT plan too.** A TypeScript migration one slice per agent, refactors, mutation testing, and fixing what a review found.
- **Free models for small tasks.** DeepSeek V4.1 Flash on OpenCode's free tier, or OpenRouter's free models through pi.
- **A review by a model that didn't write it**, before a release or going public.
- **The same fix on two models**, to see which one's good enough.

## Why via

- **No translated tool calls.** Each model drives the harness it was built for, not Claude Code's tools through a proxy. The same model scores 13 to 21 points apart across harnesses on Terminal-Bench ([survey](https://arxiv.org/pdf/2606.20683)).
- **No borrowed logins for Codex and agy.** They are OpenAI's and Google's own CLIs. Google has [suspended accounts](https://discuss.ai.google.dev/t/paid-pro-subscriber-banned-instantly-for-testing-opencode-oauth/124403) for logging in to Antigravity from other tools. `via` holds no tokens.
- **No Claude tokens on the hand-off.** No Claude model sits between Claude and the harness; OpenAI's plugin puts a Sonnet subagent there.
- **A subagent, not a Bash call.** Each streams, takes follow-ups and interrupts, runs beside the others, and signs its answer with the model that wrote it.
- **Pinned by default.** Codex's adapter installs on first use from a lockfile `via` ships: every package hash-checked, no install scripts. CI runs against the latest Claude Code weekly.

> [!IMPORTANT]
> - Each harness runs its own tools as you, with its own permission settings, outside Claude Code's. The one thing `via` enforces is read-only: plan mode, or `tools: read` at the top of the prompt. Codex, OpenCode and pi then can't write; agy refuses, because it can't.
> - Outside read-only, a repository's `.codex`, `.opencode` and `.pi` config loads, as if you had trusted it. In a repository you didn't write, use `tools: read`; Codex and OpenCode then refuse one that carries its own config.
> - pi and OpenCode are third-party clients. A subscription login there is subject to that provider's rules for third-party clients.

## Set up

1. **Install a harness and sign in to it**: [Codex](https://github.com/openai/codex), [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli), [OpenCode](https://opencode.ai) or [pi](https://pi.dev). Any one is enough. via needs [Node](https://nodejs.org) 22.18 or later, and Codex and OpenCode also need npm.
2. **Install the plugin** in Claude Code:

   ```
   /plugin install via --marketplace SeanLF/claude-code-subagent-harnesses
   ```

3. **Restart Claude Code**, so it sees the harnesses on your PATH. Do the same after installing another harness.

Tested on macOS; CI also runs on Linux. Windows is untested.

## Use

Ask in plain language: "Have codex review src/api".

Optional lines at the top of the prompt configure the harness, one per line, and persist for that agent's later messages:

| Line | Effect |
| --- | --- |
| `model: <model>` | The harness's model; `via-help` lists the ones the harness offers you, read from the harness itself |
| `tools: read` | Read-only, whatever the permission mode; see [Permissions](#permissions). pi also takes a tool list: `read` is read-only; any other list, such as `-bash,read`, can still edit and loads the project's .pi extensions |
| `thinking: <level>` | Reasoning effort; a level the harness or model lacks is refused |
| `tier: fast\|default` | Codex only: fast mode on or off; persists until replaced in an idle follow-up |
| `via-help` | Replies with that harness's lines and levels instead of running it |

```text
tools: read
thinking: high
Why does the login test fail on CI but not locally?
```

For Codex, add `tier: fast` before the task to request fast mode. Send `tier: default` at the top of an idle follow-up to switch it off. Fast mode uses more of your plan and depends on the model supporting it. Tier lines in messages to a running agent are plain text; wait until it is idle to change tier. Without a tier line, via keeps the saved choice, or the harness's default on the first run.

## How it works

- At session start, `via` adds an agent type for each harness on your PATH: `via:codex`, `via:agy`, `via:opencode`, `via:pi`.
- When Claude hands one a task, `via` runs that CLI headless with the prompt on stdin and streams its text, its tool calls and, where the harness reports it, its thinking. Codex and OpenCode run over the [Agent Client Protocol](https://agentclientprotocol.com) through a relay that ships with `via`, the ACP SDK bundled in. Codex's adapter, [`codex-acp`](https://github.com/agentclientprotocol/codex-acp), drives your own `codex`; on first use `via` installs it from the lockfile it ships (every package pinned and hash-checked, no install scripts, no Codex binary) into `~/.claude/via/acp/`.
- Codex's and OpenCode's tool calls reach Claude Code as calls to `via`'s own tool, `step`, which runs nothing: `via` answers each with what the harness reported, and draws it as a row (`Ran npm test`, `Read file 'src/a.ts'`). `step` is an MCP server's tool; via keeps groups containing only its step calls expanded, so existing rows stay in place instead of collapsing into a count. Mixed groups retain Claude Code's normal rendering, and the agent's line in the panel gets Claude Code's own summary. A call to `step` that `via` did not make is refused. pi's and agy's tool calls show as text lines (`▸ bash: npm test`), and their latest one in the agent panel; your own `subagentStatusLine` setting, if you have one, takes precedence there.
- While a reported tool runs silently, via emits a waiting continuation every 30 seconds. These are progress updates for the same command, not new executions; they keep Claude Code receiving steps during long waits. Stops and the configured time limit still apply. Claude Code controls collapsed groups and its own watchdog, so an outer host timeout can still end an agent.
- A subagent the harness starts itself shows as an agent nested under the `via` agent, as Claude Code shows a subagent's own subagent: its tool calls as rows, then its last message, signed with the model it ran on. It needs the harness to report its subagents over ACP ([subagents RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/subagents.mdx)): Codex through `codex-acp` does. `via` makes the nested agent with an Agent call and approves that call itself, since auto mode's classifier judges only calls a model's request made.
- The harness's session id is kept, so a follow-up continues the same conversation, even after a reload. A plain `SendMessage` to a running Codex, OpenCode or pi agent reaches it at its next step, as a message typed while Claude works does, and so does a message you type into that agent's own view (Claude Code hands it over when the agent's current step ends); one starting `interrupt:` stops the current step and runs the message at once. agy takes messages only as follow-ups.
- A Codex capacity failure pauses for an explicit follow-up when steering is available. Its existing runtime and native helpers stay alive until you continue, stop it, or reach `timeoutMinutes`; via does not retry the failed prompt. This protects helper identities and queued results that a fresh process cannot restore from conversation history alone. Other terminal failures end the run.
- Codex can report `aborted before dispatch` when admitting a native helper mailbox message. This comes from Codex before the tool handler runs, so there may be no corresponding via step row. Read the arriving helper message and inspect current state before deciding whether the operation is still needed. via does not automatically retry it. This differs from a tool that started and was interrupted, whose side effects may already exist. See [Codex's dispatch admission](https://github.com/openai/codex/blob/main/codex-rs/core/src/stream_events_utils.rs) and [abort result formatting](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/parallel.rs).
- A completed answer ends with the model that wrote it, as the harness reports it; one taken from your `model:` line because the harness didn't confirm it is marked `(requested)`, and a harness that won't say gets `model not reported`, never a guess. Stopped or failed runs say so, unsigned, and no Claude model stands in.
- In Claude Code the agent runs as the harness's model: its transcript and its task name it (`Fix the parser · gpt-6-luna · high`), not a Claude model. The agent types' descriptions name a model each harness lists for you, refreshed at each session start.
- A harness that compacts its own context shows it as a row, `Compacted conversation`, with pi's summary behind ctrl+o. So that Claude Code never compacts a `via` agent's copy of the conversation, which no model reads, `via` sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS` for the session, which sizes only non-Claude models, while a Claude model is the main one. It never touches a value you set, and undoes its own when `/model` switches to a non-Claude one. Another agent in the session on a non-Claude model gets the same window.
- `via` uses each CLI's own login and stores no credentials.

## Permissions

- **Read-only** is what `via` enforces, in plan mode or with `tools: read`: Codex runs in its read-only sandbox with MCP servers and plugins off, OpenCode with only reading tools and no project config, pi with only its reading tools. agy is refused. So is Codex under a project's `.codex` folder and OpenCode under a project's `.opencode`, since both would load code from there before any permission applies.
- **Otherwise** Codex works in its workspace sandbox and asks before going past it, as `codex exec` does; OpenCode, pi and agy run with their own permission settings, as when you run them yourself. A question a harness asks (Codex past its sandbox, OpenCode where its config says `ask`) reaches you in Claude Code's own dialog, with a notification, such as "codex wants to run `curl -sI https://example.com`. Allow it?"; only "Allow once" or "Deny" is offered, so nothing outlives the run. A dismissed or unanswered question, or a `claude -p` run with nobody to ask, is a deny. In bypass mode its questions are approved; in don't-ask mode, denied. pi and agy never ask.
- The mode is the one at the agent's start, kept across its follow-ups and reloads: switching modes later doesn't change an agent already started.
- Outside read-only, Codex runs with the working folder trusted (`codex-acp` sets it), so a project's `.codex/config.toml` loads, as if you had trusted the project in Codex. Outside a Git repository it edits without the refusal `codex exec` had.

## Harnesses

Each can load its own user config and instructions files; agy, for one, reads your global `AGENTS.md`.

| | Notes |
| --- | --- |
| `codex` | An interrupted command can keep running until it finishes. |
| `agy` | Commands run in Antigravity's sandbox, away from credentials such as `~/.kube`; its own file edits are not sandboxed. Its changelog says it leaves background tasks it started, such as dev servers, running after a headless run ends. |
| `opencode` | A read-only run replaces your own `OPENCODE_CONFIG_CONTENT` with `via`'s reading agent. |
| `pi` | Any model pi reaches: API keys, or logins such as ChatGPT, Copilot or OpenRouter (pi's `/login`); `pi --list-models` lists them. On a ChatGPT login it runs pi's own tools, not Codex's sandbox. A read-only tool list also skips the project's `.pi` extensions, even in a project you trusted. |

## Settings

In `/config`, or `pluginConfigs` in `settings.json`:

- `timeoutMinutes` (default 30): a run longer than this is stopped. The answer keeps what the harness wrote and says it was stopped.
- `defaultModel`: pi's model when the prompt has no `model:` line.
- `codexAcp` (default `pinned`): `pinned` runs the `codex-acp` version `via` ships with, its dependencies locked and hash-checked, updated only when `via` is; `latest` installs the newest into `~/.claude/via/acp/latest` once per Claude Code session, its dependencies unpinned.

## Develop

`mise install && pnpm install`, then `pnpm lint` (Biome: format and lint), `pnpm test` and `pnpm validate`, which CI runs too; the last two need the `claude` CLI. `pnpm typecheck` needs the engine's typings, which a logged-in Claude Code session writes to `.claude-plugin/types/`. After changing `relay/src/` or the SDK version, run `pnpm build:relay`: `relay/relay.mjs` is the committed bundle the plugin runs, and CI fails when it doesn't match. `relay/codex-acp/` is the lockfile `via` installs from. `hooks/acp/` is the generic ACP client (the step tool, the rows, the spawn of an agent described as plain data); `pnpm lint` fails if it imports anything of `via`'s, so it can ship on its own. `relay/test/` tests the relay against a fake agent (`pnpm test:relay`, which CI runs); `relay/checks/` holds the live checks used to verify each ACP agent.

## Credit

Inspired by [pi-agent-for-claude](https://github.com/FazalAAli/pi-agent-for-claude) by Fazal Ali. [claudexor](https://github.com/razzant/claudexor)'s Antigravity adapter was prior art for `via:agy`. The relay bundles the [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) (Apache-2.0) and zod (MIT); see `relay/THIRD_PARTY_LICENSES`. MIT licence.
