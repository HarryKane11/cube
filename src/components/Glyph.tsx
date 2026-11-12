import { useSyncExternalStore } from "react";
import { fileIcons, inTauri } from "@/agents/runner";
import { extOf, hasSystemIcon, type FileKind } from "@/lib/files";
import { cn } from "@/lib/utils";

// The system's icons for office files, by extension. Asked for once per extension, together.
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
    const exts = [...waiting];
    fileIcons(exts)
      .catch(() => ({}) as Record<string, string>)
      .then((got) => {
        for (const e of exts) {
          icons.set(e, got[e] ?? null);
          waiting.delete(e);
        }
        listeners.forEach((l) => l());
      });
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/**
 * The small mark beside a file's name. Office documents get the icon this Mac shows for them
 * (Word's, Excel's, PowerPoint's, Pages'…); everything else gets Cube's own mark for its kind.
 */
export function Glyph({ kind, name, small }: { kind: FileKind; name?: string; small?: boolean }) {
  const ext = name && hasSystemIcon(kind) ? extOf(name) : "";
  const icon = useSyncExternalStore(subscribe, () => (ext ? icons.get(ext) : undefined));
  if (ext) want(ext);
  if (icon) return <span className={cn("glyph glyph-icon", small && "glyph-sm")} aria-hidden="true"><img src={`data:image/png;base64,${icon}`} alt="" draggable={false} /></span>;
  return <span className={cn("glyph", `glyph-${kind}`, small && "glyph-sm")} aria-hidden="true"><i /></span>;
}
