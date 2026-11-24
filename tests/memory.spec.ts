/**
 * What stays in memory: worker Sessions are unloaded once they sat idle with nothing to do, and the main Session moves to a new
 * one that starts from its summary after its context was compacted, so neither keeps every event it ever had loaded.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { KV } from '../src/kv.ts'
import { carriedContext, nextMasterId } from '../src/app/runtime.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const MINUTE = 60_000
/** The fake agent of `sessionId` ends its turn, as DSH says; DSH's inbox no longer holds what its steps took, the fake's does. */
function idle(host: Host, sessionId: string): void {
  const agent = host.agents.get(sessionId)!
  agent.inbox.nextTurn.length = 0; agent.inbox.nextStep.length = 0
  agent.status = 'idle'
  host.ctx.emit('agent/status', { agent, status: 'idle' } as never)
}
/** The Session object of a fake agent, which DSH's session events carry. */
const sessionOf = (host: Host, sessionId: string) => (host.agents.get(sessionId) as unknown as { session: object }).session
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

it('unloads a worker Session that sat idle with nothing to do, and loads it again for its ticket\'s next message', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 查一下回归'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'found it' })
  idle(h, sessionId)
  await h.runtime.idle(); await settle()
  expect(h.runtime.store.tickets.get(ticket.id)!.ended).toMatchObject({ outcome: 'completed' })
  const at = Date.now()
  await h.runtime.executor.sweep(at + 9 * MINUTE)
  expect(h.controller.releaseAgent).not.toHaveBeenCalled()
  await h.runtime.executor.sweep(at + 11 * MINUTE)
  expect(h.controller.releaseAgent).toHaveBeenCalledWith(sessionId)
  expect(h.agents.has(sessionId)).toBe(false)
  expect((await h.api('GET', 'state')).body).toMatchObject({ load: { loaded: 0 }, replacedMasters: 0 })
  // A person's message on its thread resumes the ticket, whose Session loads again for it.
  h.deliveries.mockClear()
  h.runtime.receive(feishu('2', '再确认一下', { mentions: [], root_id: 'om_1' }))
  await h.runtime.idle(); await settle()
  expect(h.agents.has(sessionId)).toBe(true)
  expect(h.deliveries.mock.calls.some(([call]) => call.sessionId === sessionId && call.text.includes('再确认一下'))).toBe(true)
})

it('keeps a worker Session loaded while its shell job runs, or a message waits for it', async () => {
  h = await startRuntime()
  const { sessionId } = await h.acceptedTicket(feishu('1', '@bot 跑一下导出'))
  idle(h, sessionId)
  await h.runtime.idle(); await settle()
  const job = h.jobs.run(sessionId, 'export')
  const at = Date.now() + 11 * MINUTE
  await h.runtime.executor.sweep(at)
  expect(h.controller.releaseAgent).not.toHaveBeenCalled()
  // The job's end wakes the worker, whose turn then ends: it is idle again from then on.
  h.jobs.end(job)
  await settle()
  idle(h, sessionId)
  await settle()
  const later = Date.now() + 11 * MINUTE
  // A message that waits in its inbox holds it too.
  h.agents.get(sessionId)!.inbox.nextStep.push({ id: 'waiting' } as never)
  await h.runtime.executor.sweep(later)
  expect(h.controller.releaseAgent).not.toHaveBeenCalled()
  h.agents.get(sessionId)!.inbox.nextStep.length = 0
  await h.runtime.executor.sweep(later)
  expect(h.controller.releaseAgent).toHaveBeenCalledWith(sessionId)
})

it('moves the main Session to a new one that starts from its summary once its context was compacted and it is idle', async () => {
  h = await startRuntime()
  const from = h.runtime.masterId
  // A candidate the main Session was shown and did not decide.
  const pending = feishu('1', '@bot 看一下这个')
  h.runtime.receive(pending)
  await h.runtime.idle()
  expect(h.candidates()).toEqual([pending.id])
  h.ctx.emit('session/event', sessionOf(h, from) as never, { type: 'compaction/summary', data: { summary: 'Alice asked about the release.' } } as never)
  h.ctx.emit('session/event', sessionOf(h, from) as never, { type: 'compaction/end', data: {} } as never)
  // It moves only once its turn ended.
  await settle()
  expect(h.runtime.masterId).toBe(from)
  idle(h, from)
  const to = `${from}-r1`
  await vi.waitFor(() => { expect(h!.runtime.masterId).toBe(to) })
  await vi.waitFor(() => { expect(h!.controller.releaseAgent).toHaveBeenCalledWith(from) })
  await h.runtime.idle()
  expect(h.runtime.store.get(KV.runtime.masterId)).toBe(to)
  expect(h.runtime.previousMasters()).toEqual([from])
  expect((await h.api('GET', 'state')).body).toMatchObject({ masterId: to, replacedMasters: 1 })
  expect(h.agents.has(from)).toBe(false)
  // The new main Session has the main Session's tools, the summary as a notice that woke nothing, and the undecided candidate.
  expect(h.tools.get(to)?.has('orchestrator_route')).toBe(true)
  expect(h.agents.get(to)!.inject).toHaveBeenCalledWith(expect.objectContaining({
    content: [expect.objectContaining({ text: carriedContext('Alice asked about the release.') })] }))
  expect(h.candidates()).toEqual([pending.id])
  // Its routing works as before.
  expect(await h.route({ kind: 'ignore', trigger_id: pending.id, reason: 'nothing asked' })).toMatchObject({ decision: 'ignore' })
  // A DSH scheduled task that names the old main Session reaches the new one.
  const resolved = await (h.ctx as unknown as { waterfall(name: string, id: string, next: () => Promise<unknown>): Promise<unknown> })
    .waterfall('schedule/resolve-agent', from, async () => { throw new Error('not redirected') })
  expect(resolved).toBe(h.agents.get(to))
})

it('does not move the main Session for a compaction that failed', async () => {
  h = await startRuntime()
  const from = h.runtime.masterId
  h.ctx.emit('session/event', sessionOf(h, from) as never, { type: 'compaction/summary', data: { summary: 'partial' } } as never)
  h.ctx.emit('session/event', sessionOf(h, from) as never, { type: 'compaction/end', data: { error: 'overflow' } } as never)
  idle(h, from)
  await settle()
  expect(h.runtime.masterId).toBe(from)
  expect(h.controller.releaseAgent).not.toHaveBeenCalled()
})

it('numbers the main Sessions that follow one another', () => {
  expect(nextMasterId('orchestrator-abc')).toBe('orchestrator-abc-r1')
  expect(nextMasterId('orchestrator-abc-r1')).toBe('orchestrator-abc-r2')
  expect(nextMasterId('orchestrator-abc-g1')).toBe('orchestrator-abc-g1-r1')
})

it('lets the main Session reach a ticket whose worker Session was unloaded: what it sends loads it again, and reading its work does not', async () => {
  h = await startRuntime()
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot 查一下回归'))
  const master = h.runtime.masterId
  /** The worker ends its turn without a report, which makes the ticket wait, and its Session is unloaded once idle long enough. */
  const unloadIdle = async () => {
    idle(h!, sessionId)
    await h!.runtime.idle(); await settle()
    await h!.runtime.executor.sweep(Date.now() + 11 * MINUTE)
    expect(h!.agents.has(sessionId)).toBe(false)
    h!.deliveries.mockClear()
  }
  const delivered = (text: string) => h!.deliveries.mock.calls.some(([call]) => call.sessionId === sessionId && call.text.includes(text))
  await unloadIdle()
  // Reading its transcript reads the stored history and loads nothing.
  await h.runTool(master, 'orchestrator_read', { resource: `ticket/${ticket.id}/transcript` })
  expect(h.agents.has(sessionId)).toBe(false)
  // A note from the main Session reaches it, and loads it again.
  await h.runTool(master, 'orchestrator_ticket_note', { ticket_id: ticket.id, text: '另一张工单查到版本号是 1.2.3' })
  await h.runtime.idle(); await settle()
  expect(h.agents.has(sessionId)).toBe(true)
  expect(delivered('另一张工单查到版本号是 1.2.3')).toBe(true)
  // So does a status request to a waiting worker.
  await unloadIdle()
  expect(await h.runTool(master, 'orchestrator_ticket_request_status', { ticket_id: ticket.id })).toMatchObject({ reason: 'Asked the worker for a status report' })
  await h.runtime.idle(); await settle()
  expect(h.agents.has(sessionId)).toBe(true)
  // And a message from another thread that the main Session attaches to it.
  await unloadIdle()
  const pointing = feishu('7', '@bot 刚才那个回归查到哪一步了')
  h.runtime.receive(pointing)
  await h.runtime.idle()
  await h.route({ kind: 'attach', trigger_id: pointing.id, ticket_id: ticket.id })
  await h.runtime.idle(); await settle()
  expect(h.agents.has(sessionId)).toBe(true)
  expect(delivered('刚才那个回归查到哪一步了')).toBe(true)
})
