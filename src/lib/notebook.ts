/** A Jupyter notebook, read into what the Stage draws: cells in order, each with what it printed. */

export type NbOutput =
  | { type: "text"; text: string; stream?: "stdout" | "stderr" }
  | { type: "error"; name: string; text: string }
  | { type: "image"; src: string }
  | { type: "html"; html: string; rows: number }
  | { type: "markdown"; text: string };

export interface NbCell {
  kind: "markdown" | "code" | "raw";
  source: string;
  /** The number in the brackets: which run produced the outputs. */
  count?: number;
  outputs: NbOutput[];
}

export interface Notebook {
  /** The language of the code cells, for colouring. */
  language: string;
  cells: NbCell[];
}

type Json = Record<string, unknown>;

/** Notebook text is stored as one string or as a list of lines. */
const joined = (v: unknown): string => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");

/** Terminal colour codes, which tracebacks are full of. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

function outputOf(raw: Json): NbOutput | undefined {
  const type = raw.output_type;
  if (type === "stream") {
    const text = plain(joined(raw.text));
    return text ? { type: "text", text, stream: raw.name === "stderr" ? "stderr" : "stdout" } : undefined;
  }
  if (type === "error" || type === "pyerr") {
    const trace = Array.isArray(raw.traceback) ? raw.traceback.join("\n") : "";
    return { type: "error", name: String(raw.ename ?? "Error"), text: plain(trace || `${raw.ename ?? "Error"}: ${raw.evalue ?? ""}`) };
  }
  // A result comes in several forms at once: the richest one the Stage can draw wins.
  const data = (raw.data ?? raw) as Json;
  for (const mime of ["image/png", "image/jpeg", "image/gif"]) {
    const bytes = joined(data[mime]).replace(/\s+/g, "");
    if (bytes) return { type: "image", src: `data:${mime};base64,${bytes}` };
  }
  const svg = joined(data["image/svg+xml"]);
  if (svg) return { type: "image", src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` };
  const html = joined(data["text/html"]);
  if (html) return { type: "html", html, rows: (html.match(/<tr[\s>]/gi) ?? []).length };
  const markdown = joined(data["text/markdown"]);
  if (markdown) return { type: "markdown", text: markdown };
  const text = plain(joined(data["text/plain"]) || joined(data["text/latex"]) || joined(raw.text));
  return text ? { type: "text", text } : undefined;
}

/** Reads a notebook file. Returns null when the text is not a notebook. */
export function parseNotebook(text: string): Notebook | null {
  let nb: Json;
  try {
    nb = JSON.parse(text) as Json;
  } catch {
    return null;
  }
  if (!nb || typeof nb !== "object") return null;
  // Version 3 kept its cells inside worksheets.
  const sheets = nb.worksheets as Json[] | undefined;
  const raw = Array.isArray(nb.cells) ? nb.cells : Array.isArray(sheets) ? sheets.flatMap((w) => (Array.isArray(w.cells) ? w.cells : [])) : null;
  if (!raw) return null;
  const meta = (nb.metadata ?? {}) as Json;
  const language = String((meta.language_info as Json | undefined)?.name ?? (meta.kernelspec as Json | undefined)?.language ?? "python");
  const cells = (raw as Json[]).map((c): NbCell => {
    const kind = c.cell_type === "markdown" || c.cell_type === "heading" ? "markdown" : c.cell_type === "code" ? "code" : "raw";
    const source = joined(c.source ?? c.input);
    const count = typeof c.execution_count === "number" ? c.execution_count : typeof c.prompt_number === "number" ? c.prompt_number : undefined;
    const outputs = kind === "code" && Array.isArray(c.outputs) ? (c.outputs as Json[]).map(outputOf).filter((o): o is NbOutput => Boolean(o)) : [];
    // Version 3 headings carry their level beside the text.
    const heading = c.cell_type === "heading" ? `${"#".repeat(Number(c.level) || 1)} ` : "";
    return { kind, source: heading + source, count, outputs };
  });
  return { language, cells };
}

export type NbEdit =
  | { op: "source"; index: number; source: string }
  | { op: "add"; after: number; kind: "markdown" | "code" }
  | { op: "delete"; index: number };

/**
 * A notebook file's text with one change made to its cells. Everything else in the file (outputs,
 * metadata, cell ids) is kept. Returns null when the text is not a version 4 notebook, the only
 * kind the Stage edits.
 */
export function editNotebook(text: string, edit: NbEdit): string | null {
  let nb: Json;
  try {
    nb = JSON.parse(text) as Json;
  } catch {
    return null;
  }
  if (!nb || typeof nb !== "object" || !Array.isArray(nb.cells)) return null;
  const cells = nb.cells as Json[];
  // Jupyter keeps a cell's text as a list of lines, each but the last ending in a line break.
  const lines = (source: string) => source.split(/(?<=\n)/).filter((l) => l !== "");
  if (edit.op === "source") {
    const cell = cells[edit.index];
    if (!cell) return null;
    cell.source = typeof cell.source === "string" ? edit.source : lines(edit.source);
  } else if (edit.op === "add") {
    const cell: Json = edit.kind === "code"
      ? { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [] }
      : { cell_type: "markdown", metadata: {}, source: [] };
    // Notebooks from format 4.5 on give every cell an id.
    if (cells.some((c) => typeof c.id === "string")) cell.id = Math.random().toString(16).slice(2, 10);
    cells.splice(edit.after + 1, 0, cell);
  } else {
    if (!cells[edit.index]) return null;
    cells.splice(edit.index, 1);
  }
  return `${JSON.stringify(nb, null, 1)}\n`;
}
