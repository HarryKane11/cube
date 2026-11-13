import { describe, expect, it } from "vitest";
import { parseSetup, setupPrompt, usesBlock, type SetupInput } from "./setup";
import { subagentMd, toDef } from "./subagents";
import { PALETTES, propOf } from "./types";

const input: SetupInput = {
  description: "Reads our contracts and flags what is risky.",
  person: "Kane",
  language: "Korean",
  taken: ["Router", "Writer"],
  team: [{ name: "Writer", about: "Drafts documents." }],
  props: [{ id: "gavel", about: "knows the rules" }, { id: "pencil", about: "writes" }],
  palettes: PALETTES,
  tools: [{ name: "Linear", about: "Issues", program: "Claude Code" }],
  skills: [{ name: "bc-documentation", about: "Standard documents", program: "" }],
};

const answer = (o: object) => `Here it is:\n${JSON.stringify(o)}\nDone.`;

describe("setupPrompt", () => {
  it("lists what exists, so the program can only pick from it", () => {
    const p = setupPrompt(input);
    expect(p).toContain("- gavel: knows the rules");
    expect(p).toContain("- Linear (Claude Code): Issues");
    expect(p).toContain("- bc-documentation: Standard documents");
    expect(p).toContain("Not any of: Router, Writer");
    expect(p).toContain("in Korean");
  });
});

describe("parseSetup", () => {
  it("reads a definition out of whatever surrounds it", () => {
    const s = parseSetup(answer({ name: "@Counsel", role: "계약 검토", brief: "계약서를 읽고 위험한 조항을 짚어요.", instructions: "You review contracts.", prop: "gavel", palette: PALETTES[2].name, mcp: ["linear"], skills: ["bc-documentation"], missing: ["A contract store"] }), input);
    expect(s).toMatchObject({ name: "Counsel", role: "계약 검토", prop: "gavel", palette: PALETTES[2].colors, mcp: ["Linear"], skills: ["bc-documentation"], missing: ["A contract store"] });
  });

  it("leaves out a prop, colors, tools and skills that do not exist", () => {
    const s = parseSetup(answer({ name: "Counsel", brief: "Reads contracts.", instructions: "", prop: "crown", palette: "Neon", mcp: ["Salesforce", "Linear", "Linear"], skills: ["made-up"], missing: [] }), input);
    expect(s?.prop).toBeUndefined();
    expect(s?.palette).toBeUndefined();
    expect(s?.mcp).toEqual(["Linear"]);
    expect(s?.skills).toEqual([]);
  });

  it("takes \"none\" as a choice of nothing", () => {
    expect(parseSetup(answer({ name: "Plain", brief: "Does plain things.", prop: "none" }), input)?.prop).toBe("none");
  });

  it("gives nothing when there is no definition", () => {
    expect(parseSetup("I could not do that.", input)).toBeNull();
    expect(parseSetup(answer({ name: "Empty" }), input)).toBeNull();
    expect(parseSetup("{ not json }", input)).toBeNull();
  });
});

describe("a sub-agent set up this way", () => {
  const sub = { id: "sub-counsel", name: "Counsel", role: "Contract reviewer", brief: "Reads contracts.", instructions: "You review contracts.", palette: PALETTES[0].colors, prop: "gavel", uses: { mcp: ["Linear"], skills: ["bc-documentation"] } };

  it("is told which tools and skills were picked for it", () => {
    expect(usesBlock(undefined)).toBe("");
    const def = toDef(sub, "#123456");
    expect(def.instructions).toContain("You review contracts.");
    expect(def.instructions).toContain("Connected tools (MCP servers) to reach for: Linear");
    expect(def.instructions).toContain("Skills to follow: bc-documentation");
  });

  it("holds what was picked, unless the person chose otherwise", () => {
    const def = toDef(sub, "#123456");
    expect(propOf(def)).toBe("gavel");
    expect(propOf(def, { "sub-counsel": "pencil" })).toBe("pencil");
    expect(propOf(def, { "sub-counsel": "none" })).toBeUndefined();
    expect(propOf(toDef({ ...sub, prop: undefined }, "#123456"))).toBeUndefined();
  });

  it("is written out as a file that says the same", () => {
    const md = subagentMd(sub);
    expect(md).toMatch(/^---\nname: Counsel\nrole: Contract reviewer\ndescription: Reads contracts\.\nprop: gavel\nmcp: \[Linear\]\nskills: \[bc-documentation\]\n---/);
    expect(md).toContain("## How it works\n\nYou review contracts.");
  });
});
