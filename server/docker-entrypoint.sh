#!/bin/sh
set -e
npx prisma migrate deploy
node scripts/ensure-bucket.mjs
exec node dist/server/entry.mjs
