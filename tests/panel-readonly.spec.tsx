// @vitest-environment jsdom
// The panel embedded read-only in another page, and a ticket's work as its worker Session did it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { caller, ApiError } from '../src/client/api.ts'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, all, click, text, tab, find } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const READ_ONLY = { base: '/proxy/ff-agent/', readOnly: true }

it('shows everything but Settings read-only through the path the page proxies the API under, and asks for nothing but reads', async () => {
  server.base = READ_ONLY.base
  await mount(zh, READ_ONLY)
  expect(all('[role="tab"]').map(item => item.textContent)).not.toContain(zh['tab.settings'])
  expect(all('button').map(button => button.textContent)).not.toContain(zh.openMaster)
  await click(tab(zh['tab.execution']))
  expect(text()).toContain(zh.executorRunning)
  expect(all('button').map(button => button.textContent)).not.toContain(zh.pauseProcessing)
  expect(all('.dt-status-head button').map(button => button.textContent)).not.toContain(zh['tab.settings'])
  await click(find('修复回归', '.dt-open'))
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  const buttons = all('button').map(button => button.textContent)
  for (const action of [zh.stop, zh.retry, zh.openSession]) expect(buttons).not.toContain(action)
  // The policy version is a plain value: there is no Settings to open it in.
  expect(all('.dt-kv .dt-mono').map(item => item.tagName)).toContain('SPAN')
  expect(server.requests.length).toBeGreaterThan(0)
  expect(server.requests.filter(request => request.method !== 'GET')).toEqual([])
})

it('refuses a change before it leaves a read-only page', async () => {
  const call = caller(() => ({ offline: 'offline', notRunning: 'not running', readOnly: zh.readOnlyRefused, serverError: () => 'server',
    requestFailed: () => 'request', setup: () => 'setup', user: () => 'user' }), READ_ONLY)
  const refused = await call('POST executor/pause', { body: { paused: true } }).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(ApiError)
  expect(refused).toMatchObject({ status: 405, message: zh.readOnlyRefused })
  expect(server.requests).toEqual([])
})

it('opens a remembered Settings route on the Overview when read-only', async () => {
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'settings', query: { group: 'eval' } }, stack: [] }))
  server.base = READ_ONLY.base
  await mount(zh, READ_ONLY)
  expect(all('[role="tab"][aria-selected="true"]').map(item => item.textContent)).toEqual([zh['tab.overview']])
})

it('shows on a ticket where its work spent the time: totals, time by tool, and each turn step by step', async () => {
  await mount()
  await click(tab(zh['tab.execution']))
  await click(find('修复回归', '.dt-open'))
  const work = all('.dt-section').find(section => section.querySelector('.dt-section-name')?.textContent === zh.workTitle)!
  expect(work).toBeDefined()
  const stats = [...work.querySelectorAll('.dt-stat')].map(stat => stat.textContent)
  expect(stats).toContain(`${zh.workActive}2 分 40 秒`)
  expect(stats).toContain(`${zh.workTools}2 分 5 秒`)
  expect(stats).toContain(`${zh.workRetries}失败 1 次，等了 2.0 秒`)
  expect([...work.querySelectorAll('.dt-work-tools tbody tr')].map(row => [...row.children].map(cell => cell.textContent)))
    .toEqual([['bash', '1', '2 分 0 秒', '2 分 0 秒'], ['orchestrator_report', '1', '5.0 秒', '5.0 秒']])
  // The last turn opens by itself.
  expect(work.textContent).toContain('第 1 步')
  expect(work.textContent).toContain('模型 6.0 秒（首字 3.0 秒，输出 400 token）')
  expect(work.textContent).toContain('转到后台：pnpm test，共 2 分 0 秒（completed）')
  expect(work.textContent).toContain('分派')
  expect(server.requests.some(request => request.path === 'tickets/t1/timeline' && request.method === 'GET')).toBe(true)
})

it('mounts on a page outside DeepSeek Harness read-only, with the DSH tokens its stylesheet reads', async () => {
  const { mount: mountStandalone } = await import('../src/client/standalone.tsx')
  const { act } = await import('react')
  server.base = READ_ONLY.base
  const element = document.createElement('div'); document.body.append(element)
  let unmount = () => {}
  await act(async () => { unmount = mountStandalone(element, { base: READ_ONLY.base }) })
  await vi.waitFor(() => expect(element.querySelector('[role="tab"]')).not.toBeNull())
  expect([...element.querySelectorAll('[role="tab"]')].map(item => item.textContent)).not.toContain(zh['tab.settings'])
  // The token sheet, then the panel's own stylesheet (vitest loads both as empty text; the next test reads the sheet itself).
  expect(element.querySelectorAll('style').length).toBe(2)
  expect(window.DshSuperagentPanel?.mount).toBe(mountStandalone)
  act(() => { unmount() })
  element.remove()
  expect(server.requests.filter(request => request.method !== 'GET')).toEqual([])
})

it('carries every DSH token the panel stylesheet reads, for a page without the DSH theme', () => {
  const read = (name: string) => readFileSync(join(process.cwd(), 'src/client', name), 'utf8')
  const tokens = new Set([...read('standalone-theme.css').matchAll(/(--[\w-]+):/g)].map(match => match[1]))
  // `--dt-*` are the panel's own; `--dsh-frame-top-clearance` is DSH's window frame, read with a fallback.
  const read_ = [...read('client.css').matchAll(/var\((--[\w-]+)/g)].map(match => match[1]!)
    .filter(name => !name.startsWith('--dt-') && name !== '--dsh-frame-top-clearance')
  expect([...new Set(read_)].filter(name => !tokens.has(name))).toEqual([])
})
