# via

Claude hands a task to Codex, Antigravity, OpenCode or pi, and each runs it through its own CLI and login, as a Claude Code subagent.

![A via:codex agent in Claude Code, its steps folded into lines such as "Ran 4 commands"](https://github.com/user-attachments/assets/e36113c3-b375-4f0d-99ae-5851e73105e9)

## Set up

`/plugin install via --marketplace SeanLF/claude-code-subagent-harnesses` in Claude Code, or from a shell:

```
claude plugin install via --marketplace SeanLF/claude-code-subagent-harnesses
```

Needs Node 22.18 or later on PATH; Codex also needs npm. Install at least one harness: [Codex](https://github.com/openai/codex), [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli), [OpenCode](https://opencode.ai) or [pi](https://pi.dev). Your agent can run the installs; signing in opens a browser, so that part is yours. Restart Claude Code afterwards, and again after adding another harness, so it sees what's on your PATH. Tested on macOS, CI also runs on Linux; Windows is untested.

## Who it's for

Claude Code users who also pay for ChatGPT or Google AI, or want OpenCode's free models, and want to hand off tasks or get a second model's review without switching windows.

Codex and the Antigravity CLI (`agy`) are OpenAI's and Google's own tools, so you sign in to them directly. Google has [suspended accounts](https://discuss.ai.google.dev/t/paid-pro-subscriber-banned-instantly-for-testing-opencode-oauth/124403) whose Google login was used through third-party tools, though it later said it was lifting those bans. `via` stores no credentials, and no Claude subagent sits in between: the harness's work costs no Claude tokens; Claude only writes the task and reads the answer.

Not for you if:

- Claude Code isn't your main window: use a harness that switches models itself (OpenCode, pi, Cursor).
- You want Claude Code itself to run on another model: [claude-code-router](https://github.com/musistudio/claude-code-router).

Pairs with OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) if you want its review commands, a review before Claude stops, or to move a session into Codex.

## What I've used it for

- Codex, to spend my ChatGPT plan too: a TypeScript migration one slice per agent, refactors, mutation testing.
- Free models for small tasks, on OpenCode's free tier or OpenRouter through pi.
- A review by a model that didn't write the code.
- The same fix on two models, to see which one is good enough.

> [!IMPORTANT]
> - Each harness runs its own tools as you, with its own permission settings, outside Claude Code's. The one thing `via` enforces is read-only: plan mode, or `tools: read` at the top of the prompt. Codex, OpenCode and pi then can't write. agy has no read-only mode, so `via` won't run it in one.
> - Outside read-only, a repository's `.codex`, `.opencode` and `.pi` config loads, as if you had trusted it. In a repository you didn't write, use `tools: read`. Codex and OpenCode then won't run at all in a repository that has its own `.codex` or `.opencode` folder.
> - pi and OpenCode are third-party clients. A subscription login there is subject to that provider's rules for third-party clients.

## Use

Ask in plain language: "Have codex review src/api". Optional lines at the top of the prompt set options. They carry over to that agent's follow-ups.

| Line | Effect |
| --- | --- |
| `model: <model>` | The harness's model |
| `tools: read` | Read-only, whatever the permission mode |
| `thinking: <level>` | Reasoning effort; a level the harness or model doesn't have is refused |
| `via-help` | Lists the harness's options instead of running it |

A message to a running Codex, OpenCode or pi agent reaches it at its next step; `interrupt:` first stops the current step. agy only takes follow-ups. A completed answer ends with the model the harness reports; one only taken from your `model:` line says `(requested)`, and a harness that won't say gets `model not reported`.

## Permissions

- **Read-only:** Codex runs in its read-only sandbox with MCP servers and plugins off; OpenCode and pi get reading tools only.
- **Otherwise:** Codex works in its workspace sandbox and asks before going past it; OpenCode, pi and agy use their own permission settings. Codex also edits outside a Git repository.
- A harness's question (Codex past its sandbox, OpenCode where its config says `ask`) shows in Claude Code's dialog with only a one-time allow and a deny. There's no "always allow", so no approval outlives the run. No answer, or `claude -p`, is a deny. Bypass mode approves; don't-ask mode denies. The mode is set when the agent starts and stays for its follow-ups. pi and agy never ask.
- When a harness starts its own subagent, `via` approves that call without asking you.

## Harnesses

Each loads its own user config and instructions files (agy reads your global `AGENTS.md`).

- `codex`: an interrupted command can keep running until it finishes.
- `agy`: commands run in Antigravity's sandbox, away from credentials such as `~/.kube`; its own file edits are not sandboxed. Per its changelog, background tasks it starts, such as dev servers, outlive a headless run.
- `opencode`: a read-only run replaces your own `OPENCODE_CONFIG_CONTENT`.
- `pi`: any model pi reaches by API key or `/login`. On a ChatGPT login it runs pi's own tools, not Codex's sandbox. `tools:` takes a pi tool list: one of only `read`, `grep`, `find`, `ls` is read-only and skips the project's `.pi` extensions, even in a project you trusted; any other, such as `-bash,read`, can edit and loads them.

## Settings

In `/config`, or `pluginConfigs` in `settings.json`:

- `timeoutMinutes` (default 30): a longer run is stopped; its partial output is kept.
- `defaultModel`: pi's model when the prompt has no `model:` line.
- `codexAcp` (default `pinned`): `pinned` installs Codex's adapter from the lockfile `via` ships, hash-checked, no install scripts. `latest` installs the newest once per Claude Code session.

Claude Code doesn't know a harness model's context size and would stop a `via` agent at 200k tokens. While a Claude model is the main one, `via` raises `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, which only applies to models Claude Code doesn't know; any other non-Claude agent in the session gets the same window. A value you set is left alone, and `via` removes its own when `/model` switches to a non-Claude model.

## Develop

`mise install && pnpm install`, then `pnpm lint`, `pnpm test` and `pnpm validate`; see [CONTRIBUTING.md](CONTRIBUTING.md). Harness tool calls show in transcripts as calls to `via`'s `step` tool.

## Credit

Inspired by [pi-agent-for-claude](https://github.com/FazalAAli/pi-agent-for-claude) by Fazal Ali. [claudexor](https://github.com/razzant/claudexor)'s Antigravity adapter was prior art for `via:agy`. The relay bundles the [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) (Apache-2.0) and zod (MIT); see `relay/THIRD_PARTY_LICENSES`. MIT licence.
