import { createApp } from '../src/app'
import { uuidv7 } from '../src/db'
import { createApiKey } from '../src/delivery'
import { db } from './database'
import { setUp, types } from './fixtures'
import { FSDriver } from 'flydrive/drivers/fs'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

// The storage folder sits inside a temporary folder that also holds a file it mustn't serve
const root = await mkdtemp(join(tmpdir(), 'iight-media-'))
const location = join(root, 'storage')
const storage = { default: 'local', services: { local: () => new FSDriver({ location, visibility: 'public' }) } }
const app = createApp(db, types, { storage })
// A site that sets its own types, size limit and caching
const configured = createApp(db, types, {
  storage,
  media: { types: ['image/png', 'application/zip', 'application/xml'], maxFileSize: 1024, cacheControl: 'no-store' },
})
let cookie: string
let userId: string

beforeAll(async () => {
  ;({ cookie, userId } = await setUp())
  await writeFile(join(root, 'secret.txt'), 'secret')
})
beforeEach(async () => {
  await db.deleteFrom('media').execute()
  await rm(location, { recursive: true, force: true })
})
afterAll(async () => {
  await db.destroy()
  await rm(root, { recursive: true, force: true })
})

// Browsers send an Origin header with every POST, PUT and DELETE, which the CSRF check needs
const headers = () => ({ cookie, origin: 'http://localhost' })

const send = async (method: string, path: string, body?: unknown) => {
  const init = body === undefined ? {} : { body: JSON.stringify(body) }
  const response = await app.request(`/api${path}`, {
    method,
    headers: { ...headers(), 'content-type': 'application/json' },
    ...init,
  })
  return { status: response.status, body: response.status === 204 ? null : await response.json() }
}

const upload = async (bytes: Uint8Array | string, name: string, to = app) => {
  const body = new FormData()
  body.append('file', new File([bytes as BlobPart], name))
  const response = await to.request('/api/media', { method: 'POST', headers: headers(), body })
  return { status: response.status, body: await response.json() }
}

const image = (format: 'png' | 'jpeg' | 'gif' | 'webp' | 'avif', width = 3, height = 2) =>
  sharp({ create: { width, height, channels: 3, background: '#c00' } })
    [format]()
    .toBuffer()

const latin1 = (text: string) => Buffer.from(text, 'latin1')

// The ftyp box an ISO media file starts with, such as an MP4, MOV, M4A or HEIC file, with its major brand
const ftyp = (brand: string) => latin1(`\0\0\0\x14ftyp${brand}\0\0\0\0${brand}`)

// A ZIP archive's first entry, a.txt
const zip = Buffer.concat([latin1('PK\x03\x04'), Buffer.alloc(22), latin1('\x05\0\0\0a.txthello')])

// The files in the storage folder
const stored = async () => (existsSync(location) ? (await readdir(location)).sort() : [])

const rejection = (message: string) => ({
  status: 422,
  body: { isValid: false, fields: { file: { isValid: false, messages: [message] } } },
})

const unknownType = "This file's type can't be told from its content, so it can't be uploaded."
const sandbox = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

test('needs a session', async () => {
  for (const [method, path] of [
    ['GET', '/api/media'],
    ['POST', '/api/media'],
    ['PUT', `/api/media/${uuidv7()}`],
    ['DELETE', `/api/media/${uuidv7()}`],
  ]) {
    const response = await app.request(path, { method, headers: { origin: 'http://localhost' } })
    expect(response.status).toBe(401)
  }
})

test('uploads an image, stores it under its ID and serves it at its URL', async () => {
  const png = await image('png')
  const { status, body } = await upload(png, 'Team photo.png')
  expect(status).toBe(201)
  expect(body.data).toEqual({
    id: expect.any(String),
    name: 'Team photo.png',
    mime: 'image/png',
    size: png.length,
    width: 3,
    height: 2,
    alt: null,
    caption: null,
    url: `http://localhost/media/${body.data.id}/Team%20photo.png`,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
    createdBy: userId,
  })
  expect(await stored()).toEqual([`${body.data.id}.png`])

  const served = await app.request(body.data.url)
  expect(served.status).toBe(200)
  expect(Object.fromEntries(served.headers)).toMatchObject({
    'content-type': 'image/png',
    'content-length': String(png.length),
    'cache-control': 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  })
  expect(served.headers.get('content-security-policy')).toBeNull()
  expect(Buffer.from(await served.arrayBuffer())).toEqual(png)
})

test('reads the size each type of image shows at, after EXIF rotation', async () => {
  for (const format of ['jpeg', 'gif', 'webp', 'avif'] as const) {
    const { body } = await upload(await image(format, 5, 4), `picture.${format}`)
    expect(body.data).toMatchObject({ name: `picture.${format}`, mime: `image/${format}`, width: 5, height: 4 })
  }

  // A photo taken with the camera on its side is stored landscape, with EXIF saying to turn it
  const rotated = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#c00' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  expect((await upload(rotated, 'portrait.jpg')).body.data).toMatchObject({ width: 2, height: 3 })

  // An image sharp can't read, such as this HEIC that's only a header, is still taken, without a size
  expect((await upload(ftyp('heic'), 'IMG_0001.HEIC')).body.data).toMatchObject({
    name: 'IMG_0001.heic',
    mime: 'image/heic',
    width: null,
    height: null,
  })
})

test('knows video, audio and PDFs by their content', async () => {
  const frame = Buffer.concat([latin1('\xff\xfb\x90\x64'), Buffer.alloc(413)])
  const oggPage = (data: Buffer) =>
    Buffer.concat([latin1('OggS\0\x02'), Buffer.alloc(20), Buffer.from([1, data.length]), data])
  const files = {
    'video/mp4': ftyp('isom'),
    'video/quicktime': ftyp('qt  '),
    'video/webm': latin1('\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm\x42\x87\x81\x04'),
    'video/matroska': latin1('\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x88matroska\x42\x87\x81\x04'),
    'audio/mpeg': Buffer.concat([latin1('ID3\x04\0\0\0\0\0\0'), frame, frame]),
    'audio/x-m4a': ftyp('M4A '),
    'audio/wav': latin1('RIFF\x24\0\0\0WAVEfmt \x10\0\0\0'),
    'audio/ogg': oggPage(Buffer.concat([latin1('\x01vorbis'), Buffer.alloc(22)])),
    'audio/ogg; codecs=opus': oggPage(Buffer.concat([latin1('OpusHead'), Buffer.alloc(11)])),
    'application/pdf': latin1('%PDF-1.7\n'),
  }
  for (const [mime, bytes] of Object.entries(files)) {
    expect((await upload(bytes, 'file')).body.data, mime).toMatchObject({ mime, width: null, height: null })
  }
})

test('rejects files of the wrong type, whatever they are named', async () => {
  expect(await upload('<!doctype html><script>alert(1)</script>', 'photo.png')).toEqual(rejection(unknownType))
  expect(await upload('<html><svg xmlns="http://www.w3.org/2000/svg"></svg></html>', 'page.svg')).toEqual(
    rejection(unknownType),
  )
  // An SVG whose doctype declares entities, as XML bombs do
  const bomb = '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>'
  expect(await upload(bomb, 'bomb.svg')).toEqual(rejection(unknownType))
  expect(await upload('', 'empty.png')).toEqual(rejection(unknownType))
  // A file that only starts like a PNG
  const fake = Buffer.concat([(await image('png')).subarray(0, 8), Buffer.from('<script>alert(1)</script>')])
  expect(await upload(fake, 'fake.png')).toEqual(rejection(unknownType))

  // Types that are known but not allowed say what's allowed
  const allowed = 'Allowed: image/*, video/*, audio/*, application/pdf.'
  expect(await upload(zip, 'photo.jpg')).toEqual(rejection(`ZIP files can't be uploaded. ${allowed}`))
  const xhtml = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'
  expect(await upload(xhtml, 'logo.svg')).toEqual(rejection(`XML files can't be uploaded. ${allowed}`))

  const missing = await app.request('/api/media', { method: 'POST', headers: headers(), body: new FormData() })
  expect({ status: missing.status, body: await missing.json() }).toEqual(rejection('Choose a file to upload.'))
  expect(await stored()).toEqual([])

  // A real PDF named like a web page keeps a name that says what it is
  const pdf = await upload('%PDF-1.7\n', 'invoice.html')
  expect(pdf.body.data).toMatchObject({ mime: 'application/pdf', name: 'invoice.html.pdf' })
})

test('sites choose the types they take, the size limit and how files are cached', async () => {
  expect((await upload(await image('png'), 'logo.png', configured)).status).toBe(201)
  expect(await upload(await image('jpeg'), 'photo.jpg', configured)).toEqual(
    rejection("JPG files can't be uploaded. Allowed: image/png, application/zip, application/xml."),
  )

  const { body } = await upload(zip, 'files.zip', configured)
  expect(body.data).toMatchObject({ mime: 'application/zip', name: 'files.zip' })
  const served = await configured.request(body.data.url)
  // A file a browser could open as a page of the site, such as XML or an archive it doesn't know, is sandboxed
  expect(Object.fromEntries(served.headers)).toMatchObject({
    'cache-control': 'no-store',
    'content-security-policy': sandbox,
  })
  const xhtml = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'
  const xml = await upload(xhtml, 'page.xml', configured)
  expect((await configured.request(xml.body.data.url)).headers.get('content-security-policy')).toBe(sandbox)

  const over = Buffer.alloc(1025)
  ;(await image('png')).copy(over)
  expect(await upload(over, 'big.png', configured)).toEqual(rejection('The file must be at most 1 KB.'))
  // A body well over the limit is turned away before it's parsed
  expect(await upload(Buffer.alloc(1024 + 128 * 1024), 'huge.png', configured)).toEqual(
    rejection('The file must be at most 1 KB.'),
  )
})

test("won't start with a type that a file's content can't show", () => {
  expect(() => createApp(db, types, { storage, media: { types: ['text/csv', 'image/*', 'font/*', 'foo/*'] } })).toThrow(
    "media.types in iight.config.ts has text/csv, foo/*, which can't be told from a file's content.",
  )
})

test('keeps file names safe, and never lets them reach the disk', async () => {
  const png = await image('png')
  const names = {
    '../../etc/passwd': 'passwd.png',
    '..\\..\\Windows\\win.ini': 'win.ini.png',
    'C:\\fakepath\\Logo.PNG': 'Logo.png',
    '...': 'file.png',
    'what?*<>|:.png': 'what.png',
    [`${'a'.repeat(300)}.png`]: `${'a'.repeat(200)}.png`,
  }
  for (const [name, safe] of Object.entries(names)) {
    const { body } = await upload(png, name)
    expect(body.data.name).toBe(safe)
    expect(body.data.url).toBe(`http://localhost/media/${body.data.id}/${encodeURIComponent(safe)}`)
  }

  // Every file is stored inside the storage folder, under its ID
  const files = await stored()
  expect(files).toHaveLength(Object.keys(names).length)
  for (const file of files) expect(file).toMatch(/^[0-9a-f-]{36}\.png$/)
  expect((await readdir(root)).sort()).toEqual(['secret.txt', 'storage'])
})

test("serves files by ID, so a URL can't reach outside the storage folder", async () => {
  const { body } = await upload(await image('png'), 'logo.png')
  for (const path of [
    `/media/${body.data.id}`,
    '/media/secret.txt/secret.txt',
    '/media/..%2Fsecret.txt/logo.png',
    '/media/..%2F..%2Fsecret.txt/logo.png',
    '/media/%2e%2e/secret.txt',
    `/media/${body.data.id}%2F..%2F..%2Fsecret.txt/logo.png`,
    `/media/${uuidv7()}/logo.png`,
  ]) {
    const response = await app.request(path)
    expect(response.status, path).toBe(404)
    expect(await response.text()).not.toContain('secret')
  }

  // The name only gives downloads a filename, so any name serves the same file and renaming breaks no links
  const renamed = await app.request(`/media/${body.data.id}/..%2F..%2Fsecret.txt`)
  expect(renamed.headers.get('content-type')).toBe('image/png')
})

test('serves SVGs in a sandbox that runs no scripts', async () => {
  const svg =
    '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><script>alert(1)</script></svg>'
  const { body } = await upload(svg, 'icon.svg')
  expect(body.data).toMatchObject({ mime: 'image/svg+xml', width: 40, height: 30 })

  const served = await app.request(body.data.url)
  expect(Object.fromEntries(served.headers)).toMatchObject({
    'content-type': 'image/svg+xml',
    'content-security-policy': sandbox,
    'x-content-type-options': 'nosniff',
  })
  expect(await served.text()).toBe(svg)

  // PDFs open in the browser's own viewer, outside the sandbox
  const pdf = await upload('%PDF-1.7\n', 'doc.pdf')
  expect((await app.request(pdf.body.data.url)).headers.get('content-security-policy')).toBeNull()
})

test('serves ranges of bytes, for players that seek', async () => {
  const { body } = await upload('%PDF-1.7\n0123456789', 'doc.pdf')
  const get = (range: string) => app.request(body.data.url, { headers: { range } })

  const part = await get('bytes=5-8')
  expect(part.status).toBe(206)
  expect(Object.fromEntries(part.headers)).toMatchObject({ 'content-range': 'bytes 5-8/19', 'content-length': '4' })
  expect(await part.text()).toBe('1.7\n')
  expect(await (await get('bytes=-3')).text()).toBe('789')
  expect(await (await get('bytes=17-99')).text()).toBe('89')

  const outside = await get('bytes=19-')
  expect(outside.status).toBe(416)
  expect(outside.headers.get('content-range')).toBe('bytes */19')

  // Several ranges at once get the whole file
  const several = await get('bytes=0-1,4-5')
  expect(several.status).toBe(200)
  expect(await several.text()).toBe('%PDF-1.7\n0123456789')

  const head = await app.request(body.data.url, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(head.headers.get('content-length')).toBe('19')
})

test('lists media with filters on type and name, a page at a time', async () => {
  await upload(await image('png'), 'Red logo.png')
  await upload(await image('jpeg'), 'Team photo.jpg')
  await upload('%PDF-1.7\n', 'Price list.pdf')

  const list = async (query: Record<string, unknown> = {}) => {
    const params = new URLSearchParams(
      Object.entries(query).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)]),
    )
    return (await send('GET', `/media?${params}`)).body
  }
  const names = async (query: Record<string, unknown> = {}) =>
    (await list(query)).data.map((media: { name: string }) => media.name)

  expect(await names()).toEqual(['Red logo.png', 'Team photo.jpg', 'Price list.pdf'])
  const images = [[{ field: 'mime', op: 'like', value: 'image/' }]]
  expect(await names({ where: images, order: { createdAt: 'desc' } })).toEqual(['Team photo.jpg', 'Red logo.png'])
  expect(await names({ where: [[{ field: 'name', op: 'like', value: 'LOGO' }]] })).toEqual(['Red logo.png'])
  expect(await names({ where: [[{ field: 'width', op: '>', value: 1 }]] })).toEqual(['Red logo.png', 'Team photo.jpg'])
  expect((await list({ perPage: '2', page: '2' })).pagination).toEqual({ page: 2, perPage: 2, total: 3, lastPage: 2 })

  expect(await list({ where: [[{ field: 'values.title', op: '=', value: 'x' }]] })).toEqual({
    message:
      'Unknown field "values.title". Use one of id, name, mime, size, width, height, alt, caption, createdAt, updatedAt.',
  })
})

test("edits the name, alt text and caption of any file, with core's checks", async () => {
  const { body } = await upload(await image('png'), 'logo.png')
  const id = body.data.id

  const invalid = await send('PUT', `/media/${id}`, { name: '', alt: 'x'.repeat(1001) })
  expect(invalid.status).toBe(422)
  expect(invalid.body.fields.name).toEqual({ isValid: false, messages: ['This field is required.'] })
  expect(invalid.body.fields.alt.isValid).toBe(false)

  // Control and invisible characters go, and the name keeps the extension of the file's type
  const edited = await send('PUT', `/media/${id}`, {
    name: 'Brand\u202E mark\n.PNG',
    alt: 'The red logo',
    caption: 'Our logo since 2026',
  })
  expect(edited.status).toBe(200)
  expect(edited.body.data).toMatchObject({
    name: 'Brand mark.png',
    alt: 'The red logo',
    caption: 'Our logo since 2026',
    url: `http://localhost/media/${id}/Brand%20mark.png`,
  })
  expect((await send('PUT', `/media/${id}`, { name: 'logo.svg', alt: '', caption: '' })).body.data).toMatchObject({
    name: 'logo.svg.png',
    alt: null,
    caption: null,
  })

  // Files that aren't images have alt text and captions too
  const pdf = await upload('%PDF-1.7\n', 'menu.pdf')
  const described = await send('PUT', `/media/${pdf.body.data.id}`, { name: 'menu.pdf', alt: "This week's menu" })
  expect(described.body.data).toMatchObject({ alt: "This week's menu", caption: null })

  expect((await send('PUT', `/media/${uuidv7()}`, { name: 'x.png' })).status).toBe(404)
})

test('deletes the stored file with its record', async () => {
  const { body } = await upload(await image('png'), 'logo.png')
  expect(await stored()).toEqual([`${body.data.id}.png`])

  expect((await send('DELETE', `/media/${body.data.id}`)).status).toBe(204)
  expect(await stored()).toEqual([])
  expect(await db.selectFrom('media').select('id').execute()).toEqual([])
  expect((await app.request(body.data.url)).status).toBe(404)
  expect((await send('DELETE', `/media/${body.data.id}`)).status).toBe(404)
})

test('the delivery API lists media with their URLs and dimensions', async () => {
  const key = await createApiKey(db, 'Website')
  const get = (path: string, token = key) =>
    app.request(`/v1${path}`, { headers: { authorization: `Bearer ${token}` } })

  const { body } = await upload(await image('png'), 'logo.png')
  const { createdBy, ...media } = body.data

  expect((await get('/media', '')).status).toBe(401)
  expect(await (await get('/media')).json()).toEqual({
    data: [media],
    pagination: { page: 1, perPage: 15, total: 1, lastPage: 1 },
  })
  expect(await (await get(`/media/${media.id}`)).json()).toEqual({ data: media })
  expect((await get('/media/logo.png')).status).toBe(404)
  expect((await get(`/media/${uuidv7()}`)).status).toBe(404)

  // URLs are https behind a proxy that says so
  const proxied = await app.request(`/v1/media/${media.id}`, {
    headers: { authorization: `Bearer ${key}`, 'x-forwarded-proto': 'https' },
  })
  expect((await proxied.json()).data.url).toBe(`https://localhost/media/${media.id}/logo.png`)
})
