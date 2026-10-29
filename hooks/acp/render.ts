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
  const title = typeof input.title === 'string' ? unhidden(input.title).replace(/\s+/g, ' ') : ''
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
