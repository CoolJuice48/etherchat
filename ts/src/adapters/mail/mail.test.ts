import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MailDisabledError, newMailer, Resend, LogMailer } from './index.ts'

async function withServer(
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const srv = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => { body += c })
    req.on('end', () => handler(req, body, res))
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/emails`)
  } finally {
    srv.closeAllConnections()
    await new Promise((resolve) => srv.close(resolve))
  }
}

test('Resend request', async () => {
  let got: Record<string, unknown> = {}
  let raw = ''
  let auth = ''
  await withServer((req, body, res) => {
    auth = req.headers.authorization ?? ''
    raw = body
    got = JSON.parse(body)
    res.end('{"id":"abc"}')
  }, async (url) => {
    const r = new Resend('re_test', 'Etherchat <no-reply@etherchat.example>', url)
    await r.send({ to: 'a@example.com', subject: 'Hi', text: 'Body', html: '' })
  })
  assert.equal(auth, 'Bearer re_test')
  assert.equal(got.from, 'Etherchat <no-reply@etherchat.example>')
  assert.equal(got.subject, 'Hi')
  assert.equal(got.text, 'Body')
  assert.deepEqual(got.to, ['a@example.com'])
  assert.ok(!('html' in got), 'an empty html part is left out')
  // Go's encoding/json: sorted keys, HTML-safe escaping.
  assert.equal(raw, '{"from":"Etherchat \\u003cno-reply@etherchat.example\\u003e","subject":"Hi","text":"Body","to":["a@example.com"]}')
})

test('Resend sends the html part', async () => {
  let got: Record<string, unknown> = {}
  await withServer((_req, body, res) => {
    got = JSON.parse(body)
    res.end('{}')
  }, async (url) => {
    await new Resend('k', 'x@y.z', url).send({ to: 'a@b.c', subject: 's', text: 't', html: '<p>&</p>' })
  })
  assert.equal(got.html, '<p>&</p>')
})

test('Resend error', async () => {
  await withServer((_req, _body, res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('{"message":"domain not verified"}\n')
  }, async (url) => {
    await assert.rejects(new Resend('k', 'x@y.z', url).send({ to: 'a@b.c', subject: '', text: '', html: '' }),
      (err: Error) => err.message === 'resend: HTTP 403: {"message":"domain not verified"}')
  })
})

test('Resend connection error', async () => {
  const r = new Resend('k', 'x@y.z', 'http://127.0.0.1:1/emails')
  await assert.rejects(r.send({ to: 'a@b.c', subject: '', text: '', html: '' }), /^Error: resend: /)
})

test('disabled', async () => {
  await assert.rejects(newMailer('', '', '', { info() {}, warn() {}, error() {} }).send({ to: '', subject: '', text: '', html: '' }),
    (err: Error) => err instanceof MailDisabledError && err.message === 'email is not configured')
})

test('log mailer', async () => {
  const lines: { msg: string; fields?: Record<string, unknown> }[] = []
  const log = { info() {}, error() {}, warn(msg: string, fields?: Record<string, unknown>) { lines.push({ msg, fields }) } }
  const m = newMailer('log', '', '', log)
  assert.ok(m instanceof LogMailer)
  await m.send({ to: 'a@b.c', subject: 'S', text: 'T', html: '<p>T</p>' })
  assert.deepEqual(lines, [{ msg: 'email not sent (mail.provider = log)', fields: { to: 'a@b.c', subject: 'S', text: 'T' } }])
  assert.ok(newMailer('resend', 'k', 'f', log) instanceof Resend)
})
