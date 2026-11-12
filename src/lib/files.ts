export type FileKind = "md" | "html" | "image" | "video" | "audio" | "pdf" | "csv" | "code" | "text" | "word" | "sheet" | "slides" | "notebook" | "other";

const EXT: Record<string, FileKind> = {
  md: "md", markdown: "md",
  html: "html", htm: "html",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
  mp4: "video", webm: "video", mov: "video",
  mp3: "audio", wav: "audio", m4a: "audio",
  pdf: "pdf",
  docx: "word", doc: "word", docm: "word", rtf: "word", pages: "word", odt: "word", hwp: "word", hwpx: "word",
  xlsx: "sheet", xls: "sheet", xlsm: "sheet", xlsb: "sheet", numbers: "sheet", ods: "sheet",
  pptx: "slides", ppt: "slides", pptm: "slides", ppsx: "slides", key: "slides", odp: "slides",
  csv: "csv", tsv: "csv",
  ipynb: "notebook",
  txt: "text", log: "text",
  ts: "code", tsx: "code", js: "code", jsx: "code", py: "code", rs: "code", go: "code", java: "code", rb: "code",
  css: "code", json: "code", yaml: "code", yml: "code", toml: "code", sh: "code", sql: "code", c: "code", cpp: "code", swift: "code",
};

export function kindOf(path: string): FileKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT[ext] ?? "other";
}

export const KIND_LABEL: Record<FileKind, string> = {
  md: "Doc", html: "Page", image: "Image", video: "Video", audio: "Audio", pdf: "PDF", csv: "Sheet", code: "Code", text: "Text", word: "Document", sheet: "Spreadsheet", slides: "Slides", notebook: "Notebook", other: "File",
};

/** Kinds whose content is loaded as text to render. The rest are shown straight from disk. */
export function isTextKind(kind: FileKind): boolean {
  return kind === "md" || kind === "csv" || kind === "code" || kind === "text" || kind === "notebook";
}

/** Kinds the Stage shows through the system's Quick Look: office documents, and anything it does not know. */
export function isLooked(kind: FileKind): boolean {
  return kind === "word" || kind === "sheet" || kind === "slides" || kind === "other";
}

/** Kinds drawn with the icon the system gives their files (Word's, Excel's, PowerPoint's…) when there is one. */
export function hasSystemIcon(kind: FileKind): boolean {
  return kind === "word" || kind === "sheet" || kind === "slides";
}

export const extOf = (path: string) => (path.includes(".") ? path.split(".").pop()!.toLowerCase() : "");

/** Kinds that open in the code editor. */
export function isEditable(kind: FileKind): boolean {
  return isTextKind(kind) || kind === "html";
}

/** Kinds that have a rendered view besides their text. */
export function hasPreview(kind: FileKind): boolean {
  return kind === "md" || kind === "html" || kind === "csv" || kind === "notebook";
}

/** What separates the cells of a sheet kept as text: a tab when its first line has one, else a comma. */
export const csvSep = (text: string) => (text.split("\n", 1)[0].includes("\t") ? "\t" : ",");

/** Rows back to text. Cells holding the separator, a quote or a line break are quoted. */
export function toCsv(rows: string[][], sep = ","): string {
  const cell = (c: string) => (c.includes(sep) || /["\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return rows.map((r) => r.map(cell).join(sep)).join("\n") + (rows.length ? "\n" : "");
}

export function parseCsv(text: string, maxRows = 300): string[][] {
  const sep = csvSep(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
