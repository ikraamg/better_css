import { afterAll, expect, test } from 'vitest'
import { serveFixtures } from './helpers/server.js'

const srv = await serveFixtures('fixtures')
afterAll(() => srv.close())

test('serves fixture html with content-type', async () => {
  const res = await fetch(`${srv.url}/basic/index.html`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/html')
  expect(await res.text()).toContain('<header')
})

test('404s on missing files', async () => {
  const res = await fetch(`${srv.url}/nope.html`)
  expect(res.status).toBe(404)
})
