/** DSH scheduled tasks for the main Session: reading delivered occurrences, the tool guard, and the trigger an occurrence becomes. */
import { describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { parseReminders, scheduleGuard, scheduledTrigger, taskOf } from '../src/app/schedules.ts'

const origin: Trigger = { id: 'feishu:om_ask', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_a:om_ask' }],
  actor: { source: 'feishu', id: 'ou_alice' }, human: true, addressed: 'mention', at: '2026-11-24T01:00:00.000Z',
  text: '@FF 每天九点提醒我交日报', meta: { chatId: 'oc_a', messageId: 'om_ask' } }
const triggers = { get: (id: string) => (id === origin.id ? origin : id === 'feishu:om_bot' ? { ...origin, id, human: false } : undefined) }
const prompt = 'trigger_id: feishu:om_ask\n提醒张三交日报'

describe('scheduled tasks', () => {
  it('reads DSH\'s single and batch reminder framings, and nothing else', () => {
    const single = ['[SCHEDULE REMINDER]', 'This is a scheduled message from the user', 'schedule_id_json: "sch_1"',
      'occurrence_at: 2026-11-25T01:00:00.000Z', `reminder_prompt_json: ${JSON.stringify(prompt)}`].join('\n')
    expect(parseReminders(single)).toEqual([{ scheduleId: 'sch_1', occurrenceAt: '2026-11-25T01:00:00.000Z', prompt }])
    const batch = ['[SCHEDULE REMINDER BATCH]', 'This is a scheduled message from the user', `reminders_json: ${JSON.stringify([
      { schedule_id: 'sch_1', occurrence_at: '2026-11-25T01:00:00.000Z', reminder_prompt: prompt },
      { schedule_id: 'sch_2', occurrence_at: '2026-11-25T01:00:00.000Z', reminder_prompt: 'trigger_id: feishu:om_ask\n看看订单' },
    ])}`].join('\n')
    expect(parseReminders(batch).map(item => item.scheduleId)).toEqual(['sch_1', 'sch_2'])
    expect(parseReminders('hello')).toEqual([])
    expect(parseReminders('[SCHEDULE REMINDER]\nschedule_id_json: not json')).toEqual([])
  })

  it('takes the requesting trigger from the prompt\'s first line', () => {
    expect(taskOf(prompt)).toEqual({ triggerId: 'feishu:om_ask', instruction: '提醒张三交日报' })
    expect(taskOf('提醒张三交日报')).toEqual({ instruction: '提醒张三交日报' })
  })

  it('lets the main Session schedule only to itself, for a person\'s request it knows, with an instruction', () => {
    const create = (args: Record<string, unknown>) => scheduleGuard({ name: 'schedule_create', arguments: args }, triggers)
    expect(create({ title: '交日报', prompt, rrule: 'x', target: 'this_session' })).toBeUndefined()
    expect(create({ title: '交日报', prompt, rrule: 'x', target: 'new' })).toMatch(/this Session only/)
    expect(create({ title: '交日报', prompt: '提醒张三交日报', rrule: 'x', target: 'this_session' })).toMatch(/names no person's request/)
    expect(create({ title: '交日报', prompt: 'trigger_id: feishu:om_bot\nx', rrule: 'x', target: 'this_session' })).toMatch(/names no person's request/)
    expect(create({ title: '交日报', prompt: 'trigger_id: feishu:om_ask', rrule: 'x', target: 'this_session' })).toMatch(/no instruction/)
    const edit = (args: Record<string, unknown>) => scheduleGuard({ name: 'schedule_edit', arguments: args }, triggers)
    expect(edit({ id: 'sch_1', action: 'update', active: false })).toBeUndefined()
    expect(edit({ id: 'sch_1', action: 'delete' })).toBeUndefined()
    expect(edit({ id: 'sch_1', action: 'update', target: 'new_once' })).toMatch(/this Session only/)
    expect(edit({ id: 'sch_1', action: 'update', prompt: '只改文字' })).toMatch(/names no person's request/)
    expect(scheduleGuard({ name: 'schedule_list', arguments: {} }, triggers)).toBeUndefined()
    expect(scheduleGuard({ name: 'bash', arguments: {} }, triggers)).toBeUndefined()
  })

  it('makes each occurrence the requester\'s trigger on the request\'s threads, once per occurrence', () => {
    const trigger = scheduledTrigger(origin, { scheduleId: 'sch_1', occurrenceAt: '2026-11-25T01:00:00.000Z', prompt }, '提醒张三交日报',
      '2026-11-25T01:00:02.000Z')
    expect(trigger).toEqual({ id: 'schedule:sch_1:2026-11-25T01:00:00.000Z', source: 'feishu', threads: origin.threads, actor: origin.actor,
      human: true, addressed: 'mention', at: '2026-11-25T01:00:02.000Z', text: '[定时提醒] 提醒张三交日报',
      meta: { chatId: 'oc_a', messageId: 'om_ask', scheduleId: 'sch_1', occurrenceAt: '2026-11-25T01:00:00.000Z', scheduledFrom: 'feishu:om_ask' } })
  })
})
