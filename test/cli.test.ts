import { afterAll, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { serveFixtures } from './helpers/server.js'

const run = promisify(execFile)
const srv = await serveFixtures('fixtures')
afterAll(() => srv.close())

const cli = (...args: string[]) =>
  run('npx', ['tsx', 'src/cli.ts', ...args], { encoding: 'utf8' })

test('layout prints the tree', async () => {
  const { stdout } = await cli('layout', `${srv.url}/basic/index.html`)
  expect(stdout).toContain('header#top (0,0 1280x64)')
}, 60_000)

test('layout --selector scopes to a subtree', async () => {
  const { stdout } = await cli('layout', `${srv.url}/basic/index.html`, '--selector', 'main')
  expect(stdout.split('\n')[0]).toMatch(/^main \(0,64/)
  expect(stdout).not.toContain('header#top')
}, 60_000)

test('layout --selector with no match exits 2', async () => {
  const err = await cli('layout', `${srv.url}/basic/index.html`, '--selector', '.nope').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain("No element matching '.nope'")
}, 60_000)

test('check exits 1 with violations and names a suspect rule', async () => {
  const err = await cli('check', `${srv.url}/overflow-h/index.html`).catch((e) => e)
  expect(err.code).toBe(1)
  expect(err.stdout).toContain('viewport-overflow')
  expect(err.stdout).toContain('div.wide')
  expect(err.stdout).toMatch(/suspect: width: 1400px/)
}, 60_000)

test('check exits 0 on a clean page', async () => {
  const { stdout } = await cli('check', `${srv.url}/basic/index.html`)
  expect(stdout).toContain('no violations')
}, 60_000)

test('explain traces the cascade', async () => {
  const { stdout } = await cli('explain', `${srv.url}/cascade/index.html`, '--selector', '.sidebar', '--property', 'width')
  expect(stdout).toContain('✓ width: 300px')
}, 60_000)

test('layout --viewport WxH emulates the given viewport', async () => {
  const { stdout } = await cli('layout', `${srv.url}/basic/index.html`, '--viewport', '500x800')
  expect(stdout).toContain('body (0,0 500x')
}, 60_000)

test('--viewport with a malformed value exits 2', async () => {
  const err = await cli('layout', `${srv.url}/basic/index.html`, '--viewport', 'nope').catch((e) => e)
  expect(err.code).toBe(2)
  expect(err.stderr).toContain('--viewport must be WxH')
}, 60_000)

test('layout on a deep tree defaults to the 400-line budget with a truncation note', async () => {
  const { stdout } = await cli('layout', `${srv.url}/deep/index.html`)
  const lines = stdout.trimEnd().split('\n')
  expect(lines.length).toBeLessThanOrEqual(400)
  expect(stdout).toContain('truncated to depth')
}, 60_000)

test('layout --depth on a deep tree disables the budget', async () => {
  const { stdout } = await cli('layout', `${srv.url}/deep/index.html`, '--depth', '500')
  const lines = stdout.trimEnd().split('\n')
  expect(lines.length).toBeGreaterThan(400)
  expect(stdout).not.toContain('truncated to depth')
}, 60_000)
