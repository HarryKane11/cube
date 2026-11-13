import { create } from "zustand";
import { WORK_KEPT, type Imported, type WorkEntry } from "@/agents/context";
import { persist } from "zustand/middleware";
import type { Manifest } from "../agents/custom";
import type { RemoteAgent } from "../agents/remote/a2a";
import { ownColor, toDef, type SharedAgent, type SubAgent } from "../agents/subagents";
import type { HeadlessEngine } from "../agents/headless";
import type { JobKind, JobRun } from "../knowledge/jobs";
import type { Remote } from "../team/drive";
import type { TeamMember } from "../team/events";
import type { Decision, Note, PlanStep } from "../agents/notes";
import type { Question } from "../agents/permissions";
import type { Branch } from "../agents/trees";
import type { ActKind, AgentKind, Mode, Palette, RunOpts, Status, Todo, Trust } from "../agents/types";
import type { ProgramUsage, UsageProgram } from "../agents/usage";
import { AGENTS, ORCH, ROUTER, applyPalettes, isLeadRole, setSubagents } from "../agents/types";
import type { Lang } from "../i18n";
import { kindOf, type FileKind } from "../lib/files";
import type { Schedule } from "../lib/schedule";
import type { Baseline } from "../lib/tree";

/** A channel with several agents, or a direct message with one. Each has its own folder on disk. */
export interface Conv {
  id: string;
  kind: "channel" | "dm";
  name: string;
  /** Agent ids. A DM has exactly one. */
  members: string[];
  dir: string;
  createdAt: number;
  /**
   * A chat: a conversation with the whole team that was simply started, from Home, and not set
   * up as a channel. It works as a channel does (the Router reads what names nobody) and is named
   * after what it began with.
   */
  chat?: boolean;
  /** The one conversation with the whole team: written to like a direct message, handed out like a channel. */
  cube?: boolean;
  /**
   * Set for a chat that works in a folder of the person's own, opened as a workspace: the folder's
   * path. Its cubes work there directly, and Cube keeps no copies of it and never deletes it.
   */
  workspace?: string;
  /** Set for a chat that began from a session of another program: what was said there, given to the cubes here as background. */
  imported?: Imported;
  /**
   * A direct conversation with one teammate, by their key. It is a private shared channel with
   * the two of them in it; the cubes are there too, and join only when they are named.
   */
  person?: { pubkey: string };
  /**
   * Shared with the team: its id on the relay, and since when what is said here goes out.
   * `open` lets teammates call this person's cubes here by naming them, and lets the Router
   * decide whether a teammate's message wants an answer.
   */
  shared?: {
    id: string;
    since: number;
    open?: boolean;
    /** Only the people invited into it see it. Set when the channel is shared and never changed. */
    private?: boolean;
    /** Whether this conversation's folder is the channel's shared folder. Unset for a channel shared before folders could be: the person is asked once. */
    files?: boolean;
  };
}

/** A folder of the person's own that they opened for cubes to work in, as a project folder is opened in a coding agent. */
export interface Workspace {
  dir: string;
  /** The folder's own name. */
  name: string;
  /** Whether it is a git repository: the person's way back when a cube changed something. */
  git: boolean;
  /** The folder is not there now. */
  missing?: boolean;
}

/** The name a workspace folder goes by: its own. */
export const workspaceName = (dir: string): string => dir.replace(/\/+$/, "").split("/").pop() || dir;

/** How a shared folder stands on this computer right now. */
export interface DriveLive {
  /** Instruction files a teammate changed, waiting for this person's yes. */
  held: { key: string; rel: string; remote: Remote }[];
  /** Files that stay on this computer, and why. */
  skipped: { rel: string; why: string }[];
  /** Files on their way up or down, or waiting to be left alone before they go. */
  moving: number;
  /** Files someone else is working on right now: path key → who, and until when that is believed. */
  touched: Record<string, { pubkey: string; by?: Remote["by"]; until: number }>;
  /** Things the person should know happened: two versions kept side by side, a file the relay would not take. */
  notes: { id: string; text: string; rel?: string }[];
}

export const NO_DRIVE: DriveLive = { held: [], skipped: [], moving: 0, touched: {}, notes: [] };

/** Something the team could do next, in words the person could send as they are. */
export interface Suggestion {
  id: string;
  text: string;
  at: number;
  state: "new" | "taken" | "dismissed";
}

export interface Act {
  kind: ActKind;
  label: string;
  /** How much of the reply had been written when this step was taken: where it belongs in it. */
  at?: number;
}

/** A helper at work for a cube: who it is, what it runs on, what it last said, and what came of it. */
export interface Helper {
  name: string;
  engine: AgentKind;
  state: "working" | "done" | "failed";
  /** What it reported while working, oldest first. The last line is what it is doing now. */
  said: string[];
  startedAt: number;
  took?: number;
  /** What it made: a path inside the conversation's folder, and the file's full path. */
  rel?: string;
  path?: string;
  error?: string;
  /** For a request from Slack: "sent" once what it made is in the thread, or why it is not. */
  posted?: string;
}

/** Something an agent wants to do that needs the person's OK. */
export interface Ask {
  id: string;
  title: string;
  detail: string;
  /** Wording of the lasting rule the person can give instead of a single OK, when there is one. */
  always?: string;
  /** Set when the agent is not asking for an OK but asking the person something. */
  questions?: Question[];
  /** Set when the agent finished planning and asks to start: the plan, as markdown. */
  plan?: string;
  /** What the person answered, once they did. */
  answer?: string;
  /** "gone": the run ended before anyone answered. */
  state: "waiting" | "allowed" | "denied" | "gone";
}

/** How a conversation is called in a line of text: a channel with its #, a chat or a direct message by its name alone. */
export const labelOf = (conv: Pick<Conv, "kind" | "name" | "person" | "chat">): string => (conv.kind === "dm" || conv.person || conv.chat ? conv.name : `#${conv.name}`);

/** A chat's name, from the words it began with: the first line, cut to what fits in the sidebar. */
export function chatTitle(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length > 40 ? `${line.slice(0, 39).trimEnd()}…` : line || "New chat";
}

export interface Msg {
  id: string;
  convId: string;
  /** "you" or an agent id. */
  author: string;
  text: string;
  ts: number;
  /** Set on replies; points at the thread's first message. */
  parentId?: string;
  streaming?: boolean;
  /** The person sent this while agents were working, which stopped them. */
  stepped?: boolean;
  stopped?: boolean;
  /** Nobody was named, so Cube picked this agent from what the request said. */
  auto?: boolean;
  error?: string;
  /** What the agent did while writing this, in order. */
  acts?: Act[];
  /** Emoji → who reacted ("you" or agent ids). */
  reactions?: Record<string, string[]>;
  /** How many notes the agent proposed in this message, waiting for the person to review. */
  noted?: number;
  /** Permission requests made while writing this, in order. */
  asks?: Ask[];
  /** A copy of the folder was taken just before this message, so files can be put back to then. */
  checkpoint?: boolean;
  /** The person changed the text after sending it. */
  edited?: boolean;
  /** Kept at the top of the conversation for everyone to find again. */
  pinned?: boolean;
  /** Files sent along with the message, as paths inside the conversation folder. */
  files?: string[];
  /** A side question or its answer: asked while others kept working, and it changes no files. */
  aside?: boolean;
  /** Written in Plan mode by an agent that cannot ask: the reply is a plan waiting for a go-ahead. */
  plan?: boolean;
  /** How many choices the agent says it made by itself while writing this. */
  decided?: number;
  /** Sent by a schedule, not typed just now. */
  scheduled?: boolean;
  /** The agent's own list of what it is doing in this run, as it last stood. */
  todo?: Todo[];
  /** The plan the Orchestrator wrote in this message, step by step. */
  steps?: PlanStep[];
  /** The number of the plan step being worked on now. */
  stepNow?: number;
  /** The plan ran to its end. */
  stepsDone?: boolean;
  /** The plan stopped before its last step: the Orchestrator gave its answer, or could not go on. The steps reached stay as they are. */
  stepsEnded?: boolean;
  /** What the agent left on its own branch, when it worked in a separate copy of the folder. */
  branch?: Branch;
  /** A teammate's message, or their agent's: who signed it. Never treated as something to act on. */
  from?: { pubkey: string; name: string; agent?: string; /** The color of the teammate's cube that wrote it, so it is drawn as the cube it is. */ color?: string };
  /** For a message of ours in a shared channel: the text the team has. */
  sent?: string;
  /**
   * A request that came from Slack: the channel and thread its answers go back to. `called` is
   * false for a reply in a thread the team is already in that does not mention the bot: the
   * Router decides whether it wants an answer.
   */
  slack?: { channel: string; ts: string; called?: boolean };
  /** Someone a cube brought in for part of the job, such as the image model that draws its picture. Shown working under the message. */
  helper?: Helper;
  /** For a cube's answer to a Slack request: set once it has been posted there. */
  slackSent?: string;
  /** How long the agent worked on this, in milliseconds. */
  took?: number;
  /** What the run used, when the engine reports it. */
  usage?: Usage;
  /** The agent program the run was made on. */
  engine?: AgentKind;
}

export interface Usage {
  /** Tokens read and written. */
  in?: number;
  out?: number;
  /** In US dollars, when the engine prices its own runs. */
  cost?: number;
}

/** A picture of what an agent was looking at: a browser page, the screen, an image it opened. */
export interface Shot {
  id: string;
  url: string;
  label: string;
  by: string;
  ts: number;
}

/** Two cubes, or a cube and the person, changing the same file at once. */
export interface Clash {
  id: string;
  rel: string;
  /** Agent ids, or "you" for the person's unsaved edits. */
  who: string[];
  ts: number;
}

/** What `selected` holds when the Stage shows the agents' screen instead of a file. */
export const SCREEN = "@screen";
/** What `selected` holds when the Stage shows Cube's own browser. */
export const BROWSER = "@browser";

/** Another app's window being watched live on the Stage. */
export interface Follow {
  id: number;
  app: string;
  /** The app's icon as a base64 PNG, when there is one. */
  icon?: string;
}

/** How a file is shown on the Stage: rendered, as editable text, or against how it was before. */
export type ViewMode = "preview" | "code" | "diff" | "edit";

export interface Artifact {
  rel: string;
  path: string;
  kind: FileKind;
  mtime: number;
  size: number;
  by?: string;
  /** Only set in the browser preview, where there is no disk. */
  content?: string;
}

export interface Live {
  status: Status;
  statement: string;
  /** The conversation the agent is working in right now. */
  convId?: string;
}

export interface DiskFile {
  path: string;
  rel: string;
  size: number;
  mtime: number;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  /** With no @mention, pick the agent from what the request says. */
  autoAssign: boolean;
  /** Open the Stage by itself when an agent makes something. */
  stageAuto: boolean;
  /** How many times agents may hand work to each other before a person has to speak again. */
  maxHops: number;
  /** Keep cubes still instead of twisting while they work. */
  calm: boolean;
  /** Cubes may put a view (a table, a chart, a few numbers, a form) in a reply. On unless turned off. */
  richUi?: boolean;
  /** The workspace folder the next chat begun on Home works in. Unset: a folder of its own under CubeSpaces. */
  workspace?: string;
  /** The sections of the sidebar that are folded away, by name. */
  folded?: string[];
  /** How Cube's own mark is drawn: what fills it and the figure on its front. Plain when unset. See cube/CubeMark.tsx. */
  cubeLook?: { shape?: "mark" | "cube"; fill?: string; colors?: [string, string, string]; symbol?: string; spread?: "face" | "tiles" };
  /** Show the file tree beside whatever is on the Stage. */
  tree: boolean;
  /** Show the full sidebar. Off: a narrow rail of icons. */
  sidebar: boolean;
  /** The mode a conversation uses until the person picks one for it. */
  mode: Mode;
  /** Widths, in px, of the sidebar, of the conversation when something is open beside it, and of the Stage's file list. */
  sidebarW: number;
  chatW: number;
  treeW: number;
  /** The language of the app's own words. What cubes and people write is left as it is. */
  lang: Lang;
  /** Ids of the typefaces for Latin text and for Hangul. See lib/fonts.ts. */
  fontEn: string;
  fontKo: string;
  /** App-wide scale as a percentage, shared by Settings and the zoom shortcuts. */
  uiScale: number;
  /** The size of the text in messages, in px. 0 keeps the size everything else is drawn at. */
  chatSize: number;
  /** Tell the person through the system when a cube needs them or finishes while Cube is in the background. */
  notify: boolean;
}

/** Puts the person's sub-agents on the team roster, each with a color no other cube has. */
function syncSubagents(subs: SubAgent[]): void {
  setSubagents([]);
  const taken = AGENTS.map((a) => a.color);
  const defs = subs.map((sub) => {
    const color = ownColor(sub.palette[0], taken);
    taken.push(color);
    return toDef(sub, color);
  });
  setSubagents(defs);
}

/** How Cube keeps its memory, skills and wiki. */
export interface KnowledgeState {
  /** The agent program background work runs on. Empty until the person picks one; nothing runs by itself before that. */
  engine: "" | HeadlessEngine;
  model: string;
  /** Keep memory, skills and the wiki up to date without being asked. */
  auto: boolean;
  /** The fewest hours between two wiki runs. Unset: the usual three. */
  wikiEvery?: number;
  /** When each job last finished well. */
  last: Partial<Record<JobKind, number>>;
  /** The time of the last conversation line each job has read. */
  cursor: { memory: number; skills: number };
  /** When memory last changed, which is what gives the wiki something to do. */
  memoryChangedAt: number;
  /** Notes brought in from other programs are waiting to be worked into memory. */
  imported: boolean;
  /** The latest runs, newest first. */
  runs: JobRun[];
}

interface CubeState {
  settings: Settings;
  /** Per conversation, whether the person opened or closed the Stage by hand. Unset: follow the files. */
  stage: Record<string, "open" | "closed">;
  /** The person's display name. Empty until they finish the start screen. */
  name: string;
  /** This person's own picture, as a small `data:` address. Shown here and, in a team, to teammates. */
  avatar?: string;
  onboarded: boolean;
  /** Which engines are installed on this computer. */
  available: Partial<Record<AgentKind, boolean>>;
  /** Role id → the engine that powers it. */
  engines: Record<string, AgentKind>;
  /** `${agentId}:${engine}` → the model and effort that role uses on that engine. */
  models: Record<string, { model?: string; effort?: string }>;
  /** Role ids that run without the person's own setup for their engine. */
  plain: Record<string, boolean>;
  /** Conversation id → the mode picked for it in the message box. */
  modes: Record<string, Mode>;
  /** Conversation id → the mode it was in before Plan, to go back to once a plan is approved. */
  planFrom: Record<string, Mode>;
  /** Role id → how much it may do without asking. Unset: "edits". */
  trust: Record<string, Trust>;
  /** Role id → things the person said it may always do. See agents/permissions.ts for the rule format. */
  allow: Record<string, string[]>;
  /** What agents learned, proposed and approved. */
  notes: Note[];
  /** Session key → ids of the notes that session has already been told. */
  told: Record<string, string[]>;
  /** What each cube did in each conversation, as Cube saw it: by conversation, then by cube. Given to a cube that starts without a session. */
  worklog: Record<string, Record<string, WorkEntry[]>>;
  addWork(convId: string, agentId: string, entry: WorkEntry): void;
  /** Per conversation, the latest pictures of what agents were looking at. Not saved. */
  shots: Record<string, Shot[]>;
  /** Per conversation, the app window the Screen tab is following. Not saved. */
  follow: Record<string, Follow | undefined>;
  /** The system refused a picture of another app's window. Until one works, Cube does not try by itself again. Not saved. */
  captureDenied: boolean;
  /** The port Cube's own browser listens on, once it is running. Not saved. */
  browserPort?: number;
  view: "home" | "conv" | "settings" | "agent" | "inbox" | "library";
  /** A message the conversation should scroll to and flash. `n` changes on every jump, so the same message can be found twice. */
  focus?: { id: string; n: number };
  /** Choices agents made by themselves, for the person to look over. */
  decisions: Decision[];
  /** Inbox entries the person cleared, by entry id. */
  cleared: Record<string, boolean>;
  /** Role id → the three face colors the person picked for its cube: front, top, side. */
  palettes: Record<string, Palette>;
  /** Role id → what the person chose for its cube to hold: an id from the catalog, or "none". Unset: what fits its role. */
  outfits: Record<string, string>;
  /** The workspace's own emoji: name → picture. Read from one file when the app opens (lib/emoji.ts), not kept with the rest. */
  emojis: Record<string, string>;
  setEmojis(emojis: Record<string, string>): void;
  /** The folders open as workspaces. The app's own side keeps the list (workspace.rs); this is what it last said. */
  workspaces: Workspace[];
  setWorkspaces(workspaces: Workspace[]): void;
  /** Browsers with a window of their own that are installed on this Mac ("aside"). Looked for when the app opens. */
  tools: string[];
  setTools(tools: string[]): void;
  /** What each agent program says is used of the plan it is signed in with. */
  usage: Partial<Record<UsageProgram, ProgramUsage>>;
  setUsage(program: UsageProgram, usage: ProgramUsage): void;
  /** `${agentId}:${engine}` → the model the program said it ran that role on last. */
  ran: Record<string, string>;
  setRan(key: string, model: string): void;
  /** Engine → the model the program uses when none is picked, as its own settings say. */
  programModels: Record<string, string>;
  setProgramModels(models: Record<string, string>): void;
  setOutfit(agentId: string, prop: string | undefined): void;
  /** Programs of the person's own found in ~/CubeSpaces/.agents. Not saved: read again at every start. */
  customs: Manifest[];
  /** Role id → the custom agent that powers it, when the role runs on one. */
  customFor: Record<string, string>;
  /** Sub-agents the person made, or brought in from a teammate. They join the team beside the built-in roles. */
  subagents: SubAgent[];
  /** The team this Cube has joined, as the relay last described it. `agents` are the sub-agents teammates offer. */
  team: { info?: { host: string; ws: string; workspace: string; pubkey: string }; me?: { name: string; role: TeamMember["role"] }; members: TeamMember[]; head: number; agents?: SharedAgent[];
    /** Teammates' pictures, by their key. */
    avatars?: Record<string, string>;
    /** The picture of ours the team has, so it is sent again only when it changes. */
    avatarSent?: string;
    /** What the relay can do beyond the first version of the contract, e.g. "channels". */
    features?: string[];
    /** Whether ordinary members may bring new people in with a channel invite link. The owner decides. */
    memberInvites?: boolean;
    /** Channels this person was added to whose earlier history is still being fetched: shared id → the seq to go on from. Kept, so a restart picks it up. */
    pulls?: Record<string, number>;
  };
  /** The connection to the relay right now. Not kept across restarts. */
  teamLive: {
    connected: boolean;
    problem: string;
    invite?: string;
    /** An invite that was opened from outside Cube (a link in a browser or a mail) and waits for the person to say yes. */
    pending?: string;
    /** The shared channel the invite link is for, when it is for one. */
    inviteFor?: string;
    /** Who is in each shared channel, by shared id, as the relay last said. */
    convMembers?: Record<string, string[]>;
  };
  /** Each shared channel's folder as the relay describes it, by shared id: path key → the file's latest version. Not kept: it is asked for again on connecting. */
  drive: Record<string, Record<string, Remote>>;
  /** What each file here was when it last agreed with the relay, by conversation: path key → hash. Kept, so that after a restart a change made here can be told from one made there. */
  driveBase: Record<string, Record<string, string>>;
  /** How each shared folder stands right now, by conversation. Not kept. */
  driveLive: Record<string, DriveLive>;
  /** The connection to Slack right now. Not kept across restarts. */
  slackLive: { configured: boolean; connected: boolean; team: string; problem: string; /** Permissions the Slack app lacks for what Cube does there. */ missing?: string[] };
  /** How Cube keeps its memory, skills and wiki, and what the background jobs have done. */
  knowledge: KnowledgeState;
  /** The job running right now, if one is. Not kept across restarts. */
  knowledgeBusy?: { job: JobKind; since: number; activity: string };
  /** Where the knowledge folder is, and how many notes, skills and pages it holds. */
  knowledgeDir: string;
  knowledgeCount: number;
  /** When Cube last wrote CUBE.md, the file a cube starts from. Unset until it has, in this run of the app. */
  cubeMdAt?: number;
  setCubeMdAt(at: number): void;
  /** Things the team could do next, offered after the wiki was written. The person starts one or lets it go. */
  suggestions: Suggestion[];
  addSuggestions(texts: string[]): void;
  setSuggestion(id: string, state: Suggestion["state"]): void;
  /** Agents that run somewhere else, added by the person. Their credentials are in the Keychain, not here. */
  remotes: RemoteAgent[];
  /** Role id → the remote agent that powers it, when the role runs on one. */
  remoteFor: Record<string, string>;
  /** Channels where each cube works in its own copy of the folder (a git worktree). */
  trees: Record<string, boolean>;
  /** Messages Cube sends by itself at set times. */
  schedules: Schedule[];
  /** When the person last left Cube. What happened since is what they missed. */
  seenAt: number;
  /** Per conversation, files being changed from two sides right now. Not saved. */
  clashes: Record<string, Clash[]>;
  /** The role whose profile is open. */
  profileId?: string;
  convs: Conv[];
  activeId: string;
  messages: Msg[];
  /** `${convId}:${agentId}:${engine}` → that agent's own session id, so it keeps its memory between turns. */
  sessions: Record<string, string>;
  /** `${convId}:${rel}` → the agent that last wrote the file. */
  authors: Record<string, string>;
  live: Record<string, Live>;
  files: Record<string, Artifact[]>;
  selected: Record<string, string | undefined>;
  /** The person picked a file by hand, so new files should not steal the Stage. */
  pinned: Record<string, boolean>;
  /** Per conversation, the files open as tabs on the Stage, in the order they were opened. */
  tabs: Record<string, string[]>;
  /** `${convId}:${rel}` → how the person chose to look at that file. Unset: whatever suits its kind. */
  mode: Record<string, ViewMode>;
  /** Absolute paths of files with edits not saved yet. */
  dirty: Record<string, boolean>;
  /** Per conversation, how its files looked when the person last spoke. */
  baseline: Record<string, Baseline>;
  /** Text waiting to be dropped into a conversation's message box, e.g. code picked in the editor. */
  quote?: { convId: string; text: string };
  /** A place the editor should jump to once that file is open. */
  reveal?: { path: string; line: number; col: number };
  /** Conversations whose terminal panel is open. */
  termOpen: Record<string, boolean>;
  /** Per conversation, the checkpoint that takes back the last restore. */
  undo: Record<string, { id: string; label: string } | undefined>;
  unread: Record<string, number>;
  /** Root message of the thread open in the side panel. */
  threadId?: string;
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  setStage(convId: string, value: "open" | "closed"): void;
  openSettings(): void;
  openInbox(): void;
  /** Opens the Library, on one of its own sections when one is named. */
  openLibrary(at?: "schedules" | "files"): void;
  /** The Library section the person asked for from elsewhere, until they pick another. */
  libraryAt?: "schedules" | "files";
  /** Opens the conversation a message is in and brings the message into view. */
  jumpTo(msgId: string): void;
  addDecision(d: Decision): void;
  setDecision(id: string, state: Decision["state"]): void;
  clearEntry(id: string): void;
  /** Sets a role's cube colors, or puts its own colors back. */
  setPalette(agentId: string, colors: Palette | undefined): void;
  setCustoms(list: Manifest[]): void;
  setCustomFor(agentId: string, id: string): void;
  /** Adds a sub-agent or replaces the one with its id, and gives it a direct message and a place in every channel. */
  putSubagent(sub: SubAgent): void;
  /** Takes a sub-agent off the team. What it wrote stays. */
  removeSubagent(id: string): void;
  setTeam(patch: Partial<CubeState["team"]>): void;
  setTeamLive(patch: Partial<CubeState["teamLive"]>): void;
  setDrive(sharedId: string, view: Record<string, Remote> | undefined): void;
  /** Remembers the version a file here agrees with the relay on; without a hash, forgets it. */
  setDriveBase(convId: string, key: string, sha: string | undefined): void;
  setDriveLive(convId: string, patch: Partial<DriveLive>): void;
  setConvShared(convId: string, shared: Conv["shared"]): void;
  /** Says a conversation is, or is no longer, a direct one with a teammate. */
  setConvPerson(convId: string, person: Conv["person"]): void;
  renameConv(convId: string, name: string): void;
  setSlackLive(patch: Partial<CubeState["slackLive"]>): void;
  setKnowledge(patch: Partial<KnowledgeState>): void;
  setKnowledgeBusy(busy: { job: JobKind; since: number; activity: string } | undefined): void;
  setKnowledgePlace(dir: string, count: number): void;
  addKnowledgeRun(run: JobRun): void;
  putRemote(agent: RemoteAgent): void;
  removeRemote(id: string): void;
  setRemoteFor(agentId: string, id: string): void;
  setTrees(convId: string, on: boolean): void;
  saveSchedule(s: Schedule): void;
  removeSchedule(id: string): void;
  setSeen(ts: number): void;
  addClash(convId: string, clash: Clash): void;
  dropClash(convId: string, id?: string): void;
  /** Forgets every message and agent session. Channels and files on disk stay. */
  clearHistory(): void;
  restartOnboarding(): void;
  setName(name: string): void;
  /** Sets or removes this person's own picture. */
  setAvatar(avatar: string | undefined): void;
  finishOnboarding(): void;
  setAvailable(a: Partial<Record<AgentKind, boolean>>): void;
  setEngine(agentId: string, kind: AgentKind): void;
  setModel(agentId: string, kind: AgentKind, patch: Pick<RunOpts, "model" | "effort">): void;
  setPlain(agentId: string, plain: boolean): void;
  setTrust(agentId: string, trust: Trust): void;
  setConvMode(convId: string, mode: Mode): void;
  addRule(agentId: string, rule: string): void;
  removeRule(agentId: string, rule: string): void;
  patchAsk(msgId: string, askId: string, state: Ask["state"], answer?: string): void;
  openProfile(agentId: string): void;
  addNote(note: Note): void;
  /** Keeps something Cube picked up about how the person talks with it. No approval: it shapes only Cube's manner. */
  addSelf(text: string, convId?: string): void;
  keepNote(id: string): void;
  forgetNote(id: string): void;
  markTold(key: string, ids: string[]): void;
  addShot(convId: string, shot: Shot): void;
  /** Starts or stops following a window. Starting brings the Screen tab up unless the person pinned a file. */
  setFollow(convId: string, follow: Follow | undefined): void;
  setBrowserPort(port: number | undefined): void;
  setCaptureDenied(denied: boolean): void;
  goHome(): void;
  setActive(id: string): void;
  addConv(conv: Conv): void;
  /** Takes a conversation and everything said in it out of Cube. Its folder is not touched here. */
  removeConv(id: string): void;
  setConvDir(id: string, dir: string): void;
  addMsg(msg: Msg): void;
  patchMsg(id: string, patch: Partial<Msg> | ((m: Msg) => Partial<Msg>)): void;
  deleteMsg(id: string): void;
  react(id: string, emoji: string, who: string, on?: boolean): void;
  setLive(agentId: string, patch: Partial<Live>): void;
  setSession(key: string, id: string): void;
  syncFiles(convId: string, files: DiskFile[], authorOf: (f: DiskFile) => string | undefined): void;
  putArtifact(convId: string, a: Artifact): void;
  select(convId: string, rel: string | undefined, pinned: boolean): void;
  closeTab(convId: string, rel: string): void;
  setMode(convId: string, rel: string, mode: ViewMode): void;
  setDirty(path: string, dirty: boolean): void;
  setBaseline(convId: string, baseline: Baseline): void;
  /** Notes that a file is back to its baseline text, under a new modified time. */
  rebaseFile(convId: string, rel: string, mtime: number): void;
  setQuote(quote: { convId: string; text: string } | undefined): void;
  setReveal(reveal: { path: string; line: number; col: number } | undefined): void;
  setTermOpen(convId: string, open: boolean): void;
  setUndo(convId: string, undo: { id: string; label: string } | undefined): void;
  openThread(id: string | undefined): void;
}

/** How many things Cube keeps about how the person talks with it. */
const SELF_KEPT = 24;

const idleLive = (): Record<string, Live> =>
  Object.fromEntries(AGENTS.map((a) => [a.id, { status: "idle" as Status, statement: "" }]));

/** The conversation between the person and the whole team: theirs alone, and never deleted. */
export const CUBE_DM = "dm-cube";
const cubeConv = (): Conv => ({ id: CUBE_DM, kind: "channel", name: "Cube", members: AGENTS.map((a) => a.id), dir: "", createdAt: 0, chat: true, cube: true });

const defaultConvs = (): Conv[] => [
  { id: "general", kind: "channel", name: "general", members: AGENTS.map((a) => a.id), dir: "", createdAt: 0 },
  cubeConv(),
  // The Router and the Orchestrator have no direct message: alone they have nobody to hand work to.
  ...AGENTS.filter((a) => !isLeadRole(a.id)).map((a): Conv => ({ id: `dm-${a.id}`, kind: "dm", name: a.name, members: [a.id], dir: "", createdAt: 0 })),
];

export const useCube = create<CubeState>()(
  persist(
    (set) => ({
      settings: { theme: "system", autoAssign: true, stageAuto: true, maxHops: 4, calm: false, tree: true, sidebar: true, mode: "manual", notify: true, lang: "en", fontEn: "system", fontKo: "system", uiScale: 100, chatSize: 0, sidebarW: 244, chatW: 480, treeW: 200 },
      stage: {},
      name: "",
      onboarded: false,
      available: {},
      engines: {},
      models: {},
      plain: {},
      modes: {},
      planFrom: {},
      trust: {},
      allow: {},
      notes: [],
      told: {},
      worklog: {},
      addWork: (convId, agentId, entry) => set((s) => ({ worklog: { ...s.worklog, [convId]: { ...s.worklog[convId], [agentId]: [...(s.worklog[convId]?.[agentId] ?? []), entry].slice(-WORK_KEPT) } } })),
      shots: {},
      follow: {},
      captureDenied: false,
      browserPort: undefined,
      view: "home",
      focus: undefined,
      decisions: [],
      cleared: {},
      palettes: {},
      outfits: {},
      emojis: {},
      setEmojis: (emojis) => set({ emojis }),
      workspaces: [],
      setWorkspaces: (workspaces) => set({ workspaces }),
      tools: [],
      setTools: (tools) => set({ tools }),
      usage: {},
      setUsage: (program, usage) => set((s) => ({ usage: { ...s.usage, [program]: usage } })),
      ran: {},
      setRan: (key, model) => set((s) => (s.ran[key] === model ? s : { ran: { ...s.ran, [key]: model } })),
      programModels: {},
      setProgramModels: (programModels) => set({ programModels }),
      setOutfit: (agentId, prop) => set((s) => { const outfits = { ...s.outfits }; if (prop) outfits[agentId] = prop; else delete outfits[agentId]; return { outfits }; }),
      customs: [],
      customFor: {},
      remotes: [],
      remoteFor: {},
      subagents: [],
      team: { members: [], head: 0 },
      teamLive: { connected: false, problem: "" },
      drive: {},
      driveBase: {},
      driveLive: {},
      slackLive: { configured: false, connected: false, team: "", problem: "" },
      knowledge: { engine: "", model: "", auto: true, last: {}, cursor: { memory: 0, skills: 0 }, memoryChangedAt: 0, imported: false, runs: [] },
      knowledgeBusy: undefined,
      knowledgeDir: "",
      knowledgeCount: 0,
      setCubeMdAt: (cubeMdAt) => set({ cubeMdAt }),
      suggestions: [],
      // What was already offered is not offered twice, whatever became of it.
      addSuggestions: (texts) => set((s) => {
        const known = new Set(s.suggestions.map((x) => x.text));
        const fresh = texts.filter((t) => t && !known.has(t)).map((text, i) => ({ id: `sg-${Date.now().toString(36)}-${i}`, text, at: Date.now(), state: "new" as const }));
        return fresh.length ? { suggestions: [...s.suggestions, ...fresh].slice(-60) } : {};
      }),
      setSuggestion: (id, state) => set((s) => ({ suggestions: s.suggestions.map((x) => (x.id === id ? { ...x, state } : x)) })),
      trees: {},
      schedules: [],
      seenAt: Date.now(),
      clashes: {},
      profileId: undefined,
      convs: defaultConvs(),
      activeId: "general",
      messages: [],
      sessions: {},
      authors: {},
      live: idleLive(),
      files: {},
      selected: {},
      pinned: {},
      tabs: {},
      mode: {},
      dirty: {},
      baseline: {},
      quote: undefined,
      reveal: undefined,
      termOpen: {},
      undo: {},
      unread: {},
      threadId: undefined,
      setSetting: (key, value) => set((s) => ({ settings: { ...s.settings, [key]: value } })),
      setStage: (convId, value) => set((s) => ({ stage: { ...s.stage, [convId]: value } })),
      openSettings: () => set({ view: "settings", threadId: undefined }),
      openInbox: () => set({ view: "inbox", threadId: undefined }),
      openLibrary: (at) => set({ view: "library", threadId: undefined, libraryAt: at }),
      jumpTo: (msgId) =>
        set((s) => {
          const m = s.messages.find((x) => x.id === msgId);
          if (!m) return s;
          return { view: "conv", activeId: m.convId, threadId: m.parentId, unread: { ...s.unread, [m.convId]: 0 }, focus: { id: msgId, n: (s.focus?.n ?? 0) + 1 } };
        }),
      addDecision: (d) => set((s) => ({ decisions: [...s.decisions, d].slice(-300) })),
      setDecision: (id, state) => set((s) => ({ decisions: s.decisions.map((d) => (d.id === id ? { ...d, state } : d)) })),
      clearEntry: (id) => set((s) => ({ cleared: { ...s.cleared, [id]: true } })),
      setPalette: (agentId, colors) =>
        set((s) => {
          const palettes = { ...s.palettes };
          if (colors) palettes[agentId] = colors;
          else delete palettes[agentId];
          // Cubes read their colors while they are drawn, so the new ones must be in place first.
          applyPalettes(palettes);
          return { palettes };
        }),
      setCustoms: (customs) => set({ customs }),
      setCustomFor: (agentId, id) => set((s) => ({ customFor: { ...s.customFor, [agentId]: id } })),
      putSubagent: (sub) =>
        set((s) => {
          const fresh = !s.subagents.some((x) => x.id === sub.id);
          const subagents = fresh ? [...s.subagents, sub] : s.subagents.map((x) => (x.id === sub.id ? sub : x));
          syncSubagents(subagents);
          if (!fresh) return { subagents, convs: s.convs.map((c) => (c.id === `dm-${sub.id}` ? { ...c, name: sub.name } : c)) };
          const dm: Conv = { id: `dm-${sub.id}`, kind: "dm", name: sub.name, members: [sub.id], dir: "", createdAt: Date.now() };
          return {
            subagents,
            live: { ...s.live, [sub.id]: { status: "idle" as Status, statement: "" } },
            convs: [...s.convs.map((c) => (c.kind === "channel" && !c.members.includes(sub.id) ? { ...c, members: [...c.members, sub.id] } : c)), dm],
          };
        }),
      removeSubagent: (id) =>
        set((s) => {
          const subagents = s.subagents.filter((x) => x.id !== id);
          syncSubagents(subagents);
          return {
            subagents,
            convs: s.convs.filter((c) => c.id !== `dm-${id}`).map((c) => (c.members.includes(id) ? { ...c, members: c.members.filter((m) => m !== id) } : c)),
            activeId: s.activeId === `dm-${id}` ? "general" : s.activeId,
          };
        }),
      setTeam: (patch) => set((s) => ({ team: { ...s.team, ...patch } })),
      setTeamLive: (patch) => set((s) => ({ teamLive: { ...s.teamLive, ...patch } })),
      setDrive: (sharedId, view) =>
        set((s) => {
          const drive = { ...s.drive };
          if (view) drive[sharedId] = view;
          else delete drive[sharedId];
          return { drive };
        }),
      setDriveBase: (convId, key, sha) =>
        set((s) => {
          const had = s.driveBase[convId] ?? {};
          if (had[key] === sha) return s;
          const next = { ...had };
          if (sha) next[key] = sha;
          else delete next[key];
          return { driveBase: { ...s.driveBase, [convId]: next } };
        }),
      setDriveLive: (convId, patch) => set((s) => ({ driveLive: { ...s.driveLive, [convId]: { ...(s.driveLive[convId] ?? NO_DRIVE), ...patch } } })),
      setConvShared: (convId, shared) => set((s) => ({ convs: s.convs.map((c) => (c.id === convId ? { ...c, shared } : c)) })),
      setConvPerson: (convId, person) => set((s) => ({ convs: s.convs.map((c) => (c.id === convId ? { ...c, person } : c)) })),
      renameConv: (convId, name) => set((s) => ({ convs: s.convs.map((c) => (c.id === convId ? { ...c, name } : c)) })),
      setSlackLive: (patch) => set((s) => ({ slackLive: { ...s.slackLive, ...patch } })),
      setKnowledge: (patch) => set((s) => ({ knowledge: { ...s.knowledge, ...patch } })),
      setKnowledgeBusy: (knowledgeBusy) => set({ knowledgeBusy }),
      setKnowledgePlace: (knowledgeDir, knowledgeCount) => set({ knowledgeDir, knowledgeCount }),
      addKnowledgeRun: (run) => set((s) => ({ knowledge: { ...s.knowledge, runs: [run, ...s.knowledge.runs].slice(0, 30) } })),
      putRemote: (agent) => set((s) => ({ remotes: [...s.remotes.filter((r) => r.id !== agent.id), agent], available: { ...s.available, remote: true } })),
      removeRemote: (id) =>
        set((s) => {
          const remotes = s.remotes.filter((r) => r.id !== id);
          return { remotes, available: { ...s.available, remote: remotes.length > 0 } };
        }),
      setRemoteFor: (agentId, id) => set((s) => ({ remoteFor: { ...s.remoteFor, [agentId]: id } })),
      setTrees: (convId, on) => set((s) => ({ trees: { ...s.trees, [convId]: on } })),
      saveSchedule: (next) => set((s) => ({ schedules: s.schedules.some((x) => x.id === next.id) ? s.schedules.map((x) => (x.id === next.id ? next : x)) : [...s.schedules, next] })),
      removeSchedule: (id) => set((s) => ({ schedules: s.schedules.filter((x) => x.id !== id) })),
      setSeen: (seenAt) => set({ seenAt }),
      addClash: (convId, clash) =>
        set((s) => {
          const had = s.clashes[convId] ?? [];
          // One notice per file; a third party joining updates it.
          const same = had.find((c) => c.rel === clash.rel);
          const next = same ? had.map((c) => (c === same ? { ...c, who: [...new Set([...c.who, ...clash.who])] } : c)) : [...had, clash];
          return { clashes: { ...s.clashes, [convId]: next } };
        }),
      dropClash: (convId, id) => set((s) => ({ clashes: { ...s.clashes, [convId]: id ? (s.clashes[convId] ?? []).filter((c) => c.id !== id) : [] } })),
      clearHistory: () => set({ messages: [], sessions: {}, told: {}, worklog: {}, shots: {}, unread: {}, decisions: [], cleared: {}, threadId: undefined, live: idleLive() }),
      restartOnboarding: () => set({ onboarded: false }),
      setName: (name) => set({ name }),
      setAvatar: (avatar) => set({ avatar }),
      finishOnboarding: () => set({ onboarded: true, view: "home" }),
      setAvailable: (available) => set({ available }),
      setEngine: (agentId, kind) => set((s) => ({ engines: { ...s.engines, [agentId]: kind } })),
      setModel: (agentId, kind, patch) =>
        set((s) => {
          const key = `${agentId}:${kind}`;
          return { models: { ...s.models, [key]: { ...s.models[key], ...patch } } };
        }),
      setPlain: (agentId, plain) => set((s) => ({ plain: { ...s.plain, [agentId]: plain } })),
      setTrust: (agentId, trust) => set((s) => ({ trust: { ...s.trust, [agentId]: trust } })),
      setConvMode: (convId, mode) =>
        set((s) => {
          const was = s.modes[convId] ?? s.settings.mode;
          return { modes: { ...s.modes, [convId]: mode }, planFrom: mode === "plan" && was !== "plan" ? { ...s.planFrom, [convId]: was } : s.planFrom };
        }),
      addRule: (agentId, rule) => set((s) => ({ allow: { ...s.allow, [agentId]: [...new Set([...(s.allow[agentId] ?? []), rule])] } })),
      removeRule: (agentId, rule) => set((s) => ({ allow: { ...s.allow, [agentId]: (s.allow[agentId] ?? []).filter((r) => r !== rule) } })),
      patchAsk: (msgId, askId, state, answer) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === msgId ? { ...m, asks: m.asks?.map((a) => (a.id === askId ? { ...a, state, answer } : a)) } : m)),
        })),
      openProfile: (agentId) => set({ view: "agent", profileId: agentId, threadId: undefined }),
      addNote: (note) => set((s) => (s.notes.some((n) => n.agentId === note.agentId && n.text === note.text) ? s : { notes: [...s.notes, note] })),
      addSelf: (text, convId) =>
        set((s) => {
          if (s.notes.some((n) => n.agentId === ROUTER && n.text === text)) return s;
          const note: Note = { id: `self-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, agentId: ROUTER, text, ts: Date.now(), state: "kept", convId, self: true };
          // Only so many: the oldest of what Cube picked up by itself makes room. What the person approved stays.
          const own = s.notes.filter((n) => n.self);
          const drop = own.length >= SELF_KEPT ? new Set(own.slice(0, own.length - SELF_KEPT + 1).map((n) => n.id)) : undefined;
          return { notes: [...(drop ? s.notes.filter((n) => !drop.has(n.id)) : s.notes), note] };
        }),
      keepNote: (id) => set((s) => ({ notes: s.notes.map((n) => (n.id === id ? { ...n, state: "kept" as const } : n)) })),
      forgetNote: (id) => set((s) => ({ notes: s.notes.filter((n) => n.id !== id) })),
      markTold: (key, ids) => set((s) => ({ told: { ...s.told, [key]: ids } })),
      addShot: (convId, shot) =>
        set((s) => ({
          shots: { ...s.shots, [convId]: [...(s.shots[convId] ?? []), shot].slice(-12) },
          // The screen takes the Stage unless the person pinned a file there.
          selected: s.pinned[convId] ? s.selected : { ...s.selected, [convId]: SCREEN },
          tabs: { ...s.tabs, [convId]: withTab(s.tabs[convId], SCREEN) },
          stage: s.settings.stageAuto ? { ...s.stage, [convId]: "open" as const } : s.stage,
        })),
      setFollow: (convId, follow) =>
        set((s) => ({
          follow: { ...s.follow, [convId]: follow },
          ...(follow
            ? {
                selected: s.pinned[convId] ? s.selected : { ...s.selected, [convId]: SCREEN },
                tabs: { ...s.tabs, [convId]: withTab(s.tabs[convId], SCREEN) },
                stage: s.settings.stageAuto ? { ...s.stage, [convId]: "open" as const } : s.stage,
              }
            : {}),
        })),
      setBrowserPort: (browserPort) => set({ browserPort }),
      setCaptureDenied: (captureDenied) => set((s) => (s.captureDenied === captureDenied ? s : { captureDenied })),
      goHome: () => set({ view: "home", threadId: undefined }),
      setActive: (id) => set((s) => ({ view: "conv", activeId: id, threadId: undefined, unread: { ...s.unread, [id]: 0 } })),
      addConv: (conv) => set((s) => ({ convs: [...s.convs, conv] })),
      removeConv: (id) =>
        set((s) => {
          const without = <T,>(map: Record<string, T>) => Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
          return {
            convs: s.convs.filter((c) => c.id !== id),
            messages: s.messages.filter((m) => m.convId !== id),
            unread: without(s.unread),
            driveBase: without(s.driveBase),
            driveLive: without(s.driveLive),
            worklog: without(s.worklog),
            files: without(s.files),
            tabs: without(s.tabs),
            selected: without(s.selected),
            activeId: s.activeId === id ? "general" : s.activeId,
            view: s.view === "conv" && s.activeId === id ? "home" : s.view,
            threadId: s.activeId === id ? undefined : s.threadId,
          };
        }),
      setConvDir: (id, dir) => set((s) => ({ convs: s.convs.map((c) => (c.id === id ? { ...c, dir } : c)) })),
      addMsg: (msg) =>
        set((s) => ({
          messages: [...s.messages, msg],
          unread:
            (s.view !== "conv" || msg.convId !== s.activeId) && msg.author !== "you"
              ? { ...s.unread, [msg.convId]: (s.unread[msg.convId] ?? 0) + 1 }
              : s.unread,
        })),
      patchMsg: (id, patch) =>
        set((s) => ({
          messages: s.messages.map((m) => (m.id === id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)),
        })),
      deleteMsg: (id) =>
        set((s) => ({
          messages: s.messages.filter((m) => m.id !== id && m.parentId !== id),
          threadId: s.threadId === id ? undefined : s.threadId,
        })),
      react: (id, emoji, who, on) =>
        set((s) => ({
          messages: s.messages.map((m) => {
            if (m.id !== id) return m;
            const had = m.reactions?.[emoji] ?? [];
            const want = on ?? !had.includes(who);
            const next = want ? [...had.filter((w) => w !== who), who] : had.filter((w) => w !== who);
            const reactions = { ...(m.reactions ?? {}), [emoji]: next };
            if (!next.length) delete reactions[emoji];
            return { ...m, reactions };
          }),
        })),
      setLive: (agentId, patch) =>
        set((s) => ({ live: { ...s.live, [agentId]: { ...(s.live[agentId] ?? { status: "idle", statement: "" }), ...patch } } })),
      setSession: (key, id) => set((s) => ({ sessions: { ...s.sessions, [key]: id } })),
      syncFiles: (convId, files, authorOf) =>
        set((s) => {
          const before = s.files[convId] ?? [];
          const old = new Map(before.map((a) => [a.rel, a]));
          const authors = { ...s.authors };
          let newest: Artifact | undefined;
          const list = files.map((f) => {
            const prev = old.get(f.rel);
            const changed = !prev || prev.mtime !== f.mtime;
            const key = `${convId}:${f.rel}`;
            const by = (changed ? authorOf(f) : undefined) ?? prev?.by ?? authors[key];
            if (by) authors[key] = by;
            const next: Artifact = { rel: f.rel, path: f.path, kind: kindOf(f.rel), mtime: f.mtime, size: f.size, by };
            if (changed && (!newest || f.mtime > newest.mtime)) newest = next;
            return next;
          });
          list.sort((a, b) => b.mtime - a.mtime);
          const cur = s.selected[convId];
          // The browser and the screen are not files: once opened they stay until the person closes them.
          const shown = (rel: string) => rel === BROWSER || rel === SCREEN || list.some((a) => a.rel === rel);
          const stillThere = cur && shown(cur);
          const pick = newest && !s.pinned[convId] ? newest.rel : stillThere ? cur : list[0]?.rel;
          // Tabs for files that are gone close by themselves; whatever is shown always has a tab.
          const kept = (s.tabs[convId] ?? []).filter(shown);
          return {
            files: { ...s.files, [convId]: list },
            tabs: { ...s.tabs, [convId]: withTab(kept, pick) },
            // Something new to show: bring the Stage up, unless the person turned that off.
            stage: newest && s.settings.stageAuto ? { ...s.stage, [convId]: "open" as const } : s.stage,
            authors,
            selected: { ...s.selected, [convId]: pick },
            pinned: { ...s.pinned, [convId]: stillThere ? (s.pinned[convId] ?? false) : false },
          };
        }),
      putArtifact: (convId, a) =>
        set((s) => ({
          files: { ...s.files, [convId]: [a, ...(s.files[convId] ?? []).filter((x) => x.rel !== a.rel)] },
          selected: s.pinned[convId] ? s.selected : { ...s.selected, [convId]: a.rel },
          tabs: { ...s.tabs, [convId]: withTab(s.tabs[convId], a.rel) },
          stage: s.settings.stageAuto ? { ...s.stage, [convId]: "open" as const } : s.stage,
        })),
      select: (convId, rel, pinned) =>
        set((s) => ({
          selected: { ...s.selected, [convId]: rel },
          pinned: { ...s.pinned, [convId]: pinned },
          tabs: { ...s.tabs, [convId]: withTab(s.tabs[convId], rel) },
        })),
      closeTab: (convId, rel) =>
        set((s) => {
          const before = s.tabs[convId] ?? [];
          const at = before.indexOf(rel);
          const tabs = before.filter((t) => t !== rel);
          // Closing the tab in view moves to its neighbor.
          const selected = s.selected[convId] === rel ? (tabs[Math.min(at, tabs.length - 1)] ?? undefined) : s.selected[convId];
          return { tabs: { ...s.tabs, [convId]: tabs }, selected: { ...s.selected, [convId]: selected }, pinned: { ...s.pinned, [convId]: true } };
        }),
      setMode: (convId, rel, mode) => set((s) => ({ mode: { ...s.mode, [`${convId}:${rel}`]: mode } })),
      setDirty: (path, dirty) => set((s) => (Boolean(s.dirty[path]) === dirty ? s : { dirty: { ...s.dirty, [path]: dirty } })),
      setBaseline: (convId, baseline) => set((s) => ({ baseline: { ...s.baseline, [convId]: baseline } })),
      rebaseFile: (convId, rel, mtime) =>
        set((s) => {
          const base = s.baseline[convId];
          const was = base?.files[rel];
          return base && was ? { baseline: { ...s.baseline, [convId]: { ...base, files: { ...base.files, [rel]: { ...was, mtime } } } } } : s;
        }),
      setQuote: (quote) => set({ quote }),
      setReveal: (reveal) => set({ reveal }),
      setTermOpen: (convId, open) => set((s) => ({ termOpen: { ...s.termOpen, [convId]: open } })),
      setUndo: (convId, undo) => set((s) => ({ undo: { ...s.undo, [convId]: undo } })),
      openThread: (id) => set({ threadId: id }),
    }),
    {
      name: "cube-v4",
      partialize: (s) => ({
        settings: s.settings,
        name: s.name,
        avatar: s.avatar,
        onboarded: s.onboarded,
        engines: s.engines,
        models: s.models,
        plain: s.plain,
        modes: s.modes,
        planFrom: s.planFrom,
        trust: s.trust,
        allow: s.allow,
        notes: s.notes,
        told: s.told,
        worklog: s.worklog,
        decisions: s.decisions,
        suggestions: s.suggestions,
        cleared: s.cleared,
        palettes: s.palettes,
        outfits: s.outfits,
        usage: s.usage,
        ran: s.ran,
        customFor: s.customFor,
        remotes: s.remotes,
        knowledge: s.knowledge,
        subagents: s.subagents,
        team: s.team,
        remoteFor: s.remoteFor,
        trees: s.trees,
        schedules: s.schedules,
        seenAt: s.seenAt,
        convs: s.convs.map((c) => ({ ...c, dir: "" })),
        activeId: s.activeId,
        messages: s.messages,
        sessions: s.sessions,
        authors: s.authors,
        driveBase: s.driveBase,
        unread: s.unread,
      }),
      merge: (saved, current) => {
        const p = (saved ?? {}) as Partial<CubeState>;
        // Channels made before the Router and the Orchestrator existed get them now.
        const kept = (p.convs?.length ? p.convs : current.convs).map((c) =>
          c.kind === "channel" ? { ...c, members: [...[ROUTER, ORCH].filter((id) => !c.members.includes(id)), ...c.members] } : c,
        );
        applyPalettes(p.palettes ?? {});
        // The sub-agents the person made are back on the team before anything looks one up.
        syncSubagents(p.subagents ?? []);
        // A workspace from before there was a conversation with the whole team gets one, after its channels.
        const at = kept.findIndex((c) => c.kind === "dm");
        const convs = kept.some((c) => c.id === CUBE_DM) ? kept : [...kept.slice(0, at < 0 ? kept.length : at), cubeConv(), ...kept.slice(at < 0 ? kept.length : at)];
        return {
          ...current,
          ...p,
          settings: { ...current.settings, ...(p.settings ?? {}) },
          convs,
          activeId: convs.some((c) => c.id === p.activeId) ? (p.activeId as string) : convs[0].id,
          // Nothing is running after a restart, so close any message that was mid-stream.
          messages: (p.messages ?? []).map((m) => {
            const asks = m.asks?.map((a) => (a.state === "waiting" ? { ...a, state: "gone" as const } : a));
            return m.streaming ? { ...m, asks, streaming: false, stopped: true } : { ...m, asks };
          }),
        };
      },
    },
  ),
);

function withTab(tabs: string[] | undefined, rel: string | undefined): string[] {
  const list = tabs ?? [];
  return !rel || list.includes(rel) ? list : [...list, rel];
}

export function useActiveConv(): Conv {
  return useCube((s) => s.convs.find((c) => c.id === s.activeId) ?? s.convs[0]);
}

/** True while any agent is working in the given conversation. */
export function useBusy(convId: string): boolean {
  return useCube((s) =>
    Object.values(s.live).some((l) => l.convId === convId && (l.status === "thinking" || l.status === "working")),
  );
}

/** The Stage is open when the person opened it, or when there is something to show and they did not close it. */
export function useStageOpen(convId: string): boolean {
  return useCube((s) => (s.stage[convId] ? s.stage[convId] === "open" : (s.files[convId]?.length ?? 0) + (s.shots[convId]?.length ?? 0) > 0 || Boolean(s.follow[convId])));
}
