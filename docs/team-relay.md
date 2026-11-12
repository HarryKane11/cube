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
- A shared channel is **public** (every member of the workspace reads it) or **private** (only
  the members in its list do). Which one is chosen when the channel is shared and never changes.
  See "Channels and who can read them".
- A new member receives the whole history of every public channel, and of a private channel
  from the moment they are put in it.

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

## Channels and who can read them

Every shared channel has a member list on the relay (`conv_members`). The person who shares a
channel is its first member; others are added by `conv.add`, by claiming an invite that names
the channel, and taken out by `conv.remove`.

The rule, enforced only by the relay:

> A member can read a channel if the channel is public, or if they are in its member list.

- For a public channel the list only records who was put in it; everyone reads and posts anyway.
- For a private channel the list is the access list. Someone who is not in it is not sent its
  events, live or in `sync`, and every request that names it is answered exactly as for a
  channel that does not exist (`no_conv`). That holds for the owner and admins too: their
  role lets them manage public channels and the team, not read or change a private channel
  they are not in.
- Events that belong to no channel (`agent.put`, `agent.drop`) go to everyone.
- Anyone in a channel can add a teammate to it. The channel's creator, and an owner or admin who
  is in it, can take others out; anyone can leave. The creator is not taken out by others.
- Someone added to a private channel can read all of it, from its first event. Someone taken
  out is sent that one `conv.remove` and nothing after it.
- Removing a member from the team takes them out of every channel's list. If they come back
  with a new invite, they are in no private channel.

Two limits, stated plainly:

1. **The relay stores plaintext.** "Private" means private among the members of the team. It
   does not mean private from whoever runs the relay, who can read the database file.
2. **What a member already received stays on their Mac.** Taking someone out of a channel, or
   off the team, stops what they are sent from then on. It does not delete what their Cube
   already stored.

Two more things an app must expect:

- Message ids are unique across the workspace, so posting with an id that is taken in a private
  channel is refused with `duplicate_msg`. Ids are random, so this tells nobody anything useful.
- A `conv.put` for a private channel's id by someone outside it is refused with `no_conv`,
  whereas the same id would have been accepted if the channel did not exist. Channel ids must
  therefore be random too (the app makes them so).

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
3. Relay → client: `{"t":"ready","you":{"pubkey","name","role"},"members":[{"pubkey","name","role","joined_at"}],"head":<seq>,"features":["channels"],"settings":{"member_invites":<bool>}}`
   or `{"t":"denied","code":"...","message":"..."}` followed by close.

`head` is the highest `seq` this member is served (see "What a member is served"), not the last
one stored. `features` names what the relay does beyond the first version of this document;
`channels` stands for everything about private channels here (`conv.add`, `conv.remove`,
`private`, `sync` by channel, `next`, `conv.members`, `settings`). A relay without it sends no
`features` at all, and the app then offers public channels only.

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
  (default 1), and optionally a channel (`conv`).
- An invite with a channel puts whoever claims it in that channel's member list, in the same
  transaction that makes them a member, recorded as added by the invite's maker. If the channel
  was archived in the meantime they become a member without it. No event is published for this:
  the others in the channel see the new teammate in `members` and ask `conv.members`.
- The **owner invite** is made by running `cube-relay owner-invite` on the relay's machine. It
  prints the link to the terminal, never to the log. Whoever claims it becomes the owner,
  replacing an earlier owner (who becomes an admin). Being able to run it means being able to
  read the database file, which is the recovery path when the owner's key is lost.
- A link looks like `cube+wss://relay.example.com/#invite=<token>` (`cube+ws://` for local). The
  token sits in the fragment so it is not sent in HTTP requests or written to proxy logs.
- Claiming checks the token hash, expiry and uses left in one transaction, then adds the member.
- Owner and admins can list invites (never the token itself), make and revoke them. Only the
  owner can make an invite that grants `admin`. An invite may name only a channel its maker can
  read.
- A plain member can make an invite only while the workspace setting `member_invites` is on
  (the default), only for a channel they can read, and only one that grants `member`. They list
  and revoke the invites they made, not other people's.
- An invite stops working when its maker is removed from the team or demoted to member, when
  its maker is taken out of (or leaves) the channel it names, and, for invites made by plain
  members, when the owner turns `member_invites` off.
- The listing names an invite's channel only to someone who can read that channel; for anyone
  else `conv` is `null`.

## Roles

| Role | Can do |
|---|---|
| owner | everything an admin can; change roles; make admin invites; change workspace settings; cannot be removed |
| admin | make/revoke member invites, remove members (not the owner or other admins), rename or archive any channel they can read, delete any message in a channel they can read, take members out of a channel they are in |
| member | read and post in public channels and in the private channels they are in, add teammates to those, invite people to them (if `member_invites` is on), rename themselves |

A role gives nothing in a private channel its holder is not in.

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
- Accepted events get the next sequence number `seq` (per workspace, starting at 1). The relay
  numbers every event in one series, so **the seqs a member sees have gaps** wherever an event
  belongs to a private channel they are not in. A gap is not a sign of loss; the app never
  waits for a missing number.
  `seq` is the order of things; `created_at` is only for display. The app signs an event when it
  sends it, so something written offline is signed when the connection is back.
- An event's id covers its key, time (to the second), kind and body. The same body signed in
  the same second is therefore the same event and is answered as a retry: adding someone,
  taking them out and adding them again within one second publishes two events, not three.
- **Clients verify too.** The app checks the id, signature and `ws` of every event it receives,
  and applies the edit/delete rule itself (same author as the post, or an owner/admin for
  delete). An event that fails is dropped. A relay can withhold events, but it cannot forge one.
  Who may read a channel is different: only the relay decides that, by what it sends.

| Kind | Body | Who may publish |
|---|---|---|
| `conv.put` | `{"conv","name","private"?,"archived"?}` | any member for a `conv` that does not exist yet (it becomes theirs, and they are its first member); afterwards only its creator or an owner/admin, and only if they can read it |
| `msg.post` | `{"conv","msg":{"id","text","agent"?,"parent"?, ...}}` | anyone who can read `conv`, which must not be archived; `msg.id` must be new in this workspace |
| `msg.edit` | `{"conv","id","msg":{...}}` | only the key that posted `id`, who must be able to read `conv`; `conv` must be the one it was posted in; refused once `id` is deleted |
| `msg.delete` | `{"conv","id"}` | the key that posted `id`, or an owner/admin; either must be able to read `conv`, which must match |
| `conv.add` | `{"conv","member"}` | anyone who can read `conv`; `member` (a public key) must be on the team; adding someone already in is accepted and changes nothing |
| `conv.remove` | `{"conv","member"}` | someone who can read `conv` and is that member (leaving), the channel's creator, or an owner/admin; the creator is not removed by others; `member` must be in the channel |
| `agent.put` | `{"agent":{"id","name","role","brief","instructions","palette"}}` | any member: offers one of their sub-agents to the team |
| `agent.drop` | `{"id"}` | any member: takes back their own offer |

`private` counts only in the `conv.put` that creates the channel (absent means public). A later
`conv.put` may leave it out or repeat the stored value; one that says otherwise is refused with
`visibility_fixed`. Clients take a channel's visibility from the first `conv.put` they hold for
it and ignore `private` in later ones.

For every kind that names a channel the relay first checks that the signer can read it, before
anything that depends on a message: a channel that does not exist and a private channel the
signer is not in are both answered `no_conv`, whether or not the message id exists. A message
in a private channel the signer is not in is `not_found` when named through another channel.

What the relay answers to a refused publish (`{"t":"error","id","code","message"}`):

| Code | When |
|---|---|
| `no_conv` | the channel does not exist, or is private and the signer is not in it (every kind but `agent.*`; for `conv.put` only the second case) |
| `archived` | `msg.post` or `msg.edit` in an archived channel |
| `forbidden` | `conv.put` by someone who is neither the creator nor an owner/admin; `msg.edit` by another key; `msg.delete` by someone who is neither the author nor an owner/admin; `conv.remove` of someone else by a plain member who did not create the channel; `conv.remove` of the creator by anyone else |
| `visibility_fixed` | `conv.put` with a `private` that differs from the channel's |
| `not_found` | `msg.edit`/`msg.delete` of an unknown message; `conv.add` of a key that is not on the team; `conv.remove` of someone who is not in the channel |
| `wrong_conv`, `gone`, `duplicate_msg` | as before: the message is in another channel the signer can read; it was deleted; its id is taken |
| `bad_body` | the body is not the shape in the table (`member` must be 64 lower-case hex characters, `private` and `archived` true or false) |
| `not_member`, `bad_time`, `unknown_kind`, `rate_limited`, `too_large`, `wrong_key`, `wrong_workspace`, `bad_id`, `bad_signature`, `bad_request`, `duplicate`, `internal` | unchanged |

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
- `{"t":"sync","after":<seq>,"conv"?:"<id>"}` → `{"t":"events","events":[{"seq",...event}],"more":<bool>,"next":<seq>,"conv"?:"<id>"}`
  (at most 200 events and about 1 MB of bodies per frame; see "What a member is served")
- `{"t":"invite.create","role"?,"uses"?,"days"?,"conv"?}` → `{"t":"invite","token","expires_at"}`
- `{"t":"invite.list"}` → `{"t":"invites","invites":[{"id","role","uses_left","expires_at","created_by","conv"}]}`
  (`conv` is the channel id or `null`)
- `{"t":"invite.revoke","id"}` → `{"t":"ok"}`
- `{"t":"conv.members","conv"}` → `{"t":"conv.members","conv","private":<bool>,"members":[{"pubkey","added_by","added_at"}]}`
- `{"t":"settings.set","member_invites":<bool>}` → `{"t":"ok"}` (owner only)
- `{"t":"member.remove","pubkey"}`, `{"t":"member.role","pubkey","role"}`, `{"t":"member.rename","name"}` → `{"t":"ok"}`
- `{"t":"ping"}` → `{"t":"pong"}`

Anything but `publish` that is refused is answered `{"t":"error","code","message"}` (no `id`);
requests are answered in the order they were sent. The codes for the requests above:

| Request | Codes |
|---|---|
| `sync` | `rate_limited` (too many on this connection); `bad_request` (`conv` is empty, longer than 128 bytes or has control characters). A channel the member cannot read is not an error: the page is empty |
| `invite.create` | `forbidden` (the role may not make this invite: a member without `conv`, with a channel they cannot read or that does not exist, asking for `admin`, or while `member_invites` is off; an admin asking for `admin`; anyone asking for `owner`); `no_conv` (owner/admin naming a channel that does not exist or that they cannot read); `bad_request` (`role`, `uses` or `days` out of range) |
| `invite.list` | none; a member gets their own invites, possibly `[]` |
| `invite.revoke` | `not_found` (no such invite); `forbidden` (a member revoking someone else's, an admin revoking an `admin` invite) |
| `conv.members` | `no_conv` (the channel does not exist, or is private and the caller is not in it) |
| `settings.set` | `forbidden` (not the owner); `bad_request` (`member_invites` missing or not true/false) |
| any | `not_member` (the caller was removed; the connection is closed), `bad_request` (unknown or malformed frame), `internal` |

Relay → connected members:

- `{"t":"event","seq",...event}` for each accepted event, to the connections of the members who
  can read its channel once the event is applied (so the member a `conv.add` names is sent that
  event), and for `conv.remove` also to the member it names. Events without a channel go to
  everyone. The relay looks the channel's members up for every event.
- `{"t":"members","members":[...]}` to everyone, whenever the team list changes. When someone
  leaves the team, the app drops them from every channel's member list as well.
- `{"t":"settings","member_invites":<bool>}` to everyone, after the owner changes it.

Publishing is limited to 30 events per 10 seconds per key, `sync` to 60 requests per 10 seconds
per connection (a refused `sync` is answered `rate_limited`; wait and ask again). Each connection
has a bounded outgoing queue (1,000 frames); a client that does not keep up is disconnected and
syncs again.

### What a member is served

`sync`, `head` and the live `event` frames all use one filter, applied in the database before
any page limit: the events of channels the member can read **now**, the events that belong to
no channel, and every `conv.remove` that names the member.

- `sync` without `conv` returns those events after `after`, oldest first. `more` says whether
  further ones remain; it is computed after filtering, so an empty page never has `more: true`,
  however many events of other channels lie in between.
- `next` is what to pass as `after` in the next request: the last `seq` of the page, or, when
  the page is empty, the member's `head`.
- `sync` with `conv` returns only that channel's events, and echoes `conv`. If the member cannot
  read the channel (or it does not exist) the page is empty and finished. `next` works the same
  way; it is a position in this channel's listing, so the app keeps it apart from its main
  position.
- When the app receives a `conv.add` that names its own key, it asks for that channel from 0
  (`{"t":"sync","after":0,"conv":…}`, following `next` while `more`): the events before the
  `conv.add` are older than its main position and would not come otherwise. Events it already
  has are recognised by id.
- When it receives a `conv.remove` that names its own key, it stops showing the channel as
  live. Nothing more of the channel is sent, and the channel's earlier events are no longer
  returned by `sync`; what the app stored stays (limit 2 above).
- A client whose saved position is ahead of `head` starts over from 0. That happens when the
  relay was restored from a backup, and when a member was removed from the team and came back:
  events of private channels they were in are not served to them any more.

## Storage

SQLite (one file, WAL). Tables `workspace` (id, settings), `members`, `invites`, `events` (each
row also names its channel and, for `conv.add`/`conv.remove`, the member concerned), `convs`
(channel → creator, archived, private), `conv_members` (channel → member, who added them,
when), `messages` (message id → author key, channel, deleted; for the edit/delete rules). All
statements are parameterised and filter on `ws`.

The schema version is kept in `PRAGMA user_version`. Version 1 is the schema before private
channels (its files carry no stamp, so a file with tables and version 0 is version 1); this
document describes version 2. A new database is created at version 2. On start, a version 1
file is migrated in one transaction:

- `workspace.member_invites` is added (on); `convs.private` is added (every existing channel is
  public); `invites.conv` is added (empty);
- `conv_members` is created, with each existing channel's creator in it if they are still on
  the team;
- every event row gets the channel its body names (rows that were redacted keep it in what is
  left of the body; `agent.put`/`agent.drop` rows have none), and an index for reading by
  channel is built.

If a row of a kind that belongs to a channel has a body that does not name one, the migration
is rolled back, the file is left exactly as it was, and the relay refuses to start, naming the
event. Such a row stored without a channel would be served to everyone. A file with a version
this relay does not know is refused the same way.

Back the file up before upgrading, and do not run an older relay on a migrated file: it would
store events without their channel. A row like that is served to nobody.

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
