import { ensureSpace, inTauri, slackConfigured, slackListen, slackPost, slackScopes, slackStart, slackUser } from "@/agents/runner";
import { AGENTS, agentById } from "@/agents/types";
import { maskSecrets } from "@/lib/secrets";
import { splitNotes } from "@/agents/notes";
import { useCube, type Conv, type Msg } from "@/state/store";
import { fromSlack, missingScopes, slackId, threadRoot, toSlack } from "./format";

export * from "./format";

const store = () => useCube.getState();
/** The Cube channel where requests from Slack and the cubes' answers to them are kept. */
export const SLACK_CONV = "slack";
const names = new Map<string, string>();
const posting = new Set<string>();
/** Messages already taken in: Slack sends a mention inside a thread twice, as a mention and as a message. */
const taken = new Set<string>();
let timer = 0;
/** How long after it was finished an answer may still be posted to Slack. */
const STALE = 15 * 60_000;

async function nameOf(user: string): Promise<string> {
  const known = names.get(user);
  if (known) return known;
  const name = await slackUser(user).catch(() => user);
  names.set(user, name);
  return name;
}

async function ensureConv(): Promise<Conv> {
  const have = store().convs.find((c) => c.id === SLACK_CONV);
  if (have) return have;
  const conv: Conv = { id: SLACK_CONV, kind: "channel", name: "slack", members: AGENTS.map((a) => a.id), dir: "", createdAt: Date.now() };
  store().addConv(conv);
  store().setConvDir(SLACK_CONV, await ensureSpace(SLACK_CONV).catch(() => ""));
  return conv;
}

/** The message at the top of the thread a message is in. */
function rootOf(m: Msg): Msg {
  const all = store().messages;
  let top = m;
  for (let i = 0; i < 20 && top.parentId; i++) {
    const up = all.find((x) => x.id === top.parentId);
    if (!up) break;
    top = up;
  }
  return top;
}

/** Posts what the cubes answered to requests from Slack into the Slack threads they came from. */
function flush(): void {
  const s = store();
  if (!s.slackLive.connected) return;
  for (const m of s.messages) {
    // The Router's line goes too: it is how the asker hears who is coming, or gets a general question answered.
    if (m.convId !== SLACK_CONV || m.from || m.author === "you" || m.streaming || m.aside || m.slackSent || posting.has(m.id)) continue;
    if (!agentById(m.author)) continue;
    // Only what was just said. An answer that could not be posted for a while, or lines from before
    // a change in what gets posted, would land in the thread long after anyone was waiting for them.
    if (Date.now() - (m.ts + (m.took ?? 0)) > STALE) continue;
    const root = rootOf(m);
    if (!root.slack) continue;
    const said = maskSecrets(splitNotes(m.text).text.trim());
    const text = said ? toSlack(said) : m.error ? "I could not finish that. Please ask again, or ask the person who runs this Cube." : "";
    if (!text) continue;
    const who = agentById(m.author)?.name ?? "Cube";
    posting.add(m.id);
    slackPost(root.slack.channel, root.slack.ts, `*${who}*\n${text}`)
      .then((ts) => store().patchMsg(m.id, { slackSent: ts || "sent" }))
      .catch((e) => store().setSlackLive({ problem: String(e) }))
      .finally(() => posting.delete(m.id));
  }
}

function later(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, 500);
}

/**
 * Connects to Slack when the person has set it up. Someone who mentions the Cube bot, or writes
 * to it directly, gets an answer in that thread, and can go on in the thread without mentioning
 * it again. `outside` is how such a request reaches the cubes: it reads and answers, and asks
 * the person before doing anything more.
 */
export async function startSlack(outside: (convId: string, msgId: string) => void): Promise<void> {
  if (!inTauri) return;
  await slackListen((v) => {
    if (v.t === "status") {
      store().setSlackLive({ connected: Boolean(v.connected), team: String(v.team ?? "") || store().slackLive.team, problem: String(v.problem ?? "") });
      later();
      return;
    }
    if (v.t !== "message") return;
    const { channel, user, ts } = v as unknown as { channel: string; user: string; ts: string };
    const thread = String(v.thread_ts ?? "");
    // A mention of the bot or a direct message calls the team. Anything else is a reply in a thread.
    const called = v.called !== false;
    const id = slackId(channel, ts);
    if (taken.has(id)) return;
    taken.add(id);
    void (async () => {
      const conv = await ensureConv();
      if (store().messages.some((m) => m.id === id)) return;
      const inThread = thread && thread !== ts ? threadRoot(store().messages.filter((m) => m.convId === conv.id), channel, thread) : undefined;
      // A reply that does not call the team counts only in a thread the team is already in.
      if (!called && !inThread) return;
      const text = fromSlack(String(v.text ?? ""), String(v.bot ?? ""));
      if (!text) return;
      const name = await nameOf(user);
      store().addMsg({
        id, convId: conv.id, author: "peer", text, ts: Date.now(),
        from: { pubkey: `slack:${user}`, name },
        // Answers go into the thread the request is in, or start one under it.
        slack: { channel, ts: thread || ts, ...(called ? {} : { called: false }) },
        ...(inThread ? { parentId: inThread.id } : {}),
      });
      outside(conv.id, id);
    })();
  });
  useCube.subscribe((now, before) => {
    if (now.messages !== before.messages || now.slackLive.connected !== before.slackLive.connected) later();
  });
  await connectSlack();
}

/** Looks at what the Slack app is allowed, so what is missing is said up front and not found out by a failure. */
export async function checkScopes(): Promise<void> {
  const have = await slackScopes().catch(() => undefined);
  if (have?.length) store().setSlackLive({ missing: missingScopes(have) });
}

/** Starts the connection if tokens are saved, and says whether they are. */
export async function connectSlack(): Promise<boolean> {
  const configured = await slackConfigured().catch(() => false);
  store().setSlackLive({ configured });
  if (configured) {
    await slackStart().catch((e) => store().setSlackLive({ problem: String(e) }));
    void checkScopes();
  }
  return configured;
}

/** What to paste into "Create an app from a manifest" on api.slack.com to get a Slack app Cube can use. */
export const SLACK_MANIFEST = `display_information:
  name: Cube
  description: Ask the Cube team from Slack
features:
  bot_user:
    display_name: Cube
    always_online: false
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - files:write
      - groups:history
      - im:history
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;
