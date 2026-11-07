import { adminHeaders, createApp } from '../src/app'
import { db } from './database'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

let app: ReturnType<typeof createApp>

// The admin as npm run build writes it, served as sorlo start serves it, next to a file it mustn't serve
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'sorlo-admin-'))
  const admin = join(root, 'dist')
  await mkdir(join(admin, 'assets'), { recursive: true })
  await writeFile(join(admin, 'index.html'), '<script type="module" src="/admin/assets/index-abc.js"></script>')
  await writeFile(join(admin, 'assets/index-abc.js'), 'console.log("admin")')
  await writeFile(join(root, 'secret.txt'), 'secret')
  app = createApp(db, new Map(), { admin })
})
afterAll(() => db.destroy())

test('serves the built admin at /admin/, and browsers check for a new page each time', async () => {
  for (const path of ['/admin', '/admin/', '/admin/index.html']) {
    const page = await app.request(path)
    expect(page.status, path).toBe(200)
    expect(page.headers.get('content-type')).toMatch(/^text\/html/)
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(await page.text()).toContain('/admin/assets/index-abc.js')
  }

  // Each build names new files, so they can be cached as usual
  const script = await app.request('/admin/assets/index-abc.js')
  expect(script.headers.get('content-type')).toMatch(/^text\/javascript/)
  expect(script.headers.get('cache-control')).toBeNull()
  expect(await script.text()).toBe('console.log("admin")')
})

test("no other site can frame the admin, its page or its files, but the API's replies are left alone", async () => {
  expect(adminHeaders).toEqual({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" })
  for (const path of ['/admin/', '/admin/assets/index-abc.js']) {
    const reply = await app.request(path)
    expect(reply.headers.get('x-frame-options'), path).toBe('DENY')
    expect(reply.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'")
  }

  const api = await app.request('/api/types')
  expect(api.headers.get('x-frame-options')).toBeNull()
  expect(api.headers.get('content-security-policy')).toBeNull()
})

test("serves nothing that isn't in the build", async () => {
  for (const path of [
    '/admin/assets/index-old.js',
    '/admin/..%2Fsecret.txt',
    '/admin/%2e%2e%2fsecret.txt',
    '/admin/assets/..%5c..%5csecret.txt',
  ]) {
    expect((await app.request(path)).status, path).toBe(404)
  }
})
