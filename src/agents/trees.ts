import { q, record, saveAll, sh } from "./git";

/**
 * Separate copies: each cube works in its own git worktree of the conversation folder, on its
 * own branch, so cubes working at the same time never write over each other. What a cube did
 * reaches the shared folder when the person merges it.
 */

/** What a run left on its own branch, for the person to look at, merge or drop. */
export interface Branch {
  name: string;
  /** The cube's own copy of the folder. */
  tree: string;
  files: number;
  /** One line per changed file. */
  summary: string;
  state: "open" | "merged" | "dropped";
}

export const branchOf = (agentId: string) => `cube/${agentId}`;
export const treeOf = (root: string, convId: string, agentId: string) => `${root}/.trees/${convId}/${agentId}`;

/** The CubeSpaces folder, from a conversation folder inside it. */
export const rootOf = (dir: string) => dir.slice(0, dir.lastIndexOf("/"));

/** Makes the conversation folder a git repository if it is not one yet, with what is in it as the first entry in its history. */
export async function ensureRepo(dir: string): Promise<string | null> {
  if ((await sh(dir, "git rev-parse --is-inside-work-tree 2>/dev/null")).out === "true") {
    // A repository with no history yet cannot have worktrees.
    if ((await sh(dir, "git rev-parse --verify -q HEAD")).ok) return null;
  } else {
    const made = await sh(dir, "git init -q");
    if (!made.ok) return made.out || "Could not start tracking this folder with git.";
  }
  const first = await sh(dir, `git add -A && ${record(`commit -q --allow-empty -m ${q("Start of this conversation's folder")}`)}`);
  return first.ok ? null : first.out || "Could not record the folder's starting point.";
}

/** Gets a cube's own copy ready, caught up with the shared folder. Returns its path. */
export async function prepareTree(dir: string, convId: string, agentId: string, from?: string): Promise<string> {
  const tree = treeOf(rootOf(dir), convId, agentId);
  const branch = branchOf(agentId);
  const exists = (await sh(dir, `test -e ${q(`${tree}/.git`)}`)).ok;
  // What is in the shared folder right now is what the cube starts from, recorded or not.
  await sh(dir, saveAll("Shared folder, before a cube starts in its own copy"));
  if (!exists) {
    const made = await sh(dir, `mkdir -p ${q(tree.slice(0, tree.lastIndexOf("/")))} && git worktree prune && git worktree add -q -B ${q(branch)} ${q(tree)} HEAD`);
    if (!made.ok) throw new Error(made.out || "Could not make a separate copy for this cube.");
  } else {
    // Catch up with the shared folder. If that does not fit cleanly, the cube works from where it was.
    const main = (await sh(dir, "git rev-parse --abbrev-ref HEAD")).out;
    const caught = await sh(tree, record(`merge -q --no-edit ${q(main)}`));
    if (!caught.ok) await sh(tree, "git merge --abort");
  }
  if (from && (await sh(dir, `git rev-parse --verify -q ${q(from)}`)).ok) {
    // Picking up a teammate's handoff: bring in what they left on their branch.
    const got = await sh(tree, record(`merge -q --no-edit ${q(from)}`));
    if (!got.ok) await sh(tree, "git merge --abort");
  }
  return tree;
}

/** After a run: records what the cube did in its copy and says how it differs from the shared folder. */
export async function closeTree(dir: string, convId: string, agentId: string, label: string): Promise<Branch | undefined> {
  const tree = treeOf(rootOf(dir), convId, agentId);
  const branch = branchOf(agentId);
  await sh(tree, saveAll(label));
  const stat = await sh(dir, `git diff --stat=120 HEAD...${q(branch)}`);
  const lines = stat.out.split("\n").filter((l) => l.includes("|"));
  if (!stat.ok || !lines.length) return undefined;
  return { name: branch, tree, files: lines.length, summary: lines.map((l) => l.trim()).join("\n"), state: "open" };
}

/** The whole difference between the shared folder and a cube's branch. */
export async function branchDiff(dir: string, branch: string): Promise<string> {
  return (await sh(dir, `git diff HEAD...${q(branch)}`)).out;
}

/** Brings a cube's branch into the shared folder. Returns what went wrong, or null. */
export async function mergeBranch(dir: string, branch: string): Promise<string | null> {
  await sh(dir, saveAll(`Shared folder, before merging ${branch}`));
  const merged = await sh(dir, record(`merge -q --no-edit ${q(branch)}`));
  if (merged.ok) return null;
  const files = (await sh(dir, "git diff --name-only --diff-filter=U")).out.split("\n").filter(Boolean);
  await sh(dir, "git merge --abort");
  return files.length ? `It changes the same lines as the shared folder in ${files.join(", ")}. Nothing was merged. Ask a cube to bring the two together.` : merged.out || "The merge did not go through. Nothing was changed.";
}

/** Throws away what a cube did on its branch: its copy goes back to the shared folder's state. */
export async function dropBranch(dir: string, tree: string): Promise<void> {
  const head = (await sh(dir, "git rev-parse HEAD")).out;
  await sh(tree, `git reset -q --hard ${q(head)} && git clean -qfd`);
}
