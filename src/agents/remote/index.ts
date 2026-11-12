import { remoteCall, remoteCard, remoteStop, writeBytes } from "../runner";
import type { Ev } from "../types";
import { buildRequest, cardAddress, cardPin, makeReader, parseCard, readSession, type RemoteAgent, type RemoteCard } from "./a2a";

export * from "./a2a";

/** Reads the card at an address the person typed. */
export async function fetchCard(input: string): Promise<{ cardUrl: string; card: RemoteCard } | { error: string }> {
  let cardUrl: string;
  try {
    cardUrl = cardAddress(input);
  } catch {
    return { error: "That is not a valid address. It should look like https://agent.example.com" };
  }
  try {
    const card = parseCard(JSON.parse(await remoteCard(cardUrl)), cardUrl);
    return "error" in card ? card : { cardUrl, card };
  } catch (e) {
    return { error: e instanceof SyntaxError ? "That address did not return an agent card." : String(e) };
  }
}

/** When each agent's card was last compared with what the person approved. */
const checked = new Map<string, number>();

/**
 * True when the agent's card still says what the person approved. Looked up at most every ten
 * minutes; when the card cannot be read at all, the approved one stands.
 */
async function stillApproved(agent: RemoteAgent): Promise<boolean> {
  if (Date.now() - (checked.get(agent.id) ?? 0) < 600_000) return true;
  const now = await fetchCard(agent.cardUrl).catch(() => undefined);
  if (now && !("error" in now) && cardPin(now.card) !== agent.pin) return false;
  checked.set(agent.id, Date.now());
  return true;
}

/** After the person approves a card (again), it need not be looked up right away. */
export const markApproved = (id: string) => checked.set(id, Date.now());

interface Start {
  agent: RemoteAgent;
  runId: string;
  prompt: string;
  sessionId?: string;
  /** The conversation folder, where files the agent sends are saved. */
  dir: string;
  onEv(ev: Ev): void;
  onDone(): void;
}

/**
 * Sends one request to a remote agent and turns what it answers into Cube's events. The agent
 * sees the request text and nothing else: no files, no folder, no keys.
 */
export function startRemote({ agent, runId, prompt, sessionId, dir, onEv, onDone }: Start): { stop(): void } {
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    onDone();
  };
  const reader = makeReader();
  const scheme = agent.card.schemes.find((s) => s.id === agent.scheme);

  void (async () => {
    if (!(await stillApproved(agent))) {
      onEv({ t: "error", message: `${agent.card.name} changed where or how it wants to be reached since you added it. Review it under Settings > Remote agents before using it again.` });
      return end();
    }
    if (agent.card.needsAuth && !scheme) {
      onEv({ t: "error", message: `${agent.card.name} needs a sign-in that is not set up. Add it under Settings > Remote agents.` });
      return end();
    }
    const req = buildRequest(agent.card, prompt, readSession(sessionId), crypto.randomUUID());
    const auth = !scheme ? { kind: "none" } : scheme.kind === "header" ? { kind: "header", header: scheme.header } : { kind: "bearer" };
    try {
      await remoteCall(runId, { id: agent.id, url: req.url, contentType: req.type, headers: req.headers, auth, body: req.body, stream: req.stream }, (t, text) => {
        if (over) return;
        if (t === "error") {
          onEv({ t: "error", message: text });
          return end();
        }
        if (t === "done") {
          const s = reader.session();
          if (s.contextId) onEv({ t: "session", id: JSON.stringify(s) });
          return end();
        }
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          return;
        }
        const { evs, files } = reader.feed(data);
        evs.forEach(onEv);
        for (const f of files) {
          // What the agent sends as a file lands in the conversation folder, where the Stage shows it.
          void writeBytes(dir, f.name, f.base64).then((path) => onEv({ t: "file", path })).catch((e) => onEv({ t: "activity", kind: "other", label: `Could not save ${f.name}: ${String(e)}` }));
        }
      });
    } catch (e) {
      onEv({ t: "error", message: String(e) });
      end();
    }
  })();

  return {
    stop() {
      void remoteStop(runId);
      end();
    },
  };
}
