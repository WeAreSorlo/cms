import { MediaOptions, Storage, defaultMediaTypes } from '.'
import { inputs, pickValues, validateServerValues } from './core'
import { Database, isUuid, uuidv7 } from './db'
import type { AdminEnv } from './entries'
import { addEvents } from './events'
import { allows } from './fields'
import { MediaRow, listMedia, parseMediaQuery, toAdminEntry, usedBy } from './query'
import { mediaSchema } from './schemas'
import { fileTypeFromBuffer, supportedMimeTypes } from 'file-type'
import { DriveManager } from 'flydrive'
import { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { Kysely, sql } from 'kysely'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'

// file-type knows files by their content, but an SVG is XML text, known here by an svg root element after any XML
// declaration, comments and doctype. A doctype that declares entities, as XML bombs do, doesn't count. A comment stops
// at its first -->, since one that could run on to a later one would try every way to split a run of them.
const isSvg = (bytes: Buffer) =>
  /^\s*(<\?xml[^>]*\?>\s*)?(<!--(?:(?!-->)[\s\S])*-->\s*|<!DOCTYPE[^>[]*>\s*)*<svg[\s>]/.test(
    bytes.toString('utf8', 0, 4096),
  )

// A file's real type and extension, from its content, never from its name or the type its client sent
const detect = async (bytes: Buffer) =>
  isSvg(bytes) ? { ext: 'svg', mime: 'image/svg+xml' } : await fileTypeFromBuffer(bytes)

// The other extensions some types go by, since file-type gives each type one
const aliases: Record<string, Array<string>> = {
  jpg: ['jpeg', 'jpe', 'jfif'],
  tif: ['tiff'],
  heic: ['heif'],
  mp4: ['m4v'],
  mpg: ['mpeg'],
  ogg: ['oga'],
}

// A name that's safe to show and to download: no folders, no control, invisible or reserved characters, and an
// extension of the file's real type, so a file can't be saved as something it isn't, such as evil.html
function safeName(name: string, ext: string) {
  const extensions = [ext, ...(aliases[ext] ?? [])]
  const clean = (name.split(/[\\/]/).pop() ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}<>:"|?*]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  const dot = clean.lastIndexOf('.')
  const extension = clean.slice(dot + 1).toLowerCase()
  const kept = dot > 0 && extensions.includes(extension)
  const stem = [...(kept ? clean.slice(0, dot) : clean)].slice(0, 200).join('')
  return `${stem || 'file'}.${kept ? extension : ext}`
}

// The size an image shows at, after its EXIF rotation, or nulls for other files and images sharp can't read, such as BMP
async function dimensions(bytes: Buffer, mime: string) {
  const metadata = mime.startsWith('image/')
    ? await sharp(bytes)
        .metadata()
        .catch(() => undefined)
    : undefined
  return { width: metadata?.autoOrient.width ?? null, height: metadata?.autoOrient.height ?? null }
}

// Such as 512 KB or 50 MB
const formatSize = (bytes: number) =>
  bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${Math.round((bytes / 1024 ** 2) * 10) / 10} MB`

// Pictures, video, audio and PDFs open in the browser's own viewers. Anything else a browser could open as a page of the
// site, such as an SVG or XML file, is served in a sandbox that runs no scripts.
const viewable = /^(image\/(?!svg\+xml)|video\/|audio\/|application\/pdf)/

// The address file URLs start from: url in sorlo.config.ts, which createApp sets for each request, or else the CMS's
// address as its client sees it, https behind a proxy that says so, as the session cookie assumes
export function origin(c: Context) {
  const site: string | undefined = c.get('origin')
  if (site) return site
  const url = new URL(c.req.url)
  if (c.req.header('x-forwarded-proto') === 'https') url.protocol = 'https:'
  return url.origin
}

// A media file as the delivery API returns it, with the URL that serves it
export const toMedia = (row: MediaRow, origin: string) => ({
  id: row.id,
  name: row.name,
  mime: row.mime,
  size: row.size,
  width: row.width,
  height: row.height,
  alt: row.alt,
  caption: row.caption,
  url: `${origin}/media/${row.id}/${encodeURIComponent(row.name)}`,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const toAdminMedia = (row: MediaRow, origin: string) => ({ ...toMedia(row, origin), createdBy: row.created_by })

// A file's name, alt text and caption as they're saved: the name kept to an extension of the type the file was stored
// as, and empty alt text or caption as none
export const detailsOf = (
  row: { path: string },
  values: { name: string; alt?: string | null; caption?: string | null },
) => ({
  name: safeName(values.name, extname(row.path).slice(1)),
  alt: values.alt || null,
  caption: values.caption || null,
})

export interface MediaSaveOptions {
  // Runs on the file as it is, locked, before it's changed, and can throw to stop the save
  guard?: (current: MediaRow) => void
  // Runs in the save's transaction once it's written, such as to claim the proposal it applies
  during?: (trx: Kysely<Database>) => Promise<void>
}

// Saves a file's checked name, alt text and caption, as the media library's details do, with the event automations
// take, keeping any of the three that values leaves out. Files have no drafts, so the change shows on the site at once.
export const saveMediaDetails = (
  db: Kysely<Database>,
  id: string,
  values: Partial<{ name: string; alt: string | null; caption: string | null }>,
  origin: string,
  { guard, during }: MediaSaveOptions = {},
) =>
  db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('media').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
    if (!row) throw new HTTPException(404)
    guard?.(row)
    const merged = { name: row.name, alt: row.alt, caption: row.caption, ...values }
    const updated = await trx
      .updateTable('media')
      .set({ ...detailsOf(row, merged), updated_at: sql`now()` })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow()
    await addEvents(trx, 'media.updated', [{ media: toAdminMedia(updated, origin) }])
    await during?.(trx)
    return updated
  })

// An image as a model takes it: turned upright and scaled to fit 512 pixels, with an SVG drawn at that size, as a PNG
// where something in it is transparent and otherwise a JPEG, which is far smaller, an alpha channel that's opaque
// throughout included. An animated image gives its first frame.
export async function preview(bytes: Buffer, mime: string) {
  const { width, height, hasAlpha } = await sharp(bytes).metadata()
  // An SVG's size is at 72 dots an inch, so it's drawn at the density that makes it 512 pixels
  const density =
    mime === 'image/svg+xml' && width && height ? Math.min(2400, (72 * 512) / Math.max(width, height)) : undefined
  const image = sharp(bytes, { density }).autoOrient().resize(512, 512, { fit: 'inside', withoutEnlargement: true })
  const drawn = hasAlpha ? await image.png().toBuffer() : undefined
  const transparent = !!drawn && !(await sharp(drawn).stats()).isOpaque
  const data = transparent ? drawn! : await (drawn ? sharp(drawn) : image).jpeg({ quality: 80 }).toBuffer()
  return { data: data.toString('base64'), mimeType: transparent ? 'image/png' : 'image/jpeg' }
}

// A library image's preview, or undefined when it can't be read, such as a BMP, which view_media and the files attached
// to a message to the assistant both show the model
export async function imageOf(drive: DriveManager<Storage['services']>, row: Pick<MediaRow, 'disk' | 'path' | 'mime'>) {
  try {
    return await preview(Buffer.from(await drive.use(row.disk).getBytes(row.path)), row.mime)
  } catch {
    return undefined
  }
}

export async function findMedia(db: Kysely<Database>, id: string) {
  const row = isUuid(id) ? await db.selectFrom('media').selectAll().where('id', '=', id).executeTakeFirst() : undefined
  if (!row) throw new HTTPException(404)
  return row
}

// A failed upload, as core's report for a field named file
const rejected = (message: string) => ({ isValid: false, fields: { file: { isValid: false, messages: [message] } } })

// A file's details from its content, as an upload and sorlo import store it, or why it can't be stored: a type the
// content can't show, or one the media library doesn't take
export async function checkFile(bytes: Buffer, name: string, types: Array<string>) {
  const type = await detect(bytes)
  if (!type) return { problem: "This file's type can't be told from its content, so it can't be uploaded." }
  if (!allows(types, type.mime)) {
    return { problem: `${type.ext.toUpperCase()} files can't be uploaded. Allowed: ${types.join(', ')}.` }
  }
  return {
    file: {
      ext: type.ext,
      name: safeName(name, type.ext),
      mime: type.mime,
      size: bytes.length,
      ...(await dimensions(bytes, type.mime)),
    },
  }
}

// The media library's admin API, whose routes createApp signs in, and the public route that serves its files
export function mediaRoutes(
  db: Kysely<Database>,
  storage: Storage,
  {
    types = defaultMediaTypes,
    // shortcut: each upload is held in memory while it's checked, stream uploads to the disk when limits outgrow memory
    maxFileSize = 50 * 1024 ** 2,
    cacheControl = 'public, max-age=3600',
  }: MediaOptions = {},
) {
  // A type the content can't show would turn away every upload of it
  const unknown = types.filter((type) => ![...supportedMimeTypes, 'image/svg+xml'].some((mime) => allows([type], mime)))
  if (unknown.length) {
    throw new Error(
      `media.types in sorlo.config.ts has ${unknown.join(', ')}, which can't be told from a file's content.`,
    )
  }

  const app = new Hono<AdminEnv>()
  const drive = new DriveManager(storage)
  const tooLarge = `The file must be at most ${formatSize(maxFileSize)}.`

  app.get('/api/media', async (c) => {
    const { data, pagination } = await listMedia(db, parseMediaQuery(c.req.query()))
    const base = origin(c)
    return c.json({ data: data.map((row) => toAdminMedia(row, base)), pagination })
  })

  // One file, in the multipart field "file". Its name and type come from the client, so it's checked by its content.
  app.post(
    '/api/media',
    // The multipart boundaries and headers come on top of the file
    bodyLimit({ maxSize: maxFileSize + 64 * 1024, onError: (c) => c.json(rejected(tooLarge), 422) }),
    async (c) => {
      const { file } = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
      if (!(file instanceof File)) return c.json(rejected('Choose a file to upload.'), 422)
      if (file.size > maxFileSize) return c.json(rejected(tooLarge), 422)

      const bytes = Buffer.from(await file.arrayBuffer())
      const checked = await checkFile(bytes, file.name, types)
      if (!checked.file) return c.json(rejected(checked.problem), 422)
      const { ext, ...details } = checked.file

      // The key comes from the ID and the real type, so the file's name never reaches the disk
      const id = uuidv7()
      const disk = String(storage.default)
      const path = `${id}.${ext}`

      // A file that can't be stored rolls its row back
      const row = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('media')
          .values({ id, disk, path, ...details, created_by: c.var.user.id })
          .returningAll()
          .executeTakeFirstOrThrow()
        await addEvents(trx, 'media.created', [{ media: toAdminMedia(row, origin(c)) }])
        await drive.use(disk).put(path, bytes)
        return row
      })

      return c.json({ data: toAdminMedia(row, origin(c)) }, 201)
    },
  )

  // Changes the name, alt text and caption. The name keeps an extension of the type the file was stored as.
  app.put('/api/media/:id', async (c) => {
    const row = await findMedia(db, c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const values = pickValues(mediaSchema, body ?? {}, inputs)
    const report = await validateServerValues(mediaSchema, values, inputs)
    if (!report.isValid) return c.json(report, 422)

    const updated = await saveMediaDetails(db, row.id, values, origin(c))
    return c.json({ data: toAdminMedia(updated, origin(c)) })
  })

  // The entries that link to the file
  app.get('/api/media/:id/used-by', async (c) => {
    const row = await findMedia(db, c.req.param('id'))
    return c.json({ data: (await usedBy(db, row.id)).map(toAdminEntry) })
  })

  // Deletes the file with its row. A file that can't be deleted keeps its row, so deleting it can be tried again.
  // shortcut: a save that links the file while it's being deleted can slip past the check, lock it when that matters
  // shortcut: only drafts' links count, so a live copy can keep one its draft has dropped, which with() then leaves out;
  // record live copies' links in entry_relations too when that matters
  app.delete('/api/media/:id', async (c) => {
    const row = await findMedia(db, c.req.param('id'))
    const users = (await usedBy(db, row.id)).length
    if (users) {
      const message = `${users === 1 ? 'An entry links' : `${users} entries link`} to this file. Remove the links before deleting it.`
      throw new HTTPException(409, { message })
    }
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('media').where('id', '=', row.id).execute()
      await addEvents(trx, 'media.deleted', [{ media: toAdminMedia(row, origin(c)) }])
      await drive.use(row.disk).delete(row.path)
    })
    return c.body(null, 204)
  })

  // A file, public so pages can show it. It's found by its ID, so the URL can't name a path on the disk, and any name
  // after the ID serves it.
  app.get('/media/:id/:name', async (c) => {
    const row = await findMedia(db, c.req.param('id'))
    const disk = drive.use(row.disk)
    if (!(await disk.exists(row.path))) throw new HTTPException(404)

    // Downloads take the file's safe name, not the URL's, which a link could end in evil.html
    const filename = encodeURIComponent(row.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)
    const headers: Record<string, string> = {
      'content-type': row.mime,
      'accept-ranges': 'bytes',
      'cache-control': cacheControl,
      // Browsers take the file as the type its content was checked as
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename*=UTF-8''${filename}`,
    }
    if (!viewable.test(row.mime)) {
      headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    }

    // One range of bytes, which video and audio players ask for to seek, and Safari needs to play video at all
    const [, first, last] = c.req.header('range')?.match(/^bytes=(\d*)-(\d*)$/) ?? []
    const range = first || last
    const start = !range ? 0 : first ? Number(first) : Math.max(0, row.size - Number(last))
    const end = first && last ? Math.min(Number(last), row.size - 1) : row.size - 1
    if (start > end) return c.body(null, 416, { 'content-range': `bytes */${row.size}` })
    if (range) headers['content-range'] = `bytes ${start}-${end}/${row.size}`
    headers['content-length'] = String(end - start + 1)

    // HEAD replies with GET's headers and drops the body, which would leave a file open
    const status = range ? 206 : 200
    if (c.req.method === 'HEAD') return c.body(null, status, headers)
    const stream = await disk.getStream(row.path, range ? { range: { start, end } } : {})
    return c.body(Readable.toWeb(stream) as ReadableStream, status, headers)
  })

  return app
}
