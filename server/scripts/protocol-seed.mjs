// Seeds a running server through the admin API and prints the env lines the
// protocol suite needs. Usage: OEM_ADMIN_TOKEN=... node scripts/protocol-seed.mjs [baseUrl]
// The server must also have OEM_ADMIN_PASSWORD set: without it the admin API
// answers 404 even for a valid bearer token.
const base = (process.argv[2] || process.env.PROTOCOL_BASE_URL || 'http://localhost:4321').replace(/\/+$/, '')
const token = process.env.OEM_ADMIN_TOKEN
if (!token) {
  console.error('OEM_ADMIN_TOKEN is required')
  process.exit(1)
}

async function admin(method, path, body) {
  const res = await fetch(`${base}/api/admin/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json)}`)
  return json
}

const { plans } = await admin('GET', 'plans')
let pro = plans.find((p) => p.code === 'PRO')
if (!pro) pro = (await admin('POST', 'plans', { code: 'PRO', name: 'Pro', mi: 5, maxSyncedProfiles: 10 })).plan
const paid = await admin('POST', 'users', { label: 'protocol-paid', planId: pro.id })
const free = await admin('POST', 'users', { label: 'protocol-free' })

console.log(`PROTOCOL_BASE_URL=${base}`)
console.log(`PROTOCOL_API_KEY=${paid.key.key}`)
console.log(`PROTOCOL_FREE_KEY=${free.key.key}`)
