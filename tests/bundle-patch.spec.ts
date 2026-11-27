/** The bundle's patch, read with the entry-list dialect DSH reads bundle patches with, and the agent preset it defines. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ROUTER_PRESET, WORKER_PRESET } from '../src/app/sessions.ts'

interface Row { id?: string; name: string; disabled?: unknown; config?: Record<string, unknown> & { plugins?: Row[] } | Row[] }
/** The patch as DSH reads it: Cordis's include plugin parses `!!js` scalars, and applies the inserts to an entry list. */
async function patched(): Promise<Row[]> {
  const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
  const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
  const { entryListSchema, applyEntryPatches } = await import(include) as {
    entryListSchema: unknown; applyEntryPatches(data: Row[], patches: unknown[], warn: (message: string) => void): Row[] }
  const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
  const patches = yaml.load(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as unknown[]
  const warnings: string[] = []
  const rows = applyEntryPatches([], patches, message => { warnings.push(message) })
  expect(warnings).toEqual([])
  return rows
}
/** A config as DSH's loader hands it to its plugin, with its `!!js` values evaluated, here under the given environment. */
async function interpolated(config: unknown, env: Record<string, string>): Promise<unknown> {
  const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
  const { interpolate } = await import(cordis.resolve('@deepseek-ai/cordis-plugin-loader')) as { interpolate(ctx: object, value: unknown): unknown }
  const saved = Object.entries(env).map(([name]) => [name, process.env[name]] as const)
  Object.assign(process.env, env)
  try {
    return interpolate({}, config)
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
const FOREGROUND = 'DSH_SUPERAGENT_WORKER_FOREGROUND_MS', JOB_WAIT = 'DSH_SUPERAGENT_WORKER_JOB_WAIT_MS'

/** Every plugin row of a preset, those inside groups too. */
const flat = (rows: readonly Row[]): Row[] => rows.flatMap(row => [row, ...Array.isArray(row.config) ? flat(row.config) : []])

/** A preset the patch defines, by its id. */
const presetOf = (rows: readonly Row[], id: string) => rows.map(row => row.config as { id?: string; order?: number; plugins: Row[] })
  .find(config => config?.id === id)!

it('defines the worker preset Executor Sessions run under, with a shell that moves long commands to the background', async () => {
  const rows = await patched()
  expect(rows.map(row => row.id)).toEqual(['dsh-superagent', 'dsh-superagent-github', 'dsh-superagent-feishu', 'dsh-superagent-worker-preset',
    'dsh-superagent-router-preset'])
  const preset = presetOf(rows, WORKER_PRESET)
  expect(preset.id).toBe(WORKER_PRESET)
  const plugins = flat(preset.plugins)
  const named = (name: string) => plugins.filter(row => row.name === name).map(row => row.config)
  // 5 seconds unless DSH's environment sets the waits.
  const waits = async (env: Record<string, string>) => ({
    bash: await interpolated(named('@deepseek-ai/dsh-bash-sandbox'), env),
    pwsh: await interpolated(named('@deepseek-ai/dsh-pwsh-sandbox'), env),
    jobs: await interpolated(named('@deepseek-ai/dsh-tool-jobs'), env),
  })
  const expected = (foreground: number, job: number) => ({ bash: [{ timeoutMs: foreground, maxTimeoutMs: foreground }],
    pwsh: [{ timeoutMs: foreground, maxTimeoutMs: foreground }], jobs: [{ waitTimeoutMs: job, maxWaitTimeoutMs: job }] })
  expect(await waits({ [FOREGROUND]: '', [JOB_WAIT]: '' })).toEqual(expected(5000, 5000))
  expect(await waits({ [FOREGROUND]: '30000', [JOB_WAIT]: '60000' })).toEqual(expected(30_000, 60_000))
  // A value DSH's shell or job tool would refuse, or one past ten minutes, falls back to 5 seconds rather than failing the preset.
  for (const value of ['0', '-1', '999', 'abc', '600001', 'Infinity']) {
    expect(await waits({ [FOREGROUND]: value, [JOB_WAIT]: value }), value).toEqual(expected(5000, 5000))
  }
  // web_fetch through DSH's anonymous fetcher; DSH's own web_search needs a DeepSeek account or key, so search comes from toolModules.
  expect(named('@deepseek-ai/dsh-tool-web')).toEqual([{ search: false, fetch: true }])
  // Spawned subagents run under standard, whose shell moves a command to the background only after 60 s; forked ones, which would run under
  // this preset, are left out.
  expect(named('@deepseek-ai/dsh-tool-subagent')).toEqual([expect.objectContaining({ provider: 'spawn', agentPreset: 'standard' })])
  // What a worker needs, and none of what asks a person, presents, plans, changes the profile, schedules, sets goals or runs workflows.
  for (const name of ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-tool-result-pruner', '@deepseek-ai/dsh-agent-instructions']) expect(named(name).length).toBeGreaterThan(0)
  const names = plugins.map(row => row.name)
  for (const name of ['@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plan-mode', '@deepseek-ai/dsh-plugin-manager/tools',
    '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-command-goal',
    '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names).not.toContain(name)
})

it('defines the router preset the main Session runs under: 5-second shell and job waits, and only the tools it uses', async () => {
  const rows = await patched()
  const router = presetOf(rows, ROUTER_PRESET)
  expect(router.order).toBe(91)
  const plugins = flat(router.plugins)
  const named = (preset: Row[], name: string) => preset.filter(row => row.name === name).map(row => row.config)
  // The worker's waits from DSH's environment leave the main Session's alone.
  const env = { [FOREGROUND]: '30000', [JOB_WAIT]: '60000' }
  expect(await interpolated(named(plugins, '@deepseek-ai/dsh-bash-sandbox'), env)).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
  expect(await interpolated(named(plugins, '@deepseek-ai/dsh-pwsh-sandbox'), env)).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
  expect(await interpolated(named(plugins, '@deepseek-ai/dsh-tool-jobs'), env)).toEqual([{ waitTimeoutMs: 5000, maxWaitTimeoutMs: 5000 }])
  // The tools its allow list keeps: skill, bash, read, read_image and the job tools; the file tools only read.
  for (const name of ['@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-tool-result-pruner']) expect(named(plugins, name).length, name).toBeGreaterThan(0)
  expect(named(plugins, '@deepseek-ai/dsh-tool-fs')).toEqual([{ write: false, edit: false }])
  // web_fetch, so it can answer a quick lookup itself; no DSH web_search. DSH's scheduled tasks, delivered to it (schedules.ts).
  expect(named(plugins, '@deepseek-ai/dsh-tool-web')).toEqual([{ search: false, fetch: true }])
  expect(named(plugins, '@deepseek-ai/dsh-tool-schedule')).toHaveLength(1)
  const names = plugins.map(row => row.name)
  for (const name of ['@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plan-mode',
    '@deepseek-ai/dsh-plugin-manager/tools', '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names, name).not.toContain(name)
})
