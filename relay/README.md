# cube-relay

The team relay for Cube. A team runs one relay; every teammate's Cube connects to it. The relay
stores and passes on signed events for exactly one workspace, and keeps the files of its shared
channels. It never runs agents and holds no secrets.

The contract between the app and the relay is [`docs/team-relay.md`](../docs/team-relay.md). This
directory implements it.

| Path | What it is |
|---|---|
| `proto/` | `cube-proto`: the wire format shared with the app (events, challenges, invite links) |
| `server/` | `cube-relay`: the relay (`src/main.rs`), and `cube-peer` (`src/bin/cube-peer.rs`), a developer tool that acts as a teammate |
| `server/tests/relay.rs` | end-to-end tests against a real relay over WebSocket |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | container image and an example deployment behind Caddy |

## Run it locally

```sh
cd relay
cargo run --bin cube-relay
```

With no configuration it listens on `127.0.0.1:8484`, keeps its data in `./cube-relay.db` and
the files of shared channels in `./blobs/`, and expects clients to dial `127.0.0.1:8484` (not `localhost:8484`: the host a client signs for must
equal `CUBE_RELAY_PUBLIC_HOST` exactly).

### The owner invite

Nobody is a member of a new relay. On the relay's machine, with the same environment as the
relay itself, run:

```sh
cargo run --bin cube-relay -- owner-invite        # or: cube-relay owner-invite [--days N]
```

It prints one link on stdout (`cube+ws://127.0.0.1:8484/#invite=…` locally,
`cube+wss://<public host>/#invite=…` otherwise) and nothing to the log. Whoever opens the link in
Cube becomes the owner. Details:

- The link works once and for 7 days (`--days 1` to `30`).
- Running it again cancels an owner invite that was not used yet, so at most one is outstanding.
- If there already is an owner, the claimer replaces them and the earlier owner becomes an admin.
  This is the recovery path when the owner's key is lost: being able to run the command means
  being able to read the database file anyway.
- It can run while the relay is serving.

### Acting as a teammate: `cube-peer`

`cube-peer` speaks the same protocol as the app and prints one JSON object per line. It is a
testing tool: the private key sits in a plain file (created with mode `0600`), and it does not pin
the workspace between runs.

```sh
PEER="cargo run -q --bin cube-peer --"
RELAY="--relay ws://127.0.0.1:8484/ws --host 127.0.0.1:8484"

# become the owner with the link printed by `cube-relay owner-invite`
$PEER --key ann.key join 'cube+ws://127.0.0.1:8484/#invite=…' --name Ann

$PEER --key ann.key $RELAY conv general General      # create (or rename) a channel
$PEER --key ann.key $RELAY invite                    # prints {"link": "cube+ws://…", …}
$PEER --key bea.key join '<that link>' --name Bea    # a second teammate

$PEER --key ann.key $RELAY listen                    # one JSON line per event / member list
$PEER --key bea.key $RELAY post general "hello"      # → {"ok":true,"seq":2,"msg_id":"…",…}
$PEER --key bea.key $RELAY edit general <msg_id> "hello again"
$PEER --key ann.key $RELAY delete general <msg_id>
```

(In zsh, `$PEER` and `$RELAY` are not split into words; write the arguments out or use
`${=PEER}` / `${=RELAY}`.)

Private channels, their member lists and what a member is served:

```sh
$PEER --key ann.key $RELAY conv plans Plans --private     # a channel only its members can read
$PEER --key ann.key $RELAY add plans <bea's pubkey>       # publishes conv.add
$PEER --key bea.key $RELAY sync --conv plans              # that channel from the start, then {"next":…}
$PEER --key bea.key $RELAY members plans                  # who is in it
$PEER --key bea.key $RELAY invite --conv plans            # an invite that puts the claimer in it
$PEER --key ann.key $RELAY remove plans <bea's pubkey>    # publishes conv.remove (or leave: your own key)
$PEER --key bea.key $RELAY sync                           # everything bea is served; --after <seq> to continue
$PEER --key bea.key $RELAY status                         # you, members, head, features, settings
$PEER --key ann.key $RELAY settings --member-invites false   # owner only
```

A public key is printed as `you.pubkey` by `join` and `status`.

The shared folder of a channel:

```sh
$PEER --key ann.key $RELAY put-file plans ./Plan.md             # ticket, upload, then file.put
$PEER --key ann.key $RELAY put-file plans ./draft.md --path docs/Plan.md --agent Builder
$PEER --key bea.key $RELAY files plans                          # what is there; --deleted for deleted paths too
$PEER --key bea.key $RELAY get-file plans Plan.md ./copy.md     # ticket, download, hash check
$PEER --key bea.key $RELAY put-file plans ./copy.md --path Plan.md --base <sha>   # refused (stale) if it changed since
$PEER --key bea.key $RELAY history plans Plan.md                # every version, newest first
$PEER --key bea.key $RELAY get-file plans Plan.md ./old.md --sha <sha>            # an earlier version
$PEER --key ann.key $RELAY drop-file plans Plan.md              # publishes file.drop; --base as for put-file
$PEER --key ann.key $RELAY touch plans Plan.md                  # "working on it"; --off when done
$PEER --key ann.key $RELAY ticket plans get <sha>               # a raw ticket, to test a client's own transfer code
```

`--base ""` says "there is no file at this path yet". A refused `stale` prints the hash that is
there as `current`. `listen` also prints the `file.touch` frames of others.

Other options: `invite --role admin` (owner only), `listen --from <seq>` (replay history after
`seq` first; `0` for everything), `--host` may be left out when it equals the host in `--relay`.
`cube-peer` verifies every event it prints and drops, with a note on stderr, any that fail. Like
the app, it refuses `ws://` for anything but `localhost`, `127.0.0.1` and `[::1]`. A failure is
printed as `{"ok":false,"code":…,"message":…}` with a non-zero exit status.

## Configuration

Everything is read from the environment. There are no secrets to configure.

| Variable | Meaning | Default |
|---|---|---|
| `CUBE_RELAY_BIND` | IP address and port to listen on (a literal address, not a host name) | `127.0.0.1:8484` |
| `CUBE_RELAY_DB` | SQLite file (created with mode `0600` if missing) | `./cube-relay.db` |
| `CUBE_RELAY_NAME` | workspace name shown to members (at most 100 characters) | `Team` |
| `CUBE_RELAY_PUBLIC_HOST` | host (and port, if not 443) clients dial, e.g. `relay.example.com`; no scheme, no path; lower-cased | required unless bound to a loopback address, where it defaults to the bind address |
| `CUBE_RELAY_TRUSTED_PROXY` | comma-separated IP addresses (no CIDR ranges) of proxies whose `X-Forwarded-For` is believed | none |
| `CUBE_RELAY_APP_URL` | `https://` address where the Cube app can be had; shown on the invite page | none |
| `CUBE_RELAY_BLOB_MAX_MB` | largest file a member may upload, in MiB (a whole number) | `10` |
| `CUBE_RELAY_BLOB_QUOTA_MB` | what all stored files together may take, in MiB; not less than the value above | `1024` |
| `RUST_LOG` | log filter for stderr, e.g. `debug` or `cube_relay=debug` | `info` |

The relay refuses to start when `CUBE_RELAY_BIND` is not a loopback address and
`CUBE_RELAY_PUBLIC_HOST` is unset, or when any value is malformed.

Behind a proxy, set `CUBE_RELAY_TRUSTED_PROXY` to the proxy's address. Without it every client
appears to come from the proxy, and ten failed handshakes by anyone lock everyone out for a
minute. With it, the client address is the right-most `X-Forwarded-For` entry that is not itself a
trusted proxy; the proxy must overwrite or append to that header, never pass a client-supplied
value through as the last entry.

`GET /join` is the page an invite link opens in a browser (`https://<host>/join#invite=…`). It is
the same for every visitor: the invite sits after the `#`, which a browser does not send, so the
relay never sees it. The page's button hands the invite to the Cube app (`cube://<host>/#invite=…`).
Behind a proxy, forward `/join` along with `/ws` and `/healthz` (the example `Caddyfile` does).

Files travel as `PUT` and `GET /blob/<sha256>` on the same listener, each with a short-lived
ticket in the `Authorization` header. Behind a proxy, forward `/blob/*` as well (the example
`Caddyfile` does), let request bodies up to `CUBE_RELAY_BLOB_MAX_MB` through, and do not log
or cache these requests' headers. The files are kept in the directory `blobs/` next to the
database file (created with mode `0700`, files `0600`), one file per SHA-256, unencrypted.
Nothing is ever removed from it: a replaced or deleted file keeps its earlier versions, and
there is no garbage collection in this version. `CUBE_RELAY_BLOB_QUOTA_MB` is therefore how
large that directory can become, and uploads are refused once it is reached. The relay does
not look inside files.

Commands: `cube-relay` (serve), `cube-relay owner-invite [--days N]`, `cube-relay --version`.

The log records connections, membership changes, invite ids and stored uploads (the first
characters of the hash, the size). It never contains invite tokens, tickets, message bodies or
file contents.

## Deploying with Docker and Caddy

The relay speaks plain HTTP; TLS belongs to a proxy in front of it. `docker-compose.yml` is an
example with Caddy, which obtains a certificate for the domain on its own.

```sh
cd relay
RELAY_DOMAIN=relay.example.com RELAY_NAME="My Team" docker compose up -d --build
docker compose exec relay cube-relay owner-invite
```

- `RELAY_DOMAIN` must resolve to the machine, with ports 80 and 443 reachable.
- The relay's port is not published; only Caddy reaches it, over a private network on which
  Caddy has a fixed address (`172.30.84.2`) that is listed in `CUBE_RELAY_TRUSTED_PROXY`. If the
  subnet clashes with one of yours, change both places in `docker-compose.yml`.
- The image runs as an unprivileged user (uid 10001) and keeps the database in the `/data`
  volume (`relay-data`). The same volume now also holds the files (`/data/blobs`): size it for
  the database plus `CUBE_RELAY_BLOB_QUOTA_MB` (1 GiB by default), with some room to spare
  for uploads in flight.
- The `Caddyfile` forwards only `/ws`, `/healthz`, `/join` and `/blob/*`.

To run the image without compose:

```sh
docker build -t cube-relay .
docker run -d --name cube-relay -v cube-relay-data:/data -p 127.0.0.1:8484:8484 \
  -e CUBE_RELAY_PUBLIC_HOST=relay.example.com cube-relay
docker exec cube-relay cube-relay owner-invite
```

## Deploying on Railway

Railway runs the image, gives it an HTTPS address and keeps the database on a volume, so no
server or domain of your own is needed. `Dockerfile.railway` is for this. The build and health
check are set in the service's settings: Railway has deprecated its config file
(`railway.json`) and does not apply one to a new service.

1. Put the repository on GitHub and, in Railway, make a project with **Deploy from GitHub repo**.
   (Or install the Railway CLI, run `railway login`, and in this directory `railway init` and
   `railway up`.)
2. In the service's **Settings**: set **Root Directory** to `relay`, the builder to Dockerfile
   with the path `Dockerfile.railway` (the service variable
   `RAILWAY_DOCKERFILE_PATH=Dockerfile.railway` does the same), and the health check path to
   `/healthz`.
3. Attach a **volume** to the service with the mount path `/data`. Without it the database is
   lost on every deploy. The volume also holds the files of shared channels, up to
   `CUBE_RELAY_BLOB_QUOTA_MB` (1 GiB by default): give it that much on top of the database.
4. Under **Networking**, generate a public domain.
5. Under **Variables**, set `CUBE_RELAY_PUBLIC_HOST` to `${{RAILWAY_PUBLIC_DOMAIN}}` and
   `CUBE_RELAY_NAME` to your team's name. The relay refuses to start without the first.
6. Deploy. `https://<your domain>/healthz` answers `ok`, and `/ws` accepts a WebSocket.
7. Make the owner invite inside the running service: copy the service's SSH command from the
   dashboard (or `railway ssh`), and in that shell run `cube-relay owner-invite`. Paste the link
   it prints into Cube under Settings > People.

What is different from the Docker and Caddy setup:

- The container runs as root. Railway mounts volumes for root, and the relay must be able to
  write its database.
- The relay listens on the port Railway passes in `PORT`.
- `CUBE_RELAY_TRUSTED_PROXY` is left unset, because Railway's proxy has no fixed address to
  list. Every member then counts as one address for the limit on failed handshakes: ten failed
  attempts by anyone hold everyone off for a minute. For a small team that knows each other
  this is acceptable; a relay open to strangers should sit behind a proxy with a fixed address.
- Keep one replica (Railway does not allow replicas with a volume), and expect a few seconds
  without the relay on each deploy. The app reconnects on its own.

## Backup

All state is the SQLite file named by `CUBE_RELAY_DB` plus, while the relay runs, its `-wal` and
`-shm` companions, and the directory `blobs/` next to it, which holds the files.

- Copy `blobs/` along with the database, the database first. Files in it are only ever added
  and never change, so it can be copied while the relay runs (ignore names starting with
  `.tmp-`: uploads under way). A database restored without its `blobs/` still lists the files,
  but fetching one is answered `404` until someone uploads the same bytes again.

- Simplest: stop the relay (it then folds the write-ahead log back into the main file) and copy
  the file. With compose: `docker compose stop relay`, then
  `docker compose cp relay:/data/cube-relay.db ./cube-relay.backup.db`, then
  `docker compose start relay`.
- Without stopping: `sqlite3 cube-relay.db ".backup 'cube-relay.backup.db'"` from a machine that
  has the `sqlite3` tool and access to the file. Do not copy a live database with `cp`.
- A backup is a copy of the conversation. Keep it as private as the relay's disk, and remember
  that a message deleted after the backup was taken is still in the backup.
- After restoring an older backup the relay's log is shorter than what members have already
  seen. A client whose saved position is ahead of `head` starts over from 0, as the contract says.
- Members' private keys are not on the relay. Losing the database loses the history and the
  member list, not anyone's identity; start over with `owner-invite`.

## What the relay enforces beyond the letter of the contract

Where `docs/team-relay.md` leaves something open, the relay takes the stricter reading. Anything
that talks to it should expect the following.

**Handshake**

- `pubkey`, `id` and `sig` must be lower-case hex. One key must not have two spellings.
- Every refused `auth` gets `{"t":"denied","code":"denied","message":"not a member or bad
  signature"}`: not a member, bad signature, wrong host, stale nonce, malformed key. Every
  refused `claim` gets the same shape with `invite not valid or bad signature`, whether the token
  is unknown, expired, used up or revoked, the host is wrong, or the key is already a member.
- Other denial codes: `bad_request` (the first frame is not a well-formed `auth`/`claim`, or the
  display name is unusable), `rate_limited`, `timeout`, `unavailable` (the database failed).
- A connection gets exactly one handshake frame. After a denial it is closed.
- Failed attempts count per client address (IPv6: per /64) and per claimed key, 10 per minute
  each. A blocked address is refused before `hello`. A handshake that times out or is malformed
  counts as a failure for the address. A member who presents a valid signature is let in even
  while their key is over the limit, so nobody can lock a member out by failing in their name;
  a `claim` for a key over the limit is refused.
- Display names are trimmed, 1 to 64 characters, no control characters.
- A key that is already a member cannot claim a `member` or `admin` invite (the invite is not
  spent). The owner invite is the one exception.

**Invites and members**

- `uses` is 1 to 100, `days` 1 to 30. `role` is `member` or `admin`; the owner invite cannot be
  made over the wire.
- Invites that can no longer be claimed are deleted, so `invite.list` shows only live ones. It
  also shows an outstanding owner invite (`created_by` is `cli`).
- An admin can revoke only invites that grant `member`.
- Removing a member, or demoting an admin to member, deletes the invites they made. When the
  owner is replaced, the admin invites the earlier owner made are deleted.
- Nobody can remove themselves or change their own role. Ownership moves only through the owner
  invite.

**Events**

- `kind` and `ws` must not contain a line break (they are hashed line by line).
- `conv` and message ids are 1 to 128 bytes without control characters; a channel name is 1 to
  200 characters.
- `conv.put` without `archived` leaves the archived state as it is (false for a new channel).
- `msg.edit`: if `msg.id` is present it must equal `id`. Editing is refused in an archived
  channel; deleting is not.
- `msg.delete` of a message that is already deleted is refused (`gone`).
- Every publish attempt counts toward the 30 per 10 seconds, accepted or not.
- A retry of an id the relay already has is answered with the original `seq` before the
  `created_at` window is checked, so a retry may come as late as it likes.
- An `events` frame holds at most 200 events and is cut short once the bodies add up to 1 MiB
  (always at least one event); `more` says whether to ask again.
- When an edit or delete rewrites earlier events, the relay also checkpoints the write-ahead log
  and runs with `secure_delete`, so the old text does not stay in the database files.

**Files**

- `sha` must be lower-case hex everywhere (in a ticket request, an event, the address). One
  file must not have two names.
- `..` is refused anywhere in a path, also inside a name (`a..b`).
- An archived channel takes no new files: `file.put`, `file.drop` and a `put` ticket for it
  are refused with `archived`. What it has can still be listed and fetched.
- A ticket is used up by the first request that presents it in the `Authorization` header,
  also one for the wrong hash or direction, or with the wrong length. The two exceptions are
  the answers `411` and `503`, which are given before the ticket is looked at.
- A `get` ticket is checked again when it is presented: if its holder was taken out of the
  channel or off the team since, the answer is `401`.
- A member can hold 256 unused tickets; asking for more is `rate_limited`.
- Only an upload ticket that was issued counts toward the 120 per 10 minutes. An answer with
  `have`, or a refusal, does not.
- `have` is answered only when the bytes are really on disk. If the database knows a hash and
  the file is missing, a ticket is issued and the upload puts it back.
- The quota counts each distinct content once, however many paths or channels refer to it,
  and is checked twice: when the ticket is asked for and when the upload is stored.
- `file.touch` goes to the other members, not to other connections of the sender.

**Error codes** in `{"t":"error",…}`: `bad_request`, `rate_limited`, `too_large`, `wrong_key`,
`wrong_workspace`, `bad_id`, `bad_signature`, `bad_time`, `bad_body`, `unknown_kind`, `no_conv`,
`archived`, `duplicate_msg`, `duplicate`, `not_found`, `wrong_conv`, `forbidden`, `gone`,
`not_member`, `internal`, and for files `too_big`, `quota`, `unchanged`, `stale`. For a refused
`publish` the frame carries the event's `id`; for a refused `blob.ticket`, `files.list` or
`files.history`, the `id` the request had; a `stale` frame also carries `current`.

Not limited by this version: the number of open connections (per address, per key or in total),
the rate of requests other than `publish`, `sync`, `file.touch` and upload tickets, and the
number of files in a channel. Put a connection limit on the proxy if the relay faces the open
internet.

## Tests

```sh
cd relay
cargo test
```

`proto` has unit tests for every function, including tampering. `server` has unit tests for
configuration, storage rules, migrations, tickets, rate limiting and proxy handling, and
`server/tests/relay.rs` starts a relay on an ephemeral port for each test and talks to it over
real WebSocket connections and HTTP requests; it also runs the `cube-relay` and `cube-peer`
binaries.
