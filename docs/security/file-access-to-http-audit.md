---
title: js/file-access-to-http audit — #474
status: adopted
related: [#474, file-system-race-stance.md]
last_verified: 2026-04-19
---

# js/file-access-to-http audit (#474)

Companion to `file-system-race-stance.md`. Covers the 4 CodeQL
`js/file-access-to-http` alerts from the #474 first-scan bucket —
all in the federation transport layer.

## Rule intent

`js/file-access-to-http` fires when content read from the local
filesystem flows into an outbound HTTP request body, URL, or header.
The attacker model the rule targets: a server-side app that blindly
proxies arbitrary files to a remote endpoint, leaking secrets
(`/etc/passwd`, SSH keys, unrelated app state) over the wire.

## Threat model reminder

`maw` is a local single-user CLI running as the invoking user's uid.
The federation config files it reads — `~/.config/maw/maw.config.json`
(carries `federationToken`) and `~/.config/maw/workspaces/*.json`
(carries `hubUrl` + workspace `token`) — are **written by the user**
to describe where `maw` should send federation traffic and how to
authenticate. Sending their contents on the wire is the whole
purpose of the federation transport. There is no attacker-controlled
path from disk to request: the user chose the destination and the
credential.

## Classification rubric

Every `js/file-access-to-http` alert under maw-js is tagged as one of:

| Class            | Action    | When                                                              |
|------------------|-----------|-------------------------------------------------------------------|
| **TRUE-LEAK**    | Fix       | Attacker-influenced path or glob widens the set of files sent; or unrelated local file content ends up in body/URL/header. |
| **EXPECTED-AUTH**| Accept    | Federation credential/URL read from the user's own maw config is placed in the auth header, auth frame, or connection URL of a peer the user configured. Sending it is the designed behavior. |
| **EXPECTED-PAYLOAD** | Accept | Content of a user-specified file is the explicit payload of a user-invoked upload verb (none on maw today; reserved for future `maw upload` or similar). |

"Accept" = dismiss the alert via the Code Scanning API with a
`dismissed_comment` pointing here. Inline comments are human
breadcrumbs only (see file-system-race-stance.md §"Acceptance
mechanism").

## The 4 sites from #474

| Site                                          | Class          | Source (file read)                         | Sink (HTTP path)                        | Justification |
|-----------------------------------------------|----------------|--------------------------------------------|-----------------------------------------|---------------|
| `src/core/transport/curl-fetch.ts:59`         | EXPECTED-AUTH  | `loadConfig().federationToken` from `maw.config.json` | `fetch(url, { headers, ... })` where `headers` carry the HMAC signature derived from the token | The token is the federation credential; signing peer calls with it is the entire reason `curlFetch` loads config. Signing failure fails closed (lines 37–45). |
| `src/core/transport/curl-fetch.ts:62`         | EXPECTED-AUTH  | Same as :59                                | `fetch(url, { body: opts?.body })`      | `opts.body` is caller-built JSON (peer RPC payload, not file content). The config-file leg of the taint path is the token flowing into `headers` — flagged at :62 because CodeQL collapses the fetch options bag into one sink. Same justification as :59. |
| `src/transports/hub-connection.ts:40`         | EXPECTED-AUTH  | `conn.config.token` loaded from `~/.config/maw/workspaces/<id>.json` | `conn.ws.send(JSON.stringify(authPayload))` — first WS frame after connect | The workspace token authenticates the hub-transport WS to the user-chosen workspace hub. Sending it is the designed auth handshake. |
| `src/transports/hub-connection.ts:175`        | EXPECTED-AUTH  | `conn.config.hubUrl` from the same workspace JSON  | `new WebSocket(conn.config.hubUrl)` — connection URL | The hub URL is user-supplied; connecting to it is the entire point of the hub transport. Schema validated in `hub-config.ts:47` (`ws:`/`wss:` only). |

All 4 sites classify as **EXPECTED-AUTH**. No code change required.

### Why these aren't TRUE-LEAK

- **No attacker-influenced path**: the filenames (`maw.config.json`,
  workspace JSONs under `~/.config/maw/workspaces/`) are hard-coded
  constants in `src/core/paths.ts` + `hub-config.ts`, not a glob or
  a user-message parameter. An attacker would need same-uid shell
  to swap the file, which also gives them the whole home dir —
  redundant with the threat model (see
  `file-system-race-stance.md` §"Threat model").
- **No over-broad payload**: we send the token, not the file
  contents. Even if an attacker somehow inserted unrelated JSON
  into `maw.config.json`, only `federationToken` is extracted and
  signed into the header; the rest of the file is not sent.
- **Destination is not attacker-chosen**: both `url` (peer list)
  and `hubUrl` (workspace) come from the same user-owned config.
  Exfiltration requires the user to have already configured the
  attacker's server as a peer/hub, at which point the attacker
  already has whatever the user granted.

### Why no TRUE-LEAK fix is needed

A token in an auth header on a user-configured connection is not
a leak — it is the protocol. A generic fix ("don't put file content
in HTTP requests") would break the federation transport entirely.
The rule is correct to flag the data flow; the policy judgment that
this specific flow is intended lives in this document.

## Acceptance mechanism

Identical to `file-system-race-stance.md`:

```
PATCH /repos/Soul-Brews-Studio/maw-js/code-scanning/alerts/{number}
{
  "state": "dismissed",
  "dismissed_reason": "won't fix",
  "dismissed_comment": "EXPECTED-AUTH — federation credential from user-owned maw config flowing to user-configured peer; out of threat model per docs/security/file-access-to-http-audit.md"
}
```

The alert-dismisser agent lane handles the PATCH after this PR
merges (tracked off #474).

## Revisit triggers

Re-audit if any of:

- `maw` grows a verb that reads an **arbitrary** user-supplied path
  and POSTs its bytes (e.g. a real `maw upload`) — that would be
  EXPECTED-PAYLOAD, but the whitelist must be explicit and the site
  listed here.
- Federation config moves to a shared/system path (e.g.
  `/etc/maw/config.json`) so the same-uid argument no longer holds.
- `federationToken` starts pulling from env/CLI/attacker-reachable
  sources in addition to the config file, widening the source.

## Related

- #474 — CodeQL first-scan bucket.
- `file-system-race-stance.md` — parallel stance for the
  `js/file-system-race` bucket.
- `codeql-sanitizer-model.md` — parallel stance for
  `js/log-injection`.
- `lgtm-annotation-investigation.md` — why inline `// lgtm[...]`
  alone does not close alerts; dismissal via API is required.
