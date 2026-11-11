// What the pane says in words: the feed of rows and the tally. The drawing of the map itself is in map.ts.
// Nothing here touches the engine, so the live mod and the viewer share it.
import type { Board } from '../types'
import { STATIONS, foldRows, formatMs } from './map'
import type { Strings } from './text'

export type FeedRow = {
  text: string
  /** A theme key, so that the row reads on a light theme as well as on a dark one. */
  color: 'claude' | 'error' | undefined
  isDim: boolean
}

/** The newest rows of the feed, one line each. The second column fits the longest station name of the language. */
export function feedRows(board: Board, t: Strings): FeedRow[] {
  const column = Math.max(8, ...Object.values(t.stations).map(name => name.length))
  return foldRows(board.entries).map(({ entry, times, tookMs }) => {
    const isSwitch = entry.mark === 'switch'
    const mark = isSwitch ? '◆' : entry.status === 'run' ? '●' : entry.status === 'ok' ? '·' : '✕'
    const took = entry.endedAt === undefined ? t.running : tookMs > 0 ? formatMs(tookMs, t) : ''
    return {
      text: `${mark} ${t.stations[entry.station].padEnd(column)} ${entry.label}${times > 1 ? `  +${times - 1}` : ''}${took === '' ? '' : `  ${took}`}`,
      color: isSwitch || entry.status === 'run' ? 'claude' : entry.status === 'ok' ? undefined : 'error',
      isDim: entry.status === 'ok' && !isSwitch,
    }
  })
}

/** How many calls each station had, in one line, for a surface that draws no map. */
export const tallyOf = (board: Board, t: Strings): string =>
  STATIONS.filter(s => (board.counts[s.id] ?? 0) > 0)
    .map(s => `${t.stations[s.id]} ${board.counts[s.id]}`)
    .join(' · ')
