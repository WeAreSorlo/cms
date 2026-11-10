# Media

The admin's Media page holds the site's files, in a grid with a type filter and a search on names, where each file's name, alt text and caption are edited. The files are kept on a FlyDrive disk, set up as `storage` in `sorlo.config.ts`. It takes FlyDrive's `DriveManager` options as they are, so another FlyDrive driver can take the local one's place, and each file's row records the disk it went to. `media` is optional, and sets what the library takes and how its files are served. [The assistant](assistant.md#proposals) can propose names, alt text and captions too, after seeing the images, for a person to apply.

```ts
import { defaultMediaTypes, defineConfig } from '@sorlo/cms'
import { FSDriver } from 'flydrive/drivers/fs'

export default defineConfig({
  database: { url: process.env.DATABASE_URL! },
  storage: {
    default: 'local',
    services: {
      local: () => new FSDriver({ location: new URL('./storage/', import.meta.url), visibility: 'public' }),
    },
  },
  media: {
    types: [...defaultMediaTypes, 'application/zip'],
    maxFileSize: 100 * 1024 * 1024,
    cacheControl: 'public, max-age=86400',
  },
})
```

| Setting        | What it holds                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `types`        | The MIME types uploads may have, with wildcards such as `image/*`. `defaultMediaTypes` is `image/*`, `video/*`, `audio/*` and `application/pdf` |
| `maxFileSize`  | The largest file in bytes, 50 MB if not given. Each upload is held in memory while it's checked, so a big limit needs memory to match           |
| `cacheControl` | The `Cache-Control` header of served files, `public, max-age=3600` if not given                                                                 |

- An upload's type is read from its content by [file-type](https://github.com/sindresorhus/file-type), never from its name or the type the browser sends. It knows about 180 formats, such as MOV, HEIC, Office files and ZIP archives. SVGs, which are XML text, are known by their `svg` root element.
- A type with no signature in its content, such as CSV or plain text, can't be allowed, so `sorlo dev` won't start with one in `types`.
- An image's `width` and `height` are read on upload by sharp, as it shows after EXIF rotation. They're null for other files, and for images sharp can't read, such as BMP.
- A file is stored as `<id>.<extension>`, so its name never reaches the disk. Names lose folders and control, invisible and reserved characters, and end in an extension of the file's real type, so a PNG named `evil.html` becomes `evil.html.png`.
- Files are public at `/media/<id>/<name>`, since `<img>` can't send an API key. They're found by ID, so a URL can't reach outside the disk, and any name after the ID serves the same file, so renaming breaks no links. Downloads take the file's own name, whatever the URL ends in. They're served with `nosniff`, and in ranges of bytes for video and audio players.
- Pictures, video, audio and PDFs open in the browser's own viewers. Every other file, such as an SVG or an XML file, is served with `Content-Security-Policy: sandbox`, so a script in it can't run, even when its URL is opened on its own. A frontend that puts an SVG's markup into its own page loses that, so show SVGs with `<img>`.
- Deleting a file removes it from its disk too.
