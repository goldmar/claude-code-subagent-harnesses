# Changelog

## [0.9.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.8.1...via-v0.9.0) (2026-11-11)


### Bug Fixes

* keep quiet nested agents in via ([#24](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/24)) ([2ad040c](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/2ad040cfe2a47184355a5ae890701dd86b39632c))
* **via:** a nested agent in a new process answers its saved report or the cut-off, never the model ([#46](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/46)) ([26f00a7](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/26f00a740fb99bf9bd0802fb37d2a184a81a278e))
* **via:** an answer said before the run's last call is said again at the end ([#48](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/48)) ([3974216](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/39742165ff8a974349c7921c708218b8a147eeec))


### Code Refactoring

* **via:** one stored record per agent, one replay path, one step writer ([#49](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/49)) ([d40e327](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/d40e327836668f7800a6d563a9ef29407de68500))

## [0.8.1](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.8.0...via-v0.8.1) (2026-11-02)


### Bug Fixes

* **via:** a step's and a nested child's waits run as bounded engine nouns ([#41](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/41)) ([c088c91](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/c088c914619150573cf6794dd019fa85e368277a))

## [0.8.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.7.0...via-v0.8.0) (2026-10-28)


### Features

* a harness's own subagents show as agents nested under the via agent ([b612672](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/b61267254ade8c88b00cb845272efeb0c03eca3e))


### Bug Fixes

* a message typed into a running via agent's view reaches its harness ([118f9e2](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/118f9e261fe7f6977e4f94fed3502d47011f8d10))
* via agents survive a session sent to the background, and a refused model gets a did-you-mean ([a83205c](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/a83205ce420810306541c2e20d6a35aa0d269bde))

## [0.7.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.6.0...via-v0.7.0) (2026-10-26)


### Features

* via agents run as the harness's model, show its compactions, and list the models it offers ([de199ef](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/de199efbbd98980866159b3953c91707a0737efb))

## [0.6.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.5.1...via-v0.6.0) (2026-10-26)


### Features

* pi subagents show native tool rows, diffs and command output ([7e78f3c](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/7e78f3c32965654720d0142b9cc298485b14c128))

## [0.5.1](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.5.0...via-v0.5.1) (2026-10-26)


### Bug Fixes

* Esc on a via agent stops its harness, not only the wait ([3ccfd8a](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/3ccfd8a7e393cc2006191e2a22af352ef940f593)), closes [#9](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/9)
* the relay declares no plan capability, so a Codex markdown plan shows as text ([f97a9b7](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/f97a9b741d98d7620635b247763c0cdd741d4ce7)), closes [#13](https://github.com/SeanLF/claude-code-subagent-harnesses/issues/13)

## [0.5.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.4.1...via-v0.5.0) (2026-10-25)


### Features

* harness tool calls fold into one line, as Claude Code folds its own ([1bebbab](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/1bebbab001b9258a6b866892c09c4282a3705677))

## [0.4.1](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.4.0...via-v0.4.1) (2026-10-25)


### Bug Fixes

* via agents work in team mode, and the ACP parser is typed against the SDK and skips malformed content ([2253f86](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/2253f86dbe2e62be0f1f785f4ae9c91f7b6f0252))

## [0.4.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.3.0...via-v0.4.0) (2026-10-25)


### Features

* Codex and OpenCode subagents show native tool rows, Claude Code's own summary, command output, diffs and images ([c36a2e0](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/c36a2e0ecc1c5fd58b2d5c22ddb2212890a39883))

## [0.3.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.2.1...via-v0.3.0) (2026-10-24)


### Features

* a message to a running Codex or OpenCode agent reaches it at its next step ([230327b](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/230327b48dc7928bb2608898991269fc3113d5e3))

## [0.2.1](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.2.0...via-v0.2.1) (2026-10-24)


### Bug Fixes

* via-help, agent descriptions and SendMessage say Codex and OpenCode read a message after their current answer, not mid-run ([0a8282f](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/0a8282f87b64d10a37ee959d83eb60a47c37fd7e))

## [0.2.0](https://github.com/SeanLF/claude-code-subagent-harnesses/compare/via-v0.1.0...via-v0.2.0) (2026-10-24)


### Features

* via runs Codex, Antigravity, OpenCode and pi as native Claude Code subagents ([7d5568d](https://github.com/SeanLF/claude-code-subagent-harnesses/commit/7d5568dfb394903fd13f9034f7c4ce278b64bbc1))
