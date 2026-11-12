import { runCommand } from "./runner";

/** A string as one shell word, whatever is in it. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Runs a git (or gh) command line in a folder inside CubeSpaces. */
export async function sh(dir: string, command: string, timeout = 60): Promise<{ ok: boolean; out: string }> {
  const done = await runCommand(dir, command, timeout);
  return { ok: done.code === 0, out: done.output.trim() };
}

/** Git with a stand-in author, used only when the person has no name and email set up for git. */
const AS_CUBE = "git -c user.name=Cube -c user.email=cube@localhost";

/** A git subcommand that records something (commit, merge), run as the person, or as Cube when they have no git identity. */
export const record = (rest: string) => `if [ -z "$(git config user.email)" ]; then ${AS_CUBE} ${rest}; else git ${rest}; fi`;

/** Stages everything and records it under a message, when there is anything to record. */
export const saveAll = (message: string) => `git add -A && (git diff --cached --quiet || ${record(`commit -q -m ${q(message)}`)})`;

export interface RepoState {
  branch: string;
  /** Files changed and not committed. */
  dirty: number;
  ahead: number;
  remote: boolean;
}

/** `git status --porcelain=v1 -b` → the branch, how far ahead it is, and how many files are uncommitted. */
export function parseStatus(text: string): Omit<RepoState, "remote"> {
  const lines = text.split("\n").filter(Boolean);
  const head = lines.find((l) => l.startsWith("## ")) ?? "";
  const branch = head.slice(3).replace(/^No commits yet on /, "").split("...")[0].split(" ")[0] || "main";
  const ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0);
  return { branch, ahead, dirty: lines.filter((l) => !l.startsWith("## ")).length };
}

/** The state of the conversation folder as a git repository, or null when it is not one. */
export async function repoState(dir: string): Promise<RepoState | null> {
  const st = await sh(dir, "git status --porcelain=v1 -b 2>/dev/null");
  if (!st.ok) return null;
  const remote = await sh(dir, "git remote");
  return { ...parseStatus(st.out), remote: remote.ok && Boolean(remote.out) };
}

export interface PrState {
  number: number;
  url: string;
  title: string;
  failing: string[];
  pending: number;
  passing: number;
}

/** `gh pr view --json number,url,title,statusCheckRollup` → the pull request and how its checks stand. */
export function parsePr(json: string): PrState | null {
  let o: any;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof o?.number !== "number") return null;
  const pr: PrState = { number: o.number, url: String(o.url ?? ""), title: String(o.title ?? ""), failing: [], pending: 0, passing: 0 };
  for (const c of o.statusCheckRollup ?? []) {
    const result = String(c.conclusion || c.state || c.status || "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(result)) pr.failing.push(String(c.name ?? c.context ?? "a check"));
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(result)) pr.passing++;
    else pr.pending++;
  }
  return pr;
}

export async function prState(dir: string): Promise<PrState | null> {
  const got = await sh(dir, "gh pr view --json number,url,title,statusCheckRollup 2>/dev/null", 30);
  return got.ok ? parsePr(got.out) : null;
}
