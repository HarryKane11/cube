import { useCallback, useEffect, useState } from "react";
import { HEADLESS, type HeadlessEngine } from "@/agents/headless";
import { inTauri, knowledgeRemove, readText, type KnowledgeEntry, type KnowledgeListing } from "@/agents/runner";
import { ENGINES, MODEL_HINTS } from "@/agents/types";
import { BrandMark, RichText } from "@/components/bits";
import { Section, Switch } from "@/components/Settings";
import { Input } from "@/components/ui/input";
import { exportKnowledge, importKnowledge, JOB_ABOUT, JOBS, knowledgeEngine, listKnowledge, runJob, stopJob, type JobKind, WIKI_CHOICES, WIKI_EVERY } from "@/knowledge";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

const pill = "h-8 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-35";
const primary = "h-8 flex-none rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35";
const PROGRAM: Record<string, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes" };

const ago = (ts: number | undefined) => {
  if (!ts) return "Never run";
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
  return new Date(ts).toLocaleDateString();
};

/** Which agent program and model do the background work. Nothing runs by itself until one is picked. */
function WorkModel() {
  const k = useCube((s) => s.knowledge);
  const available = useCube((s) => s.available);
  const set = useCube((s) => s.setKnowledge);
  const usable = HEADLESS.filter((e) => available[e]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-3">
        <div className="min-w-[200px] flex-1">
          <div className="font-medium">Runs on</div>
          <div className="text-[13px] text-muted-foreground">The agent program that reads your conversations and writes memory, skills and the wiki. It works in the knowledge folder only.</div>
        </div>
        <div className="flex rounded-[10px] bg-secondary p-0.5" role="group" aria-label="Agent program for background work">
          {usable.map((e) => (
            <button key={e} type="button" aria-pressed={k.engine === e} className={cn("flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground", k.engine === e && "bg-background font-semibold text-foreground shadow-sm")} onClick={() => set({ engine: e as HeadlessEngine, model: k.engine === e ? k.model : "" })}>
              <BrandMark kind={e} className="size-3" /> {ENGINES[e].name.split(" ")[0]}
            </button>
          ))}
          {!usable.length && <span className="px-2.5 text-[13px] leading-7 text-muted-foreground">No agent program found</span>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-3">
        <div className="min-w-[200px] flex-1">
          <div className="font-medium">Model</div>
          <div className="text-[13px] text-muted-foreground">Leave empty to use the program's own default. A small, fast model is enough for this work.</div>
        </div>
        <Input autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Model for background work" list="knowledge-models" placeholder={k.engine ? "Program default" : "Pick a program first"} disabled={!k.engine} value={k.model} onChange={(e) => set({ model: e.target.value })} className="selectable h-9 w-[240px]" data-notranslate />
        <datalist id="knowledge-models">{(k.engine ? MODEL_HINTS[k.engine] : []).map((m) => <option key={m} value={m} />)}</datalist>
      </div>
      <Switch label="Keep it up by itself" hint="Memory after a conversation goes quiet, the wiki when memory changed, skills when enough new work has piled up. Off: only when you press Run." checked={k.auto} onChange={(auto) => set({ auto })} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t py-3">
        <div className="min-w-[200px] flex-1">
          <label htmlFor="wiki-every" className="font-medium">How often the wiki is rewritten</label>
          <div className="text-[13px] text-muted-foreground">At most this often, and only when memory has changed since.</div>
        </div>
        <select id="wiki-every" value={k.wikiEvery || WIKI_EVERY} disabled={!k.auto} onChange={(e) => set({ wikiEvery: Number(e.target.value) })} className="selectable h-9 rounded-xl border bg-transparent px-2.5 text-[13px] disabled:opacity-50">
          {WIKI_CHOICES.map((h) => <option key={h} value={h}>{h === 24 ? "Once a day" : h === 1 ? "Every hour" : `Every ${h} hours`}</option>)}
        </select>
      </div>
    </>
  );
}

function Jobs() {
  const k = useCube((s) => s.knowledge);
  const busy = useCube((s) => s.knowledgeBusy);
  const ready = useCube((s) => Boolean(s.knowledge.engine && s.available[s.knowledge.engine]));
  const set = useCube((s) => s.setKnowledge);
  return (
    <div className="flex flex-col">
      {JOBS.map((job: JobKind) => {
        const running = busy?.job === job;
        const lastRun = k.runs.find((r) => r.job === job);
        return (
          <div key={job} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-3 last:border-b-0">
            <div className="min-w-[200px] flex-1">
              <div className="font-medium">{JOB_ABOUT[job].name}</div>
              <div className="text-[13px] text-muted-foreground">{JOB_ABOUT[job].about}</div>
              <div className={cn("mt-1 text-[13px]", running ? "font-semibold text-primary" : lastRun && !lastRun.ok ? "text-destructive" : "text-muted-foreground")} role="status">
                {running ? <>Working… <span className="font-normal" data-notranslate>{busy.activity}</span></> : lastRun ? <>{ago(lastRun.at)} · <span data-notranslate>{lastRun.summary}</span></> : "Never run"}
              </div>
            </div>
            {running
              ? <button type="button" className={pill} onClick={stopJob}>Stop</button>
              : (
                <div className="flex gap-2">
                  {job !== "wiki" && k.cursor[job] > 0 && <button type="button" className={pill} disabled={Boolean(busy)} title="Read every conversation again on the next run, not only what is new" onClick={() => set({ cursor: { ...k.cursor, [job]: 0 } })}>Read all again</button>}
                  <button type="button" className={pill} disabled={Boolean(busy) || !ready} onClick={() => void runJob(job)}>Run now</button>
                </div>
              )}
          </div>
        );
      })}
      {!ready && <p className="pt-2 text-[13px] text-muted-foreground">Pick the agent program above to turn these on.</p>}
    </div>
  );
}

/** One button in, one button out: other programs' memories into Cube, and Cube's memory and skills back to them. */
function Bridge({ listing, reload }: { listing: KnowledgeListing | null; reload: () => void }) {
  const [busy, setBusy] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState("");
  const run = (name: string, work: () => Promise<string[]>) => {
    setBusy(name);
    setError("");
    setLines([]);
    work().then(setLines).catch((e) => setError(String(e))).finally(() => { setBusy(""); reload(); });
  };
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-3">
        <div className="min-w-[200px] flex-1">
          <div className="font-medium">Bring in</div>
          <div className="text-[13px] text-muted-foreground">Copies what Claude Code, Codex and Hermes remember into Cube. Nothing in their folders changes. The next memory run works it in.{listing?.imported ? ` ${listing.imported} notes brought in so far.` : ""}</div>
        </div>
        <button type="button" className={primary} disabled={Boolean(busy)} onClick={() => run("in", async () => (await importKnowledge()).map((r) => `${PROGRAM[r.source] ?? r.source}: ${r.notes} notes`))}>{busy === "in" ? "Bringing in…" : "Bring in memories"}</button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
        <div className="min-w-[200px] flex-1">
          <div className="font-medium">Send out</div>
          <div className="text-[13px] text-muted-foreground">Writes Cube's memory and skills where each program reads them: a rules file for Claude Code, a marked block in Codex's AGENTS.md, a skill for Hermes; skills as cube-… in each. Only what Cube wrote before is replaced.</div>
        </div>
        <button type="button" className={primary} disabled={Boolean(busy)} onClick={() => run("out", async () => (await exportKnowledge()).map((r) => `${PROGRAM[r.target] ?? r.target}: ${r.memory}${r.skills ? ` · ${r.skills} skills` : ""}`))}>{busy === "out" ? "Sending out…" : "Send out to all three"}</button>
      </div>
      {lines.length > 0 && <ul className="selectable rounded-xl bg-secondary/60 px-3 py-2 text-[13px]" data-notranslate>{lines.map((l) => <li key={l}>{l}</li>)}</ul>}
      {error && <p className="text-[13px] text-destructive" role="alert">{error}</p>}
    </div>
  );
}

type Shelf = "memory" | "skills" | "wiki";
const SHELF: Record<Shelf, string> = { memory: "Memory", skills: "Skills", wiki: "Wiki" };

/** What Cube knows, to read and to prune: notes, skills and wiki pages. */
function Library({ listing, reload }: { listing: KnowledgeListing | null; reload: () => void }) {
  const [shelf, setShelf] = useState<Shelf>("memory");
  const [open, setOpen] = useState<KnowledgeEntry>();
  const [text, setText] = useState("");
  const entries = listing?.[shelf] ?? [];
  useEffect(() => {
    let alive = true;
    setText("");
    if (open) void readText(open.path, 200_000).then((t) => alive && setText(t)).catch(() => alive && setText("This could not be read."));
    return () => { alive = false; };
  }, [open?.path, open?.mtime]);
  // The front matter is for agents; a reader gets the page itself.
  const page = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const remove = (e: KnowledgeEntry) => void knowledgeRemove([e.rel]).then(() => { setOpen(undefined); reload(); });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex rounded-[10px] bg-secondary p-0.5" role="tablist" aria-label="What Cube knows">
          {(Object.keys(SHELF) as Shelf[]).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={shelf === s} className={cn("h-7 rounded-lg px-3 text-[13px] font-medium text-muted-foreground", shelf === s && "bg-background font-semibold text-foreground shadow-sm")} onClick={() => { setShelf(s); setOpen(undefined); }}>
              {SHELF[s]} <span className="tabular-nums opacity-60">{listing?.[s].length ?? 0}</span>
            </button>
          ))}
        </div>
        {listing && <span className="selectable min-w-0 flex-1 truncate text-right text-xs text-muted-foreground" data-notranslate title={listing.dir}>{listing.dir.replace(/^\/Users\/[^/]+/, "~")}</span>}
      </div>
      {!entries.length && <p className="py-2 text-[13px] text-muted-foreground">{shelf === "memory" ? "Nothing remembered yet. Run Memory after a few conversations, or bring in memories from other programs." : shelf === "skills" ? "No skills yet. They appear as ways of working prove themselves." : "No pages yet. Run Wiki once there is something in memory."}</p>}
      <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-3", open && "md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]")}>
        {entries.length > 0 && (
          <ul className={cn("flex min-w-0 flex-col", open && "max-h-[520px] overflow-auto")} data-notranslate>
            {entries.map((e) => (
              <li key={e.rel}>
                <button type="button" aria-current={open?.rel === e.rel} className={cn("flex w-full min-w-0 flex-col rounded-xl px-3 py-2 text-left hover:bg-accent", open?.rel === e.rel && "bg-accent")} onClick={() => setOpen(open?.rel === e.rel ? undefined : e)}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-medium">{e.name}</span>
                    {e.kind && <span className="flex-none rounded-full bg-secondary px-1.5 text-[11px] text-muted-foreground">{e.kind}</span>}
                    {e.source && e.source !== "cube" && <span className="flex-none text-[11px] text-muted-foreground">{PROGRAM[e.source] ?? e.source}</span>}
                  </span>
                  {!open && e.description && <span className="block w-full truncate text-[13px] text-muted-foreground">{e.description}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {open && (
          <div className="min-w-0 rounded-xl border p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-notranslate>{open.rel}</span>
              <button type="button" className={pill} onClick={() => remove(open)}>Delete</button>
            </div>
            <div className="max-h-[460px] overflow-auto"><RichText text={page} className="selectable" /></div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Settings > Knowledge: what Cube remembers, the skills it has made, its wiki, and the background work that keeps them. */
export function Knowledge() {
  const busy = useCube((s) => s.knowledgeBusy);
  const runs = useCube((s) => s.knowledge.runs.length);
  const [listing, setListing] = useState<KnowledgeListing | null>(null);
  const reload = useCallback(() => { void listKnowledge().then(setListing).catch(() => undefined); }, []);
  // Looked at again whenever a job starts or ends.
  useEffect(reload, [reload, busy?.job, runs]);

  if (!inTauri) return <Section title="Knowledge"><p className="text-[13px] text-muted-foreground">Memory, skills and the wiki are kept in a folder on your computer, so they are there in the Cube desktop app.</p></Section>;
  return (
    <>
      <Section title="What Cube knows">
        <p className="mb-3 text-[13px] text-muted-foreground">Cube keeps what it learns from working with you as plain files: notes it remembers, skills for doing things the way that worked, and a wiki you can read and correct. Cubes are pointed to them at the start of a conversation.</p>
        <Library listing={listing} reload={reload} />
      </Section>
      <Section title="Background work">
        <WorkModel />
        <Jobs />
        {!knowledgeEngine() && null}
      </Section>
      <Section title="Other programs">
        <Bridge listing={listing} reload={reload} />
      </Section>
    </>
  );
}
