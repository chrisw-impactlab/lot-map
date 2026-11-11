// How the board changes: each function takes a board and returns the next one.
// Nothing here touches the engine, so the live mod and the viewer share it.
import type { Board, Entry, StationId, Status } from '../types'
import { clean } from './map'

export const KEEP = 80
export const CREW = 12

export type Start = {
  station: StationId
  label: string
  from?: Entry['from']
  status?: Status
  agentId?: string
  mark?: Entry['mark']
  /** Adds nothing to the station's count: a second view of something already counted. */
  uncounted?: boolean
  startedAt?: number
  endedAt?: number
  patch?: Partial<Pick<Board, 'model' | 'step' | 'switchedAt'>>
}

/** The newest rows, and beside them every background task still going, however long ago it started. */
export const kept = (entries: Entry[]): Entry[] => {
  const from = entries.length - KEEP
  return from <= 0 ? entries : entries.filter((e, i) => i >= from || (e.status === 'run' && e.task !== undefined))
}

const isFault = (status: Status): boolean => status === 'err' || status === 'block'

const oneMore = (faults: Board['faults'], station: StationId): Board['faults'] => ({ ...faults, [station]: (faults?.[station] ?? 0) + 1 })

/** A new row at the end of the board, with the counts, faults and crew it changes. */
export function addEntry(b: Board, start: Start, id: string, now: number): Board {
  const entry: Entry = {
    id,
    station: start.station,
    label: clean(start.label),
    from: start.from ?? 'core',
    startedAt: start.startedAt ?? now,
    status: start.status ?? 'run',
    ...(start.status !== undefined ? { endedAt: start.endedAt ?? now } : {}),
    ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
    ...(start.mark !== undefined ? { mark: start.mark } : {}),
  }
  return {
    ...b,
    ...start.patch,
    entries: kept([...b.entries, entry]),
    counts: start.uncounted ? b.counts : { ...b.counts, [entry.station]: (b.counts[entry.station] ?? 0) + 1 },
    // What a hook brought to memory unasked is counted apart from what was asked for.
    ...(entry.station === 'memory' && entry.from === 'inbound' && !start.uncounted ? { pushed: (b.pushed ?? 0) + 1 } : {}),
    // An interrupted turn lands on the person's own station and is no fault of anything.
    ...(isFault(entry.status) && entry.station !== 'you' ? { faults: oneMore(b.faults, entry.station) } : {}),
    ...(entry.agentId !== undefined && !(b.agents ?? []).includes(entry.agentId)
      ? { agents: [...(b.agents ?? []), entry.agentId].slice(-CREW) }
      : {}),
  }
}

/** A running row ends, as a fault when `status` says so. */
export function closeEntry(b: Board, id: string, status: Status, now: number, patch?: Pick<Board, 'context'>): Board {
  const open = b.entries.find(e => e.id === id && e.status === 'run')
  return {
    ...b,
    ...patch,
    entries: b.entries.map(e => (e === open ? { ...e, status, endedAt: now } : e)),
    ...(open !== undefined && isFault(status) ? { faults: oneMore(b.faults, open.station) } : {}),
  }
}

/** The call started work that goes on after it answered: its row stays open under the task's id. */
export const holdOpen = (b: Board, id: string, task: string): Board => ({
  ...b,
  entries: b.entries.map(e => (e.id === id && e.status === 'run' ? { ...e, task } : e)),
})

/** A background task ended: its row closes, as a fault when the task failed. */
export function settleTask(b: Board, task: string, status: Status, now: number): Board {
  const open = b.entries.find(e => e.task === task && e.status === 'run')
  if (open === undefined) return b
  return {
    ...b,
    entries: b.entries.map(e => (e === open ? { ...e, status, endedAt: now } : e)),
    ...(isFault(status) ? { faults: oneMore(b.faults, open.station) } : {}),
  }
}

/** A new message clears what went wrong on the way to the last answer. */
export const clearFaults = (b: Board): Board => (b.faults === undefined ? b : { ...b, faults: {} })

/** A subagent's loop is over: it leaves the agents station, and a call of its that never reported back is settled. */
export const endAgent = (b: Board, agentId: string, now: number): Board => ({
  ...b,
  agents: (b.agents ?? []).filter(id => id !== agentId),
  entries: b.entries.map(x => (x.status === 'run' && (x.agentId === agentId || x.task === agentId) ? { ...x, status: 'ok' as const, endedAt: now } : x)),
})

/** The main loop's answer is in: a call of its that never reported back ends, except one that started a background task. */
export const closeCoreRuns = (b: Board, now: number): Board => ({
  ...b,
  entries: b.entries.map(x => (x.status === 'run' && x.from === 'core' && x.task === undefined ? { ...x, status: 'ok' as const, endedAt: now } : x)),
})
