/** A ticket's work as its worker Session did it: where the time went (model, tools, waits), then each turn step by step. */
import { useState } from 'react'
import { usePoll, type WorkTimelineView } from './api.ts'
import { DisclosureRow, Icon } from './controls.tsx'
import { usePanel } from './provider.tsx'
import type { T } from './text.ts'
import { Hint, LoadState, Section } from './widgets.tsx'

type Turn = WorkTimelineView['turns'][number]
type Step = Turn['steps'][number]

/** A span of milliseconds in the units a person reads it in: milliseconds under a second, then seconds, minutes, hours. */
export function duration(t: T, ms: number): string {
  if (ms < 1000) return t('durationMs', { n: Math.round(ms) })
  const seconds = Math.round(ms / 1000)
  if (ms < 10_000) return t('durationS', { n: (ms / 1000).toFixed(1) })
  if (seconds < 60) return t('durationS', { n: seconds })
  if (seconds < 3600) return t('durationM', { m: Math.floor(seconds / 60), s: seconds % 60 })
  return t('durationH', { h: Math.floor(seconds / 3600), m: Math.floor(seconds % 3600 / 60) })
}
const clock = (t: T, ms: number) => new Date(ms).toLocaleTimeString(t('lang') === 'en' ? 'en' : 'zh-CN', { hour12: false })
const tokens = (count: number) => count >= 10_000 ? `${(count / 1000).toFixed(0)}k` : String(count)
/** Why a turn ended other than completing, in DSH's words (`TurnEndReasonMap`); a reason a plugin added reads as its code. */
const END_REASONS = ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked'] as const
const endReason = (t: T, reason: string) => (END_REASONS as readonly string[]).includes(reason)
  ? t(`workEnd.${reason as typeof END_REASONS[number]}`) : reason

function Stat({ label, value }: { label: string; value: string }) {
  return <span className="dt-stat"><span className="dt-stat-label">{label}</span><span className="dt-stat-value">{value}</span></span>
}
function Totals({ data, queuedMs }: { data: WorkTimelineView; queuedMs: number | undefined }) {
  const { t } = usePanel()
  const { totals } = data
  // DSH counts a call's input without what it read from the cache, so the whole input is both together.
  const input = totals.input + totals.cached
  const cached = input ? Math.round(totals.cached / input * 100) : 0
  return <div className="dt-stats">
    {queuedMs !== undefined && queuedMs >= 1000 && <Stat label={t('workQueued')} value={duration(t, queuedMs)} />}
    <Stat label={t('workActive')} value={duration(t, totals.activeMs)} />
    {totals.waitMs > 0 && <Stat label={t('workWait')} value={duration(t, totals.waitMs)} />}
    <Stat label={t('workModel')} value={t('workModelTotal', { duration: duration(t, totals.modelMs), first: duration(t,
      totals.firstTokenMs) })} />
    <Stat label={t('workTools')} value={duration(t, totals.toolMs)} />
    <Stat label={t('workSteps')} value={String(totals.steps)} />
    <Stat label={t('workTokens')} value={t('workTokensValue', { input: tokens(input), cached, output: tokens(totals.output) })} />
    {totals.failures > 0 && <Stat label={t('workRetries')} value={t('workRetriesValue', { count: totals.failures,
      duration: duration(t, totals.retryWaitMs) })} />}
    {totals.compactionMs > 0 && <Stat label={t('workCompaction')} value={duration(t, totals.compactionMs)} />}
  </div>
}
function ToolTotals({ tools }: { tools: WorkTimelineView['tools'] }) {
  const { t } = usePanel()
  if (!tools.length) return null
  return <table className="dt-table dt-work-tools">
    <thead><tr><th>{t('workToolHead')}</th><th>{t('workCallsHead')}</th><th>{t('workTotalHead')}</th><th>{t('workLongestHead')}</th></tr></thead>
    <tbody>{tools.slice(0, 8).map(tool => <tr key={tool.name}>
      <td className="dt-mono">{tool.name}{tool.errors > 0 && <span className="dt-work-error"> {t('workErrors', { count: tool.errors })}</span>}</td>
      <td>{tool.calls}</td><td>{duration(t, tool.ms)}</td><td>{duration(t, tool.maxMs)}</td>
    </tr>)}</tbody>
  </table>
}
function StepLine({ step, live }: { step: Step; live: boolean }) {
  const { t } = usePanel()
  const { model } = step
  const modelText = model?.end !== undefined ? t('workModelLine', { duration: duration(t, model.end - model.start),
    first: model.firstToken !== undefined ? duration(t, model.firstToken - model.start) : '—', output: model.output ?? 0 })
    : live && step.end === undefined ? t('workModelPending') : t('workModelNone')
  return <li className="dt-work-step">
    <div className="dt-work-step-head">
      <span className="dt-work-step-name">{t('workStep', { step: step.step })}</span>
      <span className="dt-work-clock">{clock(t, step.start)}</span>
      <span>{modelText}</span>
      {step.failures > 0 && <span className="dt-work-error">{t('workRetriesValue', { count: step.failures,
        duration: duration(t, step.retryWaitMs) })}</span>}
    </div>
    {step.retryReasons.length > 0 && <p className="dt-hint dt-clamp">{step.retryReasons.join(' / ')}</p>}
    {step.text && <p className="dt-work-text">{step.text}</p>}
    {step.tools.length > 0 && <ul className="dt-work-calls">{step.tools.map(tool => <li key={tool.callId} className="dt-work-call">
      <div className="dt-work-call-head">
        <span className="dt-mono">{tool.name}</span>
        <span>{tool.end !== undefined ? duration(t, tool.end - tool.start) : t('workToolRunning')}</span>
        {tool.error && <span className="dt-work-error">{t('workToolError')}</span>}
        {tool.job && <span className="dt-hint">{t(tool.job.settled !== undefined ? 'workJobSettled' : 'workJobRunning', { label: tool.job.label,
          duration: tool.job.settled !== undefined ? duration(t, tool.job.settled - tool.start) : '', status: tool.job.status ?? '' })}</span>}
      </div>
      {tool.args && <p className="dt-work-args dt-mono">{tool.args}</p>}
      {tool.result && <p className="dt-work-result dt-mono">{tool.result}</p>}
    </li>)}</ul>}
  </li>
}
function TurnRow({ turn, open, onToggle, live }: { turn: Turn; open: boolean; onToggle: () => void; live: boolean }) {
  const { t } = usePanel()
  const ended = turn.end !== undefined
  const spent = (turn.end ?? turn.steps.at(-1)?.end ?? turn.start) - turn.start
  const title = <span className="dt-work-turn-title">
    <span>{t('workTurn', { turn: turn.turn })}</span>
    <span className="dt-hint">{t('workTurnMeta', { time: clock(t, turn.start), duration: duration(t, spent), steps: turn.steps.length })}</span>
    {turn.reason && turn.reason !== 'completed' && <span className="dt-work-error">{endReason(t, turn.reason)}</span>}
    {!ended && live && <span className="dt-hint">{t('workTurnOpen')}</span>}
  </span>
  return <DisclosureRow icon={<Icon name="queue" />} title={title} open={open} onToggle={onToggle}>
    <div className="dt-disclosure-body dt-work-turn">
      {turn.waitMs !== undefined && turn.waitMs >= 1000 && <Hint>{t(turn.waitJobs?.length ? 'workWaitedJobs' : 'workWaited',
        { duration: duration(t, turn.waitMs), jobs: (turn.waitJobs ?? []).join(t('listSeparator')) })}</Hint>}
      {turn.inputs.length > 0 && <ul className="dt-work-inputs">{turn.inputs.map((input, index) => <li key={index}>
        <span className="dt-work-input-kind" title={input.source}>{t(`workInput.${input.kind}`)}</span>
        <span className="dt-work-clock">{clock(t, input.at)}</span>{input.preview && <span className="dt-clamp">{input.preview}</span>}
      </li>)}</ul>}
      {turn.compactionMs > 0 && <Hint>{t('workCompacted', { duration: duration(t, turn.compactionMs) })}</Hint>}
      <ol className="dt-work-steps">{turn.steps.map(step => <StepLine key={step.step} step={step} live={live && !ended} />)}</ol>
    </div>
  </DisclosureRow>
}

/**
 * The ticket page's account of its work, read from the worker Session's log; refreshed while the ticket works.
 * @param createdAt - when the ticket was created, so the wait for an Executor slot before the first turn shows.
 */
export function WorkTimeline({ id, live, createdAt }: { id: string; live: boolean; createdAt: string }) {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET tickets/:id/timeline', { id }), [id], live ? 5000 : 60_000)
  const [opened, setOpened] = useState<Record<number, boolean>>({})
  if (!data) return <Section title={t('workTitle')} icon="queue"><LoadState error={error} loading /></Section>
  const last = data.turns.at(-1)?.turn
  const queuedMs = data.startedAt !== undefined ? data.startedAt - new Date(createdAt).getTime() : undefined
  return <Section title={t('workTitle')} icon="queue" hint={t('workHint')}>
    {error && <LoadState error={error} loading={false} />}
    {data.turns.length ? <>
      <Totals data={data} queuedMs={queuedMs} />
      <ToolTotals tools={data.tools} />
      <div className="dt-work-turns">{data.turns.map(turn => <TurnRow key={turn.turn} turn={turn} live={live}
        open={opened[turn.turn] ?? turn.turn === last} onToggle={() => setOpened({ ...opened, [turn.turn]: !(opened[turn.turn]
          ?? turn.turn === last) })} />)}</div>
    </> : <Hint>{t('workNone')}</Hint>}
  </Section>
}
