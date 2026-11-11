// What the viewer reads: one record of a session's transcript file becomes a change of the board.
// Nothing here touches the engine or a file.
import type { Board } from '../types'
import { addEntry, clearFaults, closeCoreRuns, closeEntry, endAgent, holdOpen, settleTask } from './board'
import { classify, shortModel, taskNotice, taskOf } from './map'
import type { Setup } from './map'

/** One line of a transcript file, parsed. Only the fields named in this file are read. */
export type TranscriptRecord = Readonly<Record<string, unknown>>

export type Reading = {
  board: Board
  /** The latest model step of each loop: the key is the agent's id, or empty for the main loop. */
  steps: Readonly<Record<string, { id: string; requestId: string; index: number }>>
  /** The model the main loop last ran on. */
  model?: string
  /**
   * The agents whose end has been read. Their own files are followed at the same time as the main file, so their records can be
   * read after the record that ended them: those still count, and leave nothing running.
   */
  ended: Readonly<Record<string, true>>
}

export const startReading = (): Reading => ({ board: { entries: [], counts: {} }, steps: {}, ended: {} })

/** The key of the main loop in `Reading.steps`. */
const MAIN = ''

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The content blocks of a record's message. A message whose content is a plain string has none. */
function blocksOf(record: TranscriptRecord): readonly Readonly<Record<string, unknown>>[] {
  const content = isObject(record.message) ? record.message.content : undefined
  return Array.isArray(content) ? content.filter(isObject) : []
}

/** The text of a message: its string, or its text blocks. */
function textOf(record: TranscriptRecord): string {
  const content = isObject(record.message) ? record.message.content : undefined
  if (typeof content === 'string') return content
  return blocksOf(record)
    .filter(block => block.type === 'text')
    .map(block => str(block.text))
    .join('\n')
}

/** The loop a record belongs to: the key of a subagent's own, or of the main loop. */
const loopOf = (record: TranscriptRecord): string => (record.isSidechain === true ? str(record.agentId) : MAIN)

/** Every tool call in an assistant record starts a row under the call's own id. A subagent's call starts from the Agents station. */
function withCalls(board: Board, record: TranscriptRecord, now: number, setup: Setup, loop: string): Board {
  const own = loop === MAIN ? { from: 'core' as const } : { from: 'agents' as const, agentId: loop }
  return blocksOf(record).reduce((b, block) => {
    const id = str(block.id)
    if (block.type !== 'tool_use' || id === '') return b
    const seen = classify(str(block.name), isObject(block.input) ? block.input : {}, setup)
    return addEntry(b, { ...seen, ...own }, id, now)
  }, board)
}

/**
 * A request the model answered: the step before it in the same loop ends, and the request opens the next step.
 * In the main loop a change of model also gets a row, and the board shows the model and the step number.
 */
function withStep(reading: Reading, loop: string, requestId: string, model: string, now: number, setup: Setup): Reading {
  const before = reading.steps[loop]
  if (before?.requestId === requestId) return reading
  const isMain = loop === MAIN
  let board = before === undefined ? reading.board : closeEntry(reading.board, before.id, 'ok', now)
  if (isMain && reading.model !== undefined && reading.model !== model) {
    const label = `${shortModel(reading.model)} → ${shortModel(model)}`
    board = addEntry(board, { station: 'model', label, status: 'ok', mark: 'switch', uncounted: true, patch: { switchedAt: now } }, `switch:${requestId}`, now)
  }
  const index = (before?.index ?? 0) + 1
  const id = `step:${requestId}`
  const label = `${shortModel(model)} · ${setup.t.step(index)}${isMain ? '' : ` · ${setup.t.subagent}`}`
  board = addEntry(board, isMain ? { station: 'model', label, patch: { model, step: index } } : { station: 'model', label, from: 'agents', agentId: loop }, id, now)
  return { ...reading, board, steps: { ...reading.steps, [loop]: { id, requestId, index } }, model: isMain ? model : reading.model }
}

/** An assistant record: its request is a step, and each tool call in it starts a row. The first call ends the step. */
function ofAssistant(reading: Reading, record: TranscriptRecord, now: number, setup: Setup): Reading {
  const message = isObject(record.message) ? record.message : {}
  const loop = loopOf(record)
  const requestId = str(record.requestId)
  const model = str(message.model)
  const isStep = requestId !== '' && model !== '' && model !== '<synthetic>'
  const stepped = isStep ? withStep(reading, loop, requestId, model, now, setup) : reading
  let board = withCalls(stepped.board, record, now, setup, loop)
  const open = stepped.steps[loop]
  if (isStep && open?.requestId === requestId && blocksOf(record).some(block => block.type === 'tool_use')) {
    board = closeEntry(board, open.id, 'ok', now)
  }
  // A subagent that ended is read late: what it did counts, and nothing of it is left running.
  return { ...stepped, board: loop !== MAIN && stepped.ended[loop] === true ? endAgent(board, loop, now) : board }
}

/**
 * An agent's end: it leaves the Agents station, a call of its that never reported back ends, and its records read later leave nothing running.
 * `board` is the reading's board after the change that ended it.
 */
const withEnd = (reading: Reading, board: Board, agent: string, now: number): Reading => ({
  ...reading,
  board: endAgent(board, agent, now),
  ended: { ...reading.ended, [agent]: true },
})

/**
 * A result closes the row of its call, or keeps it open when the call started a background task.
 * A result that names an agent ends that agent, which is how a subagent that answered at once leaves the Agents station.
 */
function withResults(reading: Reading, record: TranscriptRecord, now: number): Reading {
  const agent = isObject(record.toolUseResult) ? str(record.toolUseResult.agentId) : ''
  return blocksOf(record).reduce((r, block) => {
    const id = str(block.tool_use_id)
    if (block.type !== 'tool_result' || id === '') return r
    const isError = block.is_error === true
    const task = isError ? undefined : taskOf(record.toolUseResult)
    if (task !== undefined) return { ...r, board: holdOpen(r.board, id, task) }
    const closed = closeEntry(r.board, id, isError ? 'err' : 'ok', now)
    return agent === '' ? { ...r, board: closed } : withEnd(r, closed, agent, now)
  }, reading)
}

const isHuman = (record: TranscriptRecord): boolean => isObject(record.origin) && record.origin.kind === 'human'

/**
 * The reading after a background task's notification, or nothing when the text is no notification.
 * The task's row closes, and a task that was an agent ends with it.
 * A notification with no ending in it is a monitor's event: the task goes on.
 */
function afterNotice(reading: Reading, text: string, now: number): Reading | undefined {
  const notice = taskNotice(text)
  if (notice === undefined) return undefined
  return notice.status === undefined ? reading : withEnd(reading, settleTask(reading.board, notice.id, notice.status, now), notice.id, now)
}

/**
 * A user record: a background task's notification, a message of the person, or the results of calls.
 * A message starts a turn: what went wrong before it is cleared, and the model's steps count from one again.
 */
function ofUser(reading: Reading, record: TranscriptRecord, now: number, setup: Setup): Reading {
  const noticed = afterNotice(reading, textOf(record), now)
  if (noticed !== undefined) return noticed
  if (!isHuman(record)) return withResults(reading, record, now)
  const before = reading.steps[MAIN]
  const settled = before === undefined ? reading.board : closeEntry(reading.board, before.id, 'ok', now)
  const board = addEntry(clearFaults(settled), { station: 'you', label: setup.t.newMessage, from: 'inbound', status: 'ok' }, `you:${now}`, now)
  return { ...reading, board, steps: Object.fromEntries(Object.entries(reading.steps).filter(([key]) => key !== MAIN)) }
}

/** The end of a turn is an answer; a compaction is a row on Model. */
function ofSystem(board: Board, record: TranscriptRecord, now: number, setup: Setup): Board {
  switch (record.subtype) {
    case 'turn_duration':
      return closeCoreRuns(addEntry(board, { station: 'you', label: setup.t.answerReady, status: 'ok', mark: 'done' }, `answer:${now}`, now), now)
    case 'compact_boundary':
      return addEntry(board, { station: 'model', label: setup.t.compacting, status: 'ok' }, `compact:${now}`, now)
    default:
      return board
  }
}

/**
 * An attachment: a notification that was delivered into a running turn, or context that a settings hook added to a message
 * or to the start of the session, for which the row says when and never what.
 */
function ofAttachment(reading: Reading, record: TranscriptRecord, now: number, setup: Setup): Reading {
  const attachment = isObject(record.attachment) ? record.attachment : {}
  if (attachment.type === 'queued_command') return afterNotice(reading, str(attachment.prompt), now) ?? reading
  const when = attachment.hookEvent === 'SessionStart' ? setup.t.atStart : attachment.hookEvent === 'UserPromptSubmit' ? setup.t.toMessage : undefined
  const content = attachment.content
  const text = Array.isArray(content) ? content.map(str).join('\n') : str(content)
  if (attachment.type !== 'hook_additional_context' || when === undefined || text.trim() === '') return reading
  return { ...reading, board: addEntry(reading.board, { station: 'hooks', label: setup.t.addedContext(when), status: 'ok' }, `hook:${now}:${str(attachment.hookName)}`, now) }
}

export function applyRecord(reading: Reading, record: TranscriptRecord, setup: Setup): Reading {
  const now = Date.parse(str(record.timestamp))
  if (Number.isNaN(now)) return reading
  switch (record.type) {
    case 'assistant':
      return ofAssistant(reading, record, now, setup)
    case 'user':
      return ofUser(reading, record, now, setup)
    case 'system':
      return { ...reading, board: ofSystem(reading.board, record, now, setup) }
    case 'attachment':
      return ofAttachment(reading, record, now, setup)
    case 'queue-operation':
      // A notification that was queued while a turn ran. Only the line that queues it counts: the line that removes it says nothing new.
      return record.operation === 'enqueue' ? (afterNotice(reading, str(record.content), now) ?? reading) : reading
    default:
      return reading
  }
}
