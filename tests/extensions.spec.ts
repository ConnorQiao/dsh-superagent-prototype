/** Tool modules named in `toolModules`: loading, the tools each ticket gets, and whose message a tool may act for. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Thread, Ticket, Trigger } from '../src/core/index.ts'
import { extensionTools, loadToolModules, type WorkerToolContext, type WorkerToolModule } from '../src/app/tools/extensions.ts'

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
  it('imports each module once, and skips one that fails or exports no workerTools', async () => {
    writeFileSync(join(dir, 'good.mjs'), 'export const workerTools = () => []\n')
    writeFileSync(join(dir, 'none.mjs'), 'export const other = 1\n')
    writeFileSync(join(dir, 'broken.mjs'), 'throw new Error("boom")\n')
    const warnings: string[] = []
    const modules = await loadToolModules([join(dir, 'good.mjs'), join(dir, 'none.mjs'), join(dir, 'broken.mjs')], message => warnings.push(message))
    expect(modules).toHaveLength(1)
    expect(warnings.join('\n')).toMatch(/none\.mjs exports no workerTools/)
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
})
