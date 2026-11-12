/** One row of the Stage's file tree: a folder with children, or a file. */
export interface TreeNode {
  name: string;
  /** Path from the conversation folder, with forward slashes. */
  rel: string;
  dir: boolean;
  children: TreeNode[];
}

/** Turns flat relative paths into a tree, folders before files, each level in name order. */
export function buildTree(rels: string[]): TreeNode[] {
  const root: TreeNode = { name: "", rel: "", dir: true, children: [] };
  for (const rel of rels) {
    const parts = rel.split("/").filter(Boolean);
    let at = root;
    parts.forEach((name, i) => {
      const last = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let next = at.children.find((c) => c.name === name && c.dir === !last);
      if (!next) {
        next = { name, rel: path, dir: !last, children: [] };
        at.children.push(next);
      }
      at = next;
    });
  }
  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
    nodes.forEach((n) => sort(n.children));
    return nodes;
  };
  return sort(root.children);
}

/** How the conversation's files looked when the person last spoke: the point agents' changes are measured from. */
export interface Baseline {
  at: number;
  /** Relative path → when it was last modified then, and its text when it is a text file small enough to keep. */
  files: Record<string, { mtime: number; text?: string }>;
}

export type Change = "added" | "changed";

/** Which files are new or different since the baseline. Empty when there is no baseline yet. */
export function changesSince(files: { rel: string; mtime: number }[], base: Baseline | undefined): Record<string, Change> {
  const out: Record<string, Change> = {};
  if (!base) return out;
  for (const f of files) {
    const was = base.files[f.rel];
    if (!was) out[f.rel] = "added";
    else if (was.mtime !== f.mtime) out[f.rel] = "changed";
  }
  return out;
}

/** One place a search found its text. Lines and columns start at 1. */
export interface Found {
  rel: string;
  line: number;
  col: number;
  text: string;
}

/**
 * Finds text in files held in memory. Lower-case queries match any case; a query with a
 * capital letter matches exactly. The desktop app searches on disk with the same rules.
 */
export function searchFiles(files: { rel: string; text: string }[], query: string, max = 400): Found[] {
  const out: Found[] = [];
  if (!query.trim()) return out;
  const exact = /\p{Lu}/u.test(query);
  const needle = exact ? query : query.toLowerCase();
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const lines = f.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const at = (exact ? lines[i] : lines[i].toLowerCase()).indexOf(needle);
      if (at < 0) continue;
      out.push({ rel: f.rel, line: i + 1, col: at + 1, text: lines[i].trim().slice(0, 180) });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** A selection handed to the conversation: where it is from, then the code itself. */
export function quoteOf(rel: string, fromLine: number, toLine: number, code: string): string {
  const where = fromLine === toLine ? `line ${fromLine}` : `lines ${fromLine}-${toLine}`;
  const lang = rel.includes(".") ? rel.split(".").pop() : "";
  // A fence longer than any run of backticks inside the code, so the block cannot end early.
  const fence = "`".repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((t) => t.length + 1)));
  return `In \`${rel}\` (${where}):\n${fence}${lang}\n${code.replace(/\n+$/, "")}\n${fence}\n`;
}
