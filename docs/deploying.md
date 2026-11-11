# Deploying

A site deploys as an image of its own, built from its repo, by `docker build` or by a host that builds Dockerfiles. Each deploy runs `sorlo migrate` from the new image before it takes traffic, and the host provides Postgres, HTTPS and the rest of [what a host provides](#what-a-host-provides). Its `Dockerfile`:

```dockerfile
FROM node:24-slim
WORKDIR /site
ENV NODE_ENV=production NO_COLOR=1

# The packages first, so a change to the site's types doesn't reinstall them
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .

# The local disk's folder, which a volume keeps
RUN mkdir -p storage && chown node:node storage
USER node
EXPOSE 4100
# The command itself rather than npm, so SIGTERM reaches it
CMD ["node_modules/.bin/sorlo", "start"]
```

and its `.dockerignore`:

```
node_modules
.env*
*.env
storage
.git
```

- **The image installs the packages** with `npm ci`, exactly as `package-lock.json` records them. `node:24-slim` is Debian, so sharp uses its glibc build, which a lockfile lists even when it's made on a Mac. On an Apple Silicon Mac, `docker build --platform linux/amd64` builds for an x64 host.
- **It holds no secrets.** `.env` files, and env files such as `production.env`, stay out of it, and `sorlo.config.ts` reads the environment each time the server starts. The site's files belong to root, read-only to the server, which writes only to `storage`.
- **The server is the image's command,** rather than `npm start`, so it gets the host's SIGTERM and stops [as the CLI does](cli.md#logs-and-stopping). `NO_COLOR` keeps colours out of the request log.
- **Migrations run once per deploy,** before the new version takes traffic, from the same image and environment, such as in Fly's `release_command`, Render's pre-deploy command or a Kubernetes Job:

  ```bash
  docker run --rm --env-file production.env example node_modules/.bin/sorlo migrate
  ```

  It exits 1 when a waiting migration has a TODO or one fails, which stops the deploy. A run stopped partway keeps the migrations it finished, and the next one carries on. Two at once are safe, since the second stops on the migration's unique name, but that fails its deploy.

- **The first account** is made in the admin with the link `sorlo start` prints in the log, while nobody has an account, as [People](people.md#the-first-account) describes. Each instance prints its own code, which only it takes, so make it while one instance runs.
- **`GET /health`** needs no key or session. It replies `200 {"status":"ok"}` while the database answers, and otherwise `503 {"message":"The database can't be reached."}`, logging why.
- **A database that restarts** ends the CMS's connections to it, which the CMS logs, one line for each, as `A database connection ended: …`, and replaces as it needs them. A transaction that held one fails, and a run of the worker's waits to be tried again.
- **Media** can stay on the local disk, as the sandbox's do, for one instance, with a volume at `/site/storage`. The image makes that folder the server's, so a new Docker volume starts writable, but a host's own volume can arrive owned by root and need a `chown`. More than one instance, or a host without volumes, needs a bucket, through FlyDrive's S3 driver, for which the site installs `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. The bucket can stay private, since the CMS streams every file through `/media/<id>/<name>`. Cloudflare R2 also needs `supportsACL: false`. Each file's row records its disk, so a site moving to a bucket keeps both disks set up until its files have moved.

  ```ts
  import { S3Driver } from 'flydrive/drivers/s3'

  // in defineConfig
  storage: {
    default: 's3',
    services: {
      s3: () =>
        new S3Driver({
          credentials: { accessKeyId: process.env.S3_KEY!, secretAccessKey: process.env.S3_SECRET! },
          region: process.env.S3_REGION!,
          endpoint: process.env.S3_ENDPOINT,
          bucket: process.env.S3_BUCKET!,
          visibility: 'private',
        }),
    },
  },
  ```

## What a host provides

| What                                           | Why                                                                                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres, 17 as the tests use                  | `DATABASE_URL`, with any TLS settings as pg reads them                                                                                                                                                          |
| HTTPS in front, sending `X-Forwarded-Proto`    | The session cookie is `Secure` only when it says `https`                                                                                                                                                        |
| Environment variables for settings and secrets | `DATABASE_URL`, `APP_URL` for `url`, mail and bucket credentials, `ANTHROPIC_API_KEY` with `ai`, and `PORT` if the host picks one. Leave `HOST` unset                                                           |
| A volume at `/site/storage`, or a bucket       | Media                                                                                                                                                                                                           |
| A release step                                 | `sorlo migrate` before each version takes traffic                                                                                                                                                               |
| A health check                                 | `GET /health`                                                                                                                                                                                                   |
| A stop grace of 40 seconds                     | So a webhook the worker is waiting for, 30 seconds at most, finishes. With less, the host's kill cuts it, its transaction rolls back, and it runs again later. Docker gives 10 seconds, Kubernetes 30 and Fly 5 |
| One instance, unless media is in a bucket      | The forms rate limit is also counted in each process                                                                                                                                                            |
| With a CDN in front, its networks in `proxies` | So the limits see each visitor rather than the CDN, as [Behind a proxy](#behind-a-proxy) says                                                                                                                   |

## Behind a proxy

The forms' rate limit, the address each submission records and [the limits on signing in](people.md) count the address a request came from. Behind a proxy, that's the proxy's, so the CMS takes the address in `X-Forwarded-For` instead, but only from a proxy it believes, since anyone can send the header. It believes loopback and private networks, such as a load balancer's, Docker's bridge network or `cloudflared` on the same machine, and the addresses and networks `proxies` in `sorlo.config.ts` lists. It reads the header from the right, past every proxy on a loopback or private network, then past one listed proxy at most: the hop a listed proxy names is the visitor, even if it's in a listed network too, since a CDN's customers can connect from its networks, as Cloudflare's Workers do. A hop written with a port, as Azure's Application Gateway writes `203.0.113.9:51234` or `[2001:db8::9]:443`, counts as its address alone.

```ts
// sorlo.config.ts
export default defineConfig({
  // ...
  // Cloudflare's networks, from https://www.cloudflare.com/ips/
  proxies: ['173.245.48.0/20', '103.21.244.0/22', /* … */ '2400:cb00::/32' /* … */],
})
```

- **A CDN in front**, such as Cloudflare's proxy, connects from public addresses, so list its networks. Otherwise everyone coming through one of its addresses shares that address's limits, and submissions record the CDN's address.
- **The servers won't start** with an entry that isn't an address or a network.
- **A host that publishes no addresses**, such as Vercel or Netlify in front as a rewrite, can only be listed as every address, `['0.0.0.0/0', '::/0']`, which we advise against. Whoever connects then names the visitor, in the header's last hop, so it's safe only if nothing reaches the CMS except through your proxies. The servers warn when they start with an entry that holds every address.
- **`X-Forwarded-Proto`** is believed from anyone, for the session cookie's `Secure` flag, and for media files' URLs where `url` isn't set.
