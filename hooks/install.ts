import type { EngineInterface } from 'claude-code'
import type { Adapter } from './adapter'

type Engine = Pick<EngineInterface, 'process' | 'env' | 'fs' | 'plugin'>
export type Installs = {
  node?: Promise<string | undefined> // the version on PATH, asked once
  installs: Map<string, Promise<string>> // an ACP adapter's install, shared by agents starting at once
}

// Type stripping, which runs relay/relay.mjs and mcp/step.mts as is, is on by default from Node 22.18.
const nodeOk = (version: string) => {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 18)
}

function isFile($: Engine, path: string): Promise<boolean> {
  return $.fs.stat(path).then(
    (s) => s.kind === 'file',
    () => false,
  )
}

// The versions earlier releases installed: each lives in a folder of its own. Another Claude Code session may
// still run the release before this one, so the newest of them stays and the older ones go. Newest by the
// folder's own time, which is when it was installed: using one does not change it. Best effort and not
// awaited: a folder left behind only costs disk.
async function prune($: Engine, root: string, dir: string): Promise<void> {
  const family = dir.replace(/\d.*$/, '')
  const entries = await $.fs.list(root).catch(() => [])
  const old = entries
    .filter((entry) => entry.kind === 'dir' && entry.name !== dir && entry.name.startsWith(family))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(1)
    .map((entry) => `${root}/${entry.name}`)
  if (old.length === 0) return
  const remove = "for (const d of process.argv.slice(1)) require('fs').rmSync(d, { recursive: true, force: true })"
  await $.process.run(['node', '-e', remove, ...old], { timeoutMs: 60_000 }).catch(() => undefined)
}

// Every harness needs Node, for the step server that reports its tool calls, and the relay too; an ACP
// adapter that installs needs its pinned copy, installed once, or with latest the newest, once per session.
// A string says why the run cannot start.
export async function relayReady(w: Installs, $: Engine, adapter: Adapter, latest: boolean): Promise<{ installed?: string } | string> {
  w.node ??= $.process.run(['node', '-p', 'process.versions.node'], { timeoutMs: 15_000 }).then(
    (r) => (r.exitCode === 0 ? r.stdout.trim() : undefined),
    () => undefined,
  )
  const version = await w.node
  if (!version || !nodeOk(version))
    return `via needs Node 22.18 or later on PATH to run ${adapter.name}${version ? `, not ${version}` : ''}. Install a current Node LTS and restart Claude Code.`
  const install = adapter.relay?.install
  if (!install) return {}
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!home) return `${adapter.name} needs a home folder to install ${install.dir} into.`
  const root = `${home}/.claude/via/acp`
  const dir = `${root}/${latest ? 'latest' : install.dir}`
  const entry = `${dir}/${install.entry}`
  let installing = w.installs.get(dir)
  if (!installing) {
    installing = (async () => {
      // In via's own folder, so a project's .npmrc never applies; no install scripts, and no harness binary:
      // the adapter is pointed at the person's own CLI.
      const flags = ['--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund']
      let argv: string[]
      if (latest) {
        // The newest, unpinned: the person chose upstream over review.
        await $.fs.write(`${dir}/package.json`, '{ "private": true }\n')
        argv = ['npm', 'install', ...flags, `${install.package}@latest`]
      } else {
        if (await isFile($, entry)) return entry
        for (const file of install.files) await $.fs.write(`${dir}/${file.split('/').at(-1)}`, await $.fs.read(`${$.plugin.root}/${file}`))
        // Exactly the locked tree, each package's integrity checked by npm.
        argv = ['npm', 'ci', ...flags]
      }
      const done = await $.process
        .run(argv, { cwd: dir, timeoutMs: 300_000 })
        .catch((error: unknown) => ({ exitCode: -1, stderr: String(error) }))
      // Offline, latest keeps the newest it installed before rather than refusing.
      if (done.exitCode !== 0 && latest && (await isFile($, entry))) return entry
      if (done.exitCode !== 0) throw new Error(done.stderr.trim().split('\n').slice(-3).join(' ') || `npm ci exited with ${done.exitCode}`)
      if (!latest) void prune($, root, install.dir)
      return entry
    })()
    w.installs.set(dir, installing)
  }
  return installing.then(
    (installed) => ({ installed }),
    (error: unknown) => {
      w.installs.delete(dir)
      return `${adapter.name} could not install ${install.dir} (npm ci): ${String((error as { message?: unknown })?.message ?? error)}`
    },
  )
}
