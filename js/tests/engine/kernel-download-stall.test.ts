import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { KERNEL_STALL_MS, downloadFile } from '../../src/engine/downloader'

let server: http.Server | undefined

afterEach(async () => {
  await new Promise((r) => server?.close(r) ?? r(undefined))
  server = undefined
})

/** Serves headers, then behaves as `body` dictates. Returns its base URL. */
async function serve(
  body: (res: http.ServerResponse) => void,
  headers: http.OutgoingHttpHeaders = { 'Content-Length': '1048576' },
): Promise<string> {
  server = http.createServer((_req, res) => {
    res.writeHead(200, headers)
    body(res)
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const addr = server!.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/k.zip`
}

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kdl-')), 'k.zip')
}

describe('a kernel download that stops moving', () => {
  it('has a stall timeout at all - there used to be none', () => {
    expect(KERNEL_STALL_MS).toBeGreaterThan(0)
  })

  it('fails instead of hanging forever', async () => {
    const url = await serve((res) => {
      res.write(Buffer.alloc(16))
      // and then silence
    })
    const dest = tmpFile()

    await expect(downloadFile(url, dest, undefined, 60)).rejects.toThrow(/stall/i)
  })

  it('leaves no half-written file behind', async () => {
    const url = await serve((res) => res.write(Buffer.alloc(16)))
    const dest = tmpFile()

    await expect(downloadFile(url, dest, undefined, 60)).rejects.toThrow()

    expect(fs.existsSync(dest)).toBe(false)
  })

  it('survives a slow transfer as long as bytes keep arriving', async () => {
    const url = await serve((res) => {
      // Nagle would coalesce these into one late packet and fake a stall.
      res.socket?.setNoDelay(true)
      let sent = 0
      const tick = setInterval(() => {
        res.write(Buffer.alloc(64))
        if (++sent >= 8) {
          clearInterval(tick)
          res.end()
        }
      }, 30)
    }, { 'Content-Length': '512' })
    const dest = tmpFile()

    // 240ms of dribbling outlasts the 100ms window twice over; the cap is on
    // silence, not on how long a download may take.
    await downloadFile(url, dest, undefined, 100)

    expect(fs.statSync(dest).size).toBe(512)
  })
})
