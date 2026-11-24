/**
 * Tools that the modules named in the plugin's `toolModules` add to every Executor Session, bound to the ticket the Session
 * works, and, through an optional `mainTools`, to the main Session. A module runs in the DeepSeek Harness process, not in a
 * sandbox, so it can hold what the Sessions must not read; `asker` tells it whose message it is serving, from the host's
 * records rather than from the model's arguments.
 */
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { reached, type Ticket } from '../../core/index.ts'
import type { Store } from '../store.ts'
import type { Tool } from './tool.ts'

/** Who wrote a message that reached a ticket, as its Source recorded it. */
export interface TicketAsker {
  triggerId: string
  source: string
  /** The person's id in that Source, such as a Feishu open_id. */
  actor: string
  addressed?: 'mention' | 'direct'
  at: string
  /** Source-native details, such as the Feishu `chatId` and `messageId`. */
  meta: Record<string, unknown>
}
/** What a module's `workerTools` receives for one Executor Session. */
export interface WorkerToolContext {
  readonly ticket: { readonly id: string; readonly title: string }
  /**
   * The Executor Session's working directory, where its commands run: the ticket's own directory, so a tool that writes a file
   * for the Session puts it there. Undefined until the ticket has one.
   */
  readonly cwd: string | undefined
  /** The person whose message `triggerId` is, when it is a person's message that reached this ticket; throws otherwise. */
  asker(triggerId: string): TicketAsker
  /** The zod this bundle builds tool schemas with; a module's schemas must come from it. */
  readonly z: typeof z
}
/** One of DSH's scheduled tasks, as a tool module of the main Session sees it. */
export interface ScheduledTask {
  id: string
  title: string
  /** What is delivered to the main Session at each occurrence. */
  prompt: string
  /** The kind of its timing (`rrule`, `daily`, `at` and so on) and, for an rrule, the rule. */
  kind: string
  rrule?: string
  status: 'active' | 'paused' | 'ended'
  /** Its next occurrence in UTC; for an ended task, its last. */
  scheduledAt: string
  updatedAt?: string
  /** When its latest occurrence was delivered. */
  lastDeliveredAt?: string
}
/**
 * DSH's scheduled tasks for a tool module that manages them for the people it serves (with `dshScheduleTools` off): every
 * task of the host, each delivered to the main Session, whose occurrence the module's `reminded` takes. The module decides
 * who may see or change which; DSH's tasks belong to the host, not to a person. An invalid rule or title throws its reason.
 */
export interface MainSchedules {
  list(): Promise<ScheduledTask[]>
  view(id: string): Promise<ScheduledTask | undefined>
  /** `rrule` in DSH's RFC 5545 subset (a DTSTART line, a newline, an RRULE line). */
  create(task: { title: string; prompt: string; rrule: string }): Promise<ScheduledTask>
  /** Change it, or pause (`active: false`) or resume it; undefined when there is no such task. */
  update(id: string, patch: { title?: string; prompt?: string; rrule?: string; active?: boolean }): Promise<ScheduledTask | undefined>
  /** Delete it; false when there was no such task. */
  remove(id: string): Promise<boolean>
}
/** What a module's `mainTools` receives for the main Session. */
export interface MainToolContext {
  /** The person whose message `triggerId` is, when the host recorded it as a person's message; throws otherwise. */
  asker(triggerId: string): TicketAsker
  /** The zod this bundle builds tool schemas with; a module's schemas must come from it. */
  readonly z: typeof z
  /** DSH's scheduled tasks, when the host runs DSH's schedule service. */
  readonly schedules?: MainSchedules
}
/** One due occurrence of a DSH scheduled task, delivered to the main Session. */
export interface ScheduleReminder { scheduleId: string; occurrenceAt: string; prompt: string }
/**
 * A module named in `toolModules`: tools for Executor Sessions, the main Session, or both; and, through `reminded`, the
 * occurrences of the scheduled tasks it manages. `reminded` returns true when it delivered the occurrence itself (such as a
 * message on the person's behalf in the chat the task runs in); otherwise the host turns it into the requester's trigger on
 * the request's threads (`schedules.ts`), as it does without a module.
 */
export interface WorkerToolModule {
  workerTools?(context: WorkerToolContext): Tool[]
  mainTools?(context: MainToolContext): Tool[]
  reminded?(reminder: ScheduleReminder, context: MainToolContext): boolean | Promise<boolean>
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Imports each module once; one that fails to import or exports neither `workerTools` nor `mainTools` is skipped with a warning. */
export async function loadToolModules(paths: readonly string[], warn: (message: string) => void): Promise<WorkerToolModule[]> {
  const modules: WorkerToolModule[] = []
  for (const path of paths) {
    try {
      const loaded = await import(pathToFileURL(path).href) as Partial<WorkerToolModule>
      if (typeof loaded.workerTools === 'function' || typeof loaded.mainTools === 'function' || typeof loaded.reminded === 'function')
        modules.push(loaded as WorkerToolModule)
      else warn(`tool module ${path} exports no workerTools, mainTools or reminded function`)
    } catch (error) {
      warn(`could not load tool module ${path}: ${reason(error)}`)
    }
  }
  return modules
}

/**
 * The tools the modules give `ticket`'s Executor Session. A tool whose name is malformed or already taken (by the Session's
 * own tools or an earlier module), or whose schema is not a zod schema of this bundle, is skipped with a warning.
 */
export function extensionTools(modules: readonly WorkerToolModule[], store: Pick<Store, 'tickets' | 'triggers' | 'threads'>, ticket: Ticket,
  taken: ReadonlySet<string>, warn: (message: string) => void): Tool[] {
  if (modules.length === 0) return []
  const context: WorkerToolContext = {
    ticket: { id: ticket.id, title: ticket.title },
    get cwd() { return (store.tickets.get(ticket.id) ?? ticket).execution?.directory || undefined },
    asker: triggerId => {
      // The ticket as it is now: follow-ups that reached it after the Session started count too.
      const current = store.tickets.get(ticket.id) ?? ticket
      const trigger = store.triggers.get(triggerId)
      if (!trigger || !trigger.human || !reached(current, trigger, key => store.threads.get(key), false)) {
        throw new Error(`${triggerId} is not a person's message that reached this ticket`)
      }
      return { triggerId: trigger.id, source: trigger.source, actor: trigger.actor.id, ...trigger.addressed ? { addressed: trigger.addressed } : {},
        at: trigger.at, meta: { ...trigger.meta } }
    },
    z,
  }
  return collect(modules, module => module.workerTools?.(context), taken, warn)
}

/**
 * What the main Session's module tools and `reminded` receive. `asker` accepts any trigger the host recorded as a person's
 * message: the main Session sees every one before it is judged.
 */
export function mainToolContext(store: Pick<Store, 'triggers'>, schedules?: MainSchedules): MainToolContext {
  return {
    asker: triggerId => {
      const trigger = store.triggers.get(triggerId)
      if (!trigger || !trigger.human) throw new Error(`${triggerId} is not a person's message`)
      return { triggerId: trigger.id, source: trigger.source, actor: trigger.actor.id, ...trigger.addressed ? { addressed: trigger.addressed } : {},
        at: trigger.at, meta: { ...trigger.meta } }
    },
    z,
    ...schedules ? { schedules } : {},
  }
}
/** The tools the modules give the main Session (`mainToolContext`). */
export function mainExtensionTools(modules: readonly WorkerToolModule[], store: Pick<Store, 'triggers'>, taken: ReadonlySet<string>,
  warn: (message: string) => void, schedules?: MainSchedules): Tool[] {
  if (modules.length === 0) return []
  const context = mainToolContext(store, schedules)
  return collect(modules, module => module.mainTools?.(context), taken, warn)
}

/** DSH's schedule service, as much of it as `MainSchedules` uses (`@deepseek-ai/dsh-schedule`'s `ScheduleService`). */
interface ScheduleService {
  list(request: { limit?: number; offset?: number }): Promise<{ items: ScheduleEntry[]; total: number }>
  view(request: { id: string }): Promise<ScheduleEntry | { code: 'schedule_not_found' }>
  create(request: { title: string; prompt: string; timing: { kind: 'rrule'; rrule: string }; target: { kind: 'session'; sessionId: string } },
    actorSessionId?: string): Promise<ScheduleEntry>
  edit(request: { id: string; action: 'update'; patch: Record<string, unknown> } | { id: string; action: 'delete' }, actorSessionId?: string)
    : Promise<ScheduleEntry | { deleted: true } | { code: string }>
}
interface ScheduleEntry {
  id: string; title: string; prompt: string; kind: string; rrule?: string; status: 'active' | 'paused' | 'ended'
  scheduledAt: string; updatedAt?: string; lastDelivery?: { deliveredAt?: string }
}
const LIST_PAGE = 500
const taskOf = (entry: ScheduleEntry): ScheduledTask => ({
  id: entry.id, title: entry.title, prompt: entry.prompt, kind: entry.kind, ...entry.kind === 'rrule' && entry.rrule ? { rrule: entry.rrule } : {},
  status: entry.status, scheduledAt: entry.scheduledAt, ...entry.updatedAt ? { updatedAt: entry.updatedAt } : {},
  ...entry.lastDelivery?.deliveredAt ? { lastDeliveredAt: entry.lastDelivery.deliveredAt } : {},
})
const isEntry = (value: unknown): value is ScheduleEntry => typeof value === 'object' && value !== null && 'id' in value && 'kind' in value
/** DSH's schedule errors carry a code (`invalid_rule`, `not_future`…) beside their message; keep both for the model. */
function scheduleError(error: unknown): Error {
  const code = (error as { code?: unknown })?.code
  const message = error instanceof Error ? error.message : String(error)
  return new Error(typeof code === 'string' && !message.startsWith(code) ? `${code}: ${message}` : message)
}

/**
 * `MainSchedules` over DSH's schedule service, which it looks up at each call (the service starts after the plugin), and
 * the main Session, which every task it creates is delivered to: `masterId` is read at each call, since the main Session
 * moves to a new one after a compaction, whose tasks DSH still delivers to the current one (`schedule/resolve-agent`).
 * Undefined when the host has no schedule service.
 */
export function mainSchedules(service: () => unknown, masterId: () => string): MainSchedules | undefined {
  if (!service()) return undefined
  const schedule = (): ScheduleService => {
    const found = service() as ScheduleService | undefined
    if (!found) throw new Error('DSH\'s schedule service is not running')
    return found
  }
  const run = async <T>(work: () => Promise<T>): Promise<T> => { try { return await work() } catch (error) { throw scheduleError(error) } }
  return {
    list: () => run(async () => {
      const tasks: ScheduledTask[] = []
      for (let offset = 0; ; offset += LIST_PAGE) {
        const page = await schedule().list({ limit: LIST_PAGE, offset })
        tasks.push(...page.items.map(taskOf))
        if (page.items.length < LIST_PAGE || tasks.length >= page.total) return tasks
      }
    }),
    view: id => run(async () => {
      const found = await schedule().view({ id })
      return isEntry(found) ? taskOf(found) : undefined
    }),
    create: ({ title, prompt, rrule }) => run(async () => taskOf(await schedule().create({ title, prompt, timing: { kind: 'rrule', rrule },
      target: { kind: 'session', sessionId: masterId() } }, masterId()))),
    update: (id, { title, prompt, rrule, active }) => run(async () => {
      const patch = { ...title === undefined ? {} : { title }, ...prompt === undefined ? {} : { prompt },
        ...rrule === undefined ? {} : { timing: { kind: 'rrule', rrule } }, ...active === undefined ? {} : { active } }
      if (Object.keys(patch).length === 0) throw new Error('Nothing to change')
      const edited = await schedule().edit({ id, action: 'update', patch }, masterId())
      if (isEntry(edited)) return taskOf(edited)
      if ((edited as { code?: string }).code === 'schedule_not_found') return undefined
      throw new Error(`The task did not change: ${(edited as { code?: string }).code ?? 'unknown'}`)
    }),
    remove: id => run(async () => {
      const removed = await schedule().edit({ id, action: 'delete' }, masterId())
      return (removed as { deleted?: unknown }).deleted === true
    }),
  }
}

/** Each module's tools in turn; a malformed tool, a taken name or a schema of another zod is skipped with a warning. */
function collect(modules: readonly WorkerToolModule[], build: (module: WorkerToolModule) => unknown, taken: ReadonlySet<string>,
  warn: (message: string) => void): Tool[] {
  const names = new Set(taken)
  const tools: Tool[] = []
  for (const module of modules) {
    let provided: unknown
    try { provided = build(module) } catch (error) {
      warn(`a tool module failed to build its tools: ${reason(error)}`)
      continue
    }
    for (const item of Array.isArray(provided) ? provided as Partial<Tool>[] : []) {
      const name = typeof item?.name === 'string' ? item.name : ''
      if (!NAME.test(name) || names.has(name) || typeof item.execute !== 'function' || typeof item.description !== 'string'
        || !(item.schema instanceof z.ZodType)) {
        warn(`skipped the tool module tool ${JSON.stringify(name)}: malformed, or its name is taken`)
        continue
      }
      names.add(name)
      tools.push(item as Tool)
    }
  }
  return tools
}
