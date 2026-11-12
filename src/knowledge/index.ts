import { HEADLESS, runHeadless, type HeadlessEngine } from "@/agents/headless";
import { splitNotes } from "@/agents/notes";
import { getHarness, inTauri, knowledgeExport, knowledgeImport, knowledgeList, knowledgeRemove, libraryProgram, writeText, type KnowledgeListing } from "@/agents/runner";
import { inventory } from "@/lib/library";
import { ROUTER, authorName } from "@/agents/types";
import { maskSecrets } from "@/lib/secrets";
import { useCube } from "@/state/store";
import { dueJob, finished, jobPrompt, summaryOf, transcript, type JobKind, type Line } from "./jobs";

export * from "./jobs";

const store = () => useCube.getState();
let stopCurrent: (() => void) | undefined;

/** The engine background work runs on: the person's choice, or nothing until they have made one. */
export function knowledgeEngine(): HeadlessEngine | undefined {
  const picked = store().knowledge.engine;
  return picked && HEADLESS.includes(picked) && store().available[picked] ? picked : undefined;
}

/** Conversation lines written after `after`, as the jobs read them: what people and agents said, credentials hidden. */
export function linesSince(after: number): Line[] {
  const s = store();
  const convs = new Map(s.convs.map((c) => [c.id, c]));
  const lines: Line[] = [];
  for (const m of s.messages) {
    const conv = convs.get(m.convId);
    // The Router's one-line handovers and side answers are not what was said in the conversation.
    if (!conv || m.ts <= after || m.streaming || m.aside || m.author === ROUTER) continue;
    const text = splitNotes(m.text).text.trim();
    if (!text) continue;
    lines.push({
      convId: conv.id,
      where: conv.kind === "dm" ? `Direct message with ${conv.name}` : `#${conv.name}`,
      who: m.author === "you" ? s.name || "The person" : authorName(m.author),
      text: maskSecrets(text.length > 6000 ? `${text.slice(0, 6000)}\n[…cut]` : text),
      ts: m.ts,
    });
  }
  return lines;
}

/** What each agent program found on this computer has (skills, MCP servers, plugins), written out for the wiki job. */
async function stock(): Promise<string> {
  const programs: Parameters<typeof inventory>[0] = {};
  for (const p of ["claude", "codex", "hermes"] as const) {
    if (!store().available[p]) continue;
    const [lib, harness] = await Promise.all([libraryProgram(p), getHarness(p)]).catch(() => [undefined, undefined] as const);
    if (lib && harness) programs[p] = { skills: lib.skills, mcp: harness.mcp, plugins: harness.plugins };
  }
  return inventory(programs, new Date().toISOString().slice(0, 10));
}

/** What is in the knowledge folder right now. */
export async function listKnowledge(): Promise<KnowledgeListing | null> {
  if (!inTauri) return null;
  const listing = await knowledgeList();
  if (store().knowledgeDir !== listing.dir || store().knowledgeCount !== listing.memory.length + listing.skills.length + listing.wiki.length) {
    store().setKnowledgePlace(listing.dir, listing.memory.length + listing.skills.length + listing.wiki.length);
  }
  return listing;
}

/** Brings in what Claude Code, Codex and Hermes remember, to be worked into memory by the next memory run. */
export async function importKnowledge() {
  const report = await knowledgeImport();
  if (report.some((r) => r.notes > 0)) store().setKnowledge({ imported: true });
  return report;
}

/** Writes Cube's memory and skills out to the agent programs found on this computer. */
export const exportKnowledge = () => knowledgeExport(["claude", "codex", "hermes"]);

/**
 * Runs one job now, in the background. Resolves when it has finished; what it did is added to
 * the list of runs in Settings.
 */
export async function runJob(job: JobKind): Promise<void> {
  const s = store();
  if (s.knowledgeBusy || !inTauri) return;
  const engine = knowledgeEngine();
  const started = Date.now();
  const record = (ok: boolean, summary: string) => store().addKnowledgeRun({ job, at: Date.now(), took: Math.round((Date.now() - started) / 1000), ok, summary });
  if (!engine) return record(false, "Pick the agent program and model for background work first.");

  store().setKnowledgeBusy({ job, since: started, activity: "Getting ready" });
  try {
    const before = await knowledgeList();
    // New conversation goes to the memory and skills jobs as a file in the inbox, each from where it last stopped.
    const cursor = job === "wiki" ? 0 : s.knowledge.cursor[job];
    const fresh = job === "wiki" ? { text: "", upTo: 0, count: 0 } : transcript(linesSince(cursor));
    const inbox = `inbox/${job}-${started}.md`;
    if (fresh.count) await writeText(`${before.dir}/${inbox}`, fresh.text);
    // The wiki also takes in what each agent program has: they are the team's sub-agents.
    if (job === "wiki") await writeText(`${before.dir}/${inbox}`, await stock());
    // Notes brought in from other programs are worked in one batch per run, so no run has too much to read.
    const batch = job === "memory" ? before.batches[0] : undefined;
    if (job === "memory" && !fresh.count && !batch && !before.inbox.length) {
      if (s.knowledge.imported) store().setKnowledge({ imported: false });
      return record(true, "Nothing new to read.");
    }

    const run = runHeadless({
      engine,
      model: s.knowledge.model,
      cwd: before.dir,
      prompt: jobPrompt(job, { dir: before.dir, person: s.name || "the person", today: new Date().toISOString().slice(0, 10), batch, language: s.settings.lang === "ko" ? "Korean" : "English" }),
      onActivity: (activity) => store().setKnowledgeBusy({ job, since: started, activity }),
    });
    stopCurrent = run.stop;
    const result = await run.done;
    stopCurrent = undefined;

    // Whatever the job read is gone from the inbox, and what it marked for removal is removed.
    const after = await knowledgeList();
    // A job that did not end with its counts did not do the work: what it was given stays for the next try.
    const done = !result.error && finished(result.text);
    const read = done ? after.inbox.filter((f) => f.startsWith(`inbox/${job}-`)) : after.inbox.filter((f) => f === inbox);
    const worked = done && batch ? [batch] : [];
    if (read.length || after.marked.length || worked.length) await knowledgeRemove([...read, ...after.marked, ...worked]).catch(() => undefined);

    if (result.error) return record(false, result.error);
    const summary = summaryOf(result.text);
    if (!done) return record(false, `It stopped without doing the work. ${summary}`);
    const changed = !/^0 added, 0 updated, 0 removed\./.test(summary);
    const k = store().knowledge;
    store().setKnowledge({
      last: { ...k.last, [job]: Date.now() },
      ...(job !== "wiki" && fresh.count ? { cursor: { ...k.cursor, [job]: fresh.upTo } } : {}),
      ...(job === "memory" ? { imported: after.batches.length > worked.length, ...(changed ? { memoryChangedAt: Date.now() } : {}) } : {}),
    });
    record(true, summary);
  } catch (e) {
    record(false, String(e));
  } finally {
    stopCurrent = undefined;
    store().setKnowledgeBusy(undefined);
    void listKnowledge().catch(() => undefined);
  }
}

/** Stops the job that is running. */
export function stopJob(): void {
  stopCurrent?.();
}

/**
 * Called now and then: when Cube is set to keep its knowledge up by itself, starts the job that
 * is due. Never while an agent is working for the person, and one job at a time.
 */
export function knowledgeTick(agentsBusy: boolean): void {
  const s = store();
  const k = s.knowledge;
  if (!inTauri || !k.auto || s.knowledgeBusy || agentsBusy || !knowledgeEngine()) return;
  const memory = linesSince(k.cursor.memory);
  const skills = linesSince(k.cursor.skills);
  const newest = s.messages.reduce((n, m) => Math.max(n, m.ts), 0);
  const job = dueJob({ now: Date.now(), last: k.last, unread: { memory: memory.length, skills: skills.length }, newest, imported: k.imported, memoryChangedAt: k.memoryChangedAt });
  if (job) void runJob(job);
}
