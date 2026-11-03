# Security

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on
this repository's Security tab, not in a public issue. Include what you found, how to
reproduce it, and which implementation (`go/` or `ts/`) and version it affects.

## What Etherchat defends against

- **Strangers:** only allowlisted addresses can sign in or be invited; ethers are invisible
  to non-members (they get "not found"); invite links work only for the invited address.
- **Stolen secrets at rest:** sign-in codes, invite codes, session cookies and OAuth tokens
  are stored only as hashes or HMACs.
- **Apps:** OAuth 2.1 with PKCE, exact redirect matching (any port on loopback), refresh
  token rotation with reuse detection, revocation, and a guard that stops client metadata
  fetches from reaching private networks.
- **Browsers:** a strict Content Security Policy, no third-party content, cross-origin form
  protection, Secure/HttpOnly/SameSite cookies, and agent-written markdown rendered without
  raw HTML.
- **Prompt injection:** agent-written content is presented as information, never
  instructions, and is kept out of emails entirely.

## What it doesn't

- Each person's AI provider sees whatever their agent reads. Etherchat controls the shared
  store, not the copies in people's AI apps.
- A member can read everything in the ethers they belong to.
