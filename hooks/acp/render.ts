import type { RenderElement, RenderNode, RenderPropsOf } from 'claude-code'
import { unhidden } from './text'

// What a call that reported no output answers; its row shows none.
export const NO_OUTPUT = 'Done; no output reported.'

// A diff's lines and a plan's entries are what the row is for, so more of them show before it folds;
// a compaction's summary is not, as Claude Code keeps its own behind ctrl+o.
const FOLDED: Record<string, number> = { edit: 12, plan: 12, compact: 1 }
// The calls whose row reads as a verb on its title.
const VERBS: Record<string, [string, string]> = { execute: ['Running', 'Ran'], compact: ['Compacting', 'Compacted'] }

// A changed line of a diff in its theme colour; the rest dim, as a call's output is.
function outputLine(line: string, first: boolean, diff: boolean): RenderElement {
  const lead = first ? '  ⎿  ' : '     '
  const color = diff && line.startsWith('+ ') ? 'diffAdded' : diff && line.startsWith('- ') ? 'diffRemoved' : undefined
  return color
    ? {
        type: 'Text',
        children: [
          { type: 'Text', props: { dimColor: true }, children: [lead] },
          { type: 'Text', props: { color }, children: [line] },
        ],
      }
    : { type: 'Text', props: { dimColor: true }, children: [`${lead}${line}`] }
}

// How a folded run counts each ACP tool kind: while live, then once done.
const COUNTED: Record<string, [string, string, string, string]> = {
  read: ['Reading', 'Read', 'file', 'files'],
  search: ['Searching', 'Searched', 'pattern', 'patterns'],
  execute: ['Running', 'Ran', 'command', 'commands'],
  edit: ['Editing', 'Edited', 'file', 'files'],
  delete: ['Deleting', 'Deleted', 'file', 'files'],
  move: ['Moving', 'Moved', 'file', 'files'],
  fetch: ['Fetching', 'Fetched', 'page', 'pages'],
  wait: ['Waiting on', 'Waited on', 'command', 'commands'],
}

// A call's title as one line, with nothing hidden in it.
function titleOf(input: unknown): string {
  const title = (input as { title?: unknown } | null)?.title
  return typeof title === 'string' ? unhidden(title).replace(/\s+/g, ' ') : ''
}

// The line Claude Code folds a run of harness tool calls into, counted by what each did ("Read 3 files,
// ran 2 commands") in place of its "Called plugin:via:step 5 times". Styled as Claude Code's own: dim,
// counts bold, undimmed under the pointer, since a click unfolds it. Always this one line, from the
// first call on: the running call's title rides on it, so a call joining, ending or failing changes
// words, never rows. A blank line sets it apart from the agent's text above it, as the engine's own line is.
export function drawGroup(props: RenderPropsOf['ToolGroup']): RenderElement {
  const kindOf = (call: (typeof props.calls)[number]) => (call.input as { kind?: unknown } | null)?.kind
  // A wait is a command still running after a step went by: counted with it, unless it is all there is.
  const counted = props.calls.some((call) => kindOf(call) !== 'wait') ? props.calls.filter((call) => kindOf(call) !== 'wait') : props.calls
  const counts = new Map<string, number>()
  for (const call of counted) {
    const kind = kindOf(call)
    const known = typeof kind === 'string' && Object.hasOwn(COUNTED, kind) ? kind : 'other'
    counts.set(known, (counts.get(known) ?? 0) + 1)
  }
  const parts = [...counts].flatMap(([kind, n], i): RenderNode[] => {
    const [live, done, one, many] = COUNTED[kind] ?? ['', '', 'other step', 'other steps']
    const verb = props.isActive ? live : done
    const lead = i === 0 ? verb : verb.toLowerCase()
    const said: RenderNode[] = [{ type: 'Text', props: { bold: true }, children: [String(n)] }, ` ${n === 1 ? one : many}`]
    return [...(i === 0 ? [] : [', ']), ...(lead ? [`${lead} `] : []), ...said]
  })
  const failed = props.calls.filter((call) => call.isErrored || call.isInterrupted).length
  const current = props.isActive ? (props.calls.findLast((call) => call.isRunning) ?? props.calls.at(-1)) : undefined
  const title = current ? titleOf(current.input) : ''
  return {
    type: 'Box',
    props: { key: 'via-group', marginTop: 1, paddingLeft: 2 },
    children: [
      {
        type: 'Text',
        props: { dimColor: true, wrap: 'truncate-end' },
        hover: { dimColor: false },
        children: [
          ...parts,
          ...(failed > 0 ? [`, ${failed} failed`] : []),
          ...(props.isActive ? ['…'] : []),
          ...(title ? [` · ${title}`] : []),
        ],
      },
    ],
  }
}

// The row of one harness tool call, as an ACP client draws it: its title, linked to the file it acts on
// when the agent named one, then its output (a diff for an edit, the entries of a plan), a few lines
// unless the view is expanded. Only a command gets a verb: other titles already say what they do
// ("Read file 'a.ts'").
export function drawCall(props: RenderPropsOf['ToolUse']): RenderElement {
  const input = (typeof props.input === 'object' && props.input !== null ? props.input : {}) as {
    kind?: unknown
    title?: unknown
    path?: unknown
  }
  const kind = typeof input.kind === 'string' ? input.kind : 'other'
  const title = titleOf(input)
  const path = typeof input.path === 'string' ? unhidden(input.path) : ''
  const [running, done] = VERBS[kind] ?? ['', '']
  const verb = props.isInterrupted ? 'Interrupted' : props.isErrored ? 'Failed' : props.isRunning ? running : done
  const said = typeof props.output === 'string' ? unhidden(props.output).trim() : ''
  const output = said === NO_OUTPUT ? '' : said
  const lines = output ? output.split('\n') : []
  const shown = props.isExpanded ? lines : lines.slice(0, FOLDED[kind] ?? 3)
  const more = lines.length - shown.length
  const diff = kind === 'edit'
  // Only an absolute path makes a file URL; spaces, #, ? and % in it are encoded.
  const named: RenderNode = path.startsWith('/')
    ? { type: 'Link', props: { href: `file://${encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')}` }, children: [title] }
    : title
  return {
    type: 'Box',
    props: { flexDirection: 'column' },
    children: [
      {
        type: 'Text',
        children: verb
          ? [{ type: 'Text', props: { bold: true }, children: [verb] }, ' ', named]
          : [{ type: 'Text', props: { bold: true }, children: [named] }, ...(props.isRunning ? ['…'] : [])],
      },
      ...shown.map((line, i) => outputLine(line, i === 0, diff)),
      ...(more > 0
        ? [
            {
              type: 'Text' as const,
              props: { dimColor: true },
              children: [`     … ${more} more ${more === 1 ? 'line' : 'lines'} (ctrl+o to expand)`],
            },
          ]
        : []),
    ],
  }
}
