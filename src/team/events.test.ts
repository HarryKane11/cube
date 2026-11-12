import { describe, expect, it } from "vitest";
import type { Msg } from "@/state/store";
import { applyEvent, inviteLink, nameOf, postBody, shareable, withoutImages, type TeamEvent, type TeamMember } from "./events";

const ME = "aa".repeat(32);
const BEA = "bb".repeat(32);
const CY = "cc".repeat(32);
const members: TeamMember[] = [{ pubkey: ME, name: "Kane", role: "member" }, { pubkey: BEA, name: "Bea", role: "member" }, { pubkey: CY, name: "Cy", role: "admin" }];
const ev = (kind: string, body: unknown, pubkey = BEA, extra: Partial<TeamEvent> = {}): TeamEvent => ({ seq: 1, id: "e", pubkey, created_at: 1_794_460_000, kind, body: JSON.stringify(body), ...extra });

function world(msgs: Msg[] = []) {
  return { me: ME, members, convOf: (id: string) => (id === "S1" ? "team-s1" : undefined), msgOf: (id: string) => msgs.find((m) => m.id === id) };
}
const theirs: Msg = { id: "m1", convId: "team-s1", author: "peer", text: "hello", ts: 1, from: { pubkey: BEA, name: "Bea" } };
const mine: Msg = { id: "m2", convId: "team-s1", author: "you", text: "mine", ts: 2 };

describe("applyEvent", () => {
  it("opens a channel a teammate shared, and renames one we already have", () => {
    expect(applyEvent(ev("conv.put", { conv: "S9", name: "launch" }), world())).toEqual({ t: "conv", sharedId: "S9", name: "launch" });
    expect(applyEvent(ev("conv.put", { conv: "S1", name: "renamed" }), world())).toEqual({ t: "rename", convId: "team-s1", name: "renamed" });
  });

  it("adds a teammate's message, marked as theirs, and their agent's with the agent named", () => {
    const got = applyEvent(ev("msg.post", { conv: "S1", msg: { id: "m9", text: "ship it" } }), world());
    expect(got).toEqual({ t: "add", msg: { id: "m9", convId: "team-s1", author: "peer", text: "ship it", ts: 1_794_460_000_000, from: { pubkey: BEA, name: "Bea" } } });
    const agent = applyEvent(ev("msg.post", { conv: "S1", msg: { id: "m8", text: "done", agent: { id: "builder", name: "Builder" }, parent: "m1" } }), world([theirs]));
    expect(agent).toMatchObject({ t: "add", msg: { from: { pubkey: BEA, name: "Bea", agent: "Builder" }, parentId: "m1" } });
  });

  it("ignores our own events coming back, redacted ones, unknown channels and malformed bodies", () => {
    expect(applyEvent(ev("msg.post", { conv: "S1", msg: { id: "x", text: "hi" } }, ME), world())).toBeNull();
    expect(applyEvent(ev("msg.post", { conv: "S1", msg: { id: "x", text: "hi" } }, BEA, { redacted: true }), world())).toBeNull();
    expect(applyEvent(ev("msg.post", { conv: "nope", msg: { id: "x", text: "hi" } }), world())).toBeNull();
    expect(applyEvent({ ...ev("msg.post", {}), body: "not json" }, world())).toBeNull();
    expect(applyEvent(ev("msg.post", { conv: "S1", msg: { id: "x", text: "   " } }), world())).toBeNull();
    expect(applyEvent(ev("msg.post", { conv: "S1", msg: { id: 5, text: "hi" } }), world())).toBeNull();
    expect(applyEvent(ev("member.remove", { conv: "S1" }), world())).toBeNull();
  });

  it("never lets a post overwrite a message we already have, ours least of all", () => {
    expect(applyEvent(ev("msg.post", { conv: "S1", msg: { id: "m2", text: "rewritten" } }), world([mine]))).toBeNull();
    expect(applyEvent(ev("msg.post", { conv: "S1", msg: { id: "m1", text: "again" } }), world([theirs]))).toBeNull();
  });

  it("lets only the author edit a message", () => {
    expect(applyEvent(ev("msg.edit", { conv: "S1", id: "m1", msg: { text: "hello!" } }), world([theirs]))).toEqual({ t: "edit", id: "m1", text: "hello!" });
    expect(applyEvent(ev("msg.edit", { conv: "S1", id: "m1", msg: { text: "hijacked" } }, CY), world([theirs]))).toBeNull();
    expect(applyEvent(ev("msg.edit", { conv: "S1", id: "m2", msg: { text: "hijacked" } }), world([mine]))).toBeNull();
  });

  it("lets the author or an admin delete a teammate's message, and nobody delete ours", () => {
    expect(applyEvent(ev("msg.delete", { conv: "S1", id: "m1" }), world([theirs]))).toEqual({ t: "delete", id: "m1" });
    expect(applyEvent(ev("msg.delete", { conv: "S1", id: "m1" }, CY), world([theirs]))).toEqual({ t: "delete", id: "m1" });
    const other: Msg = { ...theirs, id: "m3", from: { pubkey: CY, name: "Cy" } };
    expect(applyEvent(ev("msg.delete", { conv: "S1", id: "m3" }), world([other]))).toBeNull();
    expect(applyEvent(ev("msg.delete", { conv: "S1", id: "m2" }, CY), world([mine]))).toBeNull();
  });

  it("takes the pictures out of a teammate's text, so nothing is fetched because of it", () => {
    expect(withoutImages("see ![chart](https://x.example/p.png?u=1) and ![](https://y.example/t.gif \"t\")")).toBe("see [chart](https://x.example/p.png?u=1) and [image](https://y.example/t.gif)");
    const got = applyEvent(ev("msg.post", { conv: "S1", msg: { id: "m7", text: "![x](https://track.example/1.png)" } }), world());
    expect(got).toMatchObject({ msg: { text: "[x](https://track.example/1.png)" } });
  });
});

describe("names", () => {
  it("adds the start of the key when two members share a name, and says so for a stranger", () => {
    expect(nameOf(BEA, members)).toBe("Bea");
    expect(nameOf(BEA, [...members, { pubkey: "dd".repeat(32), name: "Bea", role: "member" }])).toBe("Bea (bbbb)");
    expect(nameOf("ee".repeat(32), members)).toBe("Someone (eeeeee)");
  });
});

describe("what goes out", () => {
  it("shares finished messages of ours said after sharing began, and nothing else", () => {
    const m = (patch: Partial<Msg>): Msg => ({ id: "x", convId: "c", author: "you", text: "hi", ts: 100, ...patch });
    expect(shareable(m({}), 50)).toBe(true);
    expect(shareable(m({ ts: 10 }), 50)).toBe(false);
    expect(shareable(m({ streaming: true }), 50)).toBe(false);
    expect(shareable(m({ aside: true }), 50)).toBe(false);
    expect(shareable(m({ from: { pubkey: BEA, name: "Bea" } }), 50)).toBe(false);
    expect(shareable(m({ text: "  " }), 50)).toBe(false);
  });

  it("builds a post with the message id inside, and an edit with it beside", () => {
    expect(JSON.parse(postBody("S1", "m1", "hi", true, { id: "builder", name: "Builder" }, "p1"))).toEqual({ conv: "S1", msg: { id: "m1", text: "hi", agent: { id: "builder", name: "Builder" }, parent: "p1" } });
    expect(JSON.parse(postBody("S1", "m1", "hi again", false))).toEqual({ conv: "S1", id: "m1", msg: { text: "hi again" } });
  });

  it("writes invite links with the token after the hash, over TLS unless the relay is on this machine", () => {
    expect(inviteLink("relay.example.com", "tok")).toBe("cube+wss://relay.example.com/#invite=tok");
    expect(inviteLink("127.0.0.1:8484", "tok")).toBe("cube+ws://127.0.0.1:8484/#invite=tok");
  });
});
