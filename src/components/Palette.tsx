import { useEffect, useMemo, useRef, useState } from "react";
import { agentById, authorName } from "@/agents/types";
import { timeOf } from "@/components/bits";
import { HashIcon, SearchIcon } from "@/components/icons";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CubeStill } from "@/cube/Cube";
import { searchMessages, snippet } from "@/lib/search";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

/** ⌘K: jump to a conversation by name, or find a message by its words. */
export function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const convs = useCube((s) => s.convs);
  const messages = useCube((s) => s.messages);
  const setActive = useCube((s) => s.setActive);
  const jumpTo = useCube((s) => s.jumpTo);
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const q = query.trim().toLowerCase();
  const places = useMemo(() => convs.filter((c) => !q || c.name.toLowerCase().includes(q)), [convs, q]);
  const found = useMemo(() => (q.length >= 2 ? searchMessages(messages, convs, q) : []), [messages, convs, q]);
  const rows = useMemo(
    () => [...places.map((c) => ({ key: `c:${c.id}`, go: () => setActive(c.id) })), ...found.map((m) => ({ key: `m:${m.id}`, go: () => jumpTo(m.id) }))],
    [places, found, setActive, jumpTo],
  );
  useEffect(() => { if (open) { setQuery(""); setPick(0); } }, [open]);
  useEffect(() => { list.current?.querySelector(`[data-i="${pick}"]`)?.scrollIntoView({ block: "nearest" }); }, [pick]);

  const choose = (i: number) => { rows[i]?.go(); onOpenChange(false); };
  const row = (i: number) => cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left", i === pick && "bg-accent");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-1/4 translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-[560px]" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>Jump to a conversation or find a message</DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 border-b px-3.5">
          <SearchIcon className="flex-none text-muted-foreground" width={16} height={16} />
          <input
            autoFocus
            value={query}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Jump to a conversation, or search messages"
            aria-label="Search conversations and messages"
            className="selectable h-11 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            onChange={(e) => { setQuery(e.target.value); setPick(0); }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (rows.length) setPick((p) => (p + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(pick);
              }
            }}
          />
        </label>
        <ul ref={list} className="max-h-[420px] overflow-auto p-1.5" role="listbox" aria-label="Results">
          {rows.length === 0 && <li className="px-2 py-6 text-center text-muted-foreground">Nothing matches.</li>}
          {places.length > 0 && <li className="px-2 pb-1 pt-1.5 text-xs font-semibold text-muted-foreground" role="presentation">Conversations</li>}
          {places.map((c, i) => {
            const a = c.kind === "dm" ? agentById(c.members[0]) : undefined;
            return (
              <li key={c.id} role="option" aria-selected={i === pick} data-i={i}>
                <button type="button" className={row(i)} onMouseEnter={() => setPick(i)} onClick={() => choose(i)}>
                  {a ? <CubeStill color={a.color} size={24} /> : <HashIcon className="mx-1 text-muted-foreground" width={16} height={16} />}
                  <span className="font-medium">{c.name}</span>
                </button>
              </li>
            );
          })}
          {found.length > 0 && <li className="px-2 pb-1 pt-2.5 text-xs font-semibold text-muted-foreground" role="presentation">Messages</li>}
          {found.map((m, j) => {
            const i = places.length + j;
            const conv = convs.find((c) => c.id === m.convId);
            return (
              <li key={m.id} role="option" aria-selected={i === pick} data-i={i}>
                <button type="button" className={cn(row(i), "items-start")} onMouseEnter={() => setPick(i)} onClick={() => choose(i)}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">{authorName(m.author)}</span> in {conv ? (conv.kind === "dm" ? conv.name : `#${conv.name}`) : "a conversation"} · {new Date(m.ts).toLocaleDateString([], { month: "short", day: "numeric" })} {timeOf(m.ts)}
                    </span>
                    <span className="block truncate text-[13px]">{snippet(m.text, q)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="border-t px-3.5 py-1.5 text-xs text-muted-foreground">Narrow with <span className="font-mono">from:writer</span>, <span className="font-mono">from:me</span> or <span className="font-mono">in:general</span></p>
      </DialogContent>
    </Dialog>
  );
}
