import { describe, expect, it } from "vitest";
import { adopt, nameProblem, newId, offer, ownColor, readOffer, toDef, type SubAgent } from "./subagents";

const sub: SubAgent = { id: "sub-legal", name: "Legal", role: "Contract reviewer", brief: "Reads contracts and flags risks.", instructions: "Quote the clause you object to.", palette: ["#112233", "#445566", "#778899"] };

describe("names and ids", () => {
  it("accepts letters and digits of any script, and refuses spaces, symbols and names in use", () => {
    expect(nameProblem("Legal", [])).toBeNull();
    expect(nameProblem("법무", [])).toBeNull();
    expect(nameProblem("QA2", [])).toBeNull();
    expect(nameProblem("Legal Team", [])).not.toBeNull();
    expect(nameProblem("2fast", [])).not.toBeNull();
    expect(nameProblem("a", [])).not.toBeNull();
    expect(nameProblem("builder", ["Builder"])).not.toBeNull();
    expect(nameProblem("You", [])).not.toBeNull();
  });

  it("makes an id that is not taken", () => {
    expect(newId("Legal", [])).toBe("sub-legal");
    expect(newId("Legal", ["sub-legal", "sub-legal-2"])).toBe("sub-legal-3");
    expect(newId("법무", [])).toBe("sub-agent");
  });

  it("gives a cube a color of its own", () => {
    expect(ownColor("#7A4DF0", [])).toBe("#7a4df0");
    expect(ownColor("#7A4DF0", ["#7a4df0", "#7a4df1"])).toBe("#7a4df2");
  });
});

describe("toDef", () => {
  it("turns a sub-agent into a role, with its instructions and the given color as its key", () => {
    const def = toDef(sub, "#112234");
    expect(def).toMatchObject({ id: "sub-legal", name: "Legal", role: "Contract reviewer", color: "#112234", palette: ["#112234", "#445566", "#778899"], custom: true, instructions: "Quote the clause you object to." });
    expect(toDef({ ...sub, instructions: "  " }, "#112233").instructions).toBeUndefined();
  });
});

describe("offering and bringing in", () => {
  const by = "bb".repeat(32);
  it("round-trips what is offered, and nothing about engines or the maker's computer", () => {
    const body = JSON.parse(offer({ ...sub, shared: true, from: { name: "x", pubkey: "y" } }));
    expect(Object.keys(body.agent).sort()).toEqual(["brief", "id", "instructions", "name", "palette", "role"]);
    expect(readOffer(body, by, "Bea")).toEqual({ key: `${by}:sub-legal`, by, byName: "Bea", name: "Legal", role: "Contract reviewer", brief: "Reads contracts and flags risks.", instructions: "Quote the clause you object to.", palette: ["#112233", "#445566", "#778899"] });
  });

  it("refuses offers that are malformed or oversized", () => {
    const good = JSON.parse(offer(sub));
    expect(readOffer({ agent: { ...good.agent, name: "has space" } }, by, "Bea")).toBeNull();
    expect(readOffer({ agent: { ...good.agent, brief: "" } }, by, "Bea")).toBeNull();
    expect(readOffer({ agent: { ...good.agent, instructions: "x".repeat(9000) } }, by, "Bea")).toBeNull();
    expect(readOffer({ agent: { ...good.agent, palette: ["red", "#000000", "#000000"] } }, by, "Bea")).toBeNull();
    expect(readOffer({ agent: { ...good.agent, id: 5 } }, by, "Bea")).toBeNull();
    expect(readOffer({}, by, "Bea")).toBeNull();
    expect(readOffer(null, by, "Bea")).toBeNull();
  });

  it("brings a teammate's sub-agent in under a free name, remembering who made it", () => {
    const shared = readOffer(JSON.parse(offer(sub)), by, "Bea")!;
    expect(adopt(shared, [], [])).toMatchObject({ id: "sub-legal", name: "Legal", from: { name: "Bea", pubkey: by } });
    expect(adopt(shared, ["Legal"], ["sub-legal"])).toMatchObject({ id: "sub-legal2", name: "Legal2" });
  });
});
