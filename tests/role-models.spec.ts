import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentModel, modelSelectionProjectionDefinition, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { initializeRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
const HOST = { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }
/**
 * An Agent whose model reads the Session through DSH's own model-selection fold, as the Agent loop does before each step: that
 * choice routes the step's request and fills its prompt's `provider` and `model` variables. No Session Controller is provided, so
 * saving the DSH default through `selectModel` would fail.
 */
function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  const resolve = vi.fn(async (value: unknown) => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const state = () => session.snapshotEvents().reduce((current, event) => modelSelectionProjectionDefinition.apply(current, event),
    modelSelectionProjectionDefinition.init(session.header, SessionLogOffset(0)))
  const agent = { ctx, session, model: new AgentModel(state, session, HOST) } as unknown as Agent
  const selections = () => session.snapshotEvents().filter(event => event.type === 'model/selection')
  return { ctx, agent, session, resolve, flush, selections }
}
it('records the role model as a new Session\'s selection, for its next step, and saves it', async () => {
  const { ctx, agent, flush, selections } = fixture()
  expect(agent.model.current()).toEqual(HOST)
  await initializeRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect(agent.model.current()).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(selections()).toHaveLength(1)
  expect(flush).toHaveBeenCalledOnce()
})
it('keeps the configured reasoning effort', async () => {
  const { ctx, agent } = fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'deep', reasoningEffort: 'low' })
  expect(agent.model.current()).toEqual({ provider: 'worker', model: 'deep', reasoningEffort: 'low' })
})
it('lets a later explicit selection win', async () => {
  const { ctx, agent } = fixture()
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  agent.model.select(manual)
  expect(agent.model.current()).toEqual(manual)
})
it.each(['header', 'selection'])('preserves a resumed Session with an existing %s', async kind => {
  const { ctx, agent, session, resolve, selections } = fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'header') session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else session.append('model/selection', existing)
  await initializeRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).not.toHaveBeenCalled()
  expect(selections()).toHaveLength(kind === 'header' ? 0 : 1)
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, selections } = fixture()
  await initializeRoleModel(ctx, agent, null)
  expect(agent.model.current()).toEqual(HOST)
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  await expect(initializeRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(selections()).toHaveLength(0)
  expect(agent.model.current()).toEqual(HOST)
})
