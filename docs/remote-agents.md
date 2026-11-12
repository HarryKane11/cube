# Remote agents

A role on a Cube team can run on an agent that lives somewhere else: a company's internal
agent, a vendor's, a colleague's. Cube reaches it with **A2A** (the Agent2Agent protocol) as a
client. Both A2A 1.0 and the 0.2/0.3 wire format are understood, over JSON-RPC (and HTTP+JSON
for 1.0).

## Adding one

Settings > Remote agents: give the agent's address, read what its card says, add it. Then pick
"Remote" under "Runs on" on a role's profile.

Cube reads the card from `/.well-known/agent-card.json` on that address (or from the address
itself when it names a `.json` file) and shows, before anything is added:

- who the agent says it is and what it says it does;
- **where messages will be sent** (flagged when that is not the host the card came from);
- what sign-in it asks for;
- whether the card is signed.

## What the agent receives

The new messages of the conversation it takes part in, as text, with a short note on its role.
Nothing from the computer: no files, no folder paths, no keys, no browser. Files the agent sends
back as bytes are saved into the conversation folder and show on the Stage; files it sends as
links are shown as links and not fetched.

## Sign-in

| The card asks for | Cube |
|---|---|
| nothing | calls it as is |
| HTTP bearer token | sends `Authorization: Bearer <token>` |
| API key in a header | sends the key in that header |
| OAuth 2 / OpenID Connect | sends an access token you obtained from the provider and pasted (no sign-in flow or refresh yet) |
| API key in the address or a cookie, HTTP basic, client certificates | not supported; the agent cannot be added if it requires one |

How the credential is handled:

- You type it once. It is stored in the macOS Keychain together with the address (scheme, host,
  port) it is for, and is never shown again or handed back to the app's web view.
- The request is made by the Rust side of the app, which reads the credential from the Keychain
  and refuses to send it anywhere but that address. Redirects are not followed.
- Only HTTPS is allowed. Plain HTTP works for `localhost` alone, for trying an agent you run
  yourself, and only when the card also came from `localhost`.
- Credentials are never put in a message. When an agent answers that it needs a sign-in on its
  side (`auth-required`), Cube tells you and stops.

## When a card changes

Cube remembers what the card said when you approved it: where requests go, how, and what
sign-in it wants. It looks at the card again from time to time. If any of that has changed, the
agent is not called until you read the new card and approve it, and the saved credential is
dropped so it cannot follow the agent to a new address.

Card signatures are shown but **not verified yet**; the pinning above is what protects you
today.

## What is not there yet

- Verifying card signatures (JWS over the canonical card).
- An OAuth sign-in flow with token refresh.
- Push notifications and re-attaching to a task after Cube restarts.
- A remote agent asking for permission mid-task: it works on its own servers and Cube has no
  say in what it does there.
