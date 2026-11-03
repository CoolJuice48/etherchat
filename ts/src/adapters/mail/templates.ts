// Every email has an HTML part in the web view's style and a plain-text part
// with the same words, for clients that don't show HTML.
//
// These functions reproduce go/adapters/mail/templates/*.{html,txt} byte for
// byte, including html/template's escaping: escapeHtml for text and
// attributes, safeUrl for href values. templates.test.ts checks the output
// against the Go templates when the Go toolchain is available.

import type { Message } from './index.ts'

/** What the frame needs from every email. */
interface Frame {
  subject: string
  preheader: string // the preview line inboxes show after the subject
  footer: string
}

/** The email with a web sign-in code. */
export function signInCode(to: string, code: string): Message {
  const e: Frame = {
    subject: 'Your Etherchat sign-in code',
    preheader: 'It expires in 10 minutes.',
    footer: 'Etherchat never asks for this code in a chat, including in a conversation with an AI.',
  }
  const expiresIn = '10 minutes'
  const text = `Your Etherchat sign-in code:

    ${code}

Enter it on the sign-in page. It expires in ${expiresIn}.
If you didn't try to sign in, you can ignore this email.

--
${e.footer}
`
  const html = `${top(e)}
<p style="margin:0 0 10px;font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace;font-size:11px;line-height:1.4;color:#85837a;">sign-in code</p>
<p style="margin:0 0 28px;font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace;font-size:36px;line-height:1;letter-spacing:6px;color:#e9e6dc;">${escapeHtml(spaced(code))}</p>
<p style="margin:0 0 14px;">Enter it on the sign-in page. It expires in ${escapeHtml(expiresIn)}.</p>
<p style="margin:0 0 24px;color:#85837a;">If you didn't try to sign in, you can ignore this email.</p>
${bottom(e)}
`
  return { to, subject: e.subject, text, html }
}

/** Describes one invite email. */
export interface InviteDetails {
  to: string
  fromEmail: string
  etherName: string
  link: string // inviteLink(baseUrl, code)
  expiresAt: Date
  /** The IANA zone the expiry date is shown in, like America/New_York ('' is UTC). */
  timeZone: string
}

/** The page where the invited person accepts or declines. */
export function inviteLink(baseUrl: string, code: string): string {
  return trimRightSlashes(baseUrl) + '/invite/' + code
}

/** The email that invites someone to an ether. */
export function invite(d: InviteDetails): Message {
  const e: Frame = {
    subject: `${d.fromEmail} invited you to "${d.etherName}" on Etherchat`,
    preheader: 'Different LLMs, different users, one memory bank.',
    footer: "If you weren't expecting this, you can ignore it. Nobody joins an ether without accepting.",
  }
  const expiresDate = longDate(d.expiresAt, d.timeZone)
  const text = `${d.fromEmail} invited you to their ether [${d.etherName}].

Etherchat is shared memory for AI agents. Different LLMs, different users, one memory bank.

View the invite:
${d.link}

The link works only for ${d.to}, until ${expiresDate}. You'll sign in, then choose whether to join.

--
${e.footer}
`
  const html = `${top(e)}
<p style="margin:0 0 16px;font-family:'DIN Condensed','Arial Narrow','Helvetica Neue',Arial,sans-serif;font-size:26px;line-height:1.1;font-weight:700;color:#e9e6dc;word-break:break-word;">${escapeHtml(d.fromEmail)} invited you to their ether [${escapeHtml(d.etherName)}].</p>
<p style="margin:0 0 26px;color:#85837a;">Etherchat is shared memory for AI agents. Different LLMs, different users, one memory bank.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;"><tr>
<td style="border:1px solid #e9e6dc;"><a href="${safeUrl(d.link)}" style="display:inline-block;padding:11px 20px;font-family:'DIN Alternate','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1;color:#e9e6dc;text-decoration:none;">View the invite</a></td>
</tr></table>
<p style="margin:0 0 10px;font-size:13px;color:#85837a;">The link works only for ${escapeHtml(d.to)}, until ${escapeHtml(expiresDate)}. You'll sign in, then choose whether to join.</p>
<p style="margin:0 0 24px;font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace;font-size:11px;line-height:1.5;color:#85837a;word-break:break-all;">${escapeHtml(d.link)}</p>
${bottom(e)}
`
  return { to: d.to, subject: e.subject, text, html }
}

/**
 * One line of a request email. It names people and the ether, never the
 * agent's own words: an email from this domain must not carry text an agent
 * chose, or a tricked agent could send phishing.
 */
export interface RequestNewsItem {
  answered?: boolean // false: someone's agent asked you something; true: someone answered your agent
  who: string // handle: whose agent asked, or who answered
  self?: boolean // your own agent asked you
  etherName: string
  link: string
}

/** The hourly-at-most email about requests. */
export interface RequestNews {
  to: string
  items: RequestNewsItem[]
  link: string // the button: the ether when all items share one, else the home page
  settingsLink: string
}

/** The email that tells someone about new requests and answers. */
export function requestEmail(n: RequestNews): Message {
  let asked = 0
  let answered = 0
  for (const it of n.items) {
    if (it.answered) answered++
    else asked++
  }
  let subject: string
  if (asked === 1 && answered === 0 && n.items[0].self) {
    subject = 'Your agent asked you something on Etherchat'
  } else if (asked === 1 && answered === 0) {
    subject = '@' + n.items[0].who + "'s agent asked you something on Etherchat"
  } else if (asked === 0 && answered === 1) {
    subject = '@' + n.items[0].who + ' answered your agent on Etherchat'
  } else if (answered === 0) {
    subject = `${asked} requests are waiting for you on Etherchat`
  } else if (asked === 0) {
    subject = `${answered} answers to your agents' requests on Etherchat`
  } else {
    subject = 'Etherchat: ' + plural(asked, 'request', 'requests') + ' for you, ' + plural(answered, 'answer', 'answers') + ' for your agents'
  }
  const e: Frame = {
    subject,
    preheader: 'Answers reach the agents the next time they catch up.',
    footer: 'You get at most one of these an hour. To stop them, turn them off in your account: ' + n.settingsLink,
  }

  let textItems = ''
  let htmlItems = ''
  const linkStyle = 'color:#e9e6dc;text-decoration:none;'
  for (const it of n.items) {
    let line: string
    let row: string
    if (it.answered) {
      line = `- @${it.who} answered your agent's request in [${it.etherName}]. Your agent sees the answer the next time it catches up.\n`
      row = `<a href="${safeUrl(it.link)}" style="${linkStyle}">@${escapeHtml(it.who)} answered your agent's request in [${escapeHtml(it.etherName)}].</a>
<span style="display:block;margin-top:2px;font-size:13px;color:#85837a;">Your agent sees the answer the next time it catches up.</span>
`
    } else if (it.self) {
      line = `- Your agent asked you something in [${it.etherName}].\n`
      row = `<a href="${safeUrl(it.link)}" style="${linkStyle}">Your agent asked you something in [${escapeHtml(it.etherName)}].</a>\n`
    } else {
      line = `- @${it.who}'s agent asked you something in [${it.etherName}].\n`
      row = `<a href="${safeUrl(it.link)}" style="${linkStyle}">@${escapeHtml(it.who)}'s agent asked you something in [${escapeHtml(it.etherName)}].</a>\n`
    }
    textItems += `\n${line}  ${it.link}\n`
    htmlItems += `
<tr><td style="padding:10px 0;border-top:1px solid #2f2e2a;">
${row}
</td></tr>
`
  }

  const text = `Your agents need you.
${textItems}
Open Etherchat: ${n.link}
The questions themselves are on the website, not in this email.

--
${e.footer}
`
  const html = `${top(e)}
<p style="margin:0 0 20px;font-family:'DIN Condensed','Arial Narrow','Helvetica Neue',Arial,sans-serif;font-size:26px;line-height:1.1;font-weight:700;color:#e9e6dc;">Your agents need you.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;">
${htmlItems}
</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;"><tr>
<td style="border:1px solid #e9e6dc;"><a href="${safeUrl(n.link)}" style="display:inline-block;padding:11px 20px;font-family:'DIN Alternate','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1;color:#e9e6dc;text-decoration:none;">Open Etherchat</a></td>
</tr></table>
<p style="margin:0 0 24px;font-size:13px;color:#85837a;">The questions themselves are on the website, not in this email.</p>
${bottom(e)}
`
  return { to: n.to, subject: e.subject, text, html }
}

/**
 * A member asking the server's admins to allow addresses they tried to
 * invite. The addresses were checked as plain email addresses, so nothing
 * else typed by the member reaches the email.
 */
export interface AllowRequest {
  to: string // an admin
  fromEmail: string
  fromHandle: string
  emails: string[]
  command: string // how to allow one address, with EMAIL as the placeholder
}

/** The request's command for one address (Go's AllowRequest.AllowCommand). */
export function allowCommandFor(a: AllowRequest, email: string): string {
  return a.command.split('EMAIL').join(email)
}

/** The email that asks an admin to allow addresses. */
export function allowRequestEmail(a: AllowRequest): Message {
  const e: Frame = {
    subject: '@' + a.fromHandle + ' asked to allow ' + plural(a.emails.length, 'address', 'addresses') + ' on Etherchat',
    preheader: "Someone wants to invite people who can't be invited yet.",
    footer: "You get these because you're an admin of this Etherchat server. Nothing changes until you run the command.",
  }
  const one = a.emails.length === 1
  const who = one ? 'someone who' : 'people who'
  const them = one ? 'it' : 'them'
  const mono = "font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace;"

  const text = `${a.fromEmail} (@${a.fromHandle}) wants to invite ${who} can't be invited yet:
${a.emails.map((m) => `\n  ${m}`).join('')}

To allow ${them}, run this on the server:
${a.emails.map((m) => `\n  ${allowCommandFor(a, m)}`).join('')}

Then they can be invited. If you don't recognize these addresses, ignore this email.

--
${e.footer}
`
  const rows = a.emails
    .map((m) => `<tr><td style="padding:9px 0;border-top:1px solid #2f2e2a;${mono}font-size:14px;color:#e9e6dc;">${escapeHtml(m)}</td></tr>\n`)
    .join('')
  const commands = a.emails
    .map((m) => `<p style="margin:0 0 8px;padding:10px 12px;border:1px solid #2f2e2a;${mono}font-size:12px;line-height:1.5;color:#e9e6dc;word-break:break-all;">${escapeHtml(allowCommandFor(a, m))}</p>\n`)
    .join('')
  const html = `${top(e)}
<p style="margin:0 0 16px;font-family:'DIN Condensed','Arial Narrow','Helvetica Neue',Arial,sans-serif;font-size:26px;line-height:1.1;font-weight:700;color:#e9e6dc;word-break:break-word;">${escapeHtml(a.fromEmail)} (@${escapeHtml(a.fromHandle)}) wants to invite ${who} can't be invited yet.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
${rows}</table>
<p style="margin:0 0 10px;color:#85837a;">To allow ${them}, run this on the server:</p>
${commands}
<p style="margin:16px 0 24px;font-size:13px;color:#85837a;">Then they can be invited. If you don't recognize these addresses, ignore this email.</p>
${bottom(e)}
`
  return { to: a.to, subject: e.subject, text, html }
}

/**
 * Every email rendered with sample data, for reviewing the design. The keys
 * are file names like "invite.html". timeZone is the zone the invite's expiry
 * is shown in (the runtime's own by default, as Go's time.Local).
 */
export function previews(baseUrl: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Record<string, string> {
  const base = trimRightSlashes(baseUrl)
  const messages: Record<string, Message> = {
    signin: signInCode('you@example.com', '359569'),
    invite: invite({
      to: 'sam@example.com', fromEmail: 'you@example.com', etherName: 'Atlas: research notes',
      link: inviteLink(baseUrl, 'ABCD-EFGH-IJKL-MNOP'), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), timeZone,
    }),
    requests: requestEmail({
      to: 'you@example.com', link: base + '/', settingsLink: base + '/account',
      items: [
        { who: 'sam', etherName: 'Atlas: research notes', link: base + '/e/abc' },
        { self: true, who: 'you', etherName: 'Atlas: research notes', link: base + '/e/abc' },
        { answered: true, who: 'sam', etherName: 'Thesis', link: base + '/e/abc/comms' },
      ],
    }),
    allow: allowRequestEmail({
      to: 'admin@example.com', fromEmail: 'you@example.com', fromHandle: 'you',
      emails: ['lee@example.org', 'kim@example.com'],
      command: 'sudo -u etherchat node /opt/etherchat/ts/src/run/node.ts admin --env /etc/etherchat/etherchat.env allow --email EMAIL',
    }),
  }
  const out: Record<string, string> = {}
  for (const [name, m] of Object.entries(messages)) {
    out[name + '.html'] = m.html
    out[name + '.txt'] = 'Subject: ' + m.subject + '\n\n' + m.text
  }
  return out
}

// The frame every HTML email shares. Email clients ignore most CSS, so the
// layout is tables and every style is inline. Colors and fonts match the web
// view: ink, bone, graphite, hairline rules.

function top(e: Frame): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${escapeHtml(e.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#000000;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(e.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#000000;">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
<tr><td style="padding:0 0 16px;border-bottom:1px solid #2f2e2a;font-family:'DIN Condensed','Arial Narrow','Helvetica Neue',Arial,sans-serif;font-size:26px;line-height:1;font-weight:700;color:#e9e6dc;">etherchat</td></tr>
<tr><td style="padding:32px 0 8px;font-family:'DIN Alternate','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#e9e6dc;">
`
}

function bottom(e: Frame): string {
  return `
</td></tr>
<tr><td style="padding:22px 0 0;border-top:1px solid #2f2e2a;font-family:ui-monospace,Menlo,Consolas,'Courier New',monospace;font-size:11px;line-height:1.6;color:#85837a;">${escapeHtml(e.footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? '1 ' + one : `${n} ${many}`
}

function spaced(code: string): string {
  return code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code
}

function trimRightSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s[end - 1] === '/') end--
  return s.slice(0, end)
}

/** Like Go's t.Format("January 2, 2006") in the given zone. */
function longDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(d)
}

// html/template's escaping, reproduced so the HTML parts match Go's exactly.

const htmlReplacements: Record<string, string> = {
  '\0': '\uFFFD',
  '"': '&#34;',
  '&': '&amp;',
  "'": '&#39;',
  '+': '&#43;',
  '<': '&lt;',
  '>': '&gt;',
}

/** Escapes text and quoted attribute values as html/template does. */
export function escapeHtml(s: string): string {
  return s.replace(/[\0"&'+<>]/g, (c) => htmlReplacements[c])
}

/**
 * Escapes a value for an href attribute as html/template does: a URL whose
 * scheme isn't http, https or mailto becomes "#ZgotmplZ", characters that
 * don't belong in a URL are percent-encoded (keeping valid escapes), and the
 * result is HTML-escaped.
 */
export function safeUrl(s: string): string {
  return escapeHtml(normalizeUrl(filterUrl(s)))
}

function filterUrl(s: string): string {
  const colon = s.indexOf(':')
  if (colon >= 0) {
    const protocol = s.slice(0, colon)
    if (!protocol.includes('/')) {
      const p = protocol.toLowerCase()
      if (p !== 'http' && p !== 'https' && p !== 'mailto') return '#ZgotmplZ'
    }
  }
  return s
}

const keepInUrl = new Set("!#$&*+,/:;=?@[]-._~".split('').map((c) => c.charCodeAt(0)))

function isHex(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)
}

function isAlnum(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
}

/** Go's urlNormalizer: percent-encodes each UTF-8 byte that isn't allowed. */
function normalizeUrl(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (isAlnum(b) || keepInUrl.has(b)) {
      out += String.fromCharCode(b)
    } else if (b === 0x25 && i + 2 < bytes.length && isHex(bytes[i + 1]) && isHex(bytes[i + 2])) {
      out += '%'
    } else {
      out += '%' + b.toString(16).padStart(2, '0')
    }
  }
  return out
}
