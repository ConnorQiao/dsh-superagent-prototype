/** Tool modules named in `toolModules`: loading, the tools each ticket gets, and whose message a tool may act for. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Thread, Ticket, Trigger } from '../src/core/index.ts'
import { extensionTools, loadToolModules, mainExtensionTools, mainSchedules, type MainToolContext, type WorkerToolContext, type WorkerToolModule }
  from '../src/app/tools/extensions.ts'

const dir = mkdtempSync(join(tmpdir(), 'dsh-superagent-tools-'))
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const trigger = (id: string, fields: Partial<Trigger> = {}): Trigger => ({ id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_a:om_root' }],
  actor: { source: 'feishu', id: 'ou_alice' }, human: true, addressed: 'mention', at: '2026-11-23T10:00:00.000Z', text: 'hi',
  meta: { chatId: 'oc_a', messageId: id.slice('feishu:'.length) }, ...fields })
const ticket = { id: 't1', title: 'Look something up', origin: { triggerId: 'feishu:om_root', triggerIds: ['feishu:om_root'] }, inputs: [] } as unknown as Ticket

function storeOf(triggers: Trigger[], threads: Thread[] = []) {
  return {
    tickets: { get: (id: string) => (id === ticket.id ? ticket : undefined) },
    triggers: { get: (id: string) => triggers.find(item => item.id === id) },
    threads: { get: (key: string) => threads.find(item => item.key === key) },
  } as never
}

describe('tool modules', () => {
  it('imports each module once, and skips one that fails or exports none of workerTools, mainTools and reminded', async () => {
    writeFileSync(join(dir, 'good.mjs'), 'export const workerTools = () => []\n')
    writeFileSync(join(dir, 'main.mjs'), 'export const mainTools = () => []\n')
    writeFileSync(join(dir, 'none.mjs'), 'export const other = 1\n')
    writeFileSync(join(dir, 'broken.mjs'), 'throw new Error("boom")\n')
    const warnings: string[] = []
    const modules = await loadToolModules([join(dir, 'good.mjs'), join(dir, 'main.mjs'), join(dir, 'none.mjs'), join(dir, 'broken.mjs')],
      message => warnings.push(message))
    expect(modules).toHaveLength(2)
    expect(warnings.join('\n')).toMatch(/none\.mjs exports no workerTools, mainTools or reminded function/)
    expect(warnings.join('\n')).toMatch(/broken\.mjs: boom/)
  })

  it('lets a tool act only for a person whose message reached the ticket', () => {
    let context: WorkerToolContext | undefined
    const module: WorkerToolModule = { workerTools: given => { context = given; return [] } }
    const store = storeOf([
      trigger('feishu:om_root'),
      trigger('feishu:om_bot', { human: false, actor: { source: 'feishu', id: 'ou_bot' } }),
      trigger('feishu:om_elsewhere', { threads: [{ source: 'feishu', id: 'oc_a:om_other' }], actor: { source: 'feishu', id: 'ou_admin' } }),
      trigger('feishu:om_followup', { actor: { source: 'feishu', id: 'ou_bob' } }),
    ], [{ key: 'feishu:oc_a:om_root', subscriptions: ['t1'] } as unknown as Thread])
    extensionTools([module], store, ticket, new Set(), () => {})
    expect(context!.ticket).toEqual({ id: 't1', title: 'Look something up' })
    // The working directory, read from the ticket as it is now.
    expect(context!.cwd).toBeUndefined()
    ;(ticket as { execution?: unknown }).execution = { name: 'look-up', directory: '/work/look-up-1', assignment: 'a1' }
    expect(context!.cwd).toBe('/work/look-up-1')
    delete (ticket as { execution?: unknown }).execution
    expect(context!.asker('feishu:om_root')).toMatchObject({ actor: 'ou_alice', source: 'feishu', addressed: 'mention', meta: { chatId: 'oc_a', messageId: 'om_root' } })
    // A follow-up on a thread the ticket is subscribed to is that ticket's too.
    expect(context!.asker('feishu:om_followup').actor).toBe('ou_bob')
    expect(() => context!.asker('feishu:om_bot')).toThrow(/not a person's message/)
    expect(() => context!.asker('feishu:om_elsewhere')).toThrow(/not a person's message/)
    expect(() => context!.asker('feishu:om_missing')).toThrow(/not a person's message/)
  })

  it('adds well-formed tools and skips a malformed one or one whose name is taken', () => {
    const execute = async () => ({ ok: true })
    const module: WorkerToolModule = { workerTools: ({ z: zod }) => [
      { name: 'ff_lookup', description: 'Look up', schema: zod.object({ q: zod.string() }), execute },
      { name: 'orchestrator_report', description: 'Collides', schema: zod.object({}), execute },
      { name: 'Bad Name', description: 'Malformed', schema: zod.object({}), execute },
      { name: 'no_schema', description: 'No schema', schema: {} as never, execute },
    ] }
    const warnings: string[] = []
    const tools = extensionTools([module, { workerTools: () => { throw new Error('nope') } }], storeOf([]), ticket,
      new Set(['orchestrator_report']), message => warnings.push(message))
    expect(tools.map(item => item.name)).toEqual(['ff_lookup'])
    expect(warnings).toHaveLength(4)
    expect(tools[0]!.schema).toBeInstanceOf(z.ZodType)
  })

  it('gives the main Session the modules\' mainTools, acting for any person\'s message the host recorded, under unique names', async () => {
    let context: MainToolContext | undefined
    const execute = async () => ({ ok: true })
    const modules: WorkerToolModule[] = [
      { workerTools: () => [{ name: 'ff_worker_only', description: 'w', schema: z.object({}), execute }] },
      { mainTools: given => { context = given; return [
        { name: 'ff_web_search', description: 'Search', schema: given.z.object({ query: given.z.string() }), execute },
        { name: 'orchestrator_reply', description: 'taken', schema: given.z.object({}), execute },
      ] } },
    ]
    const warnings: string[] = []
    const store = storeOf([trigger('feishu:om_root'), trigger('feishu:om_bot', { human: false })])
    const tools = mainExtensionTools(modules, store, new Set(['orchestrator_reply']), message => warnings.push(message))
    expect(tools.map(item => item.name)).toEqual(['ff_web_search'])
    expect(warnings.join('\n')).toMatch(/orchestrator_reply/)
    expect(context!.asker('feishu:om_root')).toMatchObject({ actor: 'ou_alice', meta: { messageId: 'om_root' } })
    expect(() => context!.asker('feishu:om_bot')).toThrow(/not a person's message/)
    expect(() => context!.asker('feishu:om_missing')).toThrow(/not a person's message/)
    // A module with only mainTools gives an Executor Session nothing.
    expect(extensionTools([modules[1]!], store, ticket, new Set(), () => {})).toEqual([])
  })
  it('loads a module that only delivers the occurrences of the scheduled tasks it manages', async () => {
    const path = join(dir, 'reminded.mjs')
    writeFileSync(path, 'export function reminded() { return true }\n')
    const [module] = await loadToolModules([path], () => {})
    expect(typeof module?.reminded).toBe('function')
  })

  it('manages DSH\'s scheduled tasks for a module, each delivered to the main Session it is now, and keeps DSH\'s error codes', async () => {
    const calls: unknown[][] = []
    const entry = (id: string, fields: Record<string, unknown> = {}) => ({ id, title: 't', prompt: 'p', kind: 'rrule',
      rrule: 'DTSTART;TZID=Asia/Singapore:20261125T090000\nRRULE:FREQ=DAILY', status: 'active', scheduledAt: '2026-11-25T01:00:00.000Z',
      involvedSessionIds: ['main-1'], lastDelivery: { scheduledAt: '2026-11-24T01:00:00.000Z', deliveredAt: '2026-11-24T01:00:01.000Z' }, ...fields })
    const service = {
      list: async (request: { offset: number }) => { calls.push(['list', request]); return { items: request.offset === 0 ? [entry('a'), entry('b')] : [], total: 2 } },
      view: async ({ id }: { id: string }) => (id === 'a' ? entry('a') : { id, code: 'schedule_not_found' }),
      create: async (request: { title: string }, actor: string): Promise<unknown> => { calls.push(['create', request, actor]); return entry('c', { title: request.title }) },
      edit: async (request: { id: string; action: string }, actor: string) => {
        calls.push(['edit', request, actor])
        if (request.action === 'delete') return { id: request.id, deleted: true }
        return request.id === 'gone' ? { id: request.id, code: 'schedule_not_found' } : entry(request.id, { status: 'paused' })
      },
    }
    let master = 'main-1'
    const schedules = mainSchedules(() => service, () => master)!
    expect(await schedules.list()).toEqual([
      { id: 'a', title: 't', prompt: 'p', kind: 'rrule', rrule: entry('a').rrule, status: 'active', scheduledAt: '2026-11-25T01:00:00.000Z',
        lastDeliveredAt: '2026-11-24T01:00:01.000Z' },
      expect.objectContaining({ id: 'b' }),
    ])
    expect(await schedules.view('a')).toMatchObject({ id: 'a' })
    expect(await schedules.view('missing')).toBeUndefined()
    // The main Session moved to a new one: what is created now goes to it.
    master = 'main-1-r1'
    const rrule = 'DTSTART;TZID=Asia/Singapore:20261125T090000\nRRULE:FREQ=DAILY'
    expect(await schedules.create({ title: '提醒交日报', prompt: 'ff_schedule: 3', rrule })).toMatchObject({ id: 'c', title: '提醒交日报' })
    expect(calls.at(-1)).toEqual(['create', { title: '提醒交日报', prompt: 'ff_schedule: 3', timing: { kind: 'rrule', rrule },
      target: { kind: 'session', sessionId: 'main-1-r1' } }, 'main-1-r1'])
    expect(await schedules.update('a', { active: false })).toMatchObject({ status: 'paused' })
    expect(calls.at(-1)).toEqual(['edit', { id: 'a', action: 'update', patch: { active: false } }, 'main-1-r1'])
    await schedules.update('a', { title: '新标题', rrule })
    expect(calls.at(-1)).toEqual(['edit', { id: 'a', action: 'update', patch: { title: '新标题', timing: { kind: 'rrule', rrule } } }, 'main-1-r1'])
    expect(await schedules.update('gone', { title: 'x' })).toBeUndefined()
    await expect(schedules.update('a', {})).rejects.toThrow('Nothing to change')
    expect(await schedules.remove('a')).toBe(true)
    service.create = async () => { throw Object.assign(new Error('DTSTART must name an existing local time'), { code: 'invalid_rule' }) }
    await expect(schedules.create({ title: 'x', prompt: 'y', rrule: 'bad' })).rejects.toThrow('invalid_rule: DTSTART must name an existing local time')
    // A host without DSH's schedule service gives modules none.
    expect(mainSchedules(() => undefined, () => master)).toBeUndefined()
  })
})
