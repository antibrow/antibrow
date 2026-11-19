# antibrow-server

Self-hostable API server for the AntiBrow SDK and desktop app. One codebase, two runtimes: Node (Docker) and Cloudflare Workers. Storage is any S3 compatible service, the database is PostgreSQL 15 or newer.

## Run with Docker

```bash
cp .env.example .env   # set FP_LICENSE_PRIVKEY
docker compose up -d --build
curl localhost:4321/api/v1/health
```

The compose file starts the app, PostgreSQL 17 (host port 5433) and RustFS, an S3 compatible object store (port 9000). The app creates the bucket on start when `S3_CREATE_BUCKET=1`, which the compose file sets.

## Build

```bash
pnpm build:node   # Node standalone output in dist/server
pnpm build:cf     # Cloudflare Workers output in dist/_worker.js
```

For Cloudflare, copy `deploy/cloudflare.jsonc.example` to your own config, set the secrets listed in it with the Cloudflare CLI, and deploy the `dist` directory.

## Configuration

See `.env.example`. `DATABASE_URL` and `FP_LICENSE_PRIVKEY` are required. The four `S3_*` variables must be set together or not at all. `S3_PUBLIC_ENDPOINT` is the address clients use for presigned uploads and downloads (default: `S3_ENDPOINT`). The compose file sets it to `http://localhost:9000`, which only works for clients on the same machine; a real deployment must set it to a client-reachable URL, such as the public address of the object store. `S3_ADDRESSING` is `path` (default, `endpoint/bucket/key`) or `virtual` (`bucket.endpoint-host/key`); Aliyun OSS users must set `S3_ADDRESSING=virtual` and `S3_REGION` to their region id (for example `cn-hangzhou`); the default `auto` is not accepted there. `OEM_ADMIN_PASSWORD` must be set for the admin API to exist at all, even when scripts authenticate with `OEM_ADMIN_TOKEN`. Set `S3_CREATE_BUCKET=1` to have the Docker entrypoint create the bucket if it is missing (needs credentials allowed to create buckets).

## Database

Schema changes ship only as Prisma migrations in `prisma/migrations`. The Docker image runs `prisma migrate deploy` on every start, so the database is migrated before the server listens. On Cloudflare, run it yourself against the production database before each deploy:

```bash
DATABASE_URL=postgresql://... pnpm db:migrate
```

`pnpm db:generate` builds both Prisma clients (workerd and Node) and must run after install and before a build.

The first migration seeds the builtin `FREE` plan (1 concurrent browser, no cloud sync) as the default plan. The `FREE` and `GRANT` plan codes are reserved.

Tests that need PostgreSQL read `TEST_DATABASE_URL` and are skipped without it.
