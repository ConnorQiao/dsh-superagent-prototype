/** A worker's background work in DSH: waiting for its shell jobs and subagents, and stopping them. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { hasLiveSubagents, releaseSubagentTree, stopSubagents, untilQuiet } from '../src/executor/background.ts'
import { jobRegistry } from './fixtures/host.ts'

/** A context with DSH's job registry and subagents, and an idle worker agent with one live subagent, `child-1`. */
function setup(waitForChildren: (agent: Agent) => Promise<boolean>, drainChildren: () => Promise<void> = async () => {}) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn() } as unknown as
    Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const subagents = { waitForChildren: vi.fn(waitForChildren), listChildren: async () => [{ id: 'child-1' }], drainChildren: vi.fn(drainChildren) }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents }
  const ctx = { get: (name: string) => services[name], agents: { get: () => agent } } as unknown as Context
  return { ctx, agent, jobs, subagents }
}

it('is not quiet when an end during the subagent check woke the worker, whose own idle looks again', async () => {
  const { ctx, agent, jobs } = setup(async () => {
    // The job settles meanwhile, and its end wakes the worker.
    jobs.end(id); (agent as { status: string }).status = 'running'
    return false
  })
  const id = jobs.run('worker-t1')
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(false)
})

it('stops waiting for subagents that never settle once the host stops', async () => {
  let joining!: () => void
  const joined = new Promise<void>(resolve => { joining = resolve })
  const { ctx, agent } = setup(() => { joining(); return new Promise(() => {}) })
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  // The host stops while the wait for its subagents runs.
  await joined
  stop.abort()
  expect(await quiet).toBe(false)
})

it('looks at the jobs only when one ends, not at each output of a noisy one', async () => {
  const { ctx, agent, jobs } = setup(async () => false)
  const id = jobs.run('worker-t1')
  const stop = new AbortController()
  const quiet = untilQuiet(ctx, agent, stop.signal)
  await new Promise(resolve => setTimeout(resolve, 0))
  const looked = jobs.service.list.mock.calls.length
  for (let line = 0; line < 100; line++) jobs.output(id)
  expect(jobs.service.list.mock.calls.length).toBe(looked)
  jobs.end(id)
  expect(await quiet).toBe(true)
})

it('joins a worker\'s subagents once for the looks that wait on them, as DSH cannot cancel the join', async () => {
  const { ctx, agent, subagents } = setup(() => new Promise(() => {}))
  for (let look = 0; look < 3; look++) {
    const stop = new AbortController()
    const quiet = untilQuiet(ctx, agent, stop.signal)
    stop.abort()
    expect(await quiet).toBe(false)
  }
  expect(subagents.waitForChildren).toHaveBeenCalledTimes(1)
})

it('gives up a release of subagents that does not end within 10 seconds, and cancels the turn their ends woke', async () => {
  const { ctx, agent } = setup(async () => false, () => new Promise(() => {}))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let stopped = false
    const stopping = stopSubagents(ctx, agent).then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
  } finally { vi.useRealTimers() }
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
})

/** DSH 0.2.3's subagents and agent registry: `waitForTreeWork`, `interrupt`, `drainDescendants`, and a registry that lists its agents. */
function setup023(waitForTreeWork: (agent: Agent) => Promise<boolean>, children: { id: string; parentSession: string; status: string }[]) {
  const jobs = jobRegistry()
  const agent = { id: 'worker-t1', status: 'idle', whenIdle: async () => {}, inbox: { nextTurn: [], nextStep: [] }, cancel: vi.fn(),
    session: { header: {} } } as unknown as Agent & { status: string; cancel: ReturnType<typeof vi.fn> }
  const live = new Map<string, { status: string } & Record<string, unknown>>(children.map(child => [child.id, { id: child.id, status: child.status,
    inbox: { nextTurn: [], nextStep: [] }, session: { header: { parentSession: child.parentSession } } }]))
  live.set(agent.id, agent as never)
  const subagents = { waitForTreeWork: vi.fn(waitForTreeWork),
    interrupt: vi.fn((id: string) => { const child = live.get(id); if (child) child.status = 'idle' }),
    drainDescendants: vi.fn(async () => { for (const child of children) live.delete(child.id) }) }
  const services: Record<string, unknown> = { jobs: jobs.service, subagents }
  const ctx = { get: (name: string) => services[name], agents: { get: (id: string) => live.get(id), list: () => [...live.values()] } } as unknown as Context
  return { ctx, agent, subagents, live }
}

it('waits for a worker\'s subagents with DSH 0.2.3\'s waitForTreeWork', async () => {
  const { ctx, agent, subagents } = setup023(async () => false, [])
  expect(await untilQuiet(ctx, agent, new AbortController().signal)).toBe(true)
  expect(subagents.waitForTreeWork).toHaveBeenCalledWith(agent)
})

it('on DSH 0.2.3, stops what a worker\'s subagents run without closing its tree, and releases the resident ones before an unload', async () => {
  const { ctx, agent, subagents, live } = setup023(async () => false,
    [{ id: 'child-1', parentSession: 'worker-t1', status: 'running' }, { id: 'grandchild', parentSession: 'child-1', status: 'idle' }])
  // A subagent at work, at any depth, holds the worker; another worker's does not.
  expect(await hasLiveSubagents(ctx, 'worker-t1')).toBe(true)
  expect(await hasLiveSubagents(ctx, 'worker-other')).toBe(false)
  await stopSubagents(ctx, agent)
  expect(subagents.interrupt).toHaveBeenCalledTimes(1)
  expect(subagents.interrupt).toHaveBeenCalledWith('child-1', agent)
  expect(subagents.drainDescendants).not.toHaveBeenCalled()
  expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  // Idle and resident, they hold the worker no more; a stop with nothing at work cancels nothing.
  expect(await hasLiveSubagents(ctx, 'worker-t1')).toBe(false)
  agent.cancel.mockClear()
  await stopSubagents(ctx, agent)
  expect(agent.cancel).not.toHaveBeenCalled()
  // Before the worker unloads, its resident subagents are released.
  await releaseSubagentTree(ctx, agent)
  expect(subagents.drainDescendants).toHaveBeenCalledWith([agent])
  expect(live.has('child-1') || live.has('grandchild')).toBe(false)
  subagents.drainDescendants.mockClear()
  await releaseSubagentTree(ctx, agent)
  expect(subagents.drainDescendants).not.toHaveBeenCalled()
})
