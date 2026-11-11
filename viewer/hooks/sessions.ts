// Which sessions the viewer can connect to: the transcript files that Claude Code keeps for each session.
import { clean } from './map'

export type Session = {
  id: string
  /** The name of the project folder that holds the session's file. */
  folder: string
  path: string
  mtimeMs: number
}

export type Found = { kind: 'found'; session: Session } | { kind: 'none' } | { kind: 'ambiguous'; count: number }

/** The shortest start of an id that connects. A whole id is 36 characters, so a short start is a typing slip. */
export const MIN_PREFIX = 6

/** The session whose id is `query`, or the only one whose id starts with it. */
export function findSession(sessions: readonly Session[], query: string): Found {
  const start = query.trim().toLowerCase()
  const whole = sessions.find(session => session.id === start)
  if (whole !== undefined) return { kind: 'found', session: whole }
  if (start.length < MIN_PREFIX) return { kind: 'none' }
  const matches = sessions.filter(session => session.id.startsWith(start))
  const [only] = matches
  if (only !== undefined && matches.length === 1) return { kind: 'found', session: only }
  return matches.length === 0 ? { kind: 'none' } : { kind: 'ambiguous', count: matches.length }
}

/** The newest sessions, newest first, without `own`: the session the viewer runs in is not worth watching. */
export function recentSessions(sessions: readonly Session[], own: string, limit = 10): Session[] {
  return sessions
    .filter(session => session.id !== own)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
}

/** Claude Code's configuration folder, from the two variables that decide it: the one it is named by, or else `~/.claude`. */
export function configDirFrom(named: string | undefined, home: string | undefined): string | undefined {
  if (named !== undefined && named !== '') return named
  return home === undefined || home === '' ? undefined : `${home}/.claude`
}

const quietly = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await work()
  } catch {
    return undefined
  }
}

/** Lists a folder. The engine's `$.fs.list` is one; a test gives its own. */
export type List = (path: string) => Promise<readonly { name: string; kind: string; mtimeMs: number }[]>

/** Every session file in every project folder of the configuration folder. A folder that cannot be listed adds none. */
export async function loadSessions(list: List, config: string): Promise<Session[]> {
  const projects = `${config}/projects`
  const folders = ((await quietly(() => list(projects))) ?? []).filter(entry => entry.kind === 'dir')
  const found = await Promise.all(
    folders.map(async folder => {
      const dir = `${projects}/${folder.name}`
      const files = (await quietly(() => list(dir))) ?? []
      return files
        .filter(file => file.kind === 'file' && file.name.endsWith('.jsonl'))
        .map(file => ({ id: file.name.slice(0, -'.jsonl'.length), folder: folder.name, path: `${dir}/${file.name}`, mtimeMs: file.mtimeMs }))
    }),
  )
  return found.flat()
}

/** Runs a command by its argument vector. The engine's `$.process.run` is one; a test gives its own. */
export type Run = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string }>

/** The title the session was last given, if it has one: the newest `ai-title` record of its file. */
export async function titleOf(run: Run, path: string): Promise<string | undefined> {
  const ran = await quietly(() => run(['grep', '-a', '-h', '"type":"ai-title"', path]))
  if (ran === undefined || ran.exitCode !== 0) return undefined
  for (const line of ran.stdout.split('\n').reverse()) {
    const title = await quietly(async () => (JSON.parse(line) as { aiTitle?: unknown }).aiTitle)
    if (typeof title === 'string' && title.trim() !== '') return clean(title, 60)
  }
  return undefined
}
