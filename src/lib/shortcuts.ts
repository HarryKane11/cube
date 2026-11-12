/** The keyboard shortcuts Cube answers to, in the order they are listed for the person. ⌘ is Ctrl on Windows and Linux. */
export const SHORTCUTS: { keys: string; does: string }[] = [
  { keys: "⌘K", does: "Search and jump to a conversation" },
  { keys: "⌘1 – ⌘9", does: "Open the first to ninth conversation in the sidebar" },
  { keys: "⌥⌘↑ / ⌥⌘↓", does: "Go to the conversation above or below" },
  { keys: "⌘N", does: "New channel" },
  { keys: "⇧⌘N", does: "New message to a teammate" },
  { keys: "⇧⌘I", does: "Share this channel and invite people" },
  { keys: "⌘.", does: "Show or hide the Stage" },
  { keys: "⌘B", does: "Show or hide the sidebar" },
  { keys: "⌘,", does: "Settings" },
  { keys: "⌘+ / ⌘− / ⌘0", does: "Bigger, smaller, normal size" },
  { keys: "⌘/", does: "Show this list" },
];

/** What a key press with ⌘ (or Ctrl) held asks for, or undefined when it is not one of Cube's own. */
export type Command =
  | { t: "switch" } | { t: "sidebar" } | { t: "settings" } | { t: "channel" } | { t: "dm" } | { t: "invite" } | { t: "stage" } | { t: "help" }
  | { t: "nth"; n: number } | { t: "step"; by: 1 | -1 };

export function commandFor(e: { key: string; shiftKey: boolean; altKey: boolean }): Command | undefined {
  const key = e.key.toLowerCase();
  if (e.altKey) return key === "arrowup" ? { t: "step", by: -1 } : key === "arrowdown" ? { t: "step", by: 1 } : undefined;
  if (e.shiftKey) return key === "n" ? { t: "dm" } : key === "i" ? { t: "invite" } : undefined;
  if (key === "k") return { t: "switch" };
  if (key === "b") return { t: "sidebar" };
  if (key === ",") return { t: "settings" };
  if (key === "n") return { t: "channel" };
  if (key === ".") return { t: "stage" };
  if (key === "/") return { t: "help" };
  if (/^[1-9]$/.test(key)) return { t: "nth", n: Number(key) };
  return undefined;
}
