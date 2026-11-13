import { useSyncExternalStore } from "react";
import { fileIcons, inTauri } from "@/agents/runner";
import { extOf, hasSystemIcon, type FileKind } from "@/lib/files";
import { cn } from "@/lib/utils";

// The system's icons for files, by extension. Asked for once per extension, together.
const icons = new Map<string, string | null>();
const waiting = new Set<string>();
const listeners = new Set<() => void>();
let queued = false;

function want(ext: string) {
  if (!inTauri || icons.has(ext) || waiting.has(ext)) return;
  waiting.add(ext);
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    const all = [...waiting];
    // The system is asked for a few dozen kinds at a time: a folder of code has more than one call takes.
    for (let i = 0; i < all.length; i += 30) {
      const exts = all.slice(i, i + 30);
      fileIcons(exts)
        .catch(() => ({}) as Record<string, string>)
        .then((got) => {
          for (const e of exts) {
            icons.set(e, got[e] ?? null);
            waiting.delete(e);
          }
          listeners.forEach((l) => l());
        });
    }
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/**
 * The small mark beside a file's name: the icon this Mac shows for that kind of file, as in
 * Finder. Where there is none to be had (the browser preview, a file with no extension, or
 * while the icon is on its way) it is Cube's own mark for the kind.
 */
export function Glyph({ kind, name, small }: { kind: FileKind; name?: string; small?: boolean }) {
  const ext = name && hasSystemIcon(kind) ? extOf(name) : "";
  const icon = useSyncExternalStore(subscribe, () => (ext ? icons.get(ext) : undefined));
  if (ext) want(ext);
  if (icon) return <span className={cn("glyph glyph-icon", small && "glyph-sm")} aria-hidden="true"><img src={`data:image/png;base64,${icon}`} alt="" draggable={false} /></span>;
  return <span className={cn("glyph", `glyph-${kind}`, small && "glyph-sm")} aria-hidden="true"><i /></span>;
}
