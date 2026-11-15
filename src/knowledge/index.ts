import { HEADLESS, runHeadless, type HeadlessEngine } from "@/agents/headless";
import { splitNotes } from "@/agents/notes";
import { channelMemoryInbox, channelMemoryList, channelMemoryTidy, teamMemoryInbox, teamMemoryList, teamMemoryTidy, getHarness, inTauri, knowledgeExport, knowledgeImport, knowledgeList, knowledgeRemove, libraryProgram, writeText, type KnowledgeListing } from "@/agents/runner";
import { inventory } from "@/lib/library";
import { subagentMd, type SubAgent } from "@/agents/subagents";
import { ROUTER, authorName } from "@/agents/types";
import { maskSecrets } from "@/lib/secrets";
import { useCube, type Conv } from "@/state/store";
import { dreamerOf, keepsOwnMemory, othersRead, saidHere } from "./scope";
import { AGENTS } from "@/agents/types";
import { nextRun, repeatOf } from "@/lib/schedule";
import { labelOf } from "@/state/store";
import { cubeMd, noteBody, workspaceFacts } from "./cubemd";
import { channelJobPrompt, dreamPrompt, dueJob, finished, type DreamScope, jobPrompt, suggestionsOf, summaryOf, transcript, type JobKind, type Line } from "./jobs";
import { libraryRead, readText } from "@/agents/runner";

export * from "./jobs";
export * from "./cubemd";
export * from "./scope";

const store = () => useCube.getState();
let stopCurrent: (() => void) | undefined;

/**
 * The programs Cube picks from by itself for background work, in order. Hermes cannot be kept out
 * of the person's own memory when it works on a channel's (see src-tauri/src/fence.rs), and the
 * built-in agent needs a key the person chose to spend; so neither is picked unasked.
 */
const AUTO_ENGINES = ["claude", "codex"] as const;

/** The engine background work runs on: the person's choice, or else the first suitable program installed. */
export function knowledgeEngine(): HeadlessEngine | undefined {
  const s = store();
  const picked = s.knowledge.engine;
  if (picked && HEADLESS.includes(picked) && s.available[picked]) return picked;
  return AUTO_ENGINES.find((e) => s.available[e]);
}

/** Whether Cube picked the engine itself, because the person has not. */
export const engineIsAuto = () => !store().knowledge.engine || !store().available[store().knowledge.engine as HeadlessEngine];

/** The model and effort background work asks for: the person's, or a small, quick one when Cube picked the program. */
export function knowledgeModel(): { model?: string; effort?: string } {
  const s = store();
  if (!engineIsAuto()) return { model: s.knowledge.model || undefined };
  return knowledgeEngine() === "claude" ? { model: "haiku" } : { effort: "low" };
}

/** The person's own conversations: what is said there goes to their personal memory. */
const personal = (c: Conv) => !keepsOwnMemory(c);

/**
 * Conversation lines written after `after`, as the jobs read them: what people and agents said,
 * credentials hidden. By default only the person's own conversations, whose words go to their
 * personal memory; `where` picks others, such as one channel for that channel's memory.
 */
export function linesSince(after: number, where: (c: Conv) => boolean = personal): Line[] {
  const s = store();
  const convs = new Map(s.convs.map((c) => [c.id, c]));
  const lines: Line[] = [];
  for (const m of s.messages) {
    const conv = convs.get(m.convId);
    // The Router's one-line handovers and side answers are not what was said in the conversation.
    if (!conv || !where(conv) || m.ts <= after || m.streaming || m.aside || m.author === ROUTER) continue;
    const text = splitNotes(m.text).text.trim();
    if (!text) continue;
    lines.push({
      convId: conv.id,
      where: conv.kind === "dm" ? `Direct message with ${conv.name}` : conv.chat ? `Chat "${conv.name}"` : `#${conv.name}`,
      who: m.author === "you" ? s.name || "The person" : authorName(m.author),
      text: maskSecrets(text.length > 6000 ? `${text.slice(0, 6000)}\n[…cut]` : text),
      ts: m.ts,
      ...(keepsOwnMemory(conv) ? { mine: saidHere(m) } : {}),
    });
  }
  return lines;
}

/** What each agent program found on this computer has: its skills, MCP servers and plugins. */
export async function programStock(): Promise<Parameters<typeof inventory>[0]> {
  const programs: Parameters<typeof inventory>[0] = {};
  for (const p of ["claude", "codex", "hermes"] as const) {
    if (!store().available[p]) continue;
    const [lib, harness] = await Promise.all([libraryProgram(p), getHarness(p)]).catch(() => [undefined, undefined] as const);
    if (lib && harness) programs[p] = { skills: lib.skills, mcp: harness.mcp, plugins: harness.plugins };
  }
  return programs;
}

const today = () => new Date().toISOString().slice(0, 10);
const PROGRAM_NAME = { claude: "Claude Code", codex: "Codex", hermes: "Hermes" } as const;

/** The same, written out for the wiki job. */
async function stock(): Promise<string> {
  return inventory(await programStock(), today());
}

/** Who is in the workspace, as the app itself knows it: for the wiki job, which keeps ontology.md, and for CUBE.md. */
function who() {
  const s = store();
  const me = s.team.info?.pubkey;
  return {
    person: s.name || "The person",
    teammates: s.team.members.filter((m) => m.pubkey !== me).map((m) => m.name).filter(Boolean),
    cubes: AGENTS.map((a) => ({ name: a.name, about: a.custom ? `${a.role}. Made here; its definition is in agents/${a.name}.md` : a.role })),
  };
}

/** What Cube knows about the workspace, for the wiki job to work into ontology.md. */
function facts(): string {
  const s = store();
  const now = new Date();
  const convs = new Map(s.convs.map((c) => [c.id, c]));
  return workspaceFacts({
    today: today(),
    ...who(),
    channels: s.convs.filter((c) => c.kind === "channel" && !c.person && !c.chat).map((c) => ({ name: c.name, shared: Boolean(c.shared), cubes: c.members.map((id) => AGENTS.find((a) => a.id === id)?.name ?? id) })),
    chats: s.convs.filter((c) => c.chat).sort((a, b) => b.createdAt - a.createdAt).map((c) => c.name),
    schedules: s.schedules.filter((x) => x.on).map((x) => ({ text: maskSecrets(x.text), when: `${repeatOf(x)} at ${x.time} (next: ${nextRun(x, now)})`, where: convs.has(x.convId) ? labelOf(convs.get(x.convId)!) : "a conversation that is gone" })),
  });
}

/**
 * Keeps a sub-agent's definition as a file in the knowledge folder (agents/<Name>.md), and takes
 * away the file of the name it had before. Nothing reads it back: the app's copy is what runs.
 */
export async function writeSubagentMd(sub: SubAgent, before?: string): Promise<void> {
  if (!inTauri) return;
  try {
    const { dir } = await knowledgeList();
    if (before && before !== sub.name) await knowledgeRemove([`agents/${before}.md`]);
    await writeText(`${dir}/agents/${sub.name}.md`, maskSecrets(subagentMd(sub)));
  } catch {
    // The file is a convenience. A sub-agent works without it.
  }
}

/** Takes away the file of a sub-agent that was deleted. */
export async function dropSubagentMd(name: string): Promise<void> {
  if (!inTauri) return;
  await knowledgeRemove([`agents/${name}.md`]).catch(() => undefined);
}

/**
 * Writes CUBE.md, the file a cube starts from, from what is on this computer right now. Called
 * when the app opens and after every background job: those are the moments what it lists changes.
 */
export async function writeCubeMd(): Promise<void> {
  if (!inTauri) return;
  try {
    const [listing, programs] = await Promise.all([knowledgeList(), programStock()]);
    const newest = [...listing.memory].sort((a, b) => b.mtime - a.mtime);
    const recent = (await Promise.all(newest.slice(0, 5).map((n) => libraryRead(n.path).then((text) => ({ name: n.name, text: maskSecrets(noteBody(text)) })).catch(() => null)))).filter((n): n is { name: string; text: string } => Boolean(n?.text));
    const ontology = await libraryRead(`${listing.dir}/ontology.md`).then((t) => t.trim().length > 0).catch(() => false);
    const item = (e: { name: string; description: string }) => ({ name: e.name, about: e.description });
    const s = store();
    const text = cubeMd({
      today: today(),
      dir: listing.dir,
      ...who(),
      conversations: s.convs.filter((c) => c.kind === "channel").map(labelOf),
      programs: (["claude", "codex", "hermes"] as const).filter((p) => programs[p]).map((p) => ({ name: PROGRAM_NAME[p], mcp: programs[p]!.mcp, skills: programs[p]!.skills, plugins: programs[p]!.plugins })),
      skills: listing.skills.map(item),
      memory: newest.map(item),
      recent,
      wiki: listing.wiki.map(item),
      ontology,
    });
    await writeText(`${listing.dir}/CUBE.md`, text);
    store().setCubeMdAt(Date.now());
  } catch (e) {
    console.error(e);
  }
}

/** What holds across the team, as kept on this Mac: read again so cubes are told of it once it has notes. */
export async function refreshTeamMemory(): Promise<void> {
  if (!inTauri) return;
  const team = await teamMemoryList();
  const now = store().teamMemory;
  if (now?.dir !== team.dir || now.count !== team.notes.length) store().setTeamMemory({ dir: team.dir, count: team.notes.length });
}

/** What is in the knowledge folder right now. */
export async function listKnowledge(): Promise<KnowledgeListing | null> {
  if (!inTauri) return null;
  void refreshTeamMemory().catch(() => undefined);
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

/** Channels that keep a memory of their own and have a folder for it. */
const channels = () => store().convs.filter((c) => keepsOwnMemory(c) && c.dir && !c.workspace);

/** A channel's lines its memory has not taken in yet. */
const channelLines = (c: Conv) => linesSince(store().knowledge.channels?.[c.id] ?? 0, (x) => x.id === c.id);

/** How many lines of this person's side, across the channels, are waiting for the memory job. */
function channelsUnread(): number {
  return channels().reduce((n, c) => n + channelLines(c).filter((l) => l.mine !== false).length, 0);
}

/**
 * Keeps up the memory of each channel with something new from this person's side, one after
 * another: in the channel's own memory folder, from the channel's lines only, and kept by macOS
 * out of the person's own memory and every other conversation, since the folder goes to everyone
 * in the channel.
 */
async function keepChannels(engine: HeadlessEngine): Promise<void> {
  for (const conv of channels()) {
    const s = store();
    if (s.knowledgeBusy) return;
    const lines = channelLines(conv);
    if (!lines.length) continue;
    const setCursor = (upTo: number) => store().setKnowledge({ channels: { ...store().knowledge.channels, [conv.id]: upTo } });
    // Only teammates spoke: their own Cubes keep what they said.
    if (!lines.some((l) => l.mine !== false)) {
      setCursor(Math.max(...lines.map((l) => l.ts)));
      continue;
    }
    const started = Date.now();
    const place = labelOf(conv);
    const record = (ok: boolean, summary: string) => store().addKnowledgeRun({ job: "memory", at: Date.now(), took: Math.round((Date.now() - started) / 1000), ok, summary: `${place}: ${summary}` });
    store().setKnowledgeBusy({ job: "memory", since: started, activity: `Keeping ${place}'s memory` });
    let inbox: string | undefined;
    try {
      const fresh = transcript(lines);
      const [dir, rel] = await channelMemoryInbox(conv.dir, fresh.text);
      inbox = rel;
      const run = runHeadless({
        engine,
        ...knowledgeModel(),
        cwd: dir,
        prompt: channelJobPrompt({ dir, place, person: s.name || "the person", today: today(), shared: othersRead(conv), language: s.settings.lang === "ko" ? "Korean" : "English" }),
        fence: { dirs: [conv.dir], write: true },
        onActivity: (activity) => store().setKnowledgeBusy({ job: "memory", since: started, activity }),
      });
      stopCurrent = run.stop;
      const result = await run.done;
      stopCurrent = undefined;
      if (result.error) {
        record(false, result.error);
        continue;
      }
      if (!finished(result.text)) {
        record(false, `It stopped without doing the work. ${summaryOf(result.text)}`);
        continue;
      }
      setCursor(fresh.upTo);
      record(true, summaryOf(result.text));
    } catch (e) {
      record(false, String(e));
    } finally {
      stopCurrent = undefined;
      // What it was given goes either way: what it did not take in is given again from the cursor.
      await channelMemoryTidy(conv.dir, inbox).catch(() => undefined);
      store().setKnowledgeBusy(undefined);
    }
  }
}

/**
 * Runs one job now, in the background. Resolves when it has finished; what it did is added to
 * the list of runs in Settings. The memory job keeps up the person's own memory, then each
 * channel's.
 */
export async function runJob(job: JobKind): Promise<void> {
  if (store().knowledgeBusy || !inTauri) return;
  if (job === "dream") return dream();
  await runPersonal(job);
  const engine = knowledgeEngine();
  if (job === "memory" && engine) {
    await keepChannels(engine);
    // Whatever came of it, the memory job does not start again at once for what is left.
    store().setKnowledge({ last: { ...store().knowledge.last, memory: Date.now() } });
  }
}

/** One headless run in a memory folder, shown as busy while it works. Says how it went. */
async function runIn(o: { label: string; dir: string; prompt: string; fence?: { dirs: string[]; write: boolean; team?: boolean } }): Promise<{ ok: boolean; summary: string; changed: boolean }> {
  const engine = knowledgeEngine();
  if (!engine) return { ok: false, summary: "No agent program is installed for background work.", changed: false };
  const started = Date.now();
  store().setKnowledgeBusy({ job: "dream", since: started, activity: o.label });
  try {
    const run = runHeadless({ engine, ...knowledgeModel(), cwd: o.dir, prompt: o.prompt, fence: o.fence, onActivity: (activity) => store().setKnowledgeBusy({ job: "dream", since: started, activity }) });
    stopCurrent = run.stop;
    const result = await run.done;
    if (result.error) return { ok: false, summary: result.error, changed: false };
    const summary = summaryOf(result.text);
    if (!finished(result.text)) return { ok: false, summary: `It stopped without doing the work. ${summary}`, changed: false };
    return { ok: true, summary, changed: !/^0 added, 0 updated, 0 removed\./.test(summary) };
  } catch (e) {
    return { ok: false, summary: String(e), changed: false };
  } finally {
    stopCurrent = undefined;
    store().setKnowledgeBusy(undefined);
  }
}

/** The newest note's time in a list of notes; 0 for none. */
const newestOf = (notes: { mtime: number }[]) => notes.reduce((n, e) => Math.max(n, e.mtime), 0);

/** Who can be the one to dream over a channel's memory today: its members, or the whole team for a public one. */
function dreamersOf(conv: Conv): string[] {
  const s = store();
  const me = s.team.info?.pubkey ?? "";
  if (!conv.shared) return [me];
  const listed = conv.shared.private || conv.person ? s.teamLive.convMembers?.[conv.shared.id] : undefined;
  return listed?.length ? listed : [me, ...s.team.members.map((m) => m.pubkey)].filter(Boolean);
}

/**
 * Dreaming: while Cube is idle, a reflective pass over each memory that changed since the last
 * one. The person's own; each channel's (a shared channel's by one member's Cube a day); and the
 * team's, gathered from what the team's public channels remember. Each run sees only its own
 * memory: a channel's and the team's are kept by macOS out of everything else.
 */
async function dream(): Promise<void> {
  const s = store();
  if (!knowledgeEngine()) return;
  const day = today();
  const base = { person: s.name || "the person", today: day, language: s.settings.lang === "ko" ? "Korean" : "English" };
  const mark = (key: string) => store().setKnowledge({ dreamed: { ...store().knowledge.dreamed, [key]: Date.now() } });
  const record = (started: number, place: string, r: { ok: boolean; summary: string }) => store().addKnowledgeRun({ job: "dream", at: Date.now(), took: Math.round((Date.now() - started) / 1000), ok: r.ok, summary: `${place}: ${r.summary}` });
  const go = async (key: string, place: string, newest: number, dir: string, scope: DreamScope, fence?: { dirs: string[]; write: boolean; team?: boolean }) => {
    if (!newest || newest <= (store().knowledge.dreamed?.[key] ?? 0)) return false;
    const started = Date.now();
    const r = await runIn({ label: `Dreaming over ${place}`, dir, prompt: dreamPrompt(scope, { dir, ...base }), fence });
    record(started, place, r);
    if (r.ok) mark(key);
    return r.ok && r.changed;
  };

  // The person's own.
  const listing = await knowledgeList();
  if (await go("personal", "Your memory", newestOf(listing.memory), listing.dir, { kind: "personal" })) {
    const after = await knowledgeList();
    if (after.marked.length) await knowledgeRemove(after.marked).catch(() => undefined);
    store().setKnowledge({ memoryChangedAt: Date.now() });
  }

  // Each channel's, where this Cube is today's one to do it.
  const me = s.team.info?.pubkey ?? "";
  for (const conv of channels()) {
    if (conv.shared && dreamerOf(dreamersOf(conv), conv.id, day) !== me) continue;
    const mem = await channelMemoryList(conv.dir).catch(() => null);
    if (!mem) continue;
    await go(conv.id, labelOf(conv), newestOf(mem.notes), mem.dir, { kind: "channel", place: labelOf(conv), shared: othersRead(conv) }, { dirs: [conv.dir], write: true });
    await channelMemoryTidy(conv.dir).catch(() => undefined);
  }

  // The team's: only public channels, which everyone in the team reads. A private channel or a direct conversation never goes in.
  const open = channels().filter((c) => c.shared && !c.shared.private && !c.person);
  const sources = (await Promise.all(open.map(async (c) => ({ c, mem: await channelMemoryList(c.dir).catch(() => null) })))).filter((x) => x.mem?.notes.length);
  const newest = newestOf(sources.flatMap((x) => x.mem!.notes));
  if (newest > (store().knowledge.dreamed?.team ?? 0)) {
    const parts = await Promise.all(sources.map(async ({ c, mem }) => {
      const notes = await Promise.all(mem!.notes.map(async (n) => `### ${n.rel}\n\n${maskSecrets(await readText(n.path).catch(() => ""))}`));
      return `## ${labelOf(c)}\n\n${notes.join("\n\n")}`;
    }));
    const [dir, inbox] = await teamMemoryInbox(`# What the team's public channels remember\n\n${parts.join("\n\n")}\n`);
    // The team's memory is the run's own folder: it reads only the inbox it was given.
    await go("team", "The team's memory", newest, dir, { kind: "team" }, { dirs: [dir], write: true });
    await teamMemoryTidy(inbox).catch(() => undefined);
    void refreshTeamMemory().catch(() => undefined);
  }
  store().setKnowledge({ last: { ...store().knowledge.last, dream: Date.now() } });
}

async function runPersonal(job: Exclude<JobKind, "dream">): Promise<void> {
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
    // And what Cube itself knows about the workspace, which is what ontology.md starts from.
    if (job === "wiki") await writeText(`${before.dir}/${inbox}`, `${await stock()}\n${facts()}`);
    // Notes brought in from other programs are worked in one batch per run, so no run has too much to read.
    const batch = job === "memory" ? before.batches[0] : undefined;
    if (job === "memory" && !fresh.count && !batch && !before.inbox.length) {
      if (s.knowledge.imported) store().setKnowledge({ imported: false });
      return record(true, "Nothing new to read.");
    }

    const run = runHeadless({
      engine,
      ...knowledgeModel(),
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
    // What the wiki job thinks is worth doing next is offered on Home.
    if (job === "wiki") store().addSuggestions(suggestionsOf(result.text));
    record(true, summary);
  } catch (e) {
    record(false, String(e));
  } finally {
    stopCurrent = undefined;
    store().setKnowledgeBusy(undefined);
    void listKnowledge().catch(() => undefined);
    void writeCubeMd();
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
  const memory = linesSince(k.cursor.memory).length + channelsUnread();
  const skills = linesSince(k.cursor.skills);
  const newest = s.messages.reduce((n, m) => Math.max(n, m.ts), 0);
  const job = dueJob({ now: Date.now(), last: k.last, channels: channels().length > 0, unread: { memory, skills: skills.length }, newest, imported: k.imported, memoryChangedAt: k.memoryChangedAt, wikiEvery: k.wikiEvery });
  if (job) void runJob(job);
}
