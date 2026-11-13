/**
 * Runs the setting-up of a sub-agent (see setup.ts) on an agent program the person has
 * connected: the one picked for background work, or else the first one found.
 */
import { PROPS } from "@/cube/props/catalog";
import { knowledgeEngine, programStock } from "@/knowledge";
import { useCube } from "@/state/store";
import { HEADLESS, runHeadless, type HeadlessEngine } from "./headless";
import { inTauri, knowledgeList } from "./runner";
import { parseSetup, setupPrompt, type Listed, type Setup, type SetupInput } from "./setup";
import { AGENTS, PALETTES } from "./types";

const PROGRAM_NAME = { claude: "Claude Code", codex: "Codex", hermes: "Hermes" } as const;

/** The program that sets a sub-agent up: the person's choice for background work, else whichever is there. */
export function setupEngine(): HeadlessEngine | undefined {
  const s = useCube.getState();
  return knowledgeEngine() ?? HEADLESS.find((e) => s.available[e]);
}

/** Everything the program is told: who is on the team, what a cube can hold, and what is connected on this computer. */
async function gather(description: string): Promise<{ input: SetupInput; dir: string }> {
  const s = useCube.getState();
  const [listing, programs] = await Promise.all([knowledgeList(), programStock()]);
  const tools: Listed[] = [];
  const skills: Listed[] = listing.skills.map((k) => ({ name: k.name, about: k.description, program: "" }));
  for (const p of ["claude", "codex", "hermes"] as const) {
    const stock = programs[p];
    if (!stock) continue;
    for (const m of stock.mcp) if (!tools.some((t) => t.name.toLowerCase() === m.name.toLowerCase())) tools.push({ ...m, program: PROGRAM_NAME[p] });
    for (const k of stock.skills) if (!skills.some((t) => t.name.toLowerCase() === k.name.toLowerCase())) skills.push({ name: k.name, about: k.about, program: PROGRAM_NAME[p] });
  }
  return {
    dir: listing.dir,
    input: {
      description,
      person: s.name || "the person",
      language: s.settings.lang === "ko" ? "Korean" : "English",
      taken: AGENTS.map((a) => a.name),
      team: AGENTS.map((a) => ({ name: a.name, about: a.brief || a.role })),
      props: PROPS.map((p) => ({ id: p.id, about: p.about })),
      palettes: PALETTES,
      tools,
      skills,
    },
  };
}

/** What a sub-agent set up in the browser preview looks like, so the form can be tried there. */
const SAMPLE: Setup = {
  name: "Counsel",
  role: "Contract reviewer",
  brief: "Reads a contract or a policy and says what is risky in it, clause by clause, with what to ask for instead.",
  instructions: "You review contracts for the team.\n\n1. Ask which side we are on if it is not clear.\n2. Read the whole document before commenting.\n3. List the clauses that carry risk, most serious first, each with what to ask for instead.\n4. Say plainly what you are not sure of. You are not a lawyer of record.\n\nHand drafting of a reply to @Writer.",
  prop: "gavel",
  palette: PALETTES[5].colors,
  mcp: [],
  skills: [],
  missing: ["A connector to where contracts are kept"],
};

/**
 * Sets a sub-agent up from what the person said it should do. Resolves with the definition to
 * put in the form, or rejects with words for the person. `stop` gives it up.
 */
export function runSetup(description: string, onActivity: (label: string) => void): { done: Promise<Setup>; stop(): void } {
  if (!inTauri) return { done: new Promise((resolve) => window.setTimeout(() => resolve(SAMPLE), 900)), stop: () => undefined };
  const engine = setupEngine();
  if (!engine) return { done: Promise.reject(new Error("No agent program is connected. Install Claude Code, Codex or Hermes, or add an API key in Settings.")), stop: () => undefined };
  let stopRun = () => {};
  let stopped = false;
  const done = (async () => {
    onActivity("Looking at what is connected");
    const { input, dir } = await gather(description);
    if (stopped) throw new Error("Stopped.");
    const s = useCube.getState();
    const run = runHeadless({ engine, model: engine === knowledgeEngine() ? s.knowledge.model : undefined, cwd: dir, prompt: setupPrompt(input), onActivity });
    stopRun = run.stop;
    const result = await run.done;
    if (stopped) throw new Error("Stopped.");
    if (result.error && !result.text) throw new Error(result.error);
    const setup = parseSetup(result.text, input);
    if (!setup) throw new Error("The program did not come back with a definition. Try again, or say a little more about what it should do.");
    return setup;
  })();
  return { done, stop: () => { stopped = true; stopRun(); } };
}
