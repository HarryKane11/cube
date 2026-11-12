import { useEffect, useMemo, useState } from "react";
import { getHarness, inTauri, knowledgeList, libraryProgram, libraryRead, type Harness, type KnowledgeListing, type ProgramLibrary } from "@/agents/runner";
import type { AgentKind } from "@/agents/types";
import { BrandMark, RichText } from "@/components/bits";
import { BookIcon, ChevronIcon, CubeIcon, PlugIcon, SearchIcon } from "@/components/icons";
import { KnowMark } from "@/cube/Cube";
import type { KnowIcon } from "@/cube/icons";
import { entries, filtered, KINDS, SOURCE_NAME, sourcesOf, type Entry, type Held, type Kind, type Source } from "@/lib/library";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

type Program = Exclude<Source, "cube">;
const PROGRAMS: Program[] = ["claude", "codex", "hermes"];
const KIND_NAME: Record<Kind, string> = { memory: "Memory", wiki: "Wiki", skills: "Skills", mcp: "MCP servers", plugins: "Plugins" };
const KIND_ABOUT: Record<Kind, string> = {
  memory: "What Cube and each agent program remember",
  wiki: "Everything the team knows, put together by Cube",
  skills: "Ways of doing things, whichever program has them",
  mcp: "Connections to tools outside the team",
  plugins: "Add-ons the agent programs carry",
};
/** Cube's own picture for each kind. */
const MARK: Record<Kind, KnowIcon> = { memory: "memory", wiki: "wiki", skills: "skill", mcp: "mcp", plugins: "plugin" };
/** The mark that stands for where something is held: Cube's own, or the program's. */
const BRAND: Record<Source, AgentKind> = { cube: "api", claude: "claude", codex: "codex", hermes: "hermes" };

const short = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

/**
 * Everything the team knows and can do, to look through the way files are looked through in
 * Finder: the kind on the left, what there is of it in the middle, the thing itself on the right.
 * It is arranged by kind, not by which program holds what: Claude Code, Codex and Hermes are the
 * team's sub-agents, so a skill is the team's skill whichever of them has it, and the row says
 * who does. Read-only: changing these is each program's own business.
 */
export function Library() {
  const available = useCube((s) => s.available);
  const runs = useCube((s) => s.knowledge.runs.length);
  const [cube, setCube] = useState<KnowledgeListing>();
  const [programs, setPrograms] = useState<Partial<Record<Program, { lib: ProgramLibrary; harness: Harness }>>>({});
  const [kind, setKind] = useState<Kind>("memory");
  const [source, setSource] = useState<Source | "all">("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<{ row: Entry; at: number }>();
  const [text, setText] = useState("");
  const here = PROGRAMS.filter((p) => available[p]);

  useEffect(() => {
    if (!inTauri) return;
    void knowledgeList().then(setCube).catch(() => undefined);
  }, [runs]);
  useEffect(() => {
    if (!inTauri) return;
    for (const p of here) {
      void Promise.all([libraryProgram(p), getHarness(p)]).then(([lib, harness]) => setPrograms((all) => ({ ...all, [p]: { lib, harness } }))).catch(() => undefined);
    }
  }, [here.join(",")]);

  /** Everything of each kind, from Cube and from every program, as rows. */
  const rows = useMemo(() => {
    const held: Record<Kind, Held[]> = { memory: [], wiki: [], skills: [], mcp: [], plugins: [] };
    for (const e of cube?.memory ?? []) held.memory.push({ source: "cube", name: e.name, about: e.description, path: e.path, tag: e.kind || undefined });
    for (const e of cube?.wiki ?? []) held.wiki.push({ source: "cube", name: e.name, about: e.description, path: e.path });
    for (const e of cube?.skills ?? []) held.skills.push({ source: "cube", name: e.name, about: e.description, path: e.path });
    for (const p of here) {
      const got = programs[p];
      if (!got) continue;
      for (const i of got.lib.memory) held.memory.push({ source: p, ...i });
      for (const i of got.lib.skills) held.skills.push({ source: p, ...i });
      for (const i of got.harness.mcp) held.mcp.push({ source: p, ...i });
      for (const i of got.harness.plugins) held.plugins.push({ source: p, ...i });
    }
    return Object.fromEntries(KINDS.map((k) => [k, entries(k, held[k])])) as Record<Kind, Entry[]>;
  }, [cube, programs, here.join(",")]);

  const all = rows[kind];
  const sources = sourcesOf(all);
  const shown = filtered(all, query, source);
  const showing = open?.row.held[open.at];

  useEffect(() => {
    let alive = true;
    setText("");
    if (showing?.path) void libraryRead(showing.path).then((t) => alive && setText(t)).catch((e) => alive && setText(String(e)));
    return () => { alive = false; };
  }, [showing?.path]);
  const go = (k: Kind) => { setKind(k); setOpen(undefined); setQuery(""); setSource("all"); };

  const plain = (k: Kind) => (k === "mcp" || k === "plugins" ? <PlugIcon width={15} height={15} /> : k === "skills" ? <CubeIcon width={15} height={15} /> : <BookIcon width={15} height={15} />);
  const mark = (k: Kind, size: number) => <KnowMark kind={MARK[k]} size={size} fallback={plain(k)} />;
  const chip = (on: boolean) => cn("flex h-6 flex-none items-center gap-1 rounded-full px-2 text-xs font-medium", on ? "bg-foreground text-background" : "bg-secondary text-muted-foreground hover:text-foreground");
  // The front matter is for agents; a reader gets the page itself.
  const page = text.replace(/^---\n[\s\S]*?\n---\n?/, "");

  return (
    <main className="grid min-h-0 grid-cols-[212px_minmax(240px,320px)_minmax(0,1fr)] overflow-hidden rounded-[22px] border bg-ground" aria-label="Library">
      <nav className="flex min-h-0 flex-col gap-0.5 overflow-auto border-r p-3 pt-6" aria-label="Kinds" data-tauri-drag-region>
        <h1 className="px-2 pb-3 font-heading text-[22px] font-bold leading-tight tracking-[-0.03em]">Library</h1>
        {KINDS.map((k) => {
          const on = kind === k;
          return (
            <button key={k} type="button" aria-current={on ? "page" : undefined} title={KIND_ABOUT[k]} className={cn("flex h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left text-[14px]", on ? "bg-secondary font-semibold" : "font-medium text-muted-foreground hover:bg-accent hover:text-foreground")} onClick={() => go(k)}>
              {mark(k, 24)}
              <span className="min-w-0 flex-1 truncate">{KIND_NAME[k]}</span>
              <span className="flex-none text-xs tabular-nums text-muted-foreground">{rows[k].length}</span>
            </button>
          );
        })}
        {!inTauri && <p className="px-2 pt-3 text-[13px] text-muted-foreground">The library reads folders on your computer, so it is there in the Cube desktop app.</p>}
      </nav>

      <section className="flex min-h-0 flex-col border-r" aria-label={KIND_NAME[kind]}>
        <div className="flex flex-col gap-2 border-b px-3 py-2.5" data-tauri-drag-region>
          <div className="flex items-center gap-2">
            <SearchIcon width={15} height={15} className="flex-none text-muted-foreground" />
            <input aria-label="Filter" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} autoCapitalize="off" spellCheck={false} className="selectable h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
            <span className="flex-none text-xs tabular-nums text-muted-foreground">{shown.length}</span>
          </div>
          {sources.length > 1 && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Held by">
              <button type="button" aria-pressed={source === "all"} className={chip(source === "all")} onClick={() => setSource("all")}>All</button>
              {sources.map((s) => (
                <button key={s} type="button" aria-pressed={source === s} className={chip(source === s)} onClick={() => setSource(s)} data-notranslate>
                  <BrandMark kind={BRAND[s]} className="size-3" /> {SOURCE_NAME[s].split(" ")[0]}
                </button>
              ))}
            </div>
          )}
        </div>
        <ul className="min-h-0 flex-1 overflow-auto p-1.5" data-notranslate>
          {shown.map((row, n) => {
            const on = open?.row === row;
            return (
              <li key={`${row.name}:${row.held[0].source}:${n}`}>
                <button type="button" aria-current={on} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left", on ? "bg-primary text-primary-foreground" : "hover:bg-accent")} onClick={() => setOpen({ row, at: Math.max(0, source === "all" ? 0 : row.held.findIndex((h) => h.source === source)) })}>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{row.name}</span>
                      {row.tag && <span className={cn("flex-none rounded-full px-1.5 text-[10px]", on ? "bg-white/20" : "bg-secondary text-muted-foreground")}>{row.tag}</span>}
                    </span>
                    {row.about && <span className={cn("block truncate text-xs", on ? "opacity-80" : "text-muted-foreground")}>{row.about}</span>}
                  </span>
                  <span className={cn("flex flex-none items-center gap-1", !on && "opacity-70")} title={row.held.map((h) => SOURCE_NAME[h.source]).join(", ")}>
                    {row.held.map((h) => <BrandMark key={h.source} kind={BRAND[h.source]} className="size-3" />)}
                  </span>
                  <ChevronIcon width={13} height={13} className={cn("flex-none", !on && "text-muted-foreground")} />
                </button>
              </li>
            );
          })}
        </ul>
        {!shown.length && <p className="px-4 pb-4 text-[13px] text-muted-foreground">{all.length ? "Nothing matches." : kind === "wiki" ? "No pages yet. Cube writes the wiki from memory and from what each agent program has; see Settings > Knowledge." : "Nothing of this kind yet."}</p>}
      </section>

      <section className="flex min-h-0 flex-col" aria-label="Preview">
        {open && showing ? (
          <>
            <header className="border-b px-6 py-3" data-tauri-drag-region>
              <h2 className="truncate font-heading text-[19px] font-bold tracking-[-0.02em]" data-notranslate>{open.row.name}</h2>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {open.row.held.map((h, i) => (
                  <button key={h.source} type="button" aria-pressed={open.at === i} disabled={open.row.held.length === 1} className={cn(chip(open.at === i), "disabled:cursor-default")} onClick={() => setOpen({ row: open.row, at: i })} data-notranslate>
                    <BrandMark kind={BRAND[h.source]} className="size-3" /> {SOURCE_NAME[h.source]}
                  </button>
                ))}
                {showing.path && <span className="selectable min-w-0 flex-1 truncate text-xs text-muted-foreground" data-notranslate>{short(showing.path)}</span>}
              </div>
            </header>
            <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
              {showing.path
                ? <RichText text={page} className="doc selectable !m-0 !max-w-[760px] !p-0" />
                : (
                  <div className="max-w-[640px]">
                    <p className="selectable text-[15px]" data-notranslate>{showing.about || open.row.about || "No description."}</p>
                    <p className="pt-3 text-[13px] text-muted-foreground">Cube shows what this is called and what it is for. How it is started, its addresses and its keys stay in the program's own settings and are not read.</p>
                  </div>
                )}
            </div>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-8 text-center text-muted-foreground" data-tauri-drag-region>
            {mark(kind, 96)}
            <p className="pt-4 font-medium text-foreground">{KIND_NAME[kind]}</p>
            <p className="text-[13px]">{KIND_ABOUT[kind]}</p>
          </div>
        )}
      </section>
    </main>
  );
}
