/**
 * Long-running work: the main Session is told of an assignment that has worked an hour without a ready, blocked or failed
 * report (longer than that is not normal), so it looks whether the worker is stuck; a worker that reported, or handed off to a person, gets no more notices.
 */
import { afterEach, expect, it } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const MINUTE = 60_000

it('tells the main Session of an assignment that worked an hour without finishing, again an hour later, and not after it reported', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 整理一下上周群里的讨论'))
  const assignment = h.runtime.store.tickets.get(ticket.id)!.assignments.at(-1)!
  expect(assignment).toMatchObject({ state: 'running', startedAt: expect.any(String) })
  const started = Date.parse(assignment.startedAt!)
  const notices = () => h!.relays(h!.runtime.masterId).filter(item => item.kind === 'worker_long_running')
  // The main Session's notices go out through the effect queue.
  const sweep = async (at: number) => { await h!.runtime.executor.sweep(at); await h!.runtime.idle() }
  await sweep(started + 59 * MINUTE)
  expect(notices()).toEqual([])
  await sweep(started + 60 * MINUTE)
  expect(notices()).toEqual([{ kind: 'worker_long_running', ticket: expect.objectContaining({ ticket_id: ticket.id }), trigger_id: ticket.origin.triggerId,
    minutes: 60, read: `ticket/${ticket.id}/transcript` }])
  await sweep(started + 119 * MINUTE)
  expect(notices()).toHaveLength(1)
  await sweep(started + 120 * MINUTE)
  expect(notices().map(item => item.minutes)).toEqual([60, 120])
  // The worker reported what it ran into: it is no longer working, and the main Session hears of it from the report.
  await h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'FF cannot read the growth chat' })
  await h.runtime.idle()
  await sweep(started + 240 * MINUTE)
  expect(notices()).toHaveLength(2)
  expect(h.relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state: 'blocked' })
})
