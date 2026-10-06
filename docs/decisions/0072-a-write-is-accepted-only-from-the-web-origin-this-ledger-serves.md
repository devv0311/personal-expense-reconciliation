# 0072. A write is accepted only from the web origin this ledger serves

**Status:** Accepted — **ratified by the owner on 6 October 2026, as built** (the owner's answer to the
round-14 release checklist: "1. Approved"). Implemented the same day as a security fix found by the
round-11 review; until the owner's approval it was recorded as _not yet reviewed_ (history kept). It
changes no financial rule, but it changes which requests the API answers, so it is written down rather
than assumed.

## Context

The API listens on loopback and, by default there, has no password (`AUTH_REQUIRED` defaults to
off for a loopback bind). Its only browser-facing protection was CORS, which decides what a web
page may _read_. It does not stop a browser _sending_ a request, and a `POST` whose body is
declared `text/plain` is a "simple" request that needs no preflight. The JSON body parser does not
care what the body was declared as, so every write route accepted it.

Reproduced on a synthetic scratch API (`round11/logs/10…`, `11…`): a page served from
`http://localhost:3001` (not the configured `http://127.0.0.1:3001`) sent
`fetch(api, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body })`
and a person was created. The page could not read the answer; it did not need to. Any website the
owner visits while the ledger is running could do the same with a decision, a statement import or a
settlement. Separately, nothing checked the `Host` header, so a domain re-pointed at 127.0.0.1
(DNS rebinding) is same-origin to the browser and could _read_ the ledger.

## Decision

`src/request-guard.ts`, applied in `src/server.ts` before any route (transport, not `src/api`,
exactly as CORS is):

- **A write (any method other than `GET`, `HEAD`, `OPTIONS`) that carries an `Origin` header is
  refused with `403 ORIGIN_NOT_ALLOWED` unless that origin is the configured web origin**
  (`CORS_ORIGIN`). A caller that sends no `Origin` — a script, `curl`, a test — is unaffected: it is
  not a browser acting for a stranger.
- **On a loopback bind, a request whose `Host` is not `localhost`, `127.0.0.1` or `::1` is refused
  with `403 HOST_NOT_ALLOWED`**, for every method. A bind to a real interface keeps authentication on
  by default and is not judged on `Host`.

Reads from another origin are still answered; CORS already withholds the response from the page.

## Consequences

- The web app (always at `CORS_ORIGIN`) is unaffected; the only browsers that stop working are ones
  already blocked by CORS, since a JSON write needs a preflight that passes only for that origin.
- This is **not authentication**. A local process, or anything that sends no `Origin`, can still
  write to a ledger with `AUTH_REQUIRED=false`. That is the loopback deployment boundary
  (see the round-11 security readiness report), unchanged.
- A running server picks this up only after a restart.

## Observable behaviour (verified round 14, production build, synthetic ledger)

| Request                                                                                                                      | Result                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Write from the configured web origin; write with no `Origin` (script, `curl`)                                                | accepted                                                                                        |
| Write with another origin, a sibling `localhost`/`127.0.0.1` origin, a different scheme, a trailing slash, or `Origin: null` | `403 ORIGIN_NOT_ALLOWED`, nothing changed (also for multipart uploads, before the body is read) |
| Cross-origin `GET` or `OPTIONS`                                                                                              | answered as before; CORS withholds the response from the page                                   |
| `Host` of `localhost`, `127.0.0.1`, `[::1]` (any case, any port) on a loopback bind                                          | accepted                                                                                        |
| Any other `Host`, including `localhost.` (trailing dot) and look-alikes                                                      | `403 HOST_NOT_ALLOWED`                                                                          |

Every response, from any route, also carries `X-Content-Type-Options: nosniff` (`applyBaselineHeaders`; added after the round-15 HawkScan run reported it missing on every JSON
route, then confirmed gone by a rescan). The refusal message deliberately does not repeat the configured origin back to the refused page.

The origin must equal `CORS_ORIGIN` character for character, as CORS already requires. A hostile `<form>` POST from a page on another origin was
refused like the `fetch` case (the browser sends `Origin` on it). Duplicate `Host` headers are collapsed by Node to the first, and a browser never
sends two, so this is not reachable from a page. A reverse proxy that serves the web app and API under one public origin must set `CORS_ORIGIN` to that
origin; `X-Forwarded-*` headers are not trusted or read.

## Alternatives not taken

- **Require `Content-Type: application/json` on writes.** It also forces a preflight, but it is
  a side effect of the parser rather than a statement of intent, and a future route that accepts
  another type would reopen it.
- **A CSRF token or a session on loopback.** Correct, and much larger: it is the authentication
  platform this change deliberately is not.
