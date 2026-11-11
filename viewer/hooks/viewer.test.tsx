import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { setupFrom } from './map'
import { configDirFrom, findSession, loadSessions, recentSessions, titleOf } from './sessions'
import type { Session } from './sessions'
import { applyRecord, startReading } from './transcript'
import type { Reading, TranscriptRecord } from './transcript'

// The test runner provides `console`; the plugin type library (es2023 only) does not declare it.
declare const console: { error(message: string): void }

const SETUP = setupFrom({})
const BASE = Date.parse('2026-11-11T10:00:00.000Z')
const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString()

// Records as a transcript file holds them, written by hand: names and ids only, no real content.
const call = (seconds: number, id: string, name: string, input: Record<string, unknown>): TranscriptRecord => ({
  type: 'assistant',
  timestamp: at(seconds),
  requestId: `req-${id}`,
  isSidechain: false,
  message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] },
})

const answer = (seconds: number, id: string, extra: { isError?: boolean; toolUseResult?: unknown } = {}): TranscriptRecord => ({
  type: 'user',
  timestamp: at(seconds),
  isSidechain: false,
  message: { content: [{ type: 'tool_result', tool_use_id: id, ...(extra.isError === true ? { is_error: true } : {}) }] },
  ...(extra.toolUseResult !== undefined ? { toolUseResult: extra.toolUseResult } : {}),
})

const notice = (seconds: number, task: string, status: string): TranscriptRecord => ({
  type: 'user',
  timestamp: at(seconds),
  isSidechain: false,
  message: { content: `<task-notification><task-id>${task}</task-id><status>${status}</status><summary>private words</summary></task-notification>` },
})

const read = (...records: TranscriptRecord[]): Reading => records.reduce<Reading>((reading, record) => applyRecord(reading, record, SETUP), startReading())

test('a tool call starts a row on its station, and its result closes it', () => {
  const open = read(call(0, 'tu1', 'Read', { file_path: '/a/b/c.py' }))
  const row = open.board.entries.find(e => e.id === 'tu1')
  expect(row?.station).toBe('files')
  expect(row?.label).toBe('b/c.py')
  expect(row?.from).toBe('core')
  expect(row?.status).toBe('run')
  expect(row?.startedAt).toBe(BASE)
  expect(open.board.counts.files).toBe(1)

  const done = read(call(0, 'tu1', 'Read', { file_path: '/a/b/c.py' }), answer(2, 'tu1'))
  const closed = done.board.entries.find(e => e.id === 'tu1')
  expect(closed?.status).toBe('ok')
  expect(closed?.endedAt).toBe(BASE + 2000)
  expect(done.board.counts.files).toBe(1)
})

test('a result that is an error leaves a fault on the station', () => {
  const failed = read(call(0, 'tu1', 'Bash', { command: 'make', description: 'Build' }), answer(3, 'tu1', { isError: true }))
  expect(failed.board.entries.find(e => e.id === 'tu1')?.status).toBe('err')
  expect(failed.board.faults?.shell).toBe(1)
})

test('a result for a call that was never seen changes nothing', () => {
  const reading = read(answer(1, 'unknown'))
  expect(reading.board.entries.length).toBe(0)
  expect(reading.board.faults).toBeUndefined()
})

test('a command sent to the background stays open until its notification, which shows only how it ended', () => {
  const started = read(
    call(0, 'tu1', 'Bash', { command: 'sleep 600', description: 'Wait for the build', run_in_background: true }),
    answer(1, 'tu1', { toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }),
  )
  const row = started.board.entries.find(e => e.id === 'tu1')
  expect(row?.status).toBe('run')
  expect(row?.task).toBe('b1')

  const other = applyRecord(started, notice(5, 'other', 'completed'), SETUP)
  expect(other.board.entries.find(e => e.id === 'tu1')?.status).toBe('run')

  const ended = applyRecord(started, notice(9, 'b1', 'completed'), SETUP)
  const closed = ended.board.entries.find(e => e.id === 'tu1')
  expect(closed?.status).toBe('ok')
  expect(closed?.endedAt).toBe(BASE + 9000)
  expect(JSON.stringify(ended.board)).not.toContain('private words')
  // The notification is no message of the person's.
  expect(ended.board.entries.some(e => e.station === 'you')).toBe(false)

  const failed = applyRecord(started, notice(9, 'b1', 'failed'), SETUP)
  expect(failed.board.entries.find(e => e.id === 'tu1')?.status).toBe('err')
  expect(failed.board.faults?.shell).toBe(1)
})

const step = (seconds: number, requestId: string | null, blocks: readonly unknown[], model = 'claude-opus-5-5'): TranscriptRecord => ({
  type: 'assistant',
  timestamp: at(seconds),
  requestId,
  isSidechain: false,
  message: { model, content: blocks },
})
const TALK = [{ type: 'text', text: 'private words' }]
const CALL = (id: string): unknown[] => [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/a/b/c.py' } }]
const modelRows = (reading: Reading) => reading.board.entries.filter(e => e.station === 'model' && e.mark === undefined)

test('a model request is one step: it opens with its first record and closes at its first tool call', () => {
  const opened = read(step(0, 'r1', [{ type: 'thinking' }]))
  expect(modelRows(opened).length).toBe(1)
  expect(modelRows(opened)[0]?.label).toBe('opus 5.5 · step 1')
  expect(modelRows(opened)[0]?.status).toBe('run')
  expect(opened.board.counts.model).toBe(1)
  expect(opened.board.model).toBe('claude-opus-5-5')
  expect(opened.board.step).toBe(1)

  // The same request writes a record for each of its blocks: they add no step.
  const same = applyRecord(opened, step(1, 'r1', TALK), SETUP)
  expect(modelRows(same).length).toBe(1)

  const called = applyRecord(same, step(2, 'r1', CALL('tu1')), SETUP)
  expect(modelRows(called).length).toBe(1)
  expect(modelRows(called)[0]?.status).toBe('ok')
  expect(modelRows(called)[0]?.endedAt).toBe(BASE + 2000)
  // The step comes before its call on the board.
  expect(called.board.entries.map(e => e.station)).toEqual(['model', 'files'])
})

test('each new request is the next step, and it closes the step before it', () => {
  const next = read(step(0, 'r1', CALL('tu1')), answer(1, 'tu1'), step(2, 'r2', TALK))
  expect(modelRows(next).map(e => e.label)).toEqual(['opus 5.5 · step 1', 'opus 5.5 · step 2'])
  expect(next.board.counts.model).toBe(2)
  expect(next.board.step).toBe(2)

  // A step that made no call is closed by the next request.
  const quiet = read(step(0, 'r1', TALK), step(5, 'r2', TALK))
  expect(modelRows(quiet)[0]?.status).toBe('ok')
  expect(modelRows(quiet)[0]?.endedAt).toBe(BASE + 5000)
  expect(modelRows(quiet)[1]?.status).toBe('run')
})

test('a change of model is a row of its own, and the first model of a session is not', () => {
  const first = read(step(0, 'r1', TALK))
  expect(first.board.entries.some(e => e.mark === 'switch')).toBe(false)

  const switched = applyRecord(first, step(5, 'r2', TALK, 'claude-fable-5-1'), SETUP)
  const row = switched.board.entries.find(e => e.mark === 'switch')
  expect(row?.station).toBe('model')
  expect(row?.label).toBe('opus 5.5 → fable 5.1')
  expect(row?.status).toBe('ok')
  expect(switched.board.switchedAt).toBe(BASE + 5000)
  expect(switched.board.model).toBe('claude-fable-5-1')
  // Two steps are counted; the change is no step.
  expect(switched.board.counts.model).toBe(2)
})

test('a placeholder model and a record with no request are no step', () => {
  const quiet = read(step(0, 'r1', TALK), step(1, null, TALK, '<synthetic>'), step(2, 'r2', TALK))
  expect(modelRows(quiet).length).toBe(2)
  expect(quiet.board.entries.some(e => e.mark === 'switch')).toBe(false)
  expect(quiet.board.model).toBe('claude-opus-5-5')
})

const human = (seconds: number, text = 'private words'): TranscriptRecord => ({
  type: 'user',
  timestamp: at(seconds),
  isSidechain: false,
  origin: { kind: 'human' },
  message: { content: text },
})
const system = (seconds: number, subtype: string): TranscriptRecord => ({ type: 'system', subtype, timestamp: at(seconds), isSidechain: false })
const hookContext = (seconds: number, hookEvent: string, content: readonly string[]): TranscriptRecord => ({
  type: 'attachment',
  timestamp: at(seconds),
  isSidechain: false,
  attachment: { type: 'hook_additional_context', hookEvent, hookName: `${hookEvent}:x`, content },
})

test('a message of the person is a row on You: it clears the faults and starts the step count again', () => {
  const failed = read(call(0, 'tu1', 'Bash', { command: 'make', description: 'Build' }), answer(1, 'tu1', { isError: true }))
  expect(failed.board.faults?.shell).toBe(1)

  const spoken = applyRecord(failed, human(2), SETUP)
  const row = spoken.board.entries.find(e => e.station === 'you')
  expect(row?.label).toBe('new message')
  expect(row?.from).toBe('inbound')
  expect(row?.status).toBe('ok')
  expect(spoken.board.counts.you).toBe(1)
  expect(spoken.board.faults?.shell).toBeUndefined()
  expect(JSON.stringify(spoken.board)).not.toContain('private words')

  const turns = read(step(0, 'r1', CALL('tu1')), answer(1, 'tu1'), human(2), step(3, 'r2', TALK))
  expect(modelRows(turns).map(e => e.label)).toEqual(['opus 5.5 · step 1', 'opus 5.5 · step 1'])
})

test('only the person writes a message: a peer session, a command echo and a notification are not one', () => {
  const peer: TranscriptRecord = { ...human(0), origin: { kind: 'peer' } }
  const echo: TranscriptRecord = { type: 'user', timestamp: at(1), isSidechain: false, message: { content: '<command-name>/plugin</command-name>' } }
  expect(read(peer, echo, notice(2, 'b1', 'completed')).board.entries.some(e => e.station === 'you')).toBe(false)
})

test('the end of a turn is an answer on You, and settles a call that never reported back, but not a background task', () => {
  const ended = read(
    call(0, 'tu1', 'Read', { file_path: '/a/b/c.py' }),
    call(0, 'tu2', 'Bash', { command: 'sleep 600', description: 'Wait', run_in_background: true }),
    answer(1, 'tu2', { toolUseResult: { backgroundTaskId: 'b1' } }),
    system(5, 'turn_duration'),
  )
  expect(ended.board.entries.find(e => e.id === 'tu1')?.status).toBe('ok')
  expect(ended.board.entries.find(e => e.id === 'tu1')?.endedAt).toBe(BASE + 5000)
  expect(ended.board.entries.find(e => e.id === 'tu2')?.status).toBe('run')
  const row = ended.board.entries.find(e => e.station === 'you')
  expect(row?.label).toBe('answer ready')
  expect(row?.mark).toBe('done')
})

test('a compaction is a finished row on Model', () => {
  const compacted = read(system(3, 'compact_boundary'))
  const row = compacted.board.entries.find(e => e.station === 'model')
  expect(row?.label).toBe('compacting context')
  expect(row?.status).toBe('ok')
  expect(compacted.board.counts.model).toBe(1)
})

test('context a hook added shows on Hooks by when it came, never as its text', () => {
  const hooked = read(
    hookContext(0, 'SessionStart', ['private words']),
    hookContext(1, 'UserPromptSubmit', ['private words']),
    hookContext(2, 'PostToolUse', ['private words']),
    hookContext(3, 'UserPromptSubmit', ['  ']),
  )
  expect(hooked.board.entries.map(e => `${e.station}: ${e.label}`)).toEqual(['hooks: added context at session start', 'hooks: added context to the message'])
  expect(JSON.stringify(hooked.board)).not.toContain('private words')
})

const inAgent = (agentId: string, record: TranscriptRecord): TranscriptRecord => ({ ...record, isSidechain: true, agentId })

test('a subagent\'s calls start from the Agents station and carry its id, and its steps say they are its own', () => {
  const reading = read(inAgent('a1', step(0, 'r1', CALL('tu1'))))
  const row = reading.board.entries.find(e => e.id === 'tu1')
  expect(row?.from).toBe('agents')
  expect(row?.agentId).toBe('a1')
  const stepRow = modelRows(reading)[0]
  expect(stepRow?.label).toBe('opus 5.5 · step 1 · subagent')
  expect(stepRow?.from).toBe('agents')
  expect(stepRow?.agentId).toBe('a1')
  expect(reading.board.agents).toEqual(['a1'])
  // What the centre of the map shows is the main loop's.
  expect(reading.board.model).toBeUndefined()
  expect(reading.board.step).toBeUndefined()
})

test('each loop counts its own steps, and a model of a subagent is no change of the main model', () => {
  const reading = read(step(0, 'm1', TALK), inAgent('a1', step(1, 's1', TALK, 'claude-sonnet-5-5')), step(2, 'm2', TALK))
  expect(modelRows(reading).map(e => e.label)).toEqual(['opus 5.5 · step 1', 'sonnet 5.5 · step 1 · subagent', 'opus 5.5 · step 2'])
  expect(reading.board.entries.some(e => e.mark === 'switch')).toBe(false)
  expect(reading.board.model).toBe('claude-opus-5-5')
})

test('a background subagent stays on the map until its notification, which also settles its hanging calls', () => {
  const launched = read(
    call(0, 'ag1', 'Agent', { description: 'Look around' }),
    answer(1, 'ag1', { toolUseResult: { status: 'async_launched', agentId: 'a1', isAsync: true } }),
    inAgent('a1', step(2, 's1', CALL('tu1'))),
  )
  const launch = launched.board.entries.find(e => e.id === 'ag1')
  expect(launch?.station).toBe('agents')
  expect(launch?.label).toBe('Look around')
  expect(launch?.status).toBe('run')
  expect(launch?.task).toBe('a1')
  expect(launched.board.agents).toEqual(['a1'])
  expect(launched.board.entries.find(e => e.id === 'tu1')?.status).toBe('run')

  const ended = applyRecord(launched, notice(9, 'a1', 'completed'), SETUP)
  expect(ended.board.entries.find(e => e.id === 'ag1')?.status).toBe('ok')
  expect(ended.board.entries.find(e => e.id === 'tu1')?.status).toBe('ok')
  expect(ended.board.entries.find(e => e.id === 'tu1')?.endedAt).toBe(BASE + 9000)
  expect(ended.board.agents).toEqual([])
})

test('a subagent that answered with its result leaves the Agents station at once', () => {
  const reading = read(
    call(0, 'ag1', 'Agent', { description: 'Fork' }),
    inAgent('f1', step(1, 's1', TALK)),
    answer(2, 'ag1', { toolUseResult: { status: 'forked', agentId: 'f1', success: true } }),
  )
  expect(reading.board.entries.find(e => e.id === 'ag1')?.status).toBe('ok')
  const hanging = reading.board.entries.find(e => e.station === 'model' && e.agentId === 'f1')
  expect(hanging?.status).toBe('ok')
  expect(hanging?.endedAt).toBe(BASE + 2000)
  expect(reading.board.agents).toEqual([])
})

const SESSION = (id: string, mtimeMs = 0, folder = 'proj'): Session => ({ id, folder, path: `/c/projects/${folder}/${id}.jsonl`, mtimeMs })
const SESSIONS = [
  SESSION('0bd00807-5534-4527-ad0a-556488daa501'),
  SESSION('0bd00899-aaaa-4bbb-8ccc-000000000001'),
  SESSION('9474d28e-ebda-413a-8371-f4a6aa498e37'),
]

test('a session is found by its whole id, or by a start of 6 or more characters that one session has', () => {
  const wanted = { kind: 'found', session: SESSIONS[2] }
  expect(findSession(SESSIONS, '9474d28e-ebda-413a-8371-f4a6aa498e37')).toEqual(wanted)
  expect(findSession(SESSIONS, '9474d2')).toEqual(wanted)
  expect(findSession(SESSIONS, '  9474D2\n')).toEqual(wanted)
  expect(findSession(SESSIONS, '0bd0080')).toEqual({ kind: 'found', session: SESSIONS[0] })
})

test('a start that two sessions share, a start that is too short and an unknown id find nothing to connect to', () => {
  expect(findSession(SESSIONS, '0bd008')).toEqual({ kind: 'ambiguous', count: 2 })
  expect(findSession(SESSIONS, '9474d')).toEqual({ kind: 'none' })
  expect(findSession(SESSIONS, 'ffffff')).toEqual({ kind: 'none' })
  expect(findSession(SESSIONS, '')).toEqual({ kind: 'none' })
})

test('the picker lists the newest sessions first, 10 at most, and leaves out the viewer\'s own', () => {
  const many = Array.from({ length: 12 }, (_, i) => SESSION(`aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, i * 1000))
  const own = many[11]?.id ?? ''
  const listed = recentSessions(many, own)
  expect(listed.map(s => s.mtimeMs)).toEqual([10000, 9000, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000])
  expect(listed.some(s => s.id === own)).toBe(false)
})

test('the config folder is the one the environment names, or else ~/.claude, or unknown', () => {
  expect(configDirFrom('/cfg', '/home/x')).toBe('/cfg')
  expect(configDirFrom(undefined, '/home/x')).toBe('/home/x/.claude')
  expect(configDirFrom('', '/home/x')).toBe('/home/x/.claude')
  expect(configDirFrom(undefined, undefined)).toBeUndefined()
  expect(configDirFrom('', '')).toBeUndefined()
})

const ENTRY = (name: string, kind: 'file' | 'dir', mtimeMs = 0) => ({ name, kind, size: 1, mtimeMs, isLink: false })

test('every session file in every project folder is a session, and nothing else is', async () => {
  const tree: Record<string, ReturnType<typeof ENTRY>[]> = {
    '/c/projects': [ENTRY('proj-a', 'dir'), ENTRY('proj-b', 'dir'), ENTRY('stray.jsonl', 'file')],
    '/c/projects/proj-a': [ENTRY('s1.jsonl', 'file', 5000), ENTRY('s1', 'dir'), ENTRY('notes.md', 'file')],
    '/c/projects/proj-b': [ENTRY('s2.jsonl', 'file', 7000)],
  }
  expect(await loadSessions(async path => tree[path] ?? [], '/c')).toEqual([
    { id: 's1', folder: 'proj-a', path: '/c/projects/proj-a/s1.jsonl', mtimeMs: 5000 },
    { id: 's2', folder: 'proj-b', path: '/c/projects/proj-b/s2.jsonl', mtimeMs: 7000 },
  ])
})

test('a folder that cannot be listed adds no sessions and stops nothing', async () => {
  const list = async (path: string) => {
    if (path === '/c/projects/locked') throw new Error('permission denied')
    return path === '/c/projects' ? [ENTRY('locked', 'dir'), ENTRY('open', 'dir')] : [ENTRY('s1.jsonl', 'file', 1)]
  }
  expect((await loadSessions(list, '/c')).map(s => s.folder)).toEqual(['open'])
  expect(await loadSessions(async () => { throw new Error('no projects folder') }, '/c')).toEqual([])
})

test('a session is titled by the newest title in its file, cut short, and by nothing when it has none', async () => {
  const titles = ['{"type":"ai-title","aiTitle":"First title","sessionId":"s"}', '{"type":"ai-title","aiTitle":"Newest title","sessionId":"s"}'].join('\n')
  const seen: string[][] = []
  const ask = (stdout: string, exitCode = 0) => async (argv: readonly string[]) => {
    seen.push([...argv])
    return { exitCode, stdout }
  }
  expect(await titleOf(ask(titles), '/c/projects/p/s.jsonl')).toBe('Newest title')
  // grep runs by argument vector with the path as one argument, so nothing reads the path as shell.
  expect(seen[0]).toEqual(['grep', '-a', '-h', '"type":"ai-title"', '/c/projects/p/s.jsonl'])

  expect(await titleOf(ask('', 1), '/p')).toBeUndefined()
  expect(await titleOf(ask(`not json\n${titles}\n{broken`), '/p')).toBe('Newest title')
  expect((await titleOf(ask(`{"aiTitle":"${'x'.repeat(100)}"}`), '/p'))?.length).toBe(60)
})

// A task that is stopped with TaskStop sends no notification: the result of that call is the only sign that it ended.
const stopResult = (task: string) => ({ message: 'Stopped', task_id: task, task_type: 'local_bash', command: 'sleep 600' })

test('a task stopped with TaskStop ends on the result of that call, and a stop that failed ends nothing', () => {
  const launched = [
    call(0, 'tu1', 'Bash', { command: 'sleep 600', description: 'Wait', run_in_background: true }),
    answer(1, 'tu1', { toolUseResult: { backgroundTaskId: 'b1' } }),
    call(5, 'tu2', 'TaskStop', { task_id: 'b1' }),
  ]
  const stopped = read(...launched, answer(6, 'tu2', { toolUseResult: stopResult('b1') }))
  expect(stopped.board.entries.find(e => e.id === 'tu1')?.status).toBe('ok')
  expect(stopped.board.entries.find(e => e.id === 'tu1')?.endedAt).toBe(BASE + 6000)
  expect(stopped.board.entries.filter(e => e.status === 'run')).toEqual([])

  const failed = read(...launched, answer(6, 'tu2', { isError: true, toolUseResult: stopResult('b1') }))
  expect(failed.board.entries.find(e => e.id === 'tu1')?.status).toBe('run')
})

test('a subagent stopped with TaskStop leaves the Agents station with its hanging calls', () => {
  const reading = read(
    call(0, 'ag1', 'Agent', { description: 'Look around' }),
    answer(1, 'ag1', { toolUseResult: { status: 'async_launched', agentId: 'a1', isAsync: true } }),
    inAgent('a1', step(2, 's1', TALK)),
    call(5, 'tu2', 'TaskStop', { task_id: 'a1' }),
    answer(6, 'tu2', { toolUseResult: stopResult('a1') }),
  )
  expect(reading.board.entries.filter(e => e.status === 'run')).toEqual([])
  expect(reading.board.agents).toEqual([])
})

// The viewer follows the main file and each subagent's file at once, so a subagent's records can be read after the record that ended it.
test('records of a subagent that are read after its end leave no running row and no dot on the Agents station', () => {
  const launched = [
    call(0, 'ag1', 'Agent', { description: 'Look around' }),
    answer(1, 'ag1', { toolUseResult: { status: 'async_launched', agentId: 'a1', isAsync: true } }),
  ]
  const reading = read(
    ...launched,
    notice(9, 'a1', 'completed'),
    inAgent('a1', step(2, 's1', CALL('tu1'))),
    inAgent('a1', step(3, 's2', TALK)),
  )
  expect(reading.board.entries.filter(e => e.status === 'run')).toEqual([])
  expect(reading.board.agents).toEqual([])
  // The late records still count.
  expect(reading.board.counts.files).toBe(1)
  expect(reading.board.counts.model).toBe(3)
})

test('records of a subagent that are read after its result leave no running row and no dot either', () => {
  const reading = read(
    call(0, 'ag1', 'Agent', { description: 'Fork' }),
    answer(2, 'ag1', { toolUseResult: { status: 'forked', agentId: 'f1', success: true } }),
    inAgent('f1', step(1, 's1', TALK)),
  )
  expect(reading.board.entries.filter(e => e.status === 'run')).toEqual([])
  expect(reading.board.agents).toEqual([])
})

// A notification that arrives while a turn runs is not a user record: the transcript keeps it as a queue record and as an attachment.
const noticeText = (task: string, status: string): string =>
  `<task-notification><task-id>${task}</task-id><status>${status}</status><summary>private words</summary></task-notification>`
const queued = (seconds: number, content: string): TranscriptRecord => ({ type: 'queue-operation', operation: 'enqueue', timestamp: at(seconds), content })
const queuedCommand = (seconds: number, prompt: string): TranscriptRecord => ({
  type: 'attachment',
  timestamp: at(seconds),
  isSidechain: false,
  attachment: { type: 'queued_command', commandMode: 'task-notification', prompt },
})

test('a notification that was queued while a turn ran settles its task as well', () => {
  const open = read(
    call(0, 'tu1', 'Bash', { command: 'sleep 600', description: 'Wait', run_in_background: true }),
    answer(1, 'tu1', { toolUseResult: { backgroundTaskId: 'b1' } }),
  )
  expect(open.board.entries.find(e => e.id === 'tu1')?.status).toBe('run')
  for (const make of [queued, queuedCommand]) {
    const ended = applyRecord(open, make(9, noticeText('b1', 'completed')), SETUP)
    expect(ended.board.entries.find(e => e.id === 'tu1')?.status).toBe('ok')
    expect(ended.board.entries.find(e => e.id === 'tu1')?.endedAt).toBe(BASE + 9000)
    expect(JSON.stringify(ended.board)).not.toContain('private words')

    const failed = applyRecord(open, make(9, noticeText('b1', 'failed')), SETUP)
    expect(failed.board.entries.find(e => e.id === 'tu1')?.status).toBe('err')
    expect(failed.board.faults?.shell).toBe(1)
  }
})

test('a queued record that is no notification, and the removal of a queued record, change nothing', () => {
  const open = read(
    call(0, 'tu1', 'Bash', { command: 'sleep 600', description: 'Wait', run_in_background: true }),
    answer(1, 'tu1', { toolUseResult: { backgroundTaskId: 'b1' } }),
  )
  expect(applyRecord(open, queued(9, '/compact'), SETUP).board).toEqual(open.board)
  expect(applyRecord(open, { ...queued(9, noticeText('b1', 'completed')), operation: 'remove' }, SETUP).board).toEqual(open.board)
  expect(applyRecord(open, queuedCommand(9, 'Background agent finished'), SETUP).board).toEqual(open.board)
})

const VIEWER_PANE = {
  plugin: 'lot-map-viewer',
  component: 'Pane',
  requestId: 'lot-map-viewer',
  props: { title: 'Viewer', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const WATCHED_ID = '0bd00807-5534-4527-ad0a-556488daa501'
const WATCHED_FILE = `/h/.claude/projects/proj/${WATCHED_ID}.jsonl`

type Tree = Record<string, ReturnType<typeof ENTRY>[]>

let lastClock: ReturnType<typeof mock.clock> | undefined
let viewerRegistered = false

/**
 * A test of the viewer's loops. `claude plugin test viewer` runs it. `claude plugin test .` finds this file too, but there the
 * plugin under test is the mod, the viewer is not loaded and `started` says so.
 * It ends the session when the body is over, passed or not: the kit waits for a loop that nobody stopped.
 */
const viewerTest = (name: string, body: TestBody): void =>
  test(name, async ($, on) => {
    lastClock = undefined
    try {
      await body($, on)
    } finally {
      await $.session.end({ reason: 'other', sessionId: 'own-session' } as never)
      // The type checker sees only the `undefined` above: the test body sets it through `world`.
      await (lastClock as ReturnType<typeof mock.clock> | undefined)?.advance(3000)
    }
  })

const HOME_TREE: Tree = {
  '/h/.claude/projects': [ENTRY('proj', 'dir')],
  '/h/.claude/projects/proj': [ENTRY(`${WATCHED_ID}.jsonl`, 'file', BASE)],
}

/** The world under the viewer: a home folder with one session in it, whose file `tail` prints as `lines`. Returns the clock. */
const world = (on: Parameters<typeof mock.env>[0], lines: readonly string[], tree: Tree = HOME_TREE, more: Record<string, readonly string[]> = {}) => {
  mock.env(on, { HOME: '/h' })
  const clock = mock.clock(on, { now: BASE + 60_000 })
  lastClock = clock
  const spawned: string[][] = []
  viewerRegistered = false
  on('command.register', (_, e) => {
    if (e.name === 'lot-map-viewer') viewerRegistered = true
    return { value: { command: e.name } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'own-session' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('fs.list', (_, e) => ({ value: tree[e.path] ?? [] }) as never)
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    const out = e.argv.includes(WATCHED_FILE) ? lines : more[e.argv.at(-1) ?? '']
    if (out !== undefined) yield { stream: 'stdout' as const, text: `${out.join('\n')}\n` }
    return { value: { code: 0, signal: null } }
  })
  return { clock, spawned }
}

/** Starts the session. False when the viewer did not register its command: it is not the plugin under test, and the test has nothing to do. */
const started = async ($: Parameters<TestBody>[0]): Promise<boolean> => {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  if (!viewerRegistered) console.error('skipped, the viewer is not the plugin under test')
  return viewerRegistered
}

viewerTest('connecting by a start of the id shows the calls of that session on the pane', async ($, on) => {
  const { clock } = world(on, [JSON.stringify(call(0, 'tu1', 'Read', { file_path: '/a/b/c.py' })), JSON.stringify(answer(1, 'tu1'))])
  if (!(await started($))) return
  const ran = await $.command.run({ command: 'lot-map-viewer', args: '0bd008' } as never)
  expect(JSON.stringify(ran)).toContain('Session viewer opened')
  await clock.settle()

  const ui = await $.ui.mount({ ...VIEWER_PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Watching/ }))?.text).toContain('0bd00807')
  expect((await ui.find({ type: 'Text', text: /b\/c\.py/ }))?.text).toContain('Files')
  // Disconnecting ends the loops, which the kit waits for.
  await ui.press({ key: 'disconnect' })
  await clock.advance(3000)
  await ui.unmount()
})

viewerTest('disconnecting leaves the pane saying that nothing is watched', async ($, on) => {
  const { clock } = world(on, [JSON.stringify(call(0, 'tu1', 'Read', { file_path: '/a/b/c.py' }))])
  if (!(await started($))) return
  await $.command.run({ command: 'lot-map-viewer', args: WATCHED_ID } as never)
  await clock.settle()

  const ui = await $.ui.mount({ ...VIEWER_PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /b\/c\.py/ })).toBeDefined()
  await ui.press({ key: 'disconnect' })
  await clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: /Not connected/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /b\/c\.py/ })).toBeUndefined()
  await ui.unmount()
})

viewerTest('the viewer only reads: the one process it starts is tail, on the files of the session it watches', async ($, on) => {
  const { clock, spawned } = world(on, [JSON.stringify(call(0, 'tu1', 'Read', { file_path: '/a/b/c.py' }))])
  if (!(await started($))) return
  await $.command.run({ command: 'lot-map-viewer', args: WATCHED_ID } as never)
  await clock.advance(3000)
  expect(spawned).toEqual([['tail', '-n', '+1', '-F', WATCHED_FILE]])

  const ui = await $.ui.mount({ ...VIEWER_PANE, surface: 'desktop' })
  await ui.press({ key: 'disconnect' })
  await clock.advance(3000)
  await ui.unmount()
})

viewerTest('when the session that runs the viewer ends, the viewer stops watching', async ($, on) => {
  const { clock } = world(on, [JSON.stringify(call(0, 'tu1', 'Read', { file_path: '/a/b/c.py' }))])
  if (!(await started($))) return
  await $.command.run({ command: 'lot-map-viewer', args: WATCHED_ID } as never)
  await clock.settle()
  await $.session.end({ reason: 'other', sessionId: 'own-session' } as never)
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...VIEWER_PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Not connected/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Watching/ })).toBeUndefined()
  await ui.unmount()
})

const SECOND_ID = '9474d28e-ebda-413a-8371-f4a6aa498e37'
const SECOND_FILE = `/h/.claude/projects/proj/${SECOND_ID}.jsonl`
const THREE: Tree = {
  '/h/.claude/projects': [ENTRY('proj', 'dir')],
  '/h/.claude/projects/proj': [ENTRY(`${WATCHED_ID}.jsonl`, 'file', BASE), ENTRY(`${SECOND_ID}.jsonl`, 'file', BASE + 1000), ENTRY('own-session.jsonl', 'file', BASE + 2000)],
}

viewerTest('connecting to another session replaces the map with that session\'s', async ($, on) => {
  const { clock } = world(on, [JSON.stringify(call(0, 'tu1', 'Read', { file_path: '/a/b/c.py' }))], THREE, {
    [SECOND_FILE]: [JSON.stringify(call(0, 'tu2', 'Bash', { command: 'make', description: 'Build it' }))],
  })
  if (!(await started($))) return
  await $.command.run({ command: 'lot-map-viewer', args: WATCHED_ID } as never)
  await clock.settle()
  await $.command.run({ command: 'lot-map-viewer', args: '9474d2' } as never)
  await clock.advance(3000)

  const ui = await $.ui.mount({ ...VIEWER_PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Watching/ }))?.text).toContain('9474d28e')
  expect(await ui.find({ type: 'Text', text: /Build it/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /b\/c\.py/ })).toBeUndefined()
  await ui.press({ key: 'disconnect' })
  await clock.advance(3000)
  await ui.unmount()
})

viewerTest('an unknown id and the viewer\'s own session connect to nothing, and the pane says why', async ($, on) => {
  const { clock, spawned } = world(on, [], THREE)
  if (!(await started($))) return
  const ui = await $.ui.mount({ ...VIEWER_PANE, surface: 'desktop' })
  for (const [args, said] of [
    ['ffffff', /No session starts with "ffffff"/],
    ['own-session', /the session this viewer runs in/],
  ] as const) {
    const ran = await $.command.run({ command: 'lot-map-viewer', args } as never)
    expect(String((ran as { text?: unknown }).text)).toMatch(said)
    expect((await ui.find({ type: 'Text', text: said }))?.text).toMatch(said)
  }
  await clock.advance(3000)
  expect(spawned).toEqual([])
  await ui.unmount()
})

viewerTest('without an id the pane offers the other sessions, newest first, and a press connects to one', async ($, on) => {
  const { clock } = world(on, [JSON.stringify(call(0, 'tu1', 'Read', { file_path: '/a/b/c.py' }))], THREE)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '{"type":"ai-title","aiTitle":"Fix the map"}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  if (!(await started($))) return
  const ran = await $.command.run({ command: 'lot-map-viewer', args: '' } as never)
  expect(JSON.stringify(ran)).toContain('pick a session')

  const ui = await $.ui.mount({ ...VIEWER_PANE, surface: 'desktop' })
  const offered = await ui.findAll({ type: 'Button' })
  // The viewer's own session is not offered; the newer of the other two comes first.
  expect(offered.map(b => b.key)).toEqual([`pick-${SECOND_ID}`, `pick-${WATCHED_ID}`])
  expect(offered[0]?.text).toContain('Fix the map')

  await ui.press({ key: `pick-${WATCHED_ID}` })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /Watching/ }))?.text).toContain('0bd00807')
  expect(await ui.find({ type: 'Text', text: /b\/c\.py/ })).toBeDefined()
  await ui.press({ key: 'disconnect' })
  await clock.advance(3000)
  await ui.unmount()
})

viewerTest('the header names the project folder without the home folder it sits in', async ($, on) => {
  const folder = '-Users-chris-code-lot-map'
  const tree: Tree = {
    '/h/.claude/projects': [ENTRY(folder, 'dir')],
    [`/h/.claude/projects/${folder}`]: [ENTRY(`${WATCHED_ID}.jsonl`, 'file', BASE)],
  }
  const { clock } = world(on, [], tree)
  if (!(await started($))) return
  await $.command.run({ command: 'lot-map-viewer', args: WATCHED_ID } as never)
  await clock.settle()

  const ui = await $.ui.mount({ ...VIEWER_PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Watching/ }))?.text).toContain('Watching code-lot-map · 0bd00807')
  await ui.press({ key: 'disconnect' })
  await clock.advance(3000)
  await ui.unmount()
})

viewerTest('the files of a subagent are followed too, and its calls start from the Agents station', async ($, on) => {
  const subagent = `/h/.claude/projects/proj/${WATCHED_ID}/subagents/agent-a1.jsonl`
  const tree: Tree = { ...HOME_TREE, [`/h/.claude/projects/proj/${WATCHED_ID}/subagents`]: [ENTRY('agent-a1.jsonl', 'file'), ENTRY('notes.txt', 'file')] }
  const inner = { ...call(0, 'tu9', 'Grep', { pattern: 'x' }), isSidechain: true, agentId: 'a1' }
  const { clock, spawned } = world(on, [JSON.stringify(call(0, 'tu1', 'Read', { file_path: '/a/b/c.py' }))], tree, { [subagent]: [JSON.stringify(inner)] })
  if (!(await started($))) return
  await $.command.run({ command: 'lot-map-viewer', args: WATCHED_ID } as never)
  await clock.advance(3000)

  expect(spawned).toEqual([
    ['tail', '-n', '+1', '-F', WATCHED_FILE],
    ['tail', '-n', '+1', '-F', subagent],
  ])
  const ui = await $.ui.mount({ ...VIEWER_PANE, surface: 'desktop' })
  const svg = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(svg).toContain('Agents')
  await ui.press({ key: 'disconnect' })
  await clock.advance(3000)
  await ui.unmount()
})
