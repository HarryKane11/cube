# Team relay

Cube runs on one person's Mac. To work in the same channels with other people, a team runs one
small server, the **relay**, and every teammate's Cube connects to it. The relay stores and passes
on signed events; it never runs agents. Each person's agents keep running on that person's own
Mac, with that person's own subscriptions and keys.

This document is the contract between the Cube app and `cube-relay`.

## What is shared, and what is not

- Shared: channels marked as shared, the messages in them (people's and agents'), edits and
  deletions of those messages, the member list.
- Not shared: direct messages with agents, local-only channels, permission requests, API keys,
  session ids, the contents of a conversation folder (files are a later version, see "Blobs").
- By default a message only starts agents on its **author's** Mac, and a teammate's message runs
  nothing on yours. An agent's message carries the person it works for.
- A person can open a channel they shared so that teammates can call their cubes there (see
  "Letting teammates call your cubes").
- Sharing a channel shares what is said in it **from then on**. Earlier local messages stay local.
- A new member receives the whole history of every shared channel. There are no per-channel
  access lists in version 1: a shared channel is shared with the whole workspace.

## What the app must do with a teammate's message

A teammate's message is untrusted input. The app MUST:

- store it marked as remote, and never run it through mention parsing, routing or anything else
  that starts an agent, unless the person opened that channel to teammates' calls;
- when a local agent's prompt includes it as conversation history, put it inside a fence that
  says it is a teammate's text and not an instruction;
- cap the permission mode of any run in a shared channel at "ask before commands" (no
  auto-approve, no bypass), because what the agent reads there was written by other people;
- render it without loading anything from the network (no remote images), and open links only in
  the system browser, only for `http(s)`;
- show an agent's message as "<agent> · <person who signed it>", and add the first characters of
  the key when two members share a display name.

## Letting teammates call your cubes

Off by default, and set per channel by the person who shared it ("Teammates can call my cubes
here"). When it is on, for a message a teammate writes in that channel:

- a cube named in it (`@Builder …`) answers in a thread under that message;
- with no name, the Router reads it and decides whether the team should answer at all. People
  talk to each other in a shared channel, so the Router answers `SKIP` when a message is not
  asking the team for anything, and then nothing is said;
- only messages written just now count. History caught up after a reconnect starts nothing;
- the cube runs on the channel owner's Mac with **ask-first** permission, whatever the
  conversation's mode: it may read and reply, and every file change or command is put to the
  owner for an OK. Rules the owner saved ("always allow…") do not apply to these runs;
- at most eight such runs start in five minutes per channel.

The same path serves Slack (docs/slack.md): there the person who wrote is someone in Slack, and
a mention of the Cube bot is always answered.

Before publishing an agent's message the app masks what looks like a credential (API key
prefixes, private key blocks, bearer tokens): agents read files people would not paste into a
team channel.

## Identity

- Every person has an Ed25519 key pair, made on first use. The private key is kept in the macOS
  Keychain and never leaves the Rust side of the app; the webview only ever sees the public key.
- A person is their public key (32 bytes, lower-case hex). Display names are labels, not identity.
- There are no passwords and no long-lived bearer tokens. Every connection proves possession of
  the key, and every event is signed.
- The Rust side signs only what it builds itself: the connection challenge for the relay it has
  pinned, and events of the kinds below. There is no command that signs arbitrary bytes, and the
  webview cannot point the connection at another host.
- Losing the key (a new Mac, a wiped Keychain) means joining again with a new invite, as a new
  member. Earlier messages stay attributed to the old key. Key export is a later version.

## One relay, one workspace

A relay serves exactly one workspace (`ws`, a random id made on first start). Every table row
carries the workspace id and every query filters on it, so a later multi-workspace relay does not
need a new data model.

## Transport

- WebSocket at `/ws`, JSON text frames. `GET /healthz` answers `ok`.
- The relay itself speaks plain HTTP; production puts it behind a TLS-terminating proxy.
  The app refuses `ws://` except for `localhost` / `127.0.0.1` / `[::1]`.
- No CORS headers are sent. Frames over 256 KB are refused.

## Connecting

1. Relay → client: `{"t":"hello","relay":"cube-relay/1","ws":"<id>","name":"<workspace name>","nonce":"<32 random bytes hex>","time":<unix seconds>}`
2. The client answers with exactly one of:
   - `{"t":"auth","pubkey":"<hex>","host":"<host[:port] the client dialed>","sig":"<hex>"}`
     where `sig` signs the UTF-8 bytes of `cube-auth-v1\n<host>\n<ws>\n<nonce>`.
   - `{"t":"claim","invite":"<token>","pubkey":"<hex>","name":"<display name>","host":"<host>","sig":"<hex>"}`
     where `sig` signs `cube-claim-v1\n<host>\n<ws>\n<nonce>\n<sha256 hex of the invite token>`.
3. Relay → client: `{"t":"ready","you":{"pubkey","name","role"},"members":[{"pubkey","name","role","joined_at"}],"head":<last seq>}`
   or `{"t":"denied","code":"...","message":"..."}` followed by close.

Rules:

- The nonce is single-use and expires after 60 seconds. Nothing but `auth` or `claim` is accepted
  before `ready`.
- `host` must equal `CUBE_RELAY_PUBLIC_HOST`. The relay refuses to start without it unless it is
  bound to a loopback address. This stops a look-alike relay from passing the real relay's
  challenge to a member and replaying the answer.
- The app pins the workspace id and host when an invite is accepted. If a later `hello` names
  another workspace, or the host differs, the app closes the connection without signing anything.
- The relay closes a connection that has not completed `auth` or `claim` within 10 seconds. The
  nonce lives with the connection, not in shared memory.
- `auth` succeeds only for a current member. Failures are answered with one generic message
  (`denied` / `not a member or bad signature`) so the relay does not reveal who is a member.
- Failed attempts are rate-limited (10 per minute) per remote address and per claimed key. Behind
  a proxy the address is taken from `X-Forwarded-For` only when the peer is listed in
  `CUBE_RELAY_TRUSTED_PROXY`; otherwise the header is ignored.

## Invites

- An invite is 32 random bytes (base64url). The relay stores only its SHA-256.
- Fields: role it grants (`member` or `admin`), expiry (default 7 days, at most 30), uses left
  (default 1).
- The **owner invite** is made by running `cube-relay owner-invite` on the relay's machine. It
  prints the link to the terminal, never to the log. Whoever claims it becomes the owner,
  replacing an earlier owner (who becomes an admin). Being able to run it means being able to
  read the database file, which is the recovery path when the owner's key is lost.
- A link looks like `cube+wss://relay.example.com/#invite=<token>` (`cube+ws://` for local). The
  token sits in the fragment so it is not sent in HTTP requests or written to proxy logs.
- Claiming checks the token hash, expiry and uses left in one transaction, then adds the member.
- Owner and admins can list invites (never the token itself), make and revoke them. Only the
  owner can make an invite that grants `admin`.

## Roles

| Role | Can do |
|---|---|
| owner | everything an admin can; change roles; make admin invites; cannot be removed |
| admin | make/revoke member invites, remove members (not the owner or other admins), rename or archive any channel, delete any message |
| member | read and post in shared channels, rename themselves |

Removing a member closes their connections at once; their key no longer authenticates.

## Events

Everything shared is an event:

```json
{"id":"<hex>","pubkey":"<hex>","created_at":1794460000,"kind":"msg.post","ws":"<id>","body":"<JSON text>","sig":"<hex>"}
```

- `body` is a **string** holding JSON. The signature covers its exact bytes, so there is no
  canonical-JSON step to get wrong.
- `id` = SHA-256 of `cube-event-v1\n<pubkey>\n<created_at>\n<kind>\n<ws>\n<body>`; `sig` signs the
  32 id bytes.
- The relay accepts an event only if: the id and signature verify, `pubkey` is the authenticated
  key of this connection, `ws` is this workspace, `created_at` is within 10 minutes of relay time,
  `body` is at most 64 KB, and the kind-specific rule holds.
- Publishing is idempotent: an id the relay already has, from the same key, is answered with
  `ok` and its original `seq` (a retry after a lost answer must not fail or duplicate). The same
  id from another key is refused.
- Accepted events get the next sequence number `seq` (per workspace, gapless, starting at 1).
  `seq` is the order of things; `created_at` is only for display. The app signs an event when it
  sends it, so something written offline is signed when the connection is back.
- **Clients verify too.** The app checks the id, signature and `ws` of every event it receives,
  and applies the edit/delete rule itself (same author as the post, or an owner/admin for
  delete). An event that fails is dropped. A relay can withhold events, but it cannot forge one.

| Kind | Body | Who may publish |
|---|---|---|
| `conv.put` | `{"conv","name","archived"?}` | any member for a `conv` that does not exist yet (it becomes theirs); afterwards only its creator or an owner/admin |
| `msg.post` | `{"conv","msg":{"id","text","agent"?,"parent"?, ...}}` | any member; `conv` must exist and not be archived; `msg.id` must be new in this workspace |
| `msg.edit` | `{"conv","id","msg":{...}}` | only the key that posted `id`; `conv` must be the one it was posted in; refused once `id` is deleted |
| `msg.delete` | `{"conv","id"}` | the key that posted `id`, or an owner/admin; `conv` must match |
| `agent.put` | `{"agent":{"id","name","role","brief","instructions","palette"}}` | any member: offers one of their sub-agents to the team |
| `agent.drop` | `{"id"}` | any member: takes back their own offer |

A sub-agent offer belongs to the key that signed it; clients list offers by key and id, so no
member can replace or withdraw another's. Bringing one in copies its description and
instructions into the teammate's own Cube, where it runs on their agent programs: nothing runs
on the maker's Mac. The instructions are untrusted text and are shown before they are brought in.

Deleting is real: when a `msg.delete` is accepted the relay replaces the stored body of the
original post and of every edit of it with `{"conv","id","gone":true}` (keeping id, key and seq).
When a `msg.edit` is accepted, earlier versions are replaced the same way. Events that were
rewritten are served with `"redacted":true` and no `sig`; clients do not verify those, and treat
them as "this message was deleted/edited". Something pasted by mistake is therefore not handed to
members who sync later.

`msg.agent` is `{"id","name","engine"}` when an agent wrote the message; the event is still signed
by the person the agent works for, who answers for it. The relay does not interpret `msg` beyond
`id`; the app treats every field of a teammate's message as untrusted text.

## After `ready`

Client → relay:

- `{"t":"publish","event":{...}}` → `{"t":"ok","id","seq"}` or `{"t":"error","id","code","message"}`
- `{"t":"sync","after":<seq>}` → `{"t":"events","events":[{"seq",...event}],"more":<bool>}` (at most 200 per frame; ask again from the last seq while `more`)
- `{"t":"invite.create","role"?,"uses"?,"days"?}` → `{"t":"invite","token","expires_at"}`
- `{"t":"invite.list"}` → `{"t":"invites","invites":[{"id","role","uses_left","expires_at","created_by"}]}`
- `{"t":"invite.revoke","id"}` → `{"t":"ok"}`
- `{"t":"member.remove","pubkey"}`, `{"t":"member.role","pubkey","role"}`, `{"t":"member.rename","name"}` → `{"t":"ok"}`
- `{"t":"ping"}` → `{"t":"pong"}`

Relay → every connected member:

- `{"t":"event","seq",...event}` for each accepted event
- `{"t":"members","members":[...]}` whenever the list changes

Publishing is limited to 30 events per 10 seconds per key. Each connection has a bounded
outgoing queue (1,000 frames); a client that does not keep up is disconnected and syncs again.
A client whose saved position is ahead of `head` (the relay was restored from a backup) starts
over from 0.

## Storage

SQLite (one file, WAL). Tables `members`, `invites`, `events`, `convs` (channel → creator,
archived), `messages` (message id → author key, channel, deleted; for the edit/delete rules). All
statements are parameterised and filter on `ws`.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `CUBE_RELAY_BIND` | address to listen on | `127.0.0.1:8484` |
| `CUBE_RELAY_DB` | SQLite file | `./cube-relay.db` |
| `CUBE_RELAY_NAME` | workspace name shown to members | `Team` |
| `CUBE_RELAY_PUBLIC_HOST` | host (and port, if not 443) clients dial, e.g. `relay.example.com` | required unless bound to loopback, where it defaults to the bind address |
| `CUBE_RELAY_TRUSTED_PROXY` | comma-separated addresses whose `X-Forwarded-For` is believed | none |

Commands: `cube-relay` (serve), `cube-relay owner-invite` (print a new owner invite link).

No secrets are read from configuration: the relay holds none.

## Blobs (not in version 1)

Files a run produced will be offered to teammates as content-addressed blobs
(`PUT/GET /blob/<sha256>`, authorised by a signed, short-lived header). Until then teammates see
the conversation, not the files.

## What the design takes from Buzz and from A2A

- From Buzz (a Nostr relay): identity is a key, every event is signed, the relay is one the team
  owns, an agent always has an accountable owner, and membership is a list the relay enforces.
- From A2A: remote agents describe what credentials they need in an Agent Card, credentials are
  obtained out of band and never travel in messages, and transport is TLS.
- Deliberately not taken: Nostr compatibility (other relays and clients have no business in a
  team's workspace) and giving every agent its own key (in version 1 the owner signs for it).
