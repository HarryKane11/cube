import { describe, expect, it } from "vitest";
import { entries, filtered, inventory, sourcesOf, type Held } from "./library";

const held = (source: Held["source"], name: string, about = "", path?: string): Held => ({ source, name, about, path });

describe("entries", () => {
  it("shows a skill several programs have as one row that names them all, Cube first", () => {
    const rows = entries("skills", [
      held("hermes", "bc-docs", "Hermes copy", "/h/SKILL.md"),
      held("claude", "BC-Docs", "Writes documents", "/c/SKILL.md"),
      held("cube", "weekly-report", "Cube's own"),
      held("codex", "pdf", "Reads PDFs"),
    ]);
    expect(rows.map((r) => [r.name, r.held.map((h) => h.source)])).toEqual([
      ["BC-Docs", ["claude", "hermes"]],
      ["pdf", ["codex"]],
      ["weekly-report", ["cube"]],
    ]);
    expect(rows[0].about).toBe("Writes documents");
  });

  it("takes a description from another program when the first has none", () => {
    const [row] = entries("mcp", [held("claude", "github", ""), held("codex", "github", "remote")]);
    expect(row.about).toBe("remote");
    expect(row.held).toHaveLength(2);
  });

  it("never merges memories, even with the same name", () => {
    const rows = entries("memory", [held("claude", "likes-tests", "a"), held("cube", "likes-tests", "b")]);
    expect(rows.map((r) => r.held[0].source)).toEqual(["cube", "claude"]);
  });
});

describe("filtered and sourcesOf", () => {
  const rows = entries("skills", [held("claude", "docs", "Writes documents"), held("hermes", "docs"), held("codex", "pdf", "Reads PDFs")]);
  it("filters by what was typed and by the program that has it", () => {
    expect(filtered(rows, "pdf", "all").map((r) => r.name)).toEqual(["pdf"]);
    expect(filtered(rows, "DOCUMENT", "all").map((r) => r.name)).toEqual(["docs"]);
    expect(filtered(rows, "", "hermes").map((r) => r.name)).toEqual(["docs"]);
    expect(filtered(rows, "pdf", "hermes")).toEqual([]);
  });
  it("lists the programs that have something", () => {
    expect(sourcesOf(rows)).toEqual(["claude", "codex", "hermes"]);
    expect(sourcesOf([])).toEqual([]);
  });
});

describe("inventory", () => {
  it("writes what each program has, by kind, with descriptions cut short", () => {
    const text = inventory({
      claude: { skills: [{ name: "docs", about: `Writes\n documents ${"x".repeat(300)}` }], mcp: [{ name: "github", about: "remote" }], plugins: [] },
      hermes: { skills: [], mcp: [], plugins: [{ name: "slack", about: "" }] },
    }, "2026-11-12");
    expect(text).toContain("## Claude Code\n\n### Skills (1)\n\n- docs: Writes documents xxx");
    expect(text).toContain("### MCP servers (1)\n\n- github: remote");
    expect(text).toContain("### Plugins (0)\n\nNone.");
    expect(text).toContain("## Hermes");
    expect(text).toContain("- slack\n");
    expect(text).not.toContain("## Codex");
    const docs = text.split("\n").find((l) => l.startsWith("- docs"))!;
    expect(docs.length).toBeLessThanOrEqual(170);
  });
});
