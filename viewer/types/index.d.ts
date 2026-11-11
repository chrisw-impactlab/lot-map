// The shared types are a copy of types/index.d.ts, the rest is viewer/types/contract.tail. Edit those, then run scripts/sync-viewer.sh.
export type StationId =
  | 'you' | 'model' | 'memory' | 'files' | 'shell'
  | 'web' | 'browser' | 'agents' | 'skills' | 'hooks'

export type Status = 'run' | 'ok' | 'err' | 'block'

/** One action on the map. Labels carry names and record numbers, never the text of a memory. */
export type Entry = {
  id: string
  station: StationId
  label: string
  /** Where the pulse starts: the core, the agents station, or the station itself (a signal coming in). */
  from: 'core' | 'agents' | 'inbound'
  startedAt: number
  endedAt?: number
  status: Status
  /** The subagent whose loop made the call; absent for the main loop. */
  agentId?: string
  /** The background task the call started; the row stays open until that task reports back. */
  task?: string
  /** A moment the map marks: the model changed, or the answer is ready. */
  mark?: 'switch' | 'done'
}

export type Board = {
  entries: Entry[]
  counts: Partial<Record<StationId, number>>
  model?: string
  step?: number
  /** How many of the memory station's count a hook brought unasked. */
  pushed?: number
  /** Errors and refusals per station since the person's last message. */
  faults?: Partial<Record<StationId, number>>
  /** Subagents whose loops are still going. */
  agents?: string[]
  /** How full the context window is, 0 to 100. */
  context?: number
  /** When the model last changed. */
  switchedAt?: number
}


/** A session the viewer can watch, as the picker and the header name it. */
export type Watched = {
  id: string
  /** The name of the project folder that holds the session's file. */
  folder: string
  path: string
  mtimeMs: number
  /** The title the session was last given, when it has one. */
  title?: string
}

/** What the pane shows besides the map. */
export type View =
  | { kind: 'idle' }
  | { kind: 'picking'; rows: Watched[] }
  | { kind: 'watching'; row: Watched }
  | { kind: 'problem'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'lot-map-viewer': { board: Shaped<Board>; view: Shaped<View> }
  }
}
