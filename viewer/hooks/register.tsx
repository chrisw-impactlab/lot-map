import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, View, Watched } from '../types'
import { describeNow, drawMap, setupFrom } from './map'
import type { Setup } from './map'
import { feedRows, tallyOf } from './pane'
import { configDirFrom, findSession, loadSessions, recentSessions, titleOf } from './sessions'
import { applyRecord, startReading } from './transcript'
import type { TranscriptRecord } from './transcript'

const PANE = 'lot-map-viewer'
const COMMAND = 'lot-map-viewer'
const SUBAGENT_FILE = /^agent-.+\.jsonl$/
const SUBAGENT_POLL_MS = 2000

// The words of the viewer itself, in English. The map, the feed and the stations speak the language the person chose.
const WORDS = {
  title: 'Session viewer',
  command: 'Show the work map of another Claude Code session',
  idle: 'Not connected. Type /lot-map-viewer to pick a session, or /lot-map-viewer and a session id to connect to one.',
  pick: 'Pick the session to watch:',
  nothingToPick: 'No other session found.',
  watching: 'Watching',
  disconnect: 'Disconnect',
  noConfigFolder: 'Cannot find the folder where Claude Code keeps its sessions.',
  unknownSession: (query: string) => `No session starts with "${query.slice(0, 40)}".`,
  manySessions: (query: string, count: number) => `${count} sessions start with "${query.slice(0, 40)}": type more of the id.`,
  ownSession: 'That is the session this viewer runs in. Pick another one.',
  opened: 'Session viewer opened.',
  pickerOpened: 'Session viewer opened: pick a session in the pane.',
  cannotOpen: (reason: string) => `Nowhere to show the viewer right now: ${reason}`,
} as const

const EMPTY: Board = { entries: [], counts: {} }

// Change the tag when a field of Board or View changes: it declines what an earlier version stored.
const board = atom({ plugin: 'lot-map-viewer', key: 'board' } as const, EMPTY, { shape: 'board-1' })
const view = atom({ plugin: 'lot-map-viewer', key: 'view' } as const, { kind: 'idle' } as View, { shape: 'view-1' })

/** Whatever goes wrong here must never reach the session the viewer runs in. */
async function quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

const ago = (ms: number): string =>
  ms < 90_000 ? 'now' : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 129_600_000 ? `${Math.round(ms / 3_600_000)} h ago` : `${Math.round(ms / 86_400_000)} d ago`

/** The project folder's name is its path with the dashes for the slashes. The home folder at the start says nothing, so it goes. */
const folderName = (folder: string): string => folder.replace(/^-?(?:Users|home)-[^-]+-/, '').replace(/^-+/, '').slice(-28)

/** A session's name: where it runs, which it is, and what it is about. */
const nameOf = (row: Watched): string => `${folderName(row.folder)} · ${row.id.slice(0, 8)}${row.title === undefined ? '' : ` · ${row.title}`}`

/** The picker's line for a session: when it last changed, then its name. */
const lineOf = (row: Watched, now: number): string => `${ago(now - row.mtimeMs)} · ${nameOf(row)}`

/** The session the person asked to watch. Anything that changes it calls `change`, which wakes the loop in `run`. */
type Control = { wanted: Watched | undefined; version: number; waiting: (() => void)[] }

const newControl = (): Control => ({ wanted: undefined, version: 0, waiting: [] })

function change(control: Control, next: Watched | undefined): void {
  control.wanted = next
  control.version++
  for (const wake of control.waiting.splice(0)) wake()
}

const untilChange = (control: Control, seen: number): Promise<void> =>
  control.version !== seen ? Promise.resolve() : new Promise<void>(resolve => control.waiting.push(resolve))

/** Reads one session's files until the wanted session changes. Only reads: the files are never written, and the session is never told. */
async function follow($: EngineInterface, control: Control, setup: Setup, target: Watched, seen: number): Promise<void> {
  let reading = startReading()
  let stopped = false
  const streams: { return: (value: { code: number | null; signal: string | null }) => Promise<unknown> }[] = []

  await quietly(() => update($, board, () => EMPTY))
  await quietly(() => update($, view, (): View => ({ kind: 'watching', row: target })))

  const feed = (lines: readonly string[]): void => {
    for (const line of lines) {
      if (line === '') continue
      try {
        reading = applyRecord(reading, JSON.parse(line) as TranscriptRecord, setup)
      } catch {
        // A line that is no record, or a record that is not understood, adds nothing.
      }
    }
  }

  /** Follows one file from its first line, and goes on as it grows. Ends when the child ends. */
  const tail = async (path: string): Promise<void> => {
    let rest = ''
    try {
      const stream = $.process.spawn({ argv: ['tail', '-n', '+1', '-F', path] })
      streams.push(stream)
      for await (const chunk of stream) {
        if (stopped) break
        if (chunk.stream !== 'stdout') continue
        const lines = (rest + chunk.text).split('\n')
        rest = lines.pop() ?? ''
        feed(lines)
        await quietly(() => update($, board, () => reading.board))
      }
    } catch {
      // The file went away, or the child could not start: the map keeps what it has.
    }
  }

  void tail(target.path)

  const subagents = `${target.path.slice(0, -'.jsonl'.length)}/subagents`
  const followed = new Set<string>()
  void (async () => {
    while (!stopped) {
      for (const file of (await quietly(() => $.fs.list(subagents))) ?? []) {
        if (stopped || file.kind !== 'file' || !SUBAGENT_FILE.test(file.name) || followed.has(file.name)) continue
        followed.add(file.name)
        void tail(`${subagents}/${file.name}`)
      }
      await quietly(() => $.clock.sleep(SUBAGENT_POLL_MS))
    }
  })()

  await untilChange(control, seen)
  stopped = true
  // Leaving a stream ends its child process. The call is not waited for: it may answer only when the file next grows.
  for (const stream of streams) void quietly(() => stream.return({ code: null, signal: null }))
}

/** The loop that lives as long as the session: it waits for a wanted session, follows it, and clears the map when none is wanted. */
async function run($: EngineInterface, control: Control, setup: Setup): Promise<void> {
  for (;;) {
    const seen = control.version
    const target = control.wanted
    if (target !== undefined) {
      await follow($, control, setup, target, seen)
    } else {
      await untilChange(control, seen)
    }
    if (control.wanted === undefined) {
      await quietly(() => update($, board, () => EMPTY))
      await quietly(() => update($, view, () => ({ kind: 'idle' })))
    }
  }
}

export const register: Register = (on, options) => {
  const setup = setupFrom(options)
  const { t } = setup
  const control = newControl()

  on('session.start', async ($, e, next) => {
    await quietly(() => $.command.register({ name: COMMAND, description: WORDS.command }))
    await quietly(() => update($, board, () => EMPTY))
    await quietly(() => update($, view, () => ({ kind: 'idle' })))
    void quietly(() => run($, control, setup))
    return next(e)
  })

  // The session that runs the viewer is over: the `tail` processes must not outlive it.
  on('session.end', async (_, e, next) => {
    change(control, undefined)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const problem = async (text: string): Promise<{ text: string }> => {
      await quietly(() => update($, view, (): View => ({ kind: 'problem', text })))
      await quietly(() => $.ui.open({ id: PANE, title: WORDS.title }))
      return { text }
    }
    const config = configDirFrom(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
    if (config === undefined) return problem(WORDS.noConfigFolder)
    const sessions = await loadSessions(path => $.fs.list(path), config)
    const own = await $.session.id()
    const query = e.args.trim()

    let next: View
    if (query === '') {
      const rows: Watched[] = await Promise.all(
        recentSessions(sessions, own).map(async session => {
          const title = await titleOf(argv => $.process.run(argv), session.path)
          return title === undefined ? session : { ...session, title }
        }),
      )
      next = { kind: 'picking', rows }
    } else {
      const found = findSession(sessions, query)
      if (found.kind === 'none') return problem(WORDS.unknownSession(query))
      if (found.kind === 'ambiguous') return problem(WORDS.manySessions(query, found.count))
      if (found.session.id === own) return problem(WORDS.ownSession)
      next = { kind: 'watching', row: found.session }
    }
    await update($, view, () => next)
    if (next.kind === 'watching') change(control, next.row)
    const opened = await $.ui.open({ id: PANE, title: WORDS.title })
    if (!opened.isPlaced) return { text: WORDS.cannotOpen(String(opened.reason)) }
    return { text: next.kind === 'picking' ? WORDS.pickerOpened : WORDS.opened }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const shown = await read($, view)
    const state = await read($, board)
    const now = await $.clock.now()
    const { Box, Button, Text } = $.ui.resolve(e)

    if (shown.kind === 'idle') return <Text dimColor>{WORDS.idle}</Text>
    if (shown.kind === 'problem') return <Text color="error">{shown.text}</Text>
    if (shown.kind === 'picking') {
      return (
        <Box flexDirection="column">
          <Text>{shown.rows.length > 0 ? WORDS.pick : WORDS.nothingToPick}</Text>
          {shown.rows.map(row => (
            <Button key={`pick-${row.id}`} label={lineOf(row, now)} onPress={() => change(control, row)} />
          ))}
        </Box>
      )
    }

    const rows = feedRows(state, t).map(row => (
      <Text mono size="footnote" color={row.color} dimColor={row.isDim}>
        {row.text}
      </Text>
    ))
    const feed = rows.length > 0 ? rows : [<Text dimColor>{t.nothingYet}</Text>]
    const current = <Text mono size="footnote">{describeNow(state, t)}</Text>
    const header = (
      <Box>
        <Text dimColor>{`${WORDS.watching} ${nameOf(shown.row)}  `}</Text>
        <Button key="disconnect" label={WORDS.disconnect} onPress={() => change(control, undefined)} />
      </Box>
    )

    if (e.surface === 'terminal') {
      const tally = tallyOf(state, t)
      return (
        <Box flexDirection="column">
          {header}
          {current}
          <Text dimColor>{tally === '' ? t.noCounts : tally}</Text>
          {feed}
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {header}
        <Svg source={drawMap(state, now, setup)} alt={`${WORDS.title}. ${describeNow(state, t)}`} />
        {current}
        {feed}
      </Box>
    )
  })
}
