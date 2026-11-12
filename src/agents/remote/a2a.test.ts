import { describe, expect, it } from "vitest";
import { buildRequest, cardAddress, cardPin, makeReader, parseCard, type RemoteCard } from "./a2a";

const CARD_URL = "https://agent.example.com/.well-known/agent-card.json";

const v1 = {
  name: "Route Planner",
  description: "Plans routes",
  version: "2.1.0",
  provider: { organization: "Example" },
  supportedInterfaces: [
    { url: "https://agent.example.com/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" },
    { url: "https://agent.example.com/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
  capabilities: { streaming: true },
  securitySchemes: {
    token: { httpAuthSecurityScheme: { scheme: "Bearer" } },
    key: { apiKeySecurityScheme: { location: "header", name: "X-Api-Key" } },
    cert: { mtlsSecurityScheme: {} },
  },
  securityRequirements: [{ schemes: { token: { list: [] } } }],
  skills: [{ id: "plan", name: "Plan a route", description: "Finds a way" }],
  signatures: [{ protected: "x", signature: "y" }],
};

const old = {
  name: "Old Agent",
  url: "https://old.example.com/rpc",
  protocolVersion: "0.3.0",
  capabilities: {},
  securitySchemes: { k: { type: "apiKey", in: "query", name: "key" }, o: { type: "oauth2" } },
  security: [{ o: [] }],
};

const card = (json: unknown) => parseCard(json, CARD_URL) as RemoteCard;

describe("cardAddress", () => {
  it("uses the well-known path unless the address names a JSON file", () => {
    expect(cardAddress("https://agent.example.com/some/page")).toBe(CARD_URL);
    expect(cardAddress(" https://agent.example.com/cards/a.json ")).toBe("https://agent.example.com/cards/a.json");
  });
});

describe("parseCard", () => {
  it("reads a 1.0 card: the JSON-RPC interface, the sign-in schemes, the skills", () => {
    const c = card(v1);
    expect(c).toMatchObject({ name: "Route Planner", provider: "Example", endpoint: "https://agent.example.com/a2a", binding: "JSONRPC", legacy: false, streaming: true, needsAuth: true, signed: true });
    expect(c.schemes.map((s) => [s.id, s.kind, s.header])).toEqual([["token", "bearer", undefined], ["key", "header", "X-Api-Key"], ["cert", "unsupported", undefined]]);
    expect(c.skills).toEqual([{ name: "Plan a route", description: "Finds a way" }]);
  });

  it("reads a 0.3 card, and will not put a key in the address", () => {
    const c = card(old);
    expect(c).toMatchObject({ endpoint: "https://old.example.com/rpc", legacy: true, streaming: false, needsAuth: true, signed: false });
    expect(c.schemes.map((s) => s.kind)).toEqual(["unsupported", "oauth"]);
  });

  it("refuses cards it cannot or should not use", () => {
    expect(parseCard({}, CARD_URL)).toHaveProperty("error");
    expect(parseCard({ name: "x" }, CARD_URL)).toHaveProperty("error");
    expect(parseCard({ name: "x", supportedInterfaces: [{ url: "https://a.example.com", protocolBinding: "GRPC", protocolVersion: "1.0" }] }, CARD_URL)).toHaveProperty("error");
    expect(parseCard({ name: "x", url: "http://agent.example.com/rpc" }, CARD_URL)).toEqual({ error: "The agent must be reached over HTTPS." });
    expect(parseCard({ name: "x", url: "https://user:pw@agent.example.com/rpc" }, CARD_URL)).toHaveProperty("error");
    // A card on the internet may not send Cube to this machine without TLS.
    expect(parseCard({ name: "x", url: "http://localhost:9000/rpc" }, CARD_URL)).toHaveProperty("error");
    expect(parseCard({ name: "x", url: "http://localhost:9000/rpc" }, "http://localhost:9000/.well-known/agent-card.json")).toMatchObject({ endpoint: "http://localhost:9000/rpc" });
  });

  it("pins what decides where things go and what goes along", () => {
    const a = cardPin(card(v1));
    expect(cardPin(card({ ...v1, description: "Reworded" }))).toBe(a);
    expect(cardPin(card({ ...v1, supportedInterfaces: [{ url: "https://elsewhere.example.com/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }] }))).not.toBe(a);
    expect(cardPin(card({ ...v1, securitySchemes: { token: { apiKeySecurityScheme: { location: "header", name: "X-Leak" } } } }))).not.toBe(a);
  });
});

describe("buildRequest", () => {
  it("speaks 1.0 JSON-RPC, continuing a conversation", () => {
    const r = buildRequest(card(v1), "hello", { contextId: "ctx", taskId: "t1" }, "m1");
    expect(r).toMatchObject({ url: "https://agent.example.com/a2a", stream: true, type: "application/json", headers: [["A2A-Version", "1.0"]] });
    expect(JSON.parse(r.body)).toEqual({ jsonrpc: "2.0", id: "m1", method: "SendStreamingMessage", params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hello" }], contextId: "ctx", taskId: "t1" } } });
  });

  it("speaks 0.3 JSON-RPC without streaming when the agent has none", () => {
    const r = buildRequest(card(old), "hello", {}, "m1");
    expect(r.stream).toBe(false);
    expect(JSON.parse(r.body)).toEqual({ jsonrpc: "2.0", id: "m1", method: "message/send", params: { message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "hello" }] } } });
  });

  it("speaks 1.0 HTTP+JSON", () => {
    const rest = card({ ...v1, supportedInterfaces: [{ url: "https://agent.example.com/v1/", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }] });
    const r = buildRequest(rest, "hi", {}, "m1");
    expect(r).toMatchObject({ url: "https://agent.example.com/v1/message:stream", type: "application/a2a+json" });
    expect(JSON.parse(r.body)).toEqual({ message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }] } });
  });
});

describe("makeReader", () => {
  it("follows a 1.0 stream: progress, an artifact in pieces, completion", () => {
    const r = makeReader();
    const all = [
      { jsonrpc: "2.0", id: 1, result: { task: { id: "t1", contextId: "c1", status: { state: "TASK_STATE_SUBMITTED" } } } },
      { result: { statusUpdate: { taskId: "t1", contextId: "c1", status: { state: "TASK_STATE_WORKING", message: { parts: [{ text: "Looking at maps\nmore" }] } } } } },
      { result: { artifactUpdate: { taskId: "t1", contextId: "c1", artifact: { artifactId: "a1", parts: [{ text: "Take " }] } } } },
      { result: { artifactUpdate: { taskId: "t1", contextId: "c1", artifact: { artifactId: "a1", parts: [{ text: "the A1." }] }, append: true, lastChunk: true } } },
      { result: { statusUpdate: { taskId: "t1", contextId: "c1", status: { state: "TASK_STATE_COMPLETED" } } } },
    ].flatMap((o) => r.feed(o).evs);
    expect(all).toEqual([
      { t: "activity", kind: "think", label: "Looking at maps" },
      { t: "delta", text: "Take " },
      { t: "delta", text: "the A1." },
    ]);
    expect(r.done()).toBe(true);
    // A finished task is closed; only the conversation carries on.
    expect(r.session()).toEqual({ contextId: "c1", taskId: undefined });
  });

  it("follows a 0.3 stream and keeps the task when the agent asks something back", () => {
    const r = makeReader();
    const all = [
      { result: { kind: "task", id: "t9", contextId: "c9", status: { state: "submitted" } } },
      { result: { kind: "status-update", taskId: "t9", contextId: "c9", status: { state: "input-required", message: { role: "agent", parts: [{ kind: "text", text: "Which city?" }] } }, final: true } },
    ].flatMap((o) => r.feed(o).evs);
    expect(all).toEqual([{ t: "delta", text: "Which city?" }]);
    expect(r.done()).toBe(true);
    expect(r.session()).toEqual({ contextId: "c9", taskId: "t9" });
  });

  it("reads an answer that is a plain message, and a whole task returned at once", () => {
    const m = makeReader();
    expect(m.feed({ result: { message: { contextId: "c2", role: "ROLE_AGENT", parts: [{ text: "Hi" }] } } }).evs).toEqual([{ t: "delta", text: "Hi" }]);
    expect(m.done()).toBe(true);
    expect(m.session().contextId).toBe("c2");
    const t = makeReader();
    const got = t.feed({ result: { kind: "task", id: "t", contextId: "c", artifacts: [{ artifactId: "a", parts: [{ kind: "text", text: "Done." }] }], status: { state: "completed" } } });
    expect(got.evs).toEqual([{ t: "delta", text: "Done." }]);
    expect(t.done()).toBe(true);
  });

  it("turns failures and protocol errors into errors", () => {
    expect(makeReader().feed({ error: { code: -32001, message: "Task not found" } }).evs).toEqual([{ t: "error", message: "Task not found" }]);
    const r = makeReader();
    expect(r.feed({ result: { statusUpdate: { taskId: "t", status: { state: "TASK_STATE_FAILED", message: { parts: [{ text: "Out of quota" }] } } } } }).evs).toEqual([{ t: "error", message: "Out of quota" }]);
    expect(r.done()).toBe(true);
  });

  it("never answers a sign-in request with a credential: it tells the person", () => {
    const r = makeReader();
    const [ev] = r.feed({ result: { statusUpdate: { taskId: "t", status: { state: "TASK_STATE_AUTH_REQUIRED", message: { parts: [{ text: "Connect your calendar" }] } } } } }).evs;
    expect(ev).toMatchObject({ t: "delta" });
    expect((ev as { text: string }).text).toContain("Connect your calendar");
    expect(r.done()).toBe(true);
  });

  it("hands over files sent as bytes with a safe name, and links to files sent as addresses", () => {
    const r = makeReader();
    const got = r.feed({ result: { artifactUpdate: { artifact: { artifactId: "a", parts: [
      { raw: "aGVsbG8=", filename: "../../etc/report.txt", mediaType: "text/plain" },
      { kind: "file", file: { name: "old.png", bytes: "AAAA" } },
      { url: "https://files.example.com/big.zip", filename: "big.zip" },
      { url: "file:///etc/passwd", filename: "nope" },
    ] } } } });
    expect(got.files).toEqual([{ name: ".._.._etc_report.txt".replace(/^\.+/, ""), base64: "aGVsbG8=" }, { name: "old.png", base64: "AAAA" }]);
    expect(got.evs).toEqual([{ t: "delta", text: "\n[big.zip](https://files.example.com/big.zip)\n" }]);
  });
});
