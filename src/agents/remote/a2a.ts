import type { Ev } from "../types";

/**
 * Agents that run somewhere else and speak A2A (the Agent2Agent protocol). Cube is the client:
 * it reads the agent's card, sends it the conversation's new messages, and reads back what it
 * streams. Both the 1.0 wire format and the 0.2/0.3 one that most deployed agents still speak are
 * understood. See docs/remote-agents.md.
 */

/** One way an agent accepts credentials, reduced to what Cube can do with it. */
export interface RemoteScheme {
  id: string;
  /**
   * bearer: `Authorization: Bearer <token>`. header: the token in a header the agent names.
   * oauth: an OAuth/OpenID access token, pasted by the person and sent as a bearer token.
   * unsupported: something Cube cannot do yet (client certificates, keys in the address, …).
   */
  kind: "bearer" | "header" | "oauth" | "unsupported";
  /** For kind "header": the header's name. */
  header?: string;
  /** What it is, in words, for the person adding the agent. */
  about: string;
}

export interface RemoteCard {
  name: string;
  description: string;
  version: string;
  provider: string;
  skills: { name: string; description: string }[];
  /** Where requests go. */
  endpoint: string;
  binding: "JSONRPC" | "HTTP+JSON";
  /** True for the pre-1.0 wire format. */
  legacy: boolean;
  streaming: boolean;
  schemes: RemoteScheme[];
  /** True when the agent says a credential is required. */
  needsAuth: boolean;
  /** True when the card carries signatures. Cube does not verify them yet; it pins the card instead. */
  signed: boolean;
}

/** A remote agent the person has added. Its credential is not here: it lives in the Keychain. */
export interface RemoteAgent {
  id: string;
  /** The address the card was read from. */
  cardUrl: string;
  card: RemoteCard;
  /** The scheme the person chose, or "" for none. */
  scheme: string;
  /** What the card said when the person approved it; a different card needs a new approval. */
  pin: string;
  addedAt: number;
}

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Where a card lives for an address the person typed: the address itself if it names a JSON file, else the well-known path. */
export function cardAddress(input: string): string {
  const url = new URL(input.trim());
  if (/\.json$/i.test(url.pathname)) return url.toString();
  return new URL("/.well-known/agent-card.json", url.origin).toString();
}

/** True for addresses on this machine, the only ones allowed without TLS. */
export function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

function schemeOf(id: string, raw: Json): RemoteScheme {
  // 1.0 wraps each scheme in a key naming its kind; 0.x uses OpenAPI's flat shape with "type".
  const api = obj(raw.apiKeySecurityScheme);
  const http = obj(raw.httpAuthSecurityScheme);
  const type = str(raw.type).toLowerCase();
  if (raw.apiKeySecurityScheme || type === "apikey") {
    const where = (str(api.location) || str(raw.in)).toLowerCase();
    const name = str(api.name) || str(raw.name);
    return where === "header" && /^[A-Za-z0-9-]+$/.test(name)
      ? { id, kind: "header", header: name, about: `A key sent in the ${name} header` }
      : { id, kind: "unsupported", about: `A key sent in the ${where || "address"}, which Cube does not do` };
  }
  if (raw.httpAuthSecurityScheme || type === "http") {
    const scheme = (str(http.scheme) || str(raw.scheme)).toLowerCase();
    return scheme === "bearer" ? { id, kind: "bearer", about: "A bearer token" } : { id, kind: "unsupported", about: `HTTP ${scheme || "authentication"}, which Cube does not do yet` };
  }
  if (raw.oauth2SecurityScheme || type === "oauth2") return { id, kind: "oauth", about: "An OAuth access token you get from the agent's provider and paste here" };
  if (raw.openIdConnectSecurityScheme || type === "openidconnect") return { id, kind: "oauth", about: "An OpenID Connect access token you get from the agent's provider and paste here" };
  if (raw.mtlsSecurityScheme || type === "mutualtls") return { id, kind: "unsupported", about: "A client certificate, which Cube does not do yet" };
  return { id, kind: "unsupported", about: "A kind of sign-in Cube does not know" };
}

/** An agent card as Cube uses it, or what is wrong with it. `cardUrl` is where it was read from. */
export function parseCard(json: unknown, cardUrl: string): RemoteCard | { error: string } {
  const c = obj(json);
  const name = str(c.name).trim();
  if (!name) return { error: "That address did not return an agent card (it has no name)." };

  // 1.0 lists interfaces, first one preferred. 0.x has one address plus optional others.
  const offered: { url: string; binding: string; version: string }[] = [
    ...list(c.supportedInterfaces).map((i) => ({ url: str(obj(i).url), binding: str(obj(i).protocolBinding), version: str(obj(i).protocolVersion) })),
    ...(str(c.url) ? [{ url: str(c.url), binding: str(c.preferredTransport) || "JSONRPC", version: str(c.protocolVersion) || "0.3" }] : []),
    ...list(c.additionalInterfaces).map((i) => ({ url: str(obj(i).url), binding: str(obj(i).transport), version: str(c.protocolVersion) || "0.3" })),
  ].filter((i) => i.url);
  const legacyOf = (version: string) => !/^[1-9]\d*\./.test(version || "1.0");
  const pick = offered.find((i) => i.binding.toUpperCase() === "JSONRPC") ?? offered.find((i) => i.binding.toUpperCase() === "HTTP+JSON" && !legacyOf(i.version));
  if (!pick) return { error: offered.length ? "This agent only offers ways to connect that Cube does not speak (it needs JSON-RPC or HTTP+JSON)." : "The card does not say where to send requests." };

  let endpoint: URL;
  try {
    endpoint = new URL(pick.url, cardUrl);
  } catch {
    return { error: "The card's address for requests is not a valid URL." };
  }
  if (endpoint.username || endpoint.password) return { error: "The card's address carries a user name or password, which Cube refuses." };
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLocal(endpoint.toString()) && isLocal(cardUrl))) {
    return { error: "The agent must be reached over HTTPS." };
  }

  const schemes = Object.entries(obj(c.securitySchemes)).map(([id, raw]) => schemeOf(id, obj(raw)));
  const required = [...list(c.securityRequirements), ...list(c.security)];
  return {
    name,
    description: str(c.description).trim(),
    version: str(c.version),
    provider: str(obj(c.provider).organization),
    skills: list(c.skills).map((s) => ({ name: str(obj(s).name) || str(obj(s).id), description: str(obj(s).description) })).filter((s) => s.name),
    endpoint: endpoint.toString(),
    binding: pick.binding.toUpperCase() === "HTTP+JSON" ? "HTTP+JSON" : "JSONRPC",
    legacy: legacyOf(pick.version),
    streaming: Boolean(obj(c.capabilities).streaming),
    schemes,
    needsAuth: required.length > 0,
    signed: list(c.signatures).length > 0,
  };
}

/**
 * The parts of a card that decide where Cube sends things and what it sends along. When these
 * change, the person approves the agent again before anything more goes out.
 */
export function cardPin(card: RemoteCard): string {
  return JSON.stringify([card.endpoint, card.binding, card.legacy, card.schemes.map((s) => [s.id, s.kind, s.header ?? ""])]);
}

export interface RemoteSession {
  contextId?: string;
  /** A task still waiting on the person; the next message continues it. */
  taskId?: string;
}

export const readSession = (s: string | undefined): RemoteSession => {
  try {
    return s ? (JSON.parse(s) as RemoteSession) : {};
  } catch {
    return {};
  }
};

export interface RemoteRequest {
  url: string;
  body: string;
  stream: boolean;
  /** The body's content type. */
  type: string;
  /** Headers that carry no secret. The credential is added on the Rust side. */
  headers: [string, string][];
}

/** The request that sends `text` to the agent, continuing `session` when there is one. */
export function buildRequest(card: RemoteCard, text: string, session: RemoteSession, messageId: string): RemoteRequest {
  const stream = card.streaming;
  const more = { ...(session.contextId ? { contextId: session.contextId } : {}), ...(session.taskId ? { taskId: session.taskId } : {}) };
  if (card.legacy) {
    const message = { kind: "message", role: "user", messageId, parts: [{ kind: "text", text }], ...more };
    return { url: card.endpoint, stream, type: "application/json", headers: [], body: JSON.stringify({ jsonrpc: "2.0", id: messageId, method: stream ? "message/stream" : "message/send", params: { message } }) };
  }
  const message = { messageId, role: "ROLE_USER", parts: [{ text }], ...more };
  const headers: [string, string][] = [["A2A-Version", "1.0"]];
  if (card.binding === "HTTP+JSON") {
    return { url: `${card.endpoint.replace(/\/+$/, "")}/message:${stream ? "stream" : "send"}`, stream, type: "application/a2a+json", headers, body: JSON.stringify({ message }) };
  }
  return { url: card.endpoint, stream, type: "application/json", headers, body: JSON.stringify({ jsonrpc: "2.0", id: messageId, method: stream ? "SendStreamingMessage" : "SendMessage", params: { message } }) };
}

/** A file the agent sent inside its answer, to be saved into the conversation folder. */
export interface RemoteFile {
  name: string;
  base64: string;
}

export interface Reader {
  /** Takes one object the agent sent (a stream event, or the whole answer) and says what it means. */
  feed(data: unknown): { evs: Ev[]; files: RemoteFile[] };
  /** What to remember so the next message continues this conversation. */
  session(): RemoteSession;
  /** True once the agent has said it is done for now. */
  done(): boolean;
}

const stateOf = (s: unknown) => str(s).toLowerCase().replace(/^task_state_/, "").replace(/_/g, "-");
const safeName = (name: string) => name.replace(/[/\\:\0]/g, "_").replace(/^\.+/, "").slice(0, 120);

/** Reads an agent's answer, in either wire format, into Cube's events. */
export function makeReader(): Reader {
  const session: RemoteSession = {};
  let finished = false;
  let wrote = false;
  let lastArtifact = "";

  const partsOf = (parts: unknown, evs: Ev[], files: RemoteFile[]) => {
    for (const raw of list(parts)) {
      const p = obj(raw);
      const file = obj(p.file);
      const text = str(p.text);
      // 1.0: raw / url beside filename. 0.x: a "file" object with bytes / uri.
      const bytes = str(p.raw) || str(file.bytes);
      const url = str(p.url) || str(file.uri);
      const name = safeName(str(p.filename) || str(file.name));
      if (text) {
        evs.push({ t: "delta", text });
        wrote = true;
      } else if (bytes && name) {
        files.push({ name, base64: bytes });
      } else if (url && /^https?:\/\//.test(url)) {
        evs.push({ t: "delta", text: `\n[${name || "file"}](${url})\n` });
        wrote = true;
      } else if (p.data !== undefined) {
        evs.push({ t: "delta", text: `\n\`\`\`json\n${JSON.stringify(p.data, null, 2)}\n\`\`\`\n` });
        wrote = true;
      }
    }
  };

  const status = (raw: unknown, evs: Ev[], files: RemoteFile[]) => {
    const s = obj(raw);
    const state = stateOf(s.state);
    const message = obj(s.message);
    const said = list(message.parts).map((p) => str(obj(p).text)).join("").trim();
    if (state === "working" || state === "submitted") {
      if (said) evs.push({ t: "activity", kind: "think", label: said.split("\n")[0].slice(0, 140) });
      return;
    }
    if (state === "failed" || state === "rejected" || state === "canceled") {
      finished = true;
      session.taskId = undefined;
      evs.push({ t: "error", message: said || `The agent ${state === "canceled" ? "stopped the task" : state === "rejected" ? "turned the request down" : "could not finish the task"}.` });
      return;
    }
    if (state === "auth-required") {
      // The agent needs the person to sign in to something on its side. Cube never sends credentials in a message.
      finished = true;
      evs.push({ t: "delta", text: `${wrote ? "\n\n" : ""}This agent says it needs a sign-in before it can go on${said ? `: ${said}` : "."} Do that with the agent's provider, then send your message again.` });
      return;
    }
    if (state === "input-required") {
      finished = true;
      partsOf(message.parts, evs, files);
      return;
    }
    if (state === "completed") {
      finished = true;
      session.taskId = undefined;
      partsOf(message.parts, evs, files);
    }
  };

  const artifact = (raw: unknown, evs: Ev[], files: RemoteFile[]) => {
    const a = obj(raw);
    const id = str(a.artifactId);
    if (wrote && id && id !== lastArtifact) evs.push({ t: "delta", text: "\n\n" });
    lastArtifact = id || lastArtifact;
    partsOf(a.parts, evs, files);
  };

  const task = (raw: unknown, evs: Ev[], files: RemoteFile[]) => {
    const t = obj(raw);
    session.contextId = str(t.contextId) || session.contextId;
    session.taskId = str(t.id) || session.taskId;
    list(t.artifacts).forEach((a) => artifact(a, evs, files));
    status(t.status, evs, files);
  };

  return {
    feed(data) {
      const evs: Ev[] = [];
      const files: RemoteFile[] = [];
      const top = obj(data);
      if (top.error) {
        finished = true;
        evs.push({ t: "error", message: str(obj(top.error).message) || "The agent answered with an error." });
        return { evs, files };
      }
      const r = obj(top.result ?? top);
      const kind = str(r.kind);
      if (r.task || kind === "task") {
        task(r.task ?? r, evs, files);
      } else if (r.statusUpdate || kind === "status-update") {
        const u = obj(r.statusUpdate ?? r);
        session.contextId = str(u.contextId) || session.contextId;
        session.taskId = str(u.taskId) || session.taskId;
        status(u.status, evs, files);
        if (u.final === true) finished = true;
      } else if (r.artifactUpdate || kind === "artifact-update") {
        const u = obj(r.artifactUpdate ?? r);
        session.contextId = str(u.contextId) || session.contextId;
        artifact(u.artifact, evs, files);
      } else if (r.message || kind === "message") {
        // A plain message is the whole answer: no task was made.
        const m = obj(r.message ?? r);
        session.contextId = str(m.contextId) || session.contextId;
        partsOf(m.parts, evs, files);
        finished = true;
      }
      return { evs, files };
    },
    session: () => ({ ...session }),
    done: () => finished,
  };
}
