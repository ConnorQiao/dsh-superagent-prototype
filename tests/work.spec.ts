// How a ticket's worker Session spent its time, read from its event log (`src/app/views/work.ts`).
import { expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { workTimeline } from '../src/app/views/work.ts'

let seq = 0
const event = (time: number, type: string, data: unknown) => ({ type, seq: seq++, time, data }) as unknown as SessionEvent
const text = (value: string) => [{ type: 'text', text: value }]
const assignment = JSON.stringify({ ticket_id: 't1', title: '确认能否读日报', assignment: 'Scope: …' })

it('times each step: the model from its request to its message, its first token, its tokens, and the retries before it', () => {
  const events = [
    event(0, 'turn/start', { turn: 1 }),
    event(5, 'step/start', { turn: 1, step: 1 }),
    event(6, 'user/message', { id: 'm1', role: 'user', content: text(assignment), source: { kind: 'dsh-superagent', form: 'relay' } }),
    event(7, 'user/message', { role: 'user', content: text('<system-reminder>cwd'), source: { kind: 'runtime-context', form: 'snapshot' } }),
    event(10, 'request/header', { header: {}, reason: 'initial' }),
    event(400, 'assistant/attempt', { turn: 1, step: 1, stream: [] }),
    event(400, 'llm/retry', { turn: 1, step: 1, delayMs: 2000, retry: 1, failure: { kind: 'rate-limit', message: '429 Too Many Requests' } }),
    event(2400, 'request/header', { header: {}, reason: 'retry' }),
    event(5400, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: text('先查一下。') },
      stream: [{ type: 'text-chunks', time0: 3400, index: 0, dt: [10], texts: ['先', '查'] }],
      usage: { inputTokens: 20_000, outputTokens: 300, cacheReadTokens: 18_000, reasoningTokens: 120 } }),
    // Two parallel calls: the second finishes first, so the first is charged only for the time after it.
    event(5400, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"lark-cli docs +fetch"}' }),
    event(5400, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'ff_chat_history', arguments: '{}' }),
    event(6400, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c2', content: text('history') } }),
    event(9400, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', isError: true, content: text('exit 1') } }),
    event(9400, 'step/end', { turn: 1, step: 1 }),
    event(9500, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const timeline = workTimeline('worker-t1', events)
  const [step] = timeline.turns[0]!.steps
  expect(step).toMatchObject({ failures: 1, retryWaitMs: 2000, retryReasons: ['429 Too Many Requests'], text: '先查一下。',
    model: { start: 2400, firstToken: 3400, end: 5400, input: 20_000, cached: 18_000, output: 300, reasoning: 120 } })
  expect(step!.tools.map(tool => [tool.name, tool.end! - tool.start, tool.error ?? false])).toEqual([['bash', 4000, true],
    ['ff_chat_history', 1000, false]])
  expect(timeline.totals).toMatchObject({ turns: 1, steps: 1, activeMs: 9500, modelMs: 3000, firstTokenMs: 1000, toolMs: 4000,
    failures: 1, retryWaitMs: 2000, input: 20_000, output: 300 })
  expect(timeline.tools).toEqual([{ name: 'bash', calls: 1, ms: 3000, maxMs: 4000, errors: 1 },
    { name: 'ff_chat_history', calls: 1, ms: 1000, maxMs: 1000, errors: 0 }])
  // Per-step context never reads as what started a turn; superagent's assignment reads as its ticket title.
  expect(timeline.turns[0]!.inputs).toEqual([{ kind: 'assignment', source: 'dsh-superagent', preview: '确认能否读日报', at: 6 }])
})

it('counts the wait between turns, names the background job that ran meanwhile, and reads what started the next turn', () => {
  const events = [
    event(0, 'turn/start', { turn: 1 }),
    event(0, 'step/start', { turn: 1, step: 1 }),
    event(10, 'request/header', { header: {}, reason: 'initial' }),
    event(1000, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [] }),
    event(1000, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"pnpm build"}' }),
    event(6000, 'job/registered', { jobId: 'j1', owner: 'worker-t1', kind: 'bash', label: 'pnpm build', startedAt: 1000,
      toolCall: { callId: 'c1', rootCallId: 'c1' } }),
    event(6000, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: text('moved to the background') } }),
    event(6000, 'step/end', { turn: 1, step: 1 }),
    event(6100, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(126_000, 'job/settled', { jobId: 'j1', owner: 'worker-t1', kind: 'bash', label: 'pnpm build', startedAt: 1000,
      finishedAt: 126_000, status: 'completed', cause: 'producer', producerReported: true, toolCall: { callId: 'c1', rootCallId: 'c1' } }),
    event(126_100, 'turn/start', { turn: 2 }),
    event(126_100, 'step/start', { turn: 2, step: 1 }),
    event(126_100, 'user/message', { role: 'user', content: text('pnpm build exited 0'), source: { kind: 'jobs', form: 'notice',
      summary: 'Job pnpm build completed' } }),
    event(126_200, 'user/message', { role: 'user', content: text('Note from the orchestrator, for context only: 先别改 README'),
      source: { kind: 'dsh-superagent', form: 'relay' } }),
    event(126_300, 'user/message', { role: 'user', content: text(JSON.stringify({ trigger_id: 'e2', from: 'ou_1', text: '好了吗' })),
      source: { kind: 'dsh-superagent', form: 'relay' } }),
  ]
  const timeline = workTimeline('worker-t1', events)
  const [first, second] = timeline.turns
  expect(first!.steps[0]!.tools[0]!.job).toEqual({ label: 'pnpm build', settled: 126_000, status: 'completed' })
  expect(second).toMatchObject({ turn: 2, waitMs: 120_000, waitJobs: ['pnpm build'] })
  expect(second!.end).toBeUndefined()
  expect(second!.inputs.map(input => [input.kind, input.preview])).toEqual([['notice', 'Job pnpm build completed'],
    ['note', '先别改 README'], ['message', '好了吗']])
  // An open turn counts up to the last event.
  expect(timeline.totals).toMatchObject({ turns: 2, waitMs: 120_000, activeMs: 6100 + 200 })
})

it('has nothing to show for a Session with no events', () => {
  expect(workTimeline('worker-t1', [])).toMatchObject({ sessionId: 'worker-t1', turns: [], tools: [], totals: { turns: 0, steps: 0 } })
})

it('reads the launch message by its ticket title and a Feishu post by its words', () => {
  const post = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: '在查：群里最近的分工' }]] } })
  const timeline = workTimeline('worker-t1', [
    event(0, 'turn/start', { turn: 1 }),
    event(0, 'step/start', { turn: 1, step: 1 }),
    event(1, 'user/message', { role: 'user', content: text(JSON.stringify({ ticket_id: 't1', title: '整理群聊成文档',
      trigger: { trigger_id: 'e1', from: 'ou_1', text: '@FF 整理一下' } })), source: { kind: 'dsh-superagent', form: 'relay' } }),
    event(2, 'user/message', { role: 'user', content: text(JSON.stringify({ ticket_id: 't1', assignment: 2 })),
      source: { kind: 'dsh-superagent', form: 'relay' } }),
    event(3, 'user/message', { role: 'user', content: text(JSON.stringify({ trigger_id: 'e2', from: 'ou_bot', text: post })),
      source: { kind: 'dsh-superagent', form: 'relay' } }),
  ])
  expect(timeline.turns[0]!.inputs.map(input => [input.kind, input.preview])).toEqual([['assignment', '整理群聊成文档'],
    ['assignment', '#2'], ['message', '在查：群里最近的分工']])
})
