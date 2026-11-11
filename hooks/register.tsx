import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Entry, Status } from '../types'
import { addEntry, clearFaults, closeCoreRuns, closeEntry, endAgent, holdOpen, kept, settleTask } from './board'
import type { Start } from './board'
import { classify, describeNow, drawMap, firstLine, memoryIds, setupFrom, shortModel, taskNotice, taskOf } from './map'
import type { Setup } from './map'
import { feedRows, tallyOf } from './pane'

const PANE = 'lot-map'

// Change the tag when a field of Entry or Board changes: it declines what an earlier version stored.
const board = atom({ plugin: 'lot-map', key: 'board' } as const, { entries: [], counts: {} } as Board, { shape: 'board-3' })

const newId = (now: number): string => `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** Whatever goes wrong on the map must never reach the tool, the turn or the conversation. */
async function quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

async function begin($: EngineInterface, start: Start): Promise<string | undefined> {
  return quietly(async () => {
    const now = await $.clock.now()
    const id = newId(now)
    await update($, board, b => addEntry(b, start, id, now))
    return id
  })
}

async function finish($: EngineInterface, id: string | undefined, status: Status, patch?: Pick<Board, 'context'>): Promise<void> {
  if (id === undefined) return
  await quietly(async () => {
    const now = await $.clock.now()
    await update($, board, b => closeEntry(b, id, status, now, patch))
  })
}

/** The call started work that goes on after it answered: its row stays open under the task's id. */
async function background($: EngineInterface, id: string | undefined, task: string): Promise<void> {
  if (id === undefined) return
  await quietly(() => update($, board, b => holdOpen(b, id, task)))
}

/** A background task ended: its row closes, as a fault when the task failed. */
async function settle($: EngineInterface, task: string, status: Status): Promise<void> {
  await quietly(async () => {
    const now = await $.clock.now()
    await update($, board, b => settleTask(b, task, status, now))
  })
}

/** How full the context window is, as the status line has it; costs nothing. */
async function contextOf($: EngineInterface): Promise<Pick<Board, 'context'>> {
  const percent = await quietly(async () => (await $.session.usage()).context.percent)
  return typeof percent === 'number' ? { context: percent } : {}
}

/** What a settings hook added to the context: shown as the hook acting and, when it brought records, as memory. */
async function noteContext($: EngineInterface, context: readonly string[] | undefined, when: string, setup: Setup): Promise<void> {
  const { t } = setup
  const text = (context ?? []).join('\n')
  if (text.trim() === '') return
  const ids = setup.hookRecords ? memoryIds(text) : []
  if (ids.length === 0) {
    await begin($, { station: 'hooks', label: t.addedContext(when), status: 'ok' })
    return
  }
  await begin($, { station: 'hooks', label: t.addedMemory(when), status: 'ok' })
  const shown = ids.slice(0, 6).map(id => `#${id}`).join(' ')
  await begin($, {
    station: 'memory',
    label: t.records(ids.length, `${shown}${ids.length > 6 ? ' …' : ''}`),
    from: 'inbound',
    status: 'ok',
  })
}

export const register: Register = (on, options) => {
  const setup = setupFrom(options)
  const { t } = setup

  // Calls a settings hook refused, so that the tool's own row reads as blocked and not as an error.
  // Loses nothing across a reload that matters: a reload never lands in the middle of a call.
  const refused = new Set<string>()

  // The model the main loop last ran on: in this session, or else in the last session in this folder.
  // The one thing the map keeps between sessions, and only its name.
  let lastModel: string | undefined
  let modelKey = 'model'

  on('session.start', async ($, e, next) => {
    await quietly(() => $.command.register({ name: 'lot-map', description: t.command }))
    void quietly(() => $.ui.open({ id: PANE, title: t.title }))
    await quietly(async () => {
      modelKey = `model:${e.cwd}`
      const kept = await $.store.get(modelKey)
      if (lastModel === undefined && typeof kept === 'string') lastModel = kept
    })
    return next(e)
  })

  on('command.run', { command: 'lot-map' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: t.title })
    return { text: opened.isPlaced ? t.opened : t.cannotOpen(String(opened.reason)) }
  })

  on('turn.start', async ($, e, next) => {
    const notice = e.agentId === undefined ? taskNotice(e.text) : undefined
    if (notice !== undefined) {
      // A background task reporting back is no message of the person's.
      if (notice.status !== undefined) await settle($, notice.id, notice.status)
    } else if (e.agentId === undefined && e.text !== '') {
      // A new message clears what went wrong on the way to the last answer.
      await quietly(() => update($, board, clearFaults))
      await begin($, { station: 'you', label: t.newMessage, from: 'inbound', status: 'ok' })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain && lastModel !== e.model) {
      const before = lastModel
      lastModel = e.model
      void quietly(() => $.store.set(modelKey, e.model))
      if (before !== undefined) {
        const now = await quietly(() => $.clock.now())
        await begin($, {
          station: 'model',
          label: `${shortModel(before)} → ${shortModel(e.model)}`,
          status: 'ok',
          mark: 'switch',
          uncounted: true,
          ...(now !== undefined ? { patch: { switchedAt: now } } : {}),
        })
      }
    }
    const id = await begin($, {
      station: 'model',
      label: `${shortModel(e.model)} · ${t.step(e.index + 1)}${isMain ? '' : ` · ${t.subagent}`}`,
      from: isMain ? 'core' : 'agents',
      ...(isMain ? { patch: { model: e.model, step: e.index + 1 } } : { agentId: e.agentId }),
    })
    try {
      return yield* next(e)
    } finally {
      await finish($, id, 'ok', isMain ? await contextOf($) : undefined)
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await quietly(async () => {
        const now = await $.clock.now()
        await update($, board, b => endAgent(b, agentId, now))
      })
    } else {
      await begin($, {
        station: 'you',
        label: e.isAborted ? t.turnAborted : t.answerReady,
        status: e.isAborted ? 'err' : 'ok',
        ...(e.isAborted ? {} : { mark: 'done' as const }),
      })
      // An interrupted call never reports back; left alone its row would pulse for the rest of the session.
      await quietly(async () => {
        const now = await $.clock.now()
        await update($, board, b => closeCoreRuns(b, now))
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = await quietly(async () => {
      const seen = classify(e.tool, e as unknown as Record<string, unknown>, setup)
      return begin($, { ...seen, ...(e.agentId === undefined ? { from: 'core' as const } : { from: 'agents' as const, agentId: e.agentId }) })
    })
    try {
      const ran = await next(e)
      const wasRefused = ran.deny !== undefined || (e.tool_use_id !== undefined && refused.delete(e.tool_use_id))
      const task = wasRefused || ran.isError === true ? undefined : taskOf(ran.result)
      if (task !== undefined) {
        await background($, id, task)
        return ran
      }
      await finish($, id, wasRefused ? 'block' : ran.isError === true ? 'err' : 'ok')
      return ran
    } catch (failure) {
      await finish($, id, 'err')
      throw failure
    }
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const startedAt = (await quietly(() => $.clock.now())) ?? 0
    const decided = await next(e)
    const endedAt = (await quietly(() => $.clock.now())) ?? startedAt
    if (decided.deny !== undefined) {
      if (e.tool_use_id !== undefined) refused.add(e.tool_use_id)
      await begin($, { station: 'hooks', label: (setup.hookReasons ? firstLine(decided.deny) : '') || t.stopped(e.tool), status: 'block', startedAt })
    } else if (decided.ask !== undefined) {
      await begin($, { station: 'hooks', label: t.askedPermission(e.tool), status: 'ok', startedAt, endedAt })
    } else if (endedAt - startedAt >= 400) {
      // A check that took a moment is worth seeing; the instant ones are not.
      await begin($, { station: 'hooks', label: t.checkBefore(e.tool), status: 'ok', startedAt, endedAt })
    }
    return decided
  })

  // A notification delivered into a running turn starts no turn of its own; this is where it is seen.
  on('prompt.submit', async ($, e, next) => {
    await quietly(async () => {
      if (e.origin?.kind !== 'task-notification') return
      const notice = taskNotice(e.text)
      if (notice?.status !== undefined) await settle($, notice.id, notice.status)
    })
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.toMessage, setup)
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.atStart, setup)
    return result
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    // A skill the model called is already on the map as its tool call; this one catches a typed slash command.
    await quietly(async () => {
      const now = await $.clock.now()
      await update($, board, b => {
        if (b.entries.some(x => x.station === 'skills' && x.status === 'run' && x.label === e.skill)) return b
        const entry: Entry = { id: newId(now), station: 'skills', label: e.skill, from: 'core', startedAt: now, endedAt: now, status: 'ok' }
        return { ...b, entries: kept([...b.entries, entry]), counts: { ...b.counts, skills: (b.counts.skills ?? 0) + 1 } }
      })
    })
    return result
  })

  on('session.compact', async ($, e, next) => {
    const id = await begin($, { station: 'model', label: t.compacting })
    try {
      return await next(e)
    } finally {
      await finish($, id, 'ok', await contextOf($))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, board)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const rows = feedRows(state, t).map(row => (
      <Text mono size="footnote" color={row.color} dimColor={row.isDim}>
        {row.text}
      </Text>
    ))
    const feed = rows.length > 0 ? rows : [<Text dimColor>{t.nothingYet}</Text>]
    const current = <Text mono size="footnote">{describeNow(state, t)}</Text>

    if (e.surface === 'terminal') {
      const tally = tallyOf(state, t)
      return (
        <Box flexDirection="column">
          {current}
          <Text dimColor>{tally === '' ? t.noCounts : tally}</Text>
          {feed}
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Svg source={drawMap(state, now, setup)} alt={`${t.title}. ${describeNow(state, t)}`} />
        {current}
        {feed}
      </Box>
    )
  })
}
