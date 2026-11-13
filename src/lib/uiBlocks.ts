/**
 * Finding the views in a reply. A cube writes a view as a fenced block named `openui-lang`
 * (see components/intelligent/library.tsx); everything else in the reply is ordinary text.
 * This file holds what can be worked out without drawing anything.
 */

const OPEN = /^[ \t]*(```+|~~~+)[ \t]*(openui-lang|openui)[ \t]*$/i;

export interface ReplyPart {
  /** True for the program of a view, false for ordinary text. */
  ui: boolean;
  body: string;
  /** A view whose block has not been closed yet: it is still being written. */
  open?: boolean;
}

/** The reply as ordinary text and views, in order. A reply without a view comes back as one part of text. */
export function splitUi(text: string): ReplyPart[] {
  const parts: ReplyPart[] = [];
  let lines: string[] = [];
  let fence: string | undefined;
  const flush = (ui: boolean, open?: boolean) => {
    const body = lines.join("\n");
    if (body.trim()) parts.push(open ? { ui, body, open } : { ui, body });
    lines = [];
  };
  for (const line of text.split("\n")) {
    if (fence === undefined) {
      const m = OPEN.exec(line);
      if (m) {
        flush(false);
        fence = m[1];
        continue;
      }
    } else if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, "") === "") {
      flush(true);
      fence = undefined;
      continue;
    }
    lines.push(line);
  }
  flush(fence !== undefined, fence !== undefined ? true : undefined);
  return parts;
}

/** True when a reply holds a view, closed or still being written. */
export const hasUi = (text: string): boolean => /(^|\n)[ \t]*(```+|~~~+)[ \t]*(openui-lang|openui)[ \t]*(\n|$)/i.test(text);

/** The reply with its fenced blocks taken out: what names and marks are looked for in. */
export const withoutFences = (text: string): string => text.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, "$1");

/**
 * What pressing a button of a view would say to the cubes, as the person will see it before it
 * is sent: the words, and under them what was filled in or handed along, when there is any.
 */
export function actionMessage(said: string, extras: unknown[]): string {
  const lines: string[] = [];
  const add = (key: string, value: unknown) => {
    const v = value && typeof value === "object" && "value" in (value as object) ? (value as { value: unknown }).value : value;
    if (v === undefined || v === null || v === "") return;
    lines.push(`- ${key}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  };
  for (const extra of extras) {
    if (typeof extra === "string") {
      if (extra.trim()) lines.push(extra.trim());
    } else if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
        // A form's fields come one level down, under the form's name.
        if (v && typeof v === "object" && !("value" in (v as object)) && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) add(k2, v2);
        else add(k, v);
      }
    }
  }
  return [said.trim(), ...lines].filter(Boolean).join("\n").slice(0, 4000);
}
