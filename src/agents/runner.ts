import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DiskFile } from "../state/store";
import type { AgentKind } from "./types";

/** False when the page is opened in a plain browser, where there is no backend. */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Stream = "stdout" | "stderr" | "exit";
type Handler = (stream: Stream, line: string, code: number | null) => void;

interface AgentEventPayload {
  run_id: string;
  stream: Stream;
  line: string;
  code: number | null;
}

const handlers = new Map<string, Handler>();
let listening: Promise<unknown> | null = null;

function ensureListener(): Promise<unknown> {
  if (!listening) {
    listening = listen<AgentEventPayload>("agent-event", (e) => {
      const { run_id, stream, line, code } = e.payload;
      handlers.get(run_id)?.(stream, line, code);
      if (stream === "exit") handlers.delete(run_id);
    });
  }
  return listening;
}

/**
 * Starts an agent program. With `input`, that text is written to its stdin and the pipe stays
 * open so answers can follow (`writeProcess`) until `endInput` closes it.
 */
export async function startProcess(runId: string, program: string, args: string[], cwd: string, handler: Handler, input?: string): Promise<void> {
  await ensureListener();
  handlers.set(runId, handler);
  try {
    await invoke("agent_start", { runId, program, args, cwd, input: input ?? null });
  } catch (e) {
    handlers.delete(runId);
    throw e;
  }
}

export function stopProcess(runId: string): Promise<void> {
  return invoke<void>("agent_stop", { runId }).catch(() => undefined);
}

export const writeProcess = (runId: string, line: string) => invoke<void>("agent_write", { runId, line });
export const endInput = (runId: string) => invoke<void>("agent_end_input", { runId }).catch(() => undefined);

const logged = new Set<string>();

/** Reports a front-end problem once: to the app's stderr in the desktop app, to the console in a browser. */
export function logLine(line: string): void {
  if (logged.has(line)) return;
  logged.add(line);
  if (inTauri) void invoke("log_line", { line }).catch(() => undefined);
  else console.error(line);
}

/** Names of the agent programs found on this computer: any of "claude", "codex", "hermes". */
export const detectEngines = () => invoke<string[]>("detect_engines");
export const ensureSpace = (name: string) => invoke<string>("ensure_space", { name });
export const listFiles = (dir: string) => invoke<DiskFile[]>("list_files", { dir });
export const readText = (path: string, maxBytes?: number) => invoke<string>("read_text", { path, maxBytes });

/** Saves a text file inside the CubeSpaces folder and returns its new modified time. */
export const writeText = (path: string, content: string) => invoke<number>("write_text", { path, content });

/** Saves base64 bytes inside a conversation folder and returns the path it ended up at, relative to that folder. */
export const writeBytes = (dir: string, rel: string, data: string, replace = false) => invoke<string>("write_bytes", { dir, rel, data, replace });
export const readBytes = (path: string) => invoke<string>("read_bytes", { path });

/**
 * The address of a file under CubeSpaces for showing a page. Unlike `convertFileSrc`, it keeps
 * the folders in the address, so what the page links to beside itself (styles, scripts, pictures,
 * other pages) is found.
 */
export const pageUrl = (path: string) => `${convertFileSrc("").replace(/\/*$/, "")}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Has the system make a page out of a document the Stage cannot draw itself, and returns that page's path. */
export const quickLook = (path: string) => invoke<string>("quick_look", { path });

export const createFile = (dir: string, rel: string) => invoke<string>("create_file", { dir, rel });
export const renamePath = (dir: string, from: string, to: string) => invoke<void>("rename_path", { dir, from, to });
/** Moves a file to the macOS Trash. */
export const trashPath = (dir: string, rel: string) => invoke<void>("trash_path", { dir, rel });

export interface Hit {
  rel: string;
  line: number;
  col: number;
  text: string;
}
export const searchText = (dir: string, query: string) => invoke<Hit[]>("search_text", { dir, query });

/** Copies a conversation folder as it is now, under an id it can later be restored by. */
export const checkpointSave = (conv: string, id: string) => invoke<number>("checkpoint_save", { conv, id });
export const checkpointRestore = (conv: string, id: string) => invoke<number>("checkpoint_restore", { conv, id });

export const termOpen = (id: string, cwd: string, cols: number, rows: number) => invoke<void>("term_open", { id, cwd, cols, rows });
export const termWrite = (id: string, data: string) => invoke<void>("term_write", { id, data }).catch(() => undefined);
export const termResize = (id: string, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }).catch(() => undefined);
export const onTermData = (fn: (e: { id: string; data: string; ended: boolean }) => void) =>
  listen<{ id: string; data: string; ended: boolean }>("term-data", (e) => fn(e.payload));

/** Model provider keys live in the macOS Keychain. The window only ever holds one while a request is being made. */
export const keySet = (provider: string, key: string) => invoke<void>("key_set", { provider, key });
export const keyGet = (provider: string) => invoke<string>("key_get", { provider });
export const keyDelete = (provider: string) => invoke<void>("key_delete", { provider });
/** The providers a key is saved for. */
export const keyList = () => (inTauri ? invoke<string[]>("key_list") : Promise.resolve([] as string[]));
export const runCommand = (dir: string, command: string, timeout?: number) => invoke<{ output: string; code: number | null }>("run_command", { dir, command, timeout });

/** The agent descriptions in ~/CubeSpaces/.agents, as [file name, content]. */
export const customAgents = () => (inTauri ? invoke<[string, string][]>("custom_agents") : Promise.resolve([] as [string, string][]));

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
}
/** Starts Cube's own browser if needed and returns the port agents can reach it on. */
export const browserStart = () => invoke<number>("browser_start");
export const browserTabs = () => invoke<BrowserTab[]>("browser_tabs");
export const browserNew = () => invoke<string>("browser_new");
export const browserCloseTab = (id: string) => invoke<void>("browser_close_tab", { id });
export const browserView = (target: string) => invoke<void>("browser_view", { target });
/** One DevTools Protocol command for the tab in view. Failures are dropped: the next frame shows the truth. */
export const browserSend = (method: string, params: Record<string, unknown> = {}) => invoke<void>("browser_send", { method, params }).catch(() => undefined);
export const onBrowser = <T,>(event: "browser-frame" | "browser-nav" | "browser-closed", fn: (payload: T) => void) => listen<T>(event, (e) => fn(e.payload));

export interface Win {
  id: number;
  app: string;
  w: number;
  h: number;
  /** The app's icon as a base64 PNG, when it could be read. */
  icon?: string;
}
/** App windows on screen, front to back. */
export interface KnowledgeEntry {
  /** Path inside the knowledge folder; for a skill, its folder. */
  rel: string;
  /** The file to read to show it. */
  path: string;
  name: string;
  description: string;
  kind: string;
  source: string;
  mtime: number;
}
export interface KnowledgeListing {
  dir: string;
  memory: KnowledgeEntry[];
  skills: KnowledgeEntry[];
  wiki: KnowledgeEntry[];
  imported: number;
  /** Batches of imported notes waiting to be worked into memory, in order. */
  batches: string[];
  inbox: string[];
  marked: string[];
}
/** Everything in Cube's knowledge folder (memory, skills, wiki), read for showing. */
export const knowledgeList = () => invoke<KnowledgeListing>("knowledge_list");
/** Copies in what Claude Code, Codex and Hermes remember. Changes nothing in their folders. */
export const knowledgeImport = () => invoke<{ source: string; notes: number }[]>("knowledge_import");
/** Writes Cube's memory and skills where each program reads them. */
export const knowledgeExport = (targets: string[]) => invoke<{ target: string; memory: string; skills: number }[]>("knowledge_export", { targets });
export const knowledgeRemove = (rels: string[]) => invoke<void>("knowledge_remove", { rels });

export interface TeamInfo {
  host: string;
  ws: string;
  workspace: string;
  pubkey: string;
}
/** The team this Cube has joined, if any. The key itself stays on the Rust side. */
export const teamInfo = () => invoke<TeamInfo | null>("team_info");
export const teamJoin = (link: string, name: string) => invoke<TeamInfo>("team_join", { link, name });
export const teamStart = () => invoke<void>("team_start");
export const teamLeave = () => invoke<void>("team_leave");
/** Signs and publishes one event of a kind the protocol defines. Resolves with its sequence number. */
export const teamPublish = (kind: string, body: string) => invoke<number>("team_publish", { kind, body });
/** Asks the relay for history, an invite or a member change. The answer arrives through `teamListen`. */
export const teamAsk = (frame: Record<string, unknown>) => invoke<void>("team_ask", { frame });
/** Hears everything the relay says, after the Rust side has checked it. */
/** Asks the relay something whose answer comes straight back: what is in a channel's shared folder, or a file's history. */
export const teamRequest = (frame: Record<string, unknown>) => invoke<Record<string, unknown>>("team_request", { frame });

/** A file in a conversation folder as the shared-folder scan sees it. `skip` says why it is never shared. */
export interface DriveFile {
  rel: string;
  size: number;
  mtime: number;
  sha?: string | null;
  skip?: "name" | "secret" | "big" | null;
}
type By = { agent: string; color?: string };
/** Why a shared-folder step failed: the relay's short code (`stale`, `quota`…) or `local`, and what to tell the person. */
export interface DriveFail {
  code: string;
  message: string;
}
export const driveScan = (dir: string) => invoke<DriveFile[]>("drive_scan", { dir });
/** Shares the file at `rel` as the channel's `path`. Rejects with a `DriveFail`. */
export const drivePut = (conv: string, dir: string, rel: string, path: string, base: string, by?: By) => invoke<{ sha: string; size: number; seq: number }>("drive_put", { conv, dir, rel, path, base, by });
export const driveDrop = (conv: string, dir: string, rel: string, path: string, base: string, by?: By) => invoke<number>("drive_drop", { conv, dir, rel, path, base, by });
/** Brings a version down to `rel`, unless the file there is not what `expect` says (then `changed`). */
export const driveGet = (conv: string, dir: string, rel: string, sha: string, size: number, expect?: string) => invoke<{ state: "written" | "changed"; mtime: number }>("drive_get", { conv, dir, rel, sha, size, expect });
export const driveMerge = (conv: string, dir: string, rel: string, base: string | undefined, sha: string, size: number, copy: string) => invoke<{ outcome: "same" | "merged" | "copied"; copy?: string | null }>("drive_merge", { conv, dir, rel, base, sha, size, copy });
export const driveTrash = (dir: string, rel: string, expect: string) => invoke<boolean>("drive_trash", { dir, rel, expect });

export const teamListen = (on: (v: Record<string, unknown> & { t: string }) => void) => listen<Record<string, unknown> & { t: string }>("team-ev", (e) => on(e.payload));

/** What one agent program has on this computer, with the file each thing lives in. */
export interface ProgramLibrary {
  skills: { name: string; about: string; path: string }[];
  memory: { name: string; about: string; path: string }[];
}
export const libraryProgram = (program: string) => invoke<ProgramLibrary>("library_program", { program });
/** The text of a skill or note the library lists. Markdown in the programs' folders and Cube's knowledge folder only. */
export const libraryRead = (path: string) => invoke<string>("library_read", { path });

/** Saves the person's Slack app tokens in the Keychain, after trying them once. They never come back to the webview. */
export const slackSet = (bot: string, app: string) => invoke<void>("slack_set", { bot, app });
export const slackConfigured = () => invoke<boolean>("slack_configured");
export const slackClear = () => invoke<void>("slack_clear");
export const slackStart = () => invoke<void>("slack_start");
/** Posts into a Slack thread; resolves with the new message's timestamp. */
export const slackPost = (channel: string, threadTs: string, text: string) => invoke<string>("slack_post", { channel, threadTs, text });
export const slackUser = (user: string) => invoke<string>("slack_user", { user });
/** Hears the Slack connection's state and the messages written to the Cube bot. */
/** The permissions the Slack app was installed with. */
export const slackScopes = () => invoke<string[]>("slack_scopes");
/** Puts a picture inside ~/CubeSpaces into a Slack thread. */
export const slackUpload = (channel: string, threadTs: string, path: string, title: string) => invoke<void>("slack_upload", { channel, threadTs, path, title });
/** Has Codex's image tool draw a picture into `<dir>/pictures`. Returns the file's path. Takes a minute or two. */
export const drawPicture = (id: string, dir: string, name: string, description: string) => invoke<string>("draw_picture", { id, dir, name, description });
/** What the drawing is doing right now, as short lines, each with the id its request was made with. */
export const pictureListen = (on: (v: { id: string; text: string }) => void) => listen<{ id: string; text: string }>("picture-ev", (e) => on(e.payload));
export const slackListen = (on: (v: Record<string, unknown> & { t: string }) => void) => listen<Record<string, unknown> & { t: string }>("slack-ev", (e) => on(e.payload));

/** An agent card, as the text the address returned. */
export const remoteCard = (url: string) => invoke<string>("remote_card", { url });
/** Saves a remote agent's credential in the Keychain, tied to the address it is for. It never comes back to the webview. */
export const remoteSecretSet = (id: string, endpoint: string, secret: string) => invoke<void>("remote_secret_set", { id, endpoint, secret });
export const remoteSecretHas = (id: string) => (inTauri ? invoke<boolean>("remote_secret_has", { id }) : Promise.resolve(false));
export const remoteSecretDelete = (id: string) => invoke<void>("remote_secret_delete", { id });
export const remoteStop = (run: string) => invoke<void>("remote_stop", { run });

interface RemoteCall {
  id: string;
  url: string;
  contentType: string;
  headers: [string, string][];
  auth: { kind: string; header?: string };
  body: string;
  stream: boolean;
}

const remoteRuns = new Map<string, (t: "data" | "error" | "done", text: string) => void>();
let remoteHeard = false;

/** Sends a request to a remote agent. `on` hears each object it sends, then "done" or "error". */
export async function remoteCall(run: string, call: RemoteCall, on: (t: "data" | "error" | "done", text: string) => void): Promise<void> {
  if (!remoteHeard) {
    remoteHeard = true;
    await listen<{ run: string; t: "data" | "error" | "done"; text: string }>("remote-ev", (e) => {
      const hear = remoteRuns.get(e.payload.run);
      if (!hear) return;
      if (e.payload.t !== "data") remoteRuns.delete(e.payload.run);
      hear(e.payload.t, e.payload.text);
    });
  }
  remoteRuns.set(run, on);
  try {
    await invoke<void>("remote_call", { run, ...call });
  } catch (e) {
    remoteRuns.delete(run);
    throw e;
  }
}

export const windowsList = () => invoke<Win[]>("windows_list");
/** The icons this Mac shows for files with these extensions, as base64 PNGs by extension. */
export const fileIcons = (exts: string[]) => invoke<Record<string, string>>("file_icons", { exts });
/** A JPEG of one window as it looks now, base64. */
export const windowShot = (id: number) => invoke<string>("window_shot", { id });

export interface HarnessItem {
  name: string;
  about: string;
}

/** What an agent program already has set up on this computer. Names and descriptions only. */
export interface Harness {
  /** The model the program uses when Cube names none. Empty when its settings do not say. */
  model: string;
  effort: string;
  skills: HarnessItem[];
  mcp: HarnessItem[];
  plugins: HarnessItem[];
}

const SAMPLE: Harness = {
  model: "preview-model",
  effort: "medium",
  skills: [
    { name: "docs", about: "Writes and edits shared documents." },
    { name: "frontend", about: "Builds pages and components with care for how they read." },
    { name: "browser", about: "Opens pages, fills forms and takes screenshots." },
  ],
  mcp: [{ name: "github", about: "remote" }, { name: "notes", about: "runs on this computer" }],
  plugins: [{ name: "slack", about: "sample marketplace" }],
};

export function getHarness(engine: AgentKind): Promise<Harness> {
  // The built-in agent brings nothing of its own: its model is whatever the role names.
  if (engine === "api" || engine === "custom" || engine === "remote") return Promise.resolve({ model: "", effort: "", skills: [], mcp: [], plugins: [] });
  return inTauri ? invoke<Harness>("harness", { engine }) : Promise.resolve(SAMPLE);
}
