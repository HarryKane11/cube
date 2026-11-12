/** The programs that can run an agent. A role cube is powered by one of them. */
export type AgentKind = "codex" | "claude" | "hermes" | "api" | "custom" | "remote";

/** What a cube is doing right now. Drives its motion and its face. */
export type Status = "idle" | "thinking" | "working" | "needs" | "stuck" | "done";

export type ActKind = "think" | "read" | "edit" | "run" | "search" | "other";

/** A role on the team: one cube, one job, powered by whichever engine it is given. */
export interface AgentDef {
  id: string;
  name: string;
  /** One short phrase shown next to the name. */
  role: string;
  /** What this role is for, told to the agent itself and to its teammates. */
  brief: string;
  /** Main color, also the key of its cube palette. */
  color: string;
  /** The three face colors of its cube when solved: front (behind the eyes), top, side. */
  palette: [string, string, string];
  /** Engines this role prefers, best first. The first one installed wins. */
  prefers: AgentKind[];
  /** Words in a request that point to this role, English and Korean. */
  keywords: string[];
  /** Sticker colors mixed across every face, for a cube that stands for the whole team. */
  mosaic?: string[];
  /** For a sub-agent the person made: how it should go about its work, told to it at the start of a conversation. */
  instructions?: string;
  /** A sub-agent the person made, as opposed to a role Cube comes with. */
  custom?: boolean;
}

/** The role that reads a request nobody was named in and passes it on: to one teammate, or to the Orchestrator when it takes a team. */
export const ROUTER = "router";
/** The team lead: plans work that takes several steps or teammates, and runs the plan. */
export const ORCH = "orchestrator";
/** Roles that hand work out instead of doing it. They have no direct message and are nobody's teammate to hand work to. */
export const isLeadRole = (id: string) => id === ROUTER || id === ORCH;

/**
 * Models a role starts with on an engine when the person picked none. The Router only decides
 * where a request goes, so it runs on a fast model. The Orchestrator uses its engine's own model.
 */
export const ROLE_DEFAULTS: Record<string, Partial<Record<AgentKind, { model?: string; effort?: string }>>> = {
  [ROUTER]: { codex: { model: "gpt-6-luna", effort: "low" }, claude: { model: "haiku" } },
  // Planning does not need the engine's deepest thinking, and a slow lead makes the whole team wait.
  [ORCH]: { codex: { effort: "medium" } },
};

/** One normalized event, whatever engine produced it. */
export type Ev =
  | { t: "session"; id: string }
  | { t: "delta"; text: string }
  | { t: "activity"; kind: ActKind; label: string; /** The command line, when the step runs one. */ cmd?: string }
  | { t: "file"; path: string }
  /** A picture a tool handed back: a browser page, the screen, an image it opened. */
  | { t: "shot"; url: string; label: string }
  /** The agent wants to do something it may not do without the person's OK, and waits for the answer. */
  | { t: "ask"; id: string; tool: string; input: unknown }
  /** A line the engine needs written back to it right away. */
  | { t: "send"; line: string }
  /** The engine finished its turn; it exits once its input is closed. */
  | { t: "end" }
  /** What the run used, as far as the engine says. */
  | { t: "usage"; in?: number; out?: number; cost?: number }
  | { t: "error"; message: string };

/**
 * How much an agent may do without asking, as its engine is started:
 * "ask" only reads freely, "edits" also changes files, "auto" decides step by step by itself
 * (the engine blocks what looks risky), "free" is never asked and never blocked,
 * "plan" changes nothing and comes back with a plan for the person to approve.
 */
export type Trust = "ask" | "edits" | "auto" | "free" | "plan";

/** What the person picks in the message box: be asked, let agents run to the end, or skip every check. */
export type Mode = "manual" | "auto" | "bypass" | "plan";

export const MODES: { id: Mode; name: string; about: string }[] = [
  { id: "manual", name: "Manual", about: "Cubes stop and ask you before commands and other steps that need your OK." },
  { id: "auto", name: "Auto", about: "Cubes work to the end without asking. Each step is checked automatically and risky ones are blocked." },
  { id: "bypass", name: "Bypass", about: "Never asks and blocks nothing. Cubes can run any command on this computer." },
  { id: "plan", name: "Plan", about: "Cubes look into it and come back with a plan. Nothing changes until you approve it." },
];

/** The trust an agent runs with: the conversation's mode decides, and in Manual the role's own setting. */
export function trustFor(mode: Mode, roleTrust: Trust | undefined): Trust {
  if (mode === "auto") return "auto";
  if (mode === "bypass") return "free";
  if (mode === "plan") return "plan";
  return roleTrust === "ask" ? "ask" : "edits";
}

/** How a role wants its engine started. Everything is optional: unset means the engine's own default. */
export interface RunOpts {
  model?: string;
  effort?: string;
  /** Start without the person's own setup for that program (skills, plugins, MCP servers, hooks). */
  plain?: boolean;
  /** Unset means "edits". */
  trust?: Trust;
}

export interface Parser {
  stdout(line: string): Ev[];
  stderr(line: string): Ev[];
  exit(code: number | null): Ev[];
  /** The line that answers an "ask" event, when the answer depends on what this run was asked. */
  reply?(id: string, allow: boolean, input: unknown): string;
}

export interface Adapter {
  /**
   * `input`, when set, is written to the program's stdin, which then stays open for answers.
   * `parser`, when set, is the one to read this run with: it already knows the request.
   */
  command(prompt: string, sessionId?: string, opts?: RunOpts): { program: string; args: string[]; input?: string; parser?: Parser };
  /** The line that answers an "ask" event. Only engines that can ask have it. */
  reply?(id: string, allow: boolean, input: unknown): string;
  parser(): Parser;
}

export const ENGINES: Record<AgentKind, { name: string; program: string }> = {
  claude: { name: "Claude Code", program: "claude" },
  codex: { name: "Codex CLI", program: "codex" },
  hermes: { name: "Hermes Agent", program: "hermes" },
  // No program of its own: Cube runs it, on a model reached with the person's API key.
  api: { name: "Built-in agent", program: "" },
  // A program of the person's own, described in ~/CubeSpaces/.agents.
  custom: { name: "Custom agent", program: "" },
  // An agent that runs somewhere else, reached over the network (A2A).
  remote: { name: "Remote agent", program: "" },
};

/** Reasoning effort levels both Claude Code and Codex accept. Hermes has no such setting. */
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** What each engine supports: an effort setting, starting without the person's setup, asking before it acts. */
export const ENGINE_CAN: Record<AgentKind, { effort: boolean; plain: boolean; ask: boolean }> = {
  claude: { effort: true, plain: true, ask: true },
  codex: { effort: true, plain: false, ask: true },
  hermes: { effort: false, plain: false, ask: false },
  api: { effort: true, plain: false, ask: true },
  custom: { effort: false, plain: false, ask: true },
  remote: { effort: false, plain: false, ask: false },
};

/** The two ways a role can behave in Manual mode. */
export const TRUSTS: { id: "ask" | "edits"; name: string }[] = [
  { id: "ask", name: "Ask first" },
  { id: "edits", name: "Edits are fine" },
];

/** What each Manual-mode setting means on each engine, in the words shown on a role's profile. */
export const TRUST_ABOUT: Record<AgentKind, Record<"ask" | "edits", string>> = {
  claude: {
    ask: "Reads freely. Asks you before every file change, command and tool.",
    edits: "Changes files in the conversation folder freely. Asks you before commands, the web and other tools.",
  },
  codex: {
    ask: "Can only read by itself. Asks you before anything that changes files or runs outside its sandbox.",
    edits: "Changes files in the conversation folder freely. Asks you before commands it does not know to be harmless.",
  },
  hermes: {
    ask: "Hermes keeps its own safety checks. It cannot ask through Cube yet, so it skips risky commands.",
    edits: "Hermes keeps its own safety checks. It cannot ask through Cube yet, so it skips risky commands.",
  },
  api: {
    ask: "Reads freely. Asks you before every file change and command.",
    edits: "Changes files in the conversation folder freely. Asks you before every command.",
  },
  custom: {
    ask: "Cube tells your program to ask before anything but reading. Honoring that is up to the program.",
    edits: "Cube tells your program it may change files and should ask before the rest. Honoring that is up to the program.",
  },
  remote: {
    ask: "A remote agent works on its own servers. It sees the messages Cube sends it and nothing on this computer.",
    edits: "A remote agent works on its own servers. It sees the messages Cube sends it and nothing on this computer.",
  },
};

/** Model names known to work. Codex and Hermes names come from each program's own settings instead. */
export const MODEL_HINTS: Record<AgentKind, string[]> = {
  claude: ["opus", "sonnet", "haiku", "claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  codex: [],
  hermes: [],
  custom: [],
  remote: [],
  api: ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5", "anthropic/claude-fable-5-2", "openai/", "openrouter/"],
};

const BUILT_IN: AgentDef[] = [
  {
    id: ROUTER,
    name: "Router",
    role: "Answers about Cube and brings in the right cube",
    brief: "You are the front desk: you answer general questions about Cube and the team, and for a request nobody was named in you bring in the one teammate who should do it, or the Orchestrator when it takes several.",
    color: "#3A3A3C",
    palette: ["#48484A", "#8E8E93", "#2C2C2E"],
    prefers: ["codex", "claude", "hermes"],
    keywords: [],
  },
  {
    id: ORCH,
    name: "Orchestrator",
    role: "Leads the team through bigger jobs",
    brief: "You lead the team: you plan work that takes several steps or teammates, hand out each step, and report back.",
    color: "#5B5BD6",
    palette: ["#FF4D8D", "#FFC83D", "#2F7BFF"],
    // One sticker color from each teammate.
    mosaic: ["#7A4DF0", "#FF7A1A", "#1FA864", "#FF4D8D", "#2F7BFF", "#FFC83D"],
    prefers: ["codex", "claude", "hermes"],
    keywords: [],
  },
  {
    id: "researcher",
    name: "Researcher",
    role: "Finds and checks facts",
    brief: "You look things up, compare sources and report what is true, with where it came from.",
    color: "#7A4DF0",
    palette: ["#7A4DF0", "#F25FD0", "#3D7BFF"],
    prefers: ["claude", "hermes", "codex"],
    keywords: ["research", "find out", "look up", "search", "compare", "source", "market", "competitor", "benchmark", "조사", "찾아", "검색", "탐색", "알아봐", "여론", "비교", "리서치", "자료", "출처", "시장", "경쟁"],
  },
  {
    id: "writer",
    name: "Writer",
    role: "Drafts docs and plans",
    brief: "You write clear documents: plans, briefs, summaries, emails and posts.",
    color: "#FF7A1A",
    palette: ["#FF7A1A", "#FFC83D", "#FF4D6D"],
    prefers: ["claude", "codex", "hermes"],
    // No bare "write": people also write code, and that belongs to the Builder.
    keywords: ["draft", "document", "doc", "summary", "summarize", "plan", "email", "post", "copy", "readme", "문서", "요약", "기획", "초안", "정리", "메일", "보고서"],
  },
  {
    id: "builder",
    name: "Builder",
    role: "Writes and runs code",
    brief: "You build working things: code, scripts, data files and small apps, and you run them to make sure they work.",
    color: "#1FA864",
    palette: ["#1FA864", "#9BE15D", "#12B5CB"],
    prefers: ["codex", "claude", "hermes"],
    keywords: ["build", "code", "implement", "fix", "bug", "script", "api", "function", "refactor", "deploy", "구현", "코드", "개발", "버그", "수정", "스크립트", "배포", "함수"],
  },
  {
    id: "designer",
    name: "Designer",
    role: "Makes pages and visuals",
    brief: "You make things people look at: pages, layouts, charts, slides and images, with care for how they read.",
    color: "#FF4D8D",
    palette: ["#FF4D8D", "#FFB13D", "#8B5CF6"],
    prefers: ["claude", "codex", "hermes"],
    keywords: ["design", "page", "ui", "layout", "logo", "color", "mockup", "chart", "slide", "landing", "html", "디자인", "화면", "레이아웃", "로고", "색상", "색깔", "컬러", "시안", "차트", "슬라이드", "페이지"],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "Checks the work",
    brief: "You read what others made, test it, and say plainly what is wrong and what is fine.",
    color: "#2F7BFF",
    palette: ["#2F7BFF", "#5ED3F3", "#7CE38B"],
    prefers: ["codex", "claude", "hermes"],
    keywords: ["review", "check", "test", "verify", "audit", "qa", "proofread", "리뷰", "검토", "확인", "테스트", "검증", "점검"],
  },
];

/**
 * Everyone on the team: the built-in roles, then the sub-agents the person made. The list is
 * kept current by `setSubagents`; read it when you need it instead of holding on to a copy.
 */
export const AGENTS: AgentDef[] = [...BUILT_IN];

/** Puts the person's sub-agents on the team, replacing the ones that were there. */
export function setSubagents(defs: AgentDef[]): void {
  AGENTS.splice(BUILT_IN.length, AGENTS.length - BUILT_IN.length, ...defs);
}


export function agentById(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id);
}

export function authorName(id: string): string {
  return id === "you" ? "You" : (agentById(id)?.name ?? id);
}

export type Palette = [string, string, string];

/** Face colors the person picked for a role's cube, by role id. Set from the store. */
let picked: Record<string, Palette> = {};

/** Makes the person's own cube colors the ones `paletteOf` hands out. */
export function applyPalettes(next: Record<string, Palette>): void {
  picked = next;
}

/** Sticker colors for a cube: the person's choice for that role, the role's own palette, or tints of a single color. */
export function paletteOf(color: string): Palette | null {
  const agent = AGENTS.find((a) => a.color.toLowerCase() === color.toLowerCase());
  return agent ? (picked[agent.id] ?? agent.palette) : null;
}

/** The mixed sticker colors of a team cube, unless the person gave that role colors of their own. */
export function mosaicOf(color: string): string[] | null {
  const agent = AGENTS.find((a) => a.color.toLowerCase() === color.toLowerCase());
  return agent?.mosaic && !picked[agent.id] ? agent.mosaic : null;
}

/** Ready-made cube colors: front, top, side. */
export const PALETTES: { name: string; colors: Palette }[] = [
  { name: "Violet", colors: ["#7A4DF0", "#F25FD0", "#3D7BFF"] },
  { name: "Sunset", colors: ["#FF7A1A", "#FFC83D", "#FF4D6D"] },
  { name: "Forest", colors: ["#1FA864", "#9BE15D", "#12B5CB"] },
  { name: "Candy", colors: ["#FF4D8D", "#FFB13D", "#8B5CF6"] },
  { name: "Ocean", colors: ["#2F7BFF", "#5ED3F3", "#7CE38B"] },
  { name: "Classic", colors: ["#E8402A", "#FFFFFF", "#1E63D0"] },
  { name: "Mono", colors: ["#3A3A3C", "#C7C7CC", "#8E8E93"] },
  { name: "Mint", colors: ["#00C7BE", "#F5F5F7", "#FFD60A"] },
];

/** The engine a role should use, given which engines are installed. */
export function pickEngine(agent: AgentDef, available: Partial<Record<AgentKind, boolean>>): AgentKind {
  return agent.prefers.find((k) => available[k]) ?? agent.prefers[0];
}

/**
 * Picks the role whose keywords best match a request with no @mention.
 * Returns null when nothing matches, so the caller can fall back to whoever spoke last.
 */
export function route(text: string, memberIds: string[]): string | null {
  const hay = text.toLowerCase();
  let best: string | null = null;
  let bestScore = 0;
  for (const id of memberIds) {
    const agent = agentById(id);
    if (!agent) continue;
    const score = agent.keywords.reduce((n, k) => n + (hay.includes(k) ? 1 : 0), 0);
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}
