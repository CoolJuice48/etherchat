// The two Client ID Metadata Document fetchers.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { NodeMetadataFetcher } from './cimd-node.ts'
import { WorkerMetadataFetcher } from './cimd-worker.ts'
import { CIMD_MAX_BYTES } from './cimd.ts'

// A self-signed certificate for localhost and 127.0.0.1, valid until 2126,
// made for these tests only.
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFAsynIGdPYVXMZeA
tgZZc1IJCDx1C/lbAuDeQ9a8mbmhRANCAAR5bpnVL49vcNZ/4BZHqzmsy2lUdSZ2
r7TDT9xtds5lQPHyFcTeXPdpgbCEJniCeTHdLlHE+3MFZsMBBAkQU3Kc
-----END PRIVATE KEY-----
`
const cert = `-----BEGIN CERTIFICATE-----
MIIBhDCCASqgAwIBAgIUD4qTG3UO8lbFc3OqzU8W+eWg3QAwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOZXRoZXJjaGF0IHRlc3QwIBcNMjYxMDI0MDEyNDE5WhgPMjEy
NjA5MzAwMTI0MTlaMBkxFzAVBgNVBAMMDmV0aGVyY2hhdCB0ZXN0MFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEeW6Z1S+Pb3DWf+AWR6s5rMtpVHUmdq+0w0/cbXbO
ZUDx8hXE3lz3aYGwhCZ4gnkx3S5RxPtzBWbDAQQJEFNynKNOMEwwHQYDVR0OBBYE
FM1MFnuzXP1nYwcFjycgmQ9CsOb/MBoGA1UdEQQTMBGCCWxvY2FsaG9zdIcEfwAA
ATAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIDBunxKKXcilXkwP
FhjGSLrcIeBUsrxIXKkzSpXELoDWAiEAvlu7eKCABbBsjUGiXMj0lzE/iw4WnolF
F7hDTwbLUP8=
-----END CERTIFICATE-----
`

const doc = { client_id: 'x', redirect_uris: ['http://127.0.0.1/cb'] }

async function serve(host: string): Promise<{ server: Server; port: number; accepts: string[] }> {
  const accepts: string[] = []
  const server = createServer({ key, cert }, (req, res) => {
    accepts.push(String(req.headers.accept))
    switch (req.url) {
      case '/client.json':
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(doc))
        return
      case '/moved':
        res.writeHead(302, { Location: '/client.json' })
        res.end()
        return
      case '/big':
        res.end('{"pad":"' + 'x'.repeat(CIMD_MAX_BYTES) + '"}')
        return
      default:
        res.end('not json')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  return { server, port: (server.address() as AddressInfo).port, accepts }
}

test('the Node fetcher reads a document and enforces its limits', async () => {
  const { server, port, accepts } = await serve('127.0.0.1')
  try {
    const f = new NodeMetadataFetcher({ addressAllowed: () => true, ca: cert })
    const base = `https://127.0.0.1:${port}`
    assert.deepEqual(await f.fetchJson(base + '/client.json'), doc)
    assert.equal(accepts[0], 'application/json')
    // Redirects aren't followed.
    await assert.rejects(f.fetchJson(base + '/moved'), /metadata document returned HTTP 302/)
    assert.equal(accepts.length, 2)
    await assert.rejects(f.fetchJson(base + '/big'), /metadata document is larger than 65536 bytes/)
    await assert.rejects(f.fetchJson(base + '/other'), /metadata document is not JSON/)
    await assert.rejects(f.fetchJson(`http://127.0.0.1:${port}/client.json`), /https/)

    // The default fetcher won't connect to it.
    await assert.rejects(new NodeMetadataFetcher({ ca: cert }).fetchJson(base + '/client.json'), /non-public address 127\.0\.0\.1/)
  } finally {
    server.close()
  }
})

test('the Node fetcher checks addresses when it resolves a name', async () => {
  const { server, port } = await serve('localhost')
  try {
    const url = `https://localhost:${port}/client.json`
    const seen: string[] = []
    const f = new NodeMetadataFetcher({ addressAllowed: (ip) => (seen.push(ip), true), ca: cert })
    assert.deepEqual(await f.fetchJson(url), doc)
    assert.ok(seen.length > 0, 'the lookup never checked an address')
    await assert.rejects(new NodeMetadataFetcher({ ca: cert }).fetchJson(url), /non-public address/)
  } finally {
    server.close()
  }
})

test('the Workers fetcher', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  let next = (): Response => new Response(JSON.stringify(doc))
  const f = new WorkerMetadataFetcher(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} })
    return next()
  })
  assert.deepEqual(await f.fetchJson('https://client.example/c.json'), doc)
  const { init } = calls[0]
  assert.equal(init.redirect, 'manual')
  assert.equal(new Headers(init.headers).get('Accept'), 'application/json')
  assert.ok(init.signal instanceof AbortSignal)

  // A redirect comes back unfollowed, and is refused like any other non-200.
  next = () => new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/c.json' } })
  await assert.rejects(f.fetchJson('https://client.example/c.json'), /metadata document returned HTTP 302/)
  next = () => new Response('', { status: 404 })
  await assert.rejects(f.fetchJson('https://client.example/c.json'), /metadata document returned HTTP 404/)
  next = () => new Response('x'.repeat(CIMD_MAX_BYTES + 1))
  await assert.rejects(f.fetchJson('https://client.example/c.json'), /larger than 65536 bytes/)
  next = () => new Response('{"a":' + ' '.repeat(CIMD_MAX_BYTES - 7) + '1}') // exactly 64 KB
  assert.deepEqual(await f.fetchJson('https://client.example/c.json'), { a: 1 })
  next = () => new Response('<html>')
  await assert.rejects(f.fetchJson('https://client.example/c.json'), /not JSON/)
  const n = calls.length
  await assert.rejects(f.fetchJson('http://client.example/c.json'), /https/)
  assert.equal(calls.length, n, 'fetched a plain-http URL')
})
