/**
 * How a ticket's worker Session spent its time, read from the Session's own event log: each turn and what started it, each
 * step's model call (time to the first token, the whole call, tokens, retries), its tool calls, the background jobs they left
 * running, and the waits between turns. Built for the panel's ticket page, so a slow ticket shows where the time went.
 */
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const PREVIEW = 200
/** Producers that add the same context to every step; they never start a turn. */
const STEP_CONTEXT = new Set(['runtime-context', 'skill-catalog', 'time-context'])

export interface WorkTool {
  callId: string; name: string; start: number; end?: number; error?: boolean
  /** The call's arguments and the start of its result, cut to a preview. */
  args: string; result?: string
  /** It moved to a background job, which settled at `settled` with `status`. */
  job?: { label: string; settled?: number; status?: string }
}
export interface WorkStep {
  turn: number; step: number; start: number; end?: number
  /** The request went out at `start`; the first token came at `firstToken`; the message ended at `end`. */
  model?: { start: number; firstToken?: number; end?: number; input?: number; cached?: number; output?: number; reasoning?: number
    interrupted?: true }
  /** Attempts that failed and were retried, with the waits before the retries. */
  failures: number; retryWaitMs: number; retryReasons: string[]
  /** The start of the assistant's text in this step. */
  text?: string
  tools: WorkTool[]
}
/**
 * One message that reached the worker: superagent's `assignment` (with the ticket title), a person's `message` relayed from a
 * Thread, a `note` from the main Session, a `notice` (one line some producer wrote about what happened), or `other`.
 */
export interface WorkInput { kind: 'assignment' | 'message' | 'note' | 'notice' | 'other'; source: string; preview: string; at: number }
export interface WorkTurn {
  turn: number; start: number; end?: number; reason?: string
  /** The messages that started the turn or reached it while it ran, other than per-step context. */
  inputs: WorkInput[]
  /** Time since the previous turn ended, and the background jobs that ran meanwhile. */
  waitMs?: number; waitJobs?: string[]
  compactionMs: number
  steps: WorkStep[]
}
export interface WorkToolTotal { name: string; calls: number; ms: number; maxMs: number; errors: number }
export interface WorkTimeline {
  sessionId: string; startedAt?: number; lastAt?: number
  totals: {
    turns: number; steps: number
    /** Time inside turns; an open turn counts up to the last event. */
    activeMs: number
    /** Model calls: from each request to its message, and the part of that before the first token. */
    modelMs: number; firstTokenMs: number
    /** Tool calls, each counted from the later of its call and the previous result of its step, so parallel calls are not counted twice. */
    toolMs: number
    /** Between turns, waiting for the next input. */
    waitMs: number
    retryWaitMs: number; failures: number; compactionMs: number
    input: number; cached: number; output: number; reasoning: number
  }
  /** Tool time by name, most first. */
  tools: WorkToolTotal[]
  turns: WorkTurn[]
}

type Content = readonly { type: string; text?: string }[]
const clip = (text: string, max = PREVIEW) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max)}…` : flat }
const textOf = (content: Content | undefined) => (content ?? []).flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n')
/** The words in a message a Source stored as JSON, such as a Feishu post (`{"zh_cn": {"content": [[{"text": …}]]}}`). */
function words(text: string): string {
  if (!/^\s*[{[]/.test(text)) return text
  try {
    const found: string[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
        if ((key === 'text' || key === 'title') && typeof item === 'string') found.push(item); else walk(item)
      }
    }
    walk(JSON.parse(text))
    return found.length ? found.join(' ') : text
  } catch { return text }
}
/**
 * Reads one input as a person would: superagent's JSON relays by the field that says what they are (the launch message's
 * ticket title, a trigger's words), a note from the main Session by its words, anything else by its first words.
 */
function readInput(source: string, text: string): Pick<WorkInput, 'kind' | 'preview'> {
  if (source === 'dsh-superagent' && text.startsWith('{')) {
    try {
      const value = JSON.parse(text) as Record<string, unknown>
      // The launch message: the ticket and its title, or for a later Assignment only its number.
      if (typeof value.ticket_id === 'string' && (typeof value.title === 'string' || 'assignment' in value))
        return { kind: 'assignment', preview: clip(typeof value.title === 'string' ? value.title : `#${String(value.assignment)}`) }
      const said = value.text ?? value.preview
      if (typeof value.trigger_id === 'string') return { kind: 'message', preview: typeof said === 'string' ? clip(words(said)) : '' }
    } catch { /* not JSON after all: show its start */ }
  }
  const note = /^Note from the orchestrator, for context only: /.exec(text)
  if (source === 'dsh-superagent' && note) return { kind: 'note', preview: clip(text.slice(note[0].length)) }
  return { kind: 'other', preview: clip(text) }
}
const source = (message: { source?: { kind?: string; form?: string; summary?: string } }) => message.source ?? {}

/** Builds the timeline of one worker Session from its events, oldest first. */
export function workTimeline(sessionId: string, events: readonly SessionEvent[]): WorkTimeline {
  const turns: WorkTurn[] = []
  const jobs = new Map<string, { label: string; start: number; end?: number; status?: string; callId?: string }>()
  let turn: WorkTurn | undefined, step: WorkStep | undefined
  let lastEnd: number | undefined, compactionStart: number | undefined
  const calls = new Map<string, WorkTool>()
  const stepOf = (data: { turn?: number; step?: number }) => step && step.turn === data.turn && step.step === data.step ? step : undefined
  for (const event of events) {
    const data = event.data as Record<string, unknown> & { turn?: number; step?: number }
    // Jobs, retries and compaction are other packages' events, outside the Session's own event map.
    const type: string = event.type
    switch (type) {
      case 'turn/start': {
        turn = { turn: Number(data.turn), start: event.time, inputs: [], compactionMs: 0, steps: [],
          ...lastEnd !== undefined ? { waitMs: Math.max(0, event.time - lastEnd) } : {} }
        turns.push(turn)
        break
      }
      case 'turn/end': {
        if (turn && turn.turn === data.turn) {
          turn.end = event.time
          const reason = data.reason as { kind?: string } | undefined
          if (reason?.kind) turn.reason = reason.kind
        }
        lastEnd = event.time; step = undefined
        break
      }
      case 'step/start': {
        step = { turn: Number(data.turn), step: Number(data.step), start: event.time, failures: 0, retryWaitMs: 0, retryReasons: [], tools: [] }
        turn?.steps.push(step)
        break
      }
      case 'step/end': { if (stepOf(data)) step!.end = event.time; break }
      case 'request/header': {
        // Each attempt appends its header before it goes out; the last one before the message is the call that answered.
        if (step) step.model = { start: event.time }
        break
      }
      case 'assistant/attempt': {
        const current = stepOf(data)
        if (current) { current.failures++; current.model = undefined }
        break
      }
      case 'llm/retry': {
        const current = stepOf(data)
        if (current) {
          current.retryWaitMs += Number(data.delayMs) || 0
          const failure = data.failure as { kind?: string; message?: string } | undefined
          const reason = clip(failure?.message ?? failure?.kind ?? '', 120)
          if (reason) current.retryReasons.push(reason)
        }
        break
      }
      case 'assistant/message': {
        const current = stepOf(data)
        if (!current) break
        const usage = data.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number }
          | undefined
        const stream = (data.stream ?? []) as Parameters<typeof assistantStreamFirstTokenTime>[0]
        const firstToken = assistantStreamFirstTokenTime(stream)
        current.model = { start: current.model?.start ?? current.start, end: event.time, ...firstToken !== undefined ? { firstToken } : {},
          ...usage ? { input: usage.inputTokens, output: usage.outputTokens, cached: usage.cacheReadTokens ?? 0,
            reasoning: usage.reasoningTokens ?? 0 } : {}, ...data.interrupted ? { interrupted: true as const } : {} }
        const text = textOf((data.message as { content?: Content } | undefined)?.content)
        if (text.trim()) current.text = clip(text)
        break
      }
      case 'tool/call': {
        const current = stepOf(data)
        if (!current) break
        const tool: WorkTool = { callId: String(data.callId), name: String(data.name), start: event.time, args: clip(String(data.arguments ?? '')) }
        current.tools.push(tool); calls.set(tool.callId, tool)
        break
      }
      case 'tool/result': {
        const message = data.message as { toolCallId?: string; isError?: boolean; content?: Content } | undefined
        const tool = message?.toolCallId ? calls.get(message.toolCallId) : undefined
        if (!tool) break
        tool.end = event.time
        if (message?.isError) tool.error = true
        const result = textOf(message?.content)
        if (result.trim()) tool.result = clip(result)
        break
      }
      case 'job/registered': case 'job/settled': {
        const job = data as { jobId?: string; label?: string; startedAt?: number; finishedAt?: number; status?: string
          toolCall?: { rootCallId?: string } }
        if (!job.jobId) break
        const known: { label: string; start: number; end?: number; status?: string; callId?: string } = jobs.get(job.jobId)
          ?? { label: clip(job.label ?? job.jobId, 120), start: job.startedAt ?? event.time }
        if (job.toolCall?.rootCallId) known.callId = job.toolCall.rootCallId
        if (type === 'job/settled') { known.end = job.finishedAt ?? event.time; if (job.status) known.status = job.status }
        jobs.set(job.jobId, known)
        break
      }
      case 'compaction/start': { compactionStart = event.time; break }
      case 'compaction/end': {
        if (turn && compactionStart !== undefined) turn.compactionMs += Math.max(0, event.time - compactionStart)
        compactionStart = undefined
        break
      }
      case 'user/message': {
        const message = data as { content?: Content; source?: { kind?: string; form?: string; summary?: string } }
        const { kind = 'user', form, summary } = source(message)
        if (!turn || STEP_CONTEXT.has(kind)) break
        turn.inputs.push({ source: kind, ...form === 'notice' && summary ? { kind: 'notice' as const, preview: clip(summary) }
          : readInput(kind, textOf(message.content)), at: event.time })
        break
      }
    }
  }
  // A job keeps its tool call's identity: show it on the call, and as what ran during the wait before the next turn.
  for (const job of jobs.values()) {
    const tool = job.callId ? calls.get(job.callId) : undefined
    if (tool) tool.job = { label: job.label, ...job.end !== undefined ? { settled: job.end } : {}, ...job.status ? { status: job.status } : {} }
  }
  for (const [index, current] of turns.entries()) {
    const previous = turns[index - 1]
    if (!previous?.end) continue
    const during = [...jobs.values()].filter(job => job.start < current.start && (job.end ?? Infinity) > previous.end!)
    if (during.length) current.waitJobs = during.map(job => job.label)
  }
  const lastAt = events.at(-1)?.time
  const totals = { turns: turns.length, steps: 0, activeMs: 0, modelMs: 0, firstTokenMs: 0, toolMs: 0, waitMs: 0, retryWaitMs: 0, failures: 0,
    compactionMs: 0, input: 0, cached: 0, output: 0, reasoning: 0 }
  const byTool = new Map<string, WorkToolTotal>()
  for (const current of turns) {
    totals.activeMs += Math.max(0, (current.end ?? lastAt ?? current.start) - current.start)
    totals.waitMs += current.waitMs ?? 0
    totals.compactionMs += current.compactionMs
    for (const item of current.steps) {
      totals.steps++
      totals.failures += item.failures; totals.retryWaitMs += item.retryWaitMs
      const model = item.model
      if (model?.end !== undefined) {
        totals.modelMs += Math.max(0, model.end - model.start)
        if (model.firstToken !== undefined) totals.firstTokenMs += Math.max(0, model.firstToken - model.start)
        totals.input += model.input ?? 0; totals.cached += model.cached ?? 0; totals.output += model.output ?? 0
        totals.reasoning += model.reasoning ?? 0
      }
      // Results come back in completion order; each call is charged from the later of its call and the result before it.
      let previous = -Infinity
      for (const tool of [...item.tools].filter(tool => tool.end !== undefined).sort((a, b) => a.end! - b.end!)) {
        const ms = Math.max(0, tool.end! - Math.max(tool.start, previous))
        previous = tool.end!
        totals.toolMs += ms
        const total = byTool.get(tool.name) ?? { name: tool.name, calls: 0, ms: 0, maxMs: 0, errors: 0 }
        total.calls++; total.ms += ms; total.maxMs = Math.max(total.maxMs, tool.end! - tool.start); if (tool.error) total.errors++
        byTool.set(tool.name, total)
      }
    }
  }
  return { sessionId, ...events[0] ? { startedAt: events[0].time } : {}, ...lastAt !== undefined ? { lastAt } : {}, totals,
    tools: [...byTool.values()].sort((a, b) => b.ms - a.ms), turns }
}
