/**
 * DSH's scheduled tasks (`schedule_create` and the rest of the `dsh-tool-schedule` tools) for the main Session. DSH delivers
 * each due occurrence into the task's target Session as a message framed "[SCHEDULE REMINDER] This is a scheduled message from
 * the user"; such a message has no trigger, so the main Session could neither answer it nor open a ticket. Here a task names the
 * trigger that asked for it on its prompt's first line, and each delivered occurrence becomes a trigger from the same person on
 * the same threads, so it is assessed, routed, worked and answered like any request, in the conversation it came from.
 */
import type { Trigger } from '../core/index.ts'

/** The DSH schedule tools the main Session gets. */
export const SCHEDULE_TOOLS = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']
/** Where every task is delivered: the main Session, which turns it into a trigger. */
export const SCHEDULE_TARGET = 'this_session'
/** The first line of a task's prompt: the trigger whose request the task serves. */
const ORIGIN = /^trigger_id:\s*(\S+)\s*$/
/** What a scheduled occurrence's trigger text starts with, so its worker knows what it is. */
export const SCHEDULED_PREFIX = '[定时提醒]'

/** One delivered occurrence of a task. */
export interface Reminder { scheduleId: string; occurrenceAt: string; prompt: string }

const json = (value: string): unknown => { try { return JSON.parse(value) } catch { return undefined } }
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

/** The occurrences one delivered message carries: DSH's single reminder framing or its recurring batch framing. */
export function parseReminders(message: string): Reminder[] {
  const lines = message.split('\n')
  const field = (name: string) => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
  if (lines[0] === '[SCHEDULE REMINDER]') {
    const scheduleId = text(json(field('schedule_id_json') ?? '')), prompt = text(json(field('reminder_prompt_json') ?? ''))
    const occurrenceAt = field('occurrence_at')
    return scheduleId && prompt && occurrenceAt ? [{ scheduleId, occurrenceAt, prompt }] : []
  }
  if (lines[0] === '[SCHEDULE REMINDER BATCH]') {
    const batch = json(field('reminders_json') ?? '')
    return Array.isArray(batch) ? batch.flatMap(item => {
      const record = item as { schedule_id?: unknown; occurrence_at?: unknown; reminder_prompt?: unknown }
      const scheduleId = text(record.schedule_id), occurrenceAt = text(record.occurrence_at), prompt = text(record.reminder_prompt)
      return scheduleId && occurrenceAt && prompt ? [{ scheduleId, occurrenceAt, prompt }] : []
    }) : []
  }
  return []
}

/** The trigger a task's prompt names on its first line, and the instruction after it. */
export function taskOf(prompt: string): { triggerId?: string; instruction: string } {
  const [first = '', ...rest] = prompt.split('\n')
  const origin = ORIGIN.exec(first.trim())
  return origin ? { triggerId: origin[1]!, instruction: rest.join('\n').trim() } : { instruction: prompt.trim() }
}

const FORMAT = `Start the prompt with a line "trigger_id: <the trigger_id of the person's request you are serving>", then the instruction `
  + `for each occurrence on the next lines, and set target to ${SCHEDULE_TARGET}: each occurrence then comes back as that person's `
  + 'request in the conversation it came from.'

/**
 * Refuse a schedule tool call the main Session could not carry out: a task delivered anywhere but the main Session, or one whose
 * prompt does not name a person's request this host recorded.
 */
export function scheduleGuard({ name, arguments: input }: { name: string; arguments: unknown },
  triggers: { get(id: string): Trigger | undefined }): string | undefined {
  if (name !== 'schedule_create' && name !== 'schedule_edit') return undefined
  const args = (input ?? {}) as { target?: unknown; prompt?: unknown }
  if ((name === 'schedule_create' || args.target !== undefined) && args.target !== SCHEDULE_TARGET)
    return `Scheduled tasks are delivered to this Session only. ${FORMAT}`
  if (name === 'schedule_create' || args.prompt !== undefined) {
    const { triggerId, instruction } = taskOf(typeof args.prompt === 'string' ? args.prompt : '')
    const origin = triggerId ? triggers.get(triggerId) : undefined
    if (!origin?.human) return `The prompt names no person's request. ${FORMAT}`
    if (!instruction) return `The prompt has no instruction after its trigger_id line. ${FORMAT}`
  }
  return undefined
}

/** The trigger one occurrence becomes: the requester's, on the request's threads, worded as the task. */
export function scheduledTrigger(origin: Trigger, reminder: Reminder, instruction: string, at: string): Trigger {
  return {
    id: `schedule:${reminder.scheduleId}:${reminder.occurrenceAt}`,
    source: origin.source,
    threads: origin.threads,
    actor: origin.actor,
    human: true,
    addressed: origin.addressed ?? 'mention',
    at,
    text: `${SCHEDULED_PREFIX} ${instruction}`,
    ...origin.channel ? { channel: origin.channel } : {},
    ...origin.url ? { url: origin.url } : {},
    meta: { ...origin.meta, scheduleId: reminder.scheduleId, occurrenceAt: reminder.occurrenceAt, scheduledFrom: origin.id },
  }
}
