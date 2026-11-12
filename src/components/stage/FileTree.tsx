import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { rescan } from "@/agents/orchestrator";
import { createFile, inTauri, renamePath, searchText, trashPath } from "@/agents/runner";
import { Glyph } from "@/components/Glyph";
import { ChevronIcon, PencilIcon, PlusIcon, TrashIcon } from "@/components/icons";
import { isEditable, kindOf } from "@/lib/files";
import { buildTree, changesSince, searchFiles, type Change, type Found, type TreeNode } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { useCube, type Artifact } from "@/state/store";

const NONE: Artifact[] = [];
const BADGE: Record<Change, { letter: string; label: string; tone: string }> = {
  added: { letter: "A", label: "New since you last spoke", tone: "text-[#1fa864]" },
  changed: { letter: "M", label: "Changed since you last spoke", tone: "text-[#d9822b]" },
};
const field = "selectable h-7 min-w-0 flex-1 rounded-lg bg-muted px-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

function Badge({ change }: { change?: Change }) {
  if (!change) return null;
  const b = BADGE[change];
  return <span className={cn("flex-none text-[11px] font-bold", b.tone)} title={b.label} aria-label={b.label}>{b.letter}</span>;
}

/** A one-line text box that commits on Enter and gives up on Escape or when focus leaves. */
function NameBox({ start, label, placeholder, onDone }: { start: string; label: string; placeholder?: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(start);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") onDone(value.trim() || null);
    else if (e.key === "Escape") onDone(null);
  };
  return <input autoFocus aria-label={label} placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} onBlur={() => onDone(null)} spellCheck={false} autoCapitalize="off" autoCorrect="off" className={field} />;
}

interface Ops {
  shut: Set<string>;
  toggle: (rel: string) => void;
  byRel: Map<string, Artifact>;
  changes: Record<string, Change>;
  current?: string;
  pick: (rel: string) => void;
  /** The file being renamed or about to be moved to the Trash, if any. */
  busy?: { rel: string; what: "rename" | "trash" };
  setBusy: (b: Ops["busy"]) => void;
  rename: (from: string, to: string | null) => void;
  trash: (rel: string) => void;
}

function Row({ node, depth, ops }: { node: TreeNode; depth: number; ops: Ops }) {
  const row = "group/row flex h-7 w-full items-center gap-1.5 rounded-lg pr-1.5 text-left text-[13px] hover:bg-accent";
  const pad = { paddingLeft: 6 + depth * 14 };
  if (node.dir) {
    const open = !ops.shut.has(node.rel);
    return (
      <li>
        <button type="button" className={cn(row, "font-medium")} style={pad} aria-expanded={open} onClick={() => ops.toggle(node.rel)}>
          <ChevronIcon width={12} height={12} className={cn("flex-none text-muted-foreground transition-transform", open && "rotate-90")} />
          <span className="truncate">{node.name}</span>
        </button>
        {open && <ul>{node.children.map((c) => <Row key={`${c.rel}:${c.dir}`} node={c} depth={depth + 1} ops={ops} />)}</ul>}
      </li>
    );
  }
  const a = ops.byRel.get(node.rel);
  const mine = ops.busy?.rel === node.rel ? ops.busy.what : undefined;
  if (mine === "rename") {
    return <li className="flex h-7 items-center" style={pad}><NameBox start={node.rel} label={`New name for ${node.rel}`} onDone={(to) => ops.rename(node.rel, to)} /></li>;
  }
  if (mine === "trash") {
    return (
      <li className="flex h-7 items-center gap-1.5 rounded-lg bg-accent pr-1.5 text-[13px]" style={pad}>
        <span className="min-w-0 flex-1 truncate">Move to Trash?</span>
        <button type="button" className="h-5 rounded-md bg-destructive px-1.5 text-xs font-semibold text-white" onClick={() => ops.trash(node.rel)}>Move</button>
        <button type="button" className="h-5 rounded-md bg-secondary px-1.5 text-xs font-semibold" onClick={() => ops.setBusy(undefined)}>Keep</button>
      </li>
    );
  }
  const act = "hidden size-5 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground group-hover/row:flex group-focus-within/row:flex";
  return (
    <li className={cn(row, node.rel === ops.current && "bg-accent font-semibold")} style={pad}>
      <button type="button" className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left" aria-current={node.rel === ops.current} onClick={() => ops.pick(node.rel)}>
        <Glyph kind={a?.kind ?? kindOf(node.rel)} name={node.rel} small />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>
      {inTauri && (
        <>
          <button type="button" className={act} aria-label={`Rename ${node.rel}`} title="Rename or move" onClick={() => ops.setBusy({ rel: node.rel, what: "rename" })}><PencilIcon width={12} height={12} /></button>
          <button type="button" className={act} aria-label={`Move ${node.rel} to the Trash`} title="Move to Trash" onClick={() => ops.setBusy({ rel: node.rel, what: "trash" })}><TrashIcon width={12} height={12} /></button>
        </>
      )}
      <Badge change={ops.changes[node.rel]} />
    </li>
  );
}

/** Every place the text was found, grouped by file. Picking one opens the file at that line. */
function SearchResults({ hits, open }: { hits: Found[]; open: (hit: Found) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, Found[]>();
    for (const h of hits) map.set(h.rel, [...(map.get(h.rel) ?? []), h]);
    return [...map.entries()];
  }, [hits]);
  return (
    <ul>
      {groups.map(([rel, list]) => (
        <li key={rel} className="mb-1.5">
          <div className="flex items-center gap-1.5 px-1.5 py-1 text-[13px] font-semibold" title={rel}>
            <Glyph kind={kindOf(rel)} name={rel} small />
            <span className="min-w-0 flex-1 truncate">{rel}</span>
            <span className="font-normal text-muted-foreground tabular-nums">{list.length}</span>
          </div>
          <ul>
            {list.map((h) => (
              <li key={`${h.line}:${h.col}`}>
                <button type="button" className="flex w-full items-baseline gap-2 rounded-lg px-1.5 py-0.5 text-left hover:bg-accent" onClick={() => open(h)}>
                  <span className="w-7 flex-none text-right text-[11px] text-muted-foreground tabular-nums">{h.line}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{h.text.trim()}</span>
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** The conversation's files: as a tree to browse and tidy, the short list of what changed, and a search across all of them. */
export function FileTree({ convId, dir, current }: { convId: string; dir: string; current?: string }) {
  const files = useCube((s) => s.files[convId] ?? NONE);
  const baseline = useCube((s) => s.baseline[convId]);
  const dirty = useCube((s) => s.dirty);
  const select = useCube((s) => s.select);
  const setMode = useCube((s) => s.setMode);
  const setReveal = useCube((s) => s.setReveal);
  const [tab, setTab] = useState<"files" | "changes" | "search">("files");
  const [q, setQ] = useState("");
  const [find, setFind] = useState("");
  const [hits, setHits] = useState<Found[]>();
  const [shut, setShut] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<Ops["busy"]>();
  const [error, setError] = useState("");

  const byRel = useMemo(() => new Map(files.map((f) => [f.rel, f])), [files]);
  const changes = useMemo(() => changesSince(files, baseline), [files, baseline]);
  const changed = useMemo(() => files.filter((f) => changes[f.rel]).sort((x, y) => x.rel.localeCompare(y.rel)), [files, changes]);
  const tree = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return buildTree(files.map((f) => f.rel).filter((rel) => !needle || rel.toLowerCase().includes(needle)));
  }, [files, q]);

  // Search a moment after the person stops typing.
  useEffect(() => {
    if (tab !== "search") return;
    if (!find.trim()) return setHits(undefined);
    let alive = true;
    const timer = window.setTimeout(() => {
      const run = inTauri ? searchText(dir, find) : Promise.resolve(searchFiles(files.filter((f) => f.content !== undefined).map((f) => ({ rel: f.rel, text: f.content ?? "" })), find));
      run.then((found) => alive && setHits(found)).catch(() => alive && setHits([]));
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
    // In the desktop app the search reads the disk, so the file list is not an input to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, find, dir, inTauri ? undefined : files]);

  const toggle = (rel: string) =>
    setShut((s) => {
      const next = new Set(s);
      if (!next.delete(rel)) next.add(rel);
      return next;
    });
  const unsaved = (rel: string) => {
    const a = byRel.get(rel);
    return Boolean(a && dirty[a.path]);
  };
  const add = async (rel: string | null) => {
    setAdding(false);
    if (!rel) return;
    setError("");
    try {
      if (inTauri) {
        await createFile(dir, rel);
        await rescan(convId);
      } else {
        useCube.getState().putArtifact(convId, { rel, path: `/preview/${convId}/${rel}`, kind: kindOf(rel), mtime: Date.now(), size: 0, content: "" });
      }
      select(convId, rel, true);
    } catch (e) {
      setError(String(e));
    }
  };
  const rename = async (from: string, to: string | null) => {
    setBusy(undefined);
    if (!to || to === from) return;
    if (unsaved(from)) return setError("Save that file first, then rename it.");
    setError("");
    try {
      await renamePath(dir, from, to);
      await rescan(convId);
      select(convId, to, true);
    } catch (e) {
      setError(String(e));
    }
  };
  const trash = async (rel: string) => {
    setBusy(undefined);
    if (unsaved(rel)) return setError("Save that file first, or close it without saving.");
    setError("");
    try {
      await trashPath(dir, rel);
      await rescan(convId);
    } catch (e) {
      setError(String(e));
    }
  };
  const openHit = (h: Found) => {
    const a = byRel.get(h.rel);
    select(convId, h.rel, true);
    if (a && isEditable(a.kind)) {
      setMode(convId, h.rel, "code");
      setReveal({ path: a.path, line: h.line, col: h.col });
    }
  };

  const ops: Ops = { shut: q ? new Set() : shut, toggle, byRel, changes, current, pick: (rel) => select(convId, rel, true), busy, setBusy, rename: (f, t) => void rename(f, t), trash: (r) => void trash(r) };
  const chip = "h-6 rounded-full bg-secondary px-2 text-xs font-medium text-muted-foreground hover:text-foreground";
  const note = "px-2 py-1 text-[13px] text-muted-foreground";

  return (
    <nav className="flex size-full flex-col" aria-label="Files in this conversation">
      {/* One field. What else can be listed shows up only when there is something to list. */}
      <div className="flex flex-none flex-col gap-1.5 p-2">
        <div className="flex gap-1">
          <input
            aria-label={tab === "search" ? "Search in all files" : "Find a file by name"}
            value={tab === "search" ? find : q}
            onChange={(e) => {
              if (tab === "search") return setFind(e.target.value);
              setQ(e.target.value);
              if (tab === "changes") setTab("files");
            }}
            placeholder={tab === "search" ? "Search in all files" : "Find a file"}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={field}
          />
          <button type="button" aria-label="New file" title="New file" className="flex size-7 flex-none items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => { setTab("files"); setAdding(true); }}>
            <PlusIcon width={14} height={14} />
          </button>
        </div>
        {(tab !== "files" || changed.length > 0 || Boolean(q.trim())) && (
          <div className="flex flex-wrap gap-1">
            {tab !== "files" && <button type="button" className={chip} onClick={() => setTab("files")}>All files</button>}
            {tab !== "changes" && changed.length > 0 && (
              <button type="button" className={chip} onClick={() => setTab("changes")}>Changes<span className="ml-1 tabular-nums">{changed.length}</span></button>
            )}
            {tab === "files" && Boolean(q.trim()) && <button type="button" className={chip} onClick={() => { setFind(q); setTab("search"); }}>Search inside files</button>}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
        {tab === "files" && (
          <>
            {adding && <div className="mb-1 flex px-0.5"><NameBox start="" label="Name of the new file" placeholder="notes.md or src/app.py" onDone={(rel) => void add(rel)} /></div>}
            {tree.length === 0 ? <p className={note}>{q ? "No file matches." : "No files yet."}</p> : <ul>{tree.map((n) => <Row key={`${n.rel}:${n.dir}`} node={n} depth={0} ops={ops} />)}</ul>}
          </>
        )}
        {tab === "changes" &&
          (changed.length === 0 ? (
            <p className={note}>{baseline ? "Nothing changed since your last message." : "After your next message, the files your cubes add or change are listed here."}</p>
          ) : (
            <ul>
              {changed.map((f) => (
                <li key={f.rel}>
                  <button
                    type="button"
                    className={cn("flex h-7 w-full items-center gap-1.5 rounded-lg px-1.5 text-left text-[13px] hover:bg-accent", f.rel === current && "bg-accent font-semibold")}
                    title={f.rel}
                    onClick={() => {
                      select(convId, f.rel, true);
                      if (isEditable(f.kind)) setMode(convId, f.rel, "diff");
                    }}
                  >
                    <Glyph kind={f.kind} name={f.rel} small />
                    <span className="min-w-0 flex-1 truncate">{f.rel}</span>
                    <Badge change={changes[f.rel]} />
                  </button>
                </li>
              ))}
            </ul>
          ))}
        {tab === "search" &&
          (!find.trim() ? (
            <p className={note}>Type to search the text of every file here. Use a capital letter to match case exactly.</p>
          ) : !hits ? (
            <p className={note}>Searching…</p>
          ) : hits.length === 0 ? (
            <p className={note}>Nothing found.</p>
          ) : (
            <>
              <p className={note}>{hits.length >= 400 ? "First 400 matches" : hits.length === 1 ? "1 match" : `${hits.length} matches`}</p>
              <SearchResults hits={hits} open={openHit} />
            </>
          ))}
      </div>
      {error && <p className="flex-none border-t px-2.5 py-1.5 text-xs text-destructive" role="alert">{error}</p>}
    </nav>
  );
}
