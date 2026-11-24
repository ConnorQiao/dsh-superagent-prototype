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
/** What a module's `mainTools` receives for the main Session. */
export interface MainToolContext {
  /** The person whose message `triggerId` is, when the host recorded it as a person's message; throws otherwise. */
  asker(triggerId: string): TicketAsker
  /** The zod this bundle builds tool schemas with; a module's schemas must come from it. */
  readonly z: typeof z
}
/** A module named in `toolModules`: tools for Executor Sessions, the main Session, or both. */
export interface WorkerToolModule { workerTools?(context: WorkerToolContext): Tool[]; mainTools?(context: MainToolContext): Tool[] }

const NAME = /^[a-z][a-z0-9_]{0,63}$/
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Imports each module once; one that fails to import or exports neither `workerTools` nor `mainTools` is skipped with a warning. */
export async function loadToolModules(paths: readonly string[], warn: (message: string) => void): Promise<WorkerToolModule[]> {
  const modules: WorkerToolModule[] = []
  for (const path of paths) {
    try {
      const loaded = await import(pathToFileURL(path).href) as Partial<WorkerToolModule>
      if (typeof loaded.workerTools === 'function' || typeof loaded.mainTools === 'function') modules.push(loaded as WorkerToolModule)
      else warn(`tool module ${path} exports no workerTools or mainTools function`)
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
 * The tools the modules give the main Session. `asker` accepts any trigger the host recorded as a person's message: the main
 * Session sees every one before it is judged.
 */
export function mainExtensionTools(modules: readonly WorkerToolModule[], store: Pick<Store, 'triggers'>, taken: ReadonlySet<string>,
  warn: (message: string) => void): Tool[] {
  if (modules.length === 0) return []
  const context: MainToolContext = {
    asker: triggerId => {
      const trigger = store.triggers.get(triggerId)
      if (!trigger || !trigger.human) throw new Error(`${triggerId} is not a person's message`)
      return { triggerId: trigger.id, source: trigger.source, actor: trigger.actor.id, ...trigger.addressed ? { addressed: trigger.addressed } : {},
        at: trigger.at, meta: { ...trigger.meta } }
    },
    z,
  }
  return collect(modules, module => module.mainTools?.(context), taken, warn)
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
