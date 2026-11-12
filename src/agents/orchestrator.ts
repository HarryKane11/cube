import { useCube, type Conv, type DiskFile, type Msg } from "../state/store";
import { isEditable, kindOf } from "../lib/files";
import { ADAPTERS } from "./adapters";
import { hasBuiltinSession, startBuiltin } from "./builtin";
import { startRemote } from "./remote";
import { knowledgeTick, listKnowledge } from "../knowledge";
import { fenced, startTeam } from "../team";
import { customAdapter, parseManifest, type Manifest } from "./custom";
import { startMock } from "./mock";
import { notesBlock, splitNotes, splitPlan, type Note } from "./notes";
import { notify } from "../lib/notify";
import { dayKey, due } from "../lib/schedule";
import { clashing } from "../lib/stats";
import { allowedBy, describeAsk, isEditTool, planOf, questionsOf, ruleFor } from "./permissions";
import { customAgents, keyList } from "./runner";
import { checkpointRestore, checkpointSave, detectEngines, endInput, ensureSpace, inTauri, listFiles, readText, startProcess, stopProcess, windowsList, writeProcess } from "./runner";
import { branchOf, closeTree, ensureRepo, prepareTree } from "./trees";
import { ORCH, ROLE_DEFAULTS, ROUTER, isLeadRole } from "./types";
import { AGENTS, ENGINE_CAN, agentById, authorName, pickEngine, route, trustFor, type AgentDef, type AgentKind, type Ev, type Mode, type RunOpts, type Trust } from "./types";

interface Run {
  convId: string;
  agentId: string;
  stop: () => void;
  /** Closes the run's message and frees the agent. Safe to call more than once. */
  finish: () => void;
  stoppedByPerson: boolean;
  /** The message this run is writing. */
  msgId: string;
  /** Permission requests nobody has answered yet: request id → what the agent asked to do. */
  pending: Map<string, { tool: string; input: unknown }>;
  /** Passes the person's answer to a permission request on to the agent. */
  answer: (id: string, allow: boolean, input: unknown) => void;
  /** A side question: it runs next to the agent's main work and may not change anything. */
  aside: boolean;
  /** Set once the person approved this run's plan: how much it may do from then on. */
  after?: Trust;
  /** The Orchestrator's plan this run is a part of. */
  job?: string;
}

/** Plans being carried out: how many times the Orchestrator was called back, and the message that holds the plan. */
const jobs = new Map<string, { rounds: number; plan: string }>();
/** A plan that keeps going round is stopped here, so a loop cannot run for ever. */
const MAX_ROUNDS = 12;

interface Dispatch {
  /** Nobody was named: Cube picked this agent. */
  auto?: boolean;
  aside?: boolean;
  job?: string;
  /** The Orchestrator is called back because the teammates it handed work to have finished. */
  wake?: boolean;
}

/** What a message can carry besides its text. */
export interface SendOpts {
  /** Paths, inside the conversation folder, of files sent along. */
  files?: string[];
  /** Ask without stopping the agents at work. The answer changes no files. */
  aside?: boolean;
  /** Sent by a schedule. */
  scheduled?: boolean;
}

const ASIDE_RULE = "This is a side question, asked while the work goes on. Answer it briefly from what you know and what you can read. Do not change any file and do not run commands.";
const PLAN_RULE = "Plan mode: do not change any file and do not run anything that changes something. Look into the request, then reply with a short step-by-step plan and stop. You will be told when to start.";

/** Browsers with their own window that agents drive from the command line, and the app each one shows up as. */
const WINDOWED: [RegExp, RegExp][] = [[/\baside\b/i, /^aside$/i], [/\bego[- ](browser|lite)\b/i, /^ego lite$/i]];

/**
 * When an agent starts using a browser that has its own window, the Screen tab begins following
 * that window, so the person sees the browsing as it happens. Quietly does nothing when the
 * window cannot be found.
 */
function followIfBrowsing(convId: string, said: string): void {
  // After the system refused once, every new try would put its permission prompt up again.
  if (!inTauri || store().follow[convId] || store().captureDenied) return;
  const hit = WINDOWED.find(([used]) => used.test(said));
  if (!hit) return;
  void windowsList()
    .then((wins) => {
      const win = wins.find((w) => hit[1].test(w.app));
      if (win && !store().follow[convId]) store().setFollow(convId, { id: win.id, app: win.app, icon: win.icon });
    })
    .catch(() => undefined);
}

/** Engines with a plan mode of their own, which hand the plan over for approval. The rest are asked in words to only plan. */
const CAN_PLAN: Record<AgentKind, boolean> = { claude: true, codex: false, hermes: false, api: false, custom: false, remote: false };

/** Reads the person's own agent descriptions again. Returns what is wrong with the ones that cannot be used. */
export async function loadCustoms(): Promise<string[]> {
  const problems: string[] = [];
  const found: Manifest[] = [];
  for (const [file, content] of await customAgents().catch(() => [] as [string, string][])) {
    let json: unknown = null;
    try { json = JSON.parse(content); } catch { /* reported below as not an object */ }
    const m = parseManifest(file, json);
    if ("error" in m) problems.push(m.error);
    else found.push(m);
  }
  store().setCustoms(found);
  store().setAvailable({ ...store().available, custom: found.length > 0 });
  return problems;
}

/**
 * Whether a step may go ahead without a card, for a run whose trust changed while it was working
 * (its plan was approved, or the person switched the conversation's mode). Questions always reach
 * the person. In Auto, file changes and simple commands pass; open-ended commands still ask.
 */
function passes(trust: Trust, tool: string, input: unknown): boolean {
  if (questionsOf(tool, input) || trust === "ask" || trust === "plan") return false;
  if (trust === "free") return true;
  if (isEditTool(tool)) return true;
  return trust === "auto" && (tool !== "Bash" || Boolean(ruleFor(tool, input)));
}

/**
 * The person changed a conversation's mode. New turns start in it anyway; this makes the cubes
 * already at work follow it too, from their next step on, and answers what they were waiting on.
 */
export function modeChanged(convId: string): void {
  const st = store();
  const mode = st.modes[convId] ?? st.settings.mode;
  // A cube that is already working cannot be turned back into one that only plans.
  if (mode === "plan") return;
  for (const run of [...active.values()]) {
    if (run.convId !== convId || run.aside || isLeadRole(run.agentId)) continue;
    run.after = mode === "manual" ? undefined : sharedCap(run.convId, trustFor(mode, st.trust[run.agentId]));
    if (!run.after) continue;
    for (const [askId, asked] of [...run.pending]) {
      if (planOf(asked.tool, asked.input) === null && passes(run.after, asked.tool, asked.input)) answerAsk(run.msgId, askId, "once");
    }
  }
}

/** The mode a conversation returns to when a plan is approved. */
function modeAfterPlan(convId: string): Mode {
  const s = store();
  const back = s.planFrom[convId] ?? s.settings.mode;
  return back === "plan" ? "manual" : back;
}

const active = new Map<string, Run>();
/** Run id → the files that run has changed so far. */
const touched = new Map<string, string[]>();
/** Absolute path → the agent that said it wrote the file. */
const fileAuthors = new Map<string, string>();
let poll = 0;

const uid = () => crypto.randomUUID();
const store = () => useCube.getState();
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const convById = (id: string) => store().convs.find((c) => c.id === id);

/** The engine that powers a role right now: the person's choice, or the best installed one. */
export function engineOf(agent: AgentDef): AgentKind {
  const s = store();
  return s.engines[agent.id] ?? pickEngine(agent, s.available);
}

/** How a role's engine should be started: the model and effort picked for it, and whether it runs plain. */
export function runOpts(agent: AgentDef, engine: AgentKind, convId: string): RunOpts {
  const s = store();
  const picked = s.models[`${agent.id}:${engine}`] ?? {};
  const base = ROLE_DEFAULTS[agent.id]?.[engine] ?? {};
  return {
    model: picked.model?.trim() || base.model || undefined,
    effort: ENGINE_CAN[engine].effort ? picked.effort || base.effort || undefined : undefined,
    plain: ENGINE_CAN[engine].plain ? Boolean(s.plain[agent.id]) : false,
    // The Router and the Orchestrator only read and hand out: they never change anything, whatever the mode.
    trust: isLeadRole(agent.id) ? (engine === "claude" ? "ask" : "plan") : sharedCap(convId, trustFor(s.modes[convId] ?? s.settings.mode, s.trust[agent.id])),
  };
}

/**
 * In a channel shared with a team, what a cube reads was partly written by other people. However
 * the conversation's mode is set, a cube there asks before it runs anything.
 */
export function sharedCap(convId: string, trust: Trust): Trust {
  return convById(convId)?.shared && (trust === "auto" || trust === "free") ? "edits" : trust;
}

/** Agent ids mentioned as @Name, in order, without duplicates. */
export function mentions(text: string, except?: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/@([A-Za-z]+)/g)) {
    const agent = AGENTS.find((a) => a.name.toLowerCase() === m[1].toLowerCase());
    if (agent && agent.id !== except && !found.includes(agent.id)) found.push(agent.id);
  }
  return found;
}

/** What the Router is told: one line, naming who gets the request. */
function routerIntro(conv: Conv, person: string): string {
  const team = conv.members
    .filter((id) => !isLeadRole(id))
    .map((id) => agentById(id))
    .filter((a): a is AgentDef => Boolean(a))
    .map((a) => `- @${a.name}: ${a.brief}`)
    .join("\n");
  return [
    `You are the Router of a team of AI agents in the Cube app, in the #${conv.name} channel. ${person} (shown as "You") wrote a message without naming anyone. Your only job is to decide who gets it. You never do the work, answer the question, change files or run commands.`,
    `The team:\n${team || "- none"}\n- @Orchestrator: leads the team through jobs that need several teammates or several steps in a row.`,
    "Reply with exactly one line and nothing else:",
    "- If one teammate can do it alone, even in several steps of their own: `@Name` followed by the request, restated so they have everything they need.",
    "- If it needs two or more teammates, or work that has to be checked, repeated or built on by someone else: `@Orchestrator` followed by the request, restated the same way.",
    `- Keep the request in the language ${person} wrote it in. Do not add tasks they did not ask for.`,
  ].join("\n");
}

/** What the Orchestrator is told about its job: plan the work and run the plan round by round. */
function leadIntro(conv: Conv, person: string): string {
  const team = conv.members
    .filter((id) => !isLeadRole(id))
    .map((id) => agentById(id))
    .filter((a): a is AgentDef => Boolean(a))
    .map((a) => `- @${a.name}: ${a.brief}`)
    .join("\n");
  return [
    `You are the Orchestrator of a team of AI agents in the Cube app, in the #${conv.name} channel. ${person} (shown as "You") says what is needed. You do not do the work yourself and you never change files or run commands: you decide which teammate does what, in what order, and you report back.`,
    `Your team:\n${team || "- none"}`,
    "How to work here:",
    "- To hand work to a teammate, write @Name followed by exactly what they should do and everything they need to know. A teammate you name starts when your message ends. Teammates named in the same message work at the same time.",
    "- If one teammate can simply do it, hand it straight over in one short message and write nothing else. No plan.",
    "- If it takes several steps, write the plan first, then hand out its first step in the same message. Write the plan exactly like this, one step per line:\nPLAN\n1. @Name: what they do\n2. @Name + @Name: what they do at the same time\n3. @Name: check the result. Repeat steps 2-3 until it passes, at most 3 times",
    "- Names inside the plan start nobody. Only what you write after the plan does.",
    "- When the teammates you named have finished you are called again and see what they wrote. Start that message with a line `STEP: <number>` naming the plan step you now hand out, then the hand-offs. To repeat a step, hand it out again and say what must change this time.",
    `- When everything is done, or it cannot be done, write a short final answer for ${person} with no @names in it: what was made and where it is.`,
    `- If you need a decision from ${person} before going on, ask one clear question with no @names in it and stop.`,
    `- Write in the language ${person} writes in.`,
  ].join("\n");
}

function intro(agent: AgentDef, conv: Conv): string {
  const person = store().name || "the person";
  if (agent.id === ROUTER && conv.kind === "channel") return routerIntro(conv, person);
  if (agent.id === ORCH && conv.kind === "channel") return leadIntro(conv, person);
  // An agent somewhere else gets what it needs to answer and nothing about this computer.
  if (engineOf(agent) === "remote") {
    return [
      `You are taking part in a conversation in Cube, a workspace where a person and several AI agents work together. Here you have the role of ${agent.name}. ${agent.brief}`,
      `The person is ${person} and appears as "You"; the other agents appear by name. You are reached over the network: you cannot see their files or screen, and they see only what you write back.`,
      "Reply to the latest message. Keep it short and plain. If you need a decision or more information, ask one clear question and stop.",
    ].join("\n");
  }
  const rules = [
    "- The current folder is this conversation's shared folder. Files you create or edit there appear on a shared Stage that everyone sees. Put real deliverables in files (markdown, HTML, CSV, images, code) instead of pasting long content into chat.",
    "- Keep chat replies short and plain: what you did and what you need.",
    "- If you need a decision from the person, ask one clear question and stop.",
    "- When you make a choice the person did not specify and might have wanted otherwise (an assumption, a scope cut, picking one tool or approach over another), end your reply with one line per choice that starts with `DECIDED:` and says what you chose and why in one sentence. They look these over later. Skip trivial choices.",
    "- When the person corrects you or tells you how they want things done from now on, end your reply with one line that starts with `NOTE:` and states the lesson in one plain sentence. They review it, and if they keep it you will be reminded of it in every later conversation. Use it rarely: lasting preferences and facts only, never something that matters just for this task.",
  ];
  const known = store();
  if (known.knowledgeDir && known.knowledgeCount > 0) {
    rules.push(`- What this workspace has learned about ${person} and their work is kept as files in ${known.knowledgeDir}: memory/MEMORY.md lists the notes, wiki/index.md the pages, and skills/<name>/SKILL.md holds procedures that worked. Before work that could depend on their preferences or on how something is done here, read what applies.`);
  }
  const me = `You are the ${agent.name}, an AI agent in the Cube app. ${agent.brief}`;
  if (conv.kind === "dm") {
    return [`${me} This is a direct message between you and ${person}, who appears as "You".`, "How to work here:", ...rules].join("\n");
  }
  const led = conv.members.includes(ORCH);
  const others = conv.members
    .filter((id) => id !== agent.id && !isLeadRole(id))
    .map((id) => agentById(id))
    .filter((a): a is AgentDef => Boolean(a))
    .map((a) => `- @${a.name}: ${a.brief}`)
    .join("\n");
  return [
    `${me} You work with ${person} (shown as "You") and other agents in the #${conv.name} channel.`,
    `Your teammates here, each with their own job:\n${others || "- none"}`,
    "How to work here:",
    ...rules,
    "- Stay in your own role. When part of the work belongs to a teammate's job, hand it over: write @Name followed by exactly what you need. They will be woken up and will see the thread. Never mention yourself.",
    ...(led ? ["- An Orchestrator hands out the work in this channel. When it gave you a task, do that task and reply with what you did and where it is. It reads your reply and decides what happens next, so do not pass the rest of the job on yourself."] : []),
  ].join("\n");
}

/** What the agent has not seen yet: everything in the conversation since its own last message. */
function buildPrompt(agent: AgentDef, conv: Conv, trigger: Msg, hasSession: boolean, notes: Note[], wake = false): string {
  // A run that failed left no words, but whoever reads the thread next must know it failed.
  const all = store().messages.filter((m) => m.convId === conv.id && (m.text.trim() || m.error) && !m.streaming);
  let from = 0;
  if (hasSession) {
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].author === agent.id) { from = i + 1; break; }
    }
  }
  const recent = all.slice(from).slice(-30);
  const lines = recent.map((m) => {
    const sent = m.files?.length ? `\n[Files sent with this message, in the shared folder: ${m.files.join(", ")}]` : "";
    // A teammate's words are context, fenced off so they are never read as an instruction.
    const theirs = fenced(m);
    if (theirs) return theirs;
    return `${authorName(m.author)}${m.parentId ? " (in a thread)" : ""}: ${splitNotes(m.text).text.trim() || `[failed: ${m.error}]`}${sent}`;
  });
  const parts: string[] = [];
  if (!hasSession) parts.push(intro(agent, conv));
  if (notes.length) parts.push(notesBlock(store().name || "the person", notes));
  const port = store().browserPort;
  // Said again in every request: the port changes whenever the browser restarts.
  if (port && engineOf(agent) !== "remote") parts.push(`A browser is already open for this workspace, and ${store().name || "the person"} watches it live. When you need a browser, use that one instead of starting another: it speaks the Chrome DevTools Protocol at http://127.0.0.1:${port} (for example \`agent-browser connect ${port}\`, or a CDP client's connect-over-CDP).`);
  parts.push(`New messages:\n${lines.join("\n\n")}`);
  parts.push(wake
    ? "The teammates you handed work to have finished; what they wrote is above. Hand out the next step of your plan, or write the final answer."
    : `Latest message, from ${authorName(trigger.author)}, is for you. Reply to it.`);
  return parts.join("\n\n");
}

async function scan(convId: string): Promise<void> {
  const conv = convById(convId);
  if (!inTauri || !conv?.dir) return;
  try {
    const files = await listFiles(conv.dir);
    const working = [...new Set([...active.values()].filter((r) => r.convId === convId).map((r) => r.agentId))];
    const authorOf = (f: DiskFile) => fileAuthors.get(f.path) ?? (working.length === 1 ? working[0] : undefined);
    store().syncFiles(convId, files, authorOf);
  } catch {
    // The folder may not exist yet; the next scan will pick it up.
  }
}

/** Looks at the conversation's folder again, e.g. after the person saved a file from the Stage. */
export const rescan = scan;

/**
 * Remembers how the conversation's files look right now, so the Stage can show what agents
 * changed since the person last spoke. Text files small enough are kept whole, for diffs.
 */
async function snapshot(convId: string): Promise<void> {
  await scan(convId);
  const files = store().files[convId] ?? [];
  let kept = 0;
  const entries = await Promise.all(
    files.map(async (f): Promise<[string, { mtime: number; text?: string }]> => {
      const keep = isEditable(f.kind) && f.size <= 300_000 && kept++ < 200;
      const text = !keep ? undefined : (f.content ?? (inTauri ? await readText(f.path).catch(() => undefined) : undefined));
      return [f.rel, { mtime: f.mtime, text }];
    }),
  );
  store().setBaseline(convId, { at: Date.now(), files: Object.fromEntries(entries) });
}

function updatePolling(): void {
  if (active.size > 0 && !poll) {
    poll = window.setInterval(() => {
      for (const id of new Set([...active.values()].map((r) => r.convId))) void scan(id);
    }, 1200);
  }
  if (active.size === 0 && poll) {
    window.clearInterval(poll);
    poll = 0;
  }
}

async function prepare(conv: Conv): Promise<void> {
  if (!inTauri) return store().setConvDir(conv.id, `/preview/${conv.id}`);
  try {
    store().setConvDir(conv.id, await ensureSpace(conv.id));
    await scan(conv.id);
  } catch (e) {
    console.error(e);
  }
}

/** Finds which engines are installed. In the browser preview every engine counts as present. */
export async function refreshEngines(): Promise<void> {
  if (!inTauri) return store().setAvailable({ claude: true, codex: true, hermes: true });
  try {
    const [found, keys] = await Promise.all([detectEngines(), keyList().catch(() => [] as string[])]);
    // The built-in agent is there as soon as a model key is saved.
    store().setAvailable({ claude: found.includes("claude"), codex: found.includes("codex"), hermes: found.includes("hermes"), api: keys.length > 0, custom: store().customs.length > 0, remote: store().remotes.length > 0 });
    await loadCustoms();
  } catch (e) {
    console.error(e);
  }
}

export async function init(): Promise<void> {
  await refreshEngines();
  await Promise.all(store().convs.map(prepare));
  runSchedules();
  window.setInterval(runSchedules, 20_000);
  // Memory, skills and the wiki are kept up in the background, never while a cube is working for the person.
  void listKnowledge().catch(() => undefined);
  void startTeam().catch(() => undefined);
  window.setInterval(() => knowledgeTick(active.size > 0), 60_000);
  // What happens after the person leaves is what they missed.
  window.addEventListener("blur", () => store().setSeen(Date.now()));
}

/** Sends the scheduled messages whose time has come. Runs only while Cube is open. */
function runSchedules(): void {
  const now = new Date();
  for (const s of due(store().schedules, now)) {
    if (!convById(s.convId)) continue;
    store().saveSchedule({ ...s, last: dayKey(now), on: s.once ? false : s.on });
    send(s.convId, s.text, undefined, { scheduled: true });
  }
}

/** Stops one agent's work in a conversation and leaves the others going. */
export function stopAgent(convId: string, agentId: string): void {
  for (const run of [...active.values()].filter((r) => r.convId === convId && r.agentId === agentId)) {
    run.stoppedByPerson = true;
    run.stop();
    run.finish();
  }
}

/** Makes a new channel with its own folder and switches to it. Returns an error message, or null. */
export async function createChannel(name: string, members: string[]): Promise<string | null> {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return "Use letters or digits in the name.";
  if (store().convs.some((c) => c.id === slug)) return "A channel with that name already exists.";
  if (!members.length) return "Pick at least one agent.";
  const conv: Conv = { id: slug, kind: "channel", name: slug, members, dir: "", createdAt: Date.now() };
  store().addConv(conv);
  await prepare(conv);
  store().setActive(slug);
  return null;
}

function dispatch(conv: Conv, agentId: string, trigger: Msg, hops: number, rootId: string | undefined, how: Dispatch = {}): void {
  const { auto = false, aside = false } = how;
  const isLead = agentId === ORCH && conv.kind === "channel";
  const isRouter = agentId === ROUTER && conv.kind === "channel";
  const agent = agentById(agentId);
  if (!agent) return;
  // An agent already at work here will read the new messages on its next turn.
  if (!aside && [...active.values()].some((r) => r.agentId === agentId && r.convId === conv.id && !r.aside)) return;

  const s = store();
  const runId = uid();
  const msgId = uid();
  const engine = engineOf(agent);
  // A cube's session belongs to the folder it ran in, so its own copy has a session of its own.
  const key = `${conv.id}:${agentId}:${engine}${!aside && !isLead && !isRouter && inTauri && conv.kind === "channel" && s.trees[conv.id] ? ":copy" : ""}`;
  // A side question starts from scratch and leaves the agent's own session alone.
  // The built-in agent's memory does not outlive the app: after a restart it starts over.
  // The Router decides each request on its own, from the recent messages: it keeps no session either.
  const stateless = aside || isRouter;
  const session = stateless || (engine === "api" && !hasBuiltinSession(s.sessions[key])) ? undefined : s.sessions[key];
  const opts = runOpts(agent, engine, conv.id);
  if (aside) opts.trust = "ask";
  const planning = !aside && !isLead && !isRouter && opts.trust === "plan";
  // A side answer, the Router and the Orchestrator never stop to ask: whatever needs an OK is simply not done.
  const quiet = aside || isLead || isRouter;
  // Approved notes go out once per session: all of them at its start, later ones as they are kept.
  const kept = s.notes.filter((n) => n.agentId === agentId && n.state === "kept");
  const already = session ? (s.told[key] ?? []) : [];
  let prompt = buildPrompt(agent, conv, trigger, Boolean(session), kept.filter((n) => !already.includes(n.id)), how.wake);
  // In a channel set to separate copies, the cube works in its own worktree of the folder.
  const separate = !aside && !isLead && !isRouter && inTauri && conv.kind === "channel" && Boolean(s.trees[conv.id]);
  if (separate) prompt += `\n\nYou are working in your own copy of the shared folder, on the git branch ${branchOf(agentId)}. Other cubes have their own copies. Your changes reach the shared folder when ${s.name || "the person"} merges them, so say in your reply what you changed.`;
  if (aside) prompt += `\n\n${ASIDE_RULE}`;
  else if (planning && !CAN_PLAN[engine]) prompt += `\n\n${PLAN_RULE}`;
  if (!stateless) s.markTold(key, kept.map((n) => n.id));
  const startedAt = Date.now();
  s.addMsg({ id: msgId, convId: conv.id, author: agentId, text: "", ts: startedAt, parentId: rootId, streaming: true, acts: [], auto, aside: aside || undefined });
  // A side answer does not change what the cube is shown doing: its main work goes on.
  const setLive: typeof s.setLive = (id, patch) => { if (!aside) store().setLive(id, patch); };
  setLive(agentId, { status: "thinking", statement: `${agent.name} is reading the thread`, convId: conv.id });
  // Like a teammate dropping an "eyes" emoji on a request they picked up.
  s.react(trigger.id, "👀", agentId, true);

  let failed = false;
  const run: Run = { convId: conv.id, agentId, stop: () => undefined, finish: () => undefined, stoppedByPerson: false, msgId, pending: new Map(), answer: () => undefined, aside, job: how.job };

  const onEv = (ev: Ev) => {
    const st = store();
    if (ev.t === "session") {
      if (!stateless) st.setSession(key, ev.id);
    } else if (ev.t === "delta") {
      st.patchMsg(msgId, (m) => ({ text: m.text + ev.text }));
      setLive(agentId, { status: "working", statement: `${agent.name} is writing a reply`, convId: conv.id });
    } else if (ev.t === "activity") {
      st.patchMsg(msgId, (m) => ({ acts: [...(m.acts ?? []), { kind: ev.kind, label: ev.label }].slice(-40) }));
      setLive(agentId, { status: ev.kind === "think" ? "thinking" : "working", statement: `${agent.name} is ${lower(ev.label)}`, convId: conv.id });
      followIfBrowsing(conv.id, `${ev.label} ${ev.cmd ?? ""}`);
    } else if (ev.t === "file") {
      fileAuthors.set(ev.path, agentId);
      // Someone else at work on the same file, or the person's unsaved edits in it: say so at once.
      const others = Object.fromEntries([...active.entries()].filter(([, r]) => r.convId === conv.id && !r.aside).map(([id, r]) => [r.agentId, touched.get(id) ?? []]));
      const who = clashing(others, agentId, ev.path, st.dirty);
      touched.set(runId, [...new Set([...(touched.get(runId) ?? []), ev.path])]);
      if (who.length) st.addClash(conv.id, { id: uid(), rel: ev.path.startsWith(`${conv.dir}/`) ? ev.path.slice(conv.dir.length + 1) : ev.path, who: [agentId, ...who], ts: Date.now() });
    } else if (ev.t === "usage") {
      st.patchMsg(msgId, { usage: { in: ev.in, out: ev.out, cost: ev.cost } });
    } else if (ev.t === "ask") {
      // A side question never stops to ask: whatever needs an OK is simply not done.
      if (quiet) return run.answer(ev.id, false, ev.input);
      const what = describeAsk(ev.tool, ev.input);
      const plan = planOf(ev.tool, ev.input) ?? undefined;
      // Once its plan is approved, the run goes on as the conversation's own mode would let it.
      const cleared = plan === undefined && run.after !== undefined && passes(run.after, ev.tool, ev.input);
      if (cleared) return run.answer(ev.id, true, ev.input);
      // Codex asks before every file change. With edits allowed, changes inside the conversation folder go through.
      const inFolder = String((ev.input as { file_path?: unknown })?.file_path ?? "").split(", ").every((path) => path.startsWith(`${conv.dir}/`));
      if (plan === undefined && engine === "codex" && opts.trust !== "ask" && isEditTool(ev.tool) && inFolder) return run.answer(ev.id, true, ev.input);
      if (plan === undefined && allowedBy(st.allow[agentId] ?? [], ev.tool, ev.input)) {
        // The person already said this role may always do this.
        run.answer(ev.id, true, ev.input);
        st.patchMsg(msgId, (m) => ({ acts: [...(m.acts ?? []), { kind: "other" as const, label: `Allowed by your rule: ${lower(what.title)}` }].slice(-40) }));
        return;
      }
      run.pending.set(ev.id, { tool: ev.tool, input: ev.input });
      const questions = questionsOf(ev.tool, ev.input) ?? undefined;
      st.patchMsg(msgId, (m) => ({ asks: [...(m.asks ?? []), { id: ev.id, ...what, questions, plan, always: ruleFor(ev.tool, ev.input)?.label, state: "waiting" as const }] }));
      const why = plan !== undefined ? `${agent.name} has a plan for you` : questions ? `${agent.name} has a question for you` : `${agent.name} is waiting for your OK`;
      st.setLive(agentId, { status: "needs", statement: why, convId: conv.id });
      void notify(why, plan ?? questions?.[0]?.question ?? `${what.title}${what.detail ? `: ${what.detail}` : ""}`);
    } else if (ev.t === "send") {
      if (inTauri) void writeProcess(runId, ev.line).catch(() => undefined);
    } else if (ev.t === "end") {
      if (inTauri) void endInput(runId);
    } else if (ev.t === "shot") {
      st.addShot(conv.id, { id: uid(), url: ev.url, label: ev.label, by: agentId, ts: Date.now() });
    } else if (ev.t === "error") {
      failed = true;
      st.patchMsg(msgId, (m) => ({ error: m.error ? `${m.error}\n${ev.message}` : ev.message }));
    }
  };

  const finish = () => {
    if (!active.delete(runId)) return;
    touched.delete(runId);
    // With nobody left at work here, there is nothing left to clash.
    if (![...active.values()].some((r) => r.convId === conv.id)) store().dropClash(conv.id);
    updatePolling();
    void scan(conv.id);
    const st = store();
    // Requests nobody answered die with the run.
    for (const id of run.pending.keys()) st.patchAsk(msgId, id, "gone");
    run.pending.clear();
    // `NOTE:` lines are proposals for the person to review, not part of the reply.
    const said = splitNotes(st.messages.find((m) => m.id === msgId)?.text ?? "");
    // The Orchestrator's plan becomes a card of its own; the names in it are not hand-offs.
    const plan = isLead ? splitPlan(said.text) : { text: said.text, steps: [] };
    const text = plan.text.trim();
    /** When the Router could not decide, the request goes to whoever its words point to, or to the Orchestrator. */
    const passOn = () => {
      const workers = conv.members.filter((id) => !isLeadRole(id));
      const to = route(trigger.text, workers) ?? (conv.members.includes(ORCH) ? ORCH : workers[0]);
      st.setLive(agentId, { status: "idle", statement: "", convId: undefined });
      if (to) dispatch(conv, to, trigger, hops + 1, rootId, { auto: true });
    };
    /** Calls the Orchestrator back once nobody is left working on its plan. */
    const settle = (last: Msg | undefined) => {
      const id = run.job;
      const job = id ? jobs.get(id) : undefined;
      if (!id || !job || !last || [...active.values()].some((r) => r.job === id)) return;
      if (++job.rounds > MAX_ROUNDS) {
        jobs.delete(id);
        return store().patchMsg(job.plan, (m) => ({ error: `${m.error ? `${m.error}\n` : ""}The plan was stopped after ${MAX_ROUNDS} rounds.` }));
      }
      dispatch(conv, ORCH, last, hops + 1, rootId, { job: id, wake: true });
    };
    st.react(trigger.id, "👀", agentId, false);
    const took = Date.now() - startedAt;
    if (run.stoppedByPerson) {
      st.patchMsg(msgId, { streaming: false, stopped: true, took });
      setLive(agentId, { status: "idle", statement: "", convId: undefined });
      return;
    }
    if (aside) return st.patchMsg(msgId, { streaming: false, text, took });
    for (const note of said.notes) st.addNote({ id: uid(), agentId, text: note, ts: Date.now(), state: "pending", convId: conv.id });
    for (const choice of said.decisions) st.addDecision({ id: uid(), agentId, convId: conv.id, msgId, text: choice, ts: Date.now(), state: "new" });
    // An agent that cannot ask hands its plan back as a plain reply; the person starts it from there.
    const planned = planning && !CAN_PLAN[engine] && !failed && Boolean(text);
    st.patchMsg(msgId, {
      streaming: false, text, took, noted: said.notes.length || undefined, decided: said.decisions.length || undefined, plan: planned || undefined,
      steps: plan.steps.length ? plan.steps : undefined, stepNow: plan.steps.length ? (said.step ?? plan.steps[0].n) : undefined,
    });
    if (failed) {
      st.setLive(agentId, { status: "stuck", statement: `${agent.name} hit a problem`, convId: undefined });
      void notify(`${agent.name} hit a problem`, st.messages.find((m) => m.id === msgId)?.error ?? "Open Cube to see what went wrong.");
      // A teammate failing is something the Orchestrator has to hear about, to try another way.
      if (!isLead) settle(store().messages.find((m) => m.id === msgId));
      // A Router that failed must not swallow the request: it goes on by the words in it.
      if (isRouter) passOn();
      return;
    }
    st.react(trigger.id, "✅", agentId, true);
    // Only the Router may call on the Orchestrator, and nobody hands work to the Router.
    const named = conv.kind === "channel" ? mentions(text, agentId).filter((id) => conv.members.includes(id) && id !== ROUTER && (id !== ORCH || isRouter)) : [];
    // The Orchestrator's rounds are counted on their own; everyone else may pass work on a few times.
    const next = isRouter ? named.slice(0, 1) : isLead || hops < st.settings.maxHops ? named : [];
    // A Router that named nobody still has to pass the request on.
    if (isRouter && next.length === 0) return passOn();
    const asksPerson = next.length === 0 && (planned || /\?\s*$/.test(text));
    if (isLead) {
      if (next.length && (plan.steps.length || run.job)) {
        // A plan is under way: the teammates named now work as part of it.
        if (!run.job) {
          run.job = uid();
          jobs.set(run.job, { rounds: 0, plan: msgId });
        }
        const job = jobs.get(run.job);
        if (job && job.plan !== msgId && said.step !== undefined) st.patchMsg(job.plan, { stepNow: said.step });
      } else if (run.job) {
        // No hand-off: the plan is over, or it waits on the person.
        const job = jobs.get(run.job);
        if (job && !asksPerson) st.patchMsg(job.plan, { stepsDone: true });
        jobs.delete(run.job);
      }
    }
    if (next.length === 0) void notify(asksPerson ? `${agent.name} is waiting for you` : `${agent.name} finished`, text || "Open Cube to see the result.");
    st.setLive(agentId, asksPerson
      ? { status: "needs", statement: `${agent.name} is waiting for you`, convId: undefined }
      : { status: "done", statement: "", convId: undefined });
    if (!asksPerson) {
      window.setTimeout(() => {
        if (store().live[agentId]?.status === "done") store().setLive(agentId, { status: "idle", statement: "" });
      }, 7000);
    }
    // What the cube did in its own copy is recorded on its branch first, so whoever it hands to can start from it.
    const closing = separate
      ? closeTree(conv.dir, conv.id, agentId, `${agent.name}: ${trigger.text.replace(/\s+/g, " ").slice(0, 60)}`).then((branch) => { if (branch) store().patchMsg(msgId, { branch }); }).catch((e) => console.error(e))
      : Promise.resolve();
    void closing.then(() => {
      const finished = store().messages.find((m) => m.id === msgId);
      // What the Router passes on is answered at the top level, not tucked under the Router's line.
      if (finished) for (const id of next) dispatch(conv, id, finished, hops + 1, isRouter ? rootId : (rootId ?? msgId), { job: run.job, auto: isRouter });
      if (!isLead) settle(finished);
    });
  };

  run.finish = finish;
  active.set(runId, run);
  updatePolling();

  if (!inTauri) {
    const mock = startMock(
      agent,
      prompt,
      onEv,
      (rel, content) =>
        store().putArtifact(conv.id, { rel, path: `/preview/${conv.id}/${rel}`, kind: kindOf(rel), mtime: Date.now(), size: content.length, by: agentId, content }),
      finish,
    );
    run.stop = mock.stop;
    run.answer = (_id, allow) => mock.answer(allow);
    return;
  }

  const begin = (cwd: string) => {
    // Stopped while its copy was being set up.
    if (!active.has(runId)) return;
    if (engine === "api") {
      const built = startBuiltin({ prompt, sessionId: session, opts, dir: cwd, onEv, onDone: finish });
      run.stop = built.stop;
      run.answer = (id, allow) => built.answer(id, allow);
      return;
    }
    if (engine === "remote") {
      const far = store().remotes.find((r) => r.id === store().remoteFor[agentId]) ?? store().remotes[0];
      if (!far) {
        onEv({ t: "error", message: "No remote agent has been added. Add one under Settings > Remote agents, or pick another agent program on this role's profile." });
        return finish();
      }
      run.stop = startRemote({ agent: far, runId, prompt, sessionId: session, dir: cwd, onEv, onDone: finish }).stop;
      return;
    }
    const mine = engine === "custom" ? (store().customs.find((m) => m.id === store().customFor[agentId]) ?? store().customs[0]) : undefined;
    if (engine === "custom" && !mine) {
      onEv({ t: "error", message: "No custom agent was found in ~/CubeSpaces/.agents. Pick another agent program on this role's profile." });
      return finish();
    }
    const adapter = mine ? customAdapter(mine) : ADAPTERS[engine as Exclude<AgentKind, "api" | "custom" | "remote">];
    const started = adapter.command(prompt, session, opts);
    const { program, args, input } = started;
    const parser = started.parser ?? adapter.parser();
    const reply = parser.reply ?? adapter.reply;
    run.stop = () => void stopProcess(runId);
    run.answer = (id, allow, asked) => {
      if (reply) void writeProcess(runId, reply(id, allow, asked)).catch((e) => onEv({ t: "error", message: String(e) }));
    };
    startProcess(runId, program, args, cwd, (stream, line, code) => {
      if (stream === "stdout") parser.stdout(line).forEach(onEv);
      else if (stream === "stderr") parser.stderr(line).forEach(onEv);
      else {
        if (!run.stoppedByPerson) parser.exit(code).forEach(onEv);
        finish();
      }
    }, input).catch((e) => {
      onEv({ t: "error", message: String(e) });
      finish();
    });
  };

  if (!separate) return begin(conv.dir);
  // A cube picking up a teammate's handoff starts from what that teammate left on its branch.
  const from = trigger.author !== "you" && trigger.author !== agentId ? branchOf(trigger.author) : undefined;
  prepareTree(conv.dir, conv.id, agentId, from)
    .then(begin)
    .catch((e) => {
      onEv({ t: "error", message: String(e instanceof Error ? e.message : e) });
      finish();
    });
}

/** Turns separate copies on or off for a channel. Turning them on makes the folder a git repository if it is not one. */
export async function setSeparate(convId: string, on: boolean): Promise<string | null> {
  const conv = convById(convId);
  if (!conv) return "That conversation is gone.";
  if (on && inTauri) {
    const problem = await ensureRepo(conv.dir).catch((e) => String(e));
    if (problem) return problem;
  }
  store().setTrees(convId, on);
  return null;
}

/**
 * The person answers a permission request: once, for good ("always" also saves a rule for the role), or no.
 * The agent has been waiting on this and carries on as soon as it hears back.
 */
export function answerAsk(msgId: string, askId: string, choice: "once" | "always" | "deny", answers?: Record<string, string>): void {
  const run = [...active.values()].find((r) => r.msgId === msgId);
  const asked = run?.pending.get(askId);
  const st = store();
  if (!run || !asked) return st.patchAsk(msgId, askId, "gone");
  const rule = choice === "always" ? ruleFor(asked.tool, asked.input)?.rule : undefined;
  if (rule) st.addRule(run.agentId, rule);
  run.pending.delete(askId);
  // An answered question goes back as the same request with the answers filled in, keyed by question.
  run.answer(askId, choice !== "deny", answers ? { ...(asked.input as object), answers } : asked.input);
  if (planOf(asked.tool, asked.input) !== null && choice !== "deny") {
    // The plan is approved: leave Plan mode, and let the run carry on the way that mode allows.
    const mode = modeAfterPlan(run.convId);
    st.setConvMode(run.convId, mode);
    run.after = sharedCap(run.convId, trustFor(mode, st.trust[run.agentId]));
  }
  st.patchAsk(msgId, askId, choice === "deny" ? "denied" : "allowed", answers ? Object.values(answers).join(" · ") : undefined);
  if (run.pending.size === 0) {
    const agent = agentById(run.agentId);
    st.setLive(run.agentId, { status: "working", statement: `${agent?.name ?? "The agent"} is carrying on`, convId: run.convId });
  }
}

/** Stops every agent working in a conversation. Used by Stop and when the person steps in. */
export function stopAll(convId: string): string[] {
  const runs = [...active.values()].filter((r) => r.convId === convId);
  for (const run of runs) {
    run.stoppedByPerson = true;
    run.stop();
    run.finish();
    // A plan the person stopped does not pick itself up again.
    if (run.job) jobs.delete(run.job);
  }
  return [...new Set(runs.map((r) => r.agentId))];
}

/**
 * The person sends a message, optionally as a reply inside a thread.
 * If agents are working in this conversation, this steps in: they stop and re-read it.
 */
export function send(convId: string, raw: string, parentId?: string, opts: SendOpts = {}): void {
  const text = raw.trim() || (opts.files?.length ? "See the attached files." : "");
  const conv = convById(convId);
  if (!text || !conv) return;
  const s = store();
  const working = [...new Set([...active.values()].filter((r) => r.convId === convId && !r.aside).map((r) => r.agentId))];
  const planned = [...active.values()].some((r) => r.convId === convId && r.job);
  // What nobody was named in goes to the Router first, when it and its engine are there. The
  // Orchestrator takes over a plan the person steps into, and stands in when there is no Router.
  const ready = (id: string) => {
    const a = agentById(id);
    return Boolean(conv.kind === "channel" && s.settings.autoAssign && a && conv.members.includes(id) && s.available[engineOf(a)] !== false);
  };
  const hasOrch = ready(ORCH);
  const first = ready(ROUTER) ? ROUTER : hasOrch ? ORCH : undefined;
  const interrupted = opts.aside ? [] : stopAll(convId);
  const msg: Msg = {
    id: uid(), convId, author: "you", text, ts: Date.now(), parentId, stepped: interrupted.length > 0 || undefined,
    files: opts.files?.length ? opts.files : undefined, aside: opts.aside || undefined, scheduled: opts.scheduled || undefined,
  };
  s.addMsg(msg);
  if (!opts.aside) {
    for (const id of conv.members) {
      if (s.live[id]?.status === "needs") s.setLive(id, { status: "idle", statement: "" });
    }
  }

  let targets: string[];
  let auto = false;
  if (conv.kind === "dm") {
    targets = conv.members.slice(0, 1);
  } else {
    // Names at the very start say who gets the message. A name later in the sentence
    // ("then ask @Writer") is an instruction for the receiver, not a second recipient.
    const lead = text.match(/^\s*(?:@[A-Za-z]+[\s,]*)+/)?.[0] ?? "";
    const inConv = (ids: string[]) => ids.filter((id) => conv.members.includes(id));
    targets = inConv(mentions(lead));
    if (!targets.length) targets = inConv(mentions(text));
    // Stepping into a plan goes to the one running it, not to every teammate that was stopped.
    if (!targets.length && interrupted.length) targets = hasOrch && (planned || interrupted.includes(ORCH)) ? [ORCH] : interrupted.filter((id) => id !== ROUTER);
    // A side question with no name goes to whoever is at work.
    if (!targets.length && opts.aside && working.length === 1) targets = working;
    if (!targets.length) {
      // No names. Inside a thread, whoever is already in it answers. Otherwise pick the role
      // the request points to, and fall back to whoever spoke last.
      const scope = s.messages.filter((m) => m.convId === convId && (parentId ? m.id === parentId || m.parentId === parentId : true));
      const lastAgent = [...scope].reverse().find((m) => m.author !== "you" && m.author !== ROUTER)?.author;
      const lastHere = lastAgent && conv.members.includes(lastAgent) ? lastAgent : undefined;
      const workers = conv.members.filter((id) => !isLeadRole(id));
      const routed = !parentId && s.settings.autoAssign ? (first ?? route(text, workers)) : null;
      auto = Boolean(routed);
      // A reply in a thread the Orchestrator started is for the Orchestrator.
      const inPlan = hasOrch && parentId && s.messages.find((m) => m.id === parentId)?.author === ORCH;
      targets = [routed ?? (inPlan ? ORCH : lastHere && lastHere !== ROUTER ? lastHere : undefined) ?? workers[0] ?? conv.members[0]];
    }
  }
  if (opts.aside) {
    // Answers to a side question stay in its own thread, out of the way of the work.
    targets.forEach((id) => dispatch(conv, id, msg, 0, parentId ?? msg.id, { aside: true }));
    return;
  }
  // Take the "before" picture first, so everything the agents touch from here on counts as a
  // change, and keep a copy on disk so the folder can be put back to this moment later.
  void snapshot(convId)
    .then(() => (inTauri ? checkpointSave(convId, msg.id).then(() => store().patchMsg(msg.id, { checkpoint: true })) : undefined))
    .catch((e) => console.error(e))
    .finally(() => targets.forEach((id) => dispatch(conv, id, msg, 0, parentId, { auto })));
}

/**
 * Puts the conversation's files back to how they were just before one of the person's messages.
 * What is there now is copied first, so the restore itself can be taken back with `undoRestore`.
 * Messages and agents' memory are left as they are: only files move.
 */
export async function restoreTo(convId: string, msgId: string): Promise<string | null> {
  const msg = store().messages.find((m) => m.id === msgId);
  if (!inTauri || !msg) return "That checkpoint is gone.";
  stopAll(convId);
  try {
    const undoId = `undo-${Date.now()}`;
    await checkpointSave(convId, undoId);
    await checkpointRestore(convId, msgId);
    const when = new Date(msg.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    store().setUndo(convId, { id: undoId, label: `Files are back to how they were before your message at ${when}.` });
    await scan(convId);
    return null;
  } catch (e) {
    return String(e);
  }
}

export async function undoRestore(convId: string): Promise<void> {
  const undo = store().undo[convId];
  if (!undo) return;
  try {
    await checkpointRestore(convId, undo.id);
    await scan(convId);
  } catch (e) {
    console.error(e);
  }
  store().setUndo(convId, undefined);
}

/** The person approves a plan that came back as a plain reply: leave Plan mode and tell the agent to start. */
export function approvePlan(msgId: string): void {
  const st = store();
  const msg = st.messages.find((m) => m.id === msgId);
  const conv = msg && convById(msg.convId);
  const agent = msg && agentById(msg.author);
  if (!msg || !conv || !agent) return;
  st.patchMsg(msgId, { plan: undefined });
  st.setConvMode(conv.id, modeAfterPlan(conv.id));
  send(conv.id, conv.kind === "channel" ? `@${agent.name} Go ahead with your plan.` : "Go ahead with your plan.", msg.parentId);
}
