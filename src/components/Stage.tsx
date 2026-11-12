import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { lazy, Suspense, useEffect, useMemo, useState, useCallback } from "react";
import { rescan } from "@/agents/orchestrator";
import { inTauri, pageUrl, quickLook, readText, windowShot, windowsList, type Win } from "@/agents/runner";
import { agentById } from "@/agents/types";
import { CloseIcon, GlobeIcon, OpenIcon, PanelIcon, StageIcon, TermIcon } from "@/components/icons";
import { Face } from "@/components/bits";
import { FileTree } from "@/components/stage/FileTree";
import { FileHistory, FolderNotices, useFolder } from "@/components/stage/SharedFolder";
import { GitBar } from "@/components/stage/GitBar";
import { EDIT_LIMIT, saveText } from "@/components/stage/save";
import { Glyph } from "@/components/Glyph";
import { Resizer } from "@/components/Resizer";
import { BorderBeam } from "@/components/ui/border-beam";
import { CodeBlock, CodeBlockCode } from "@/components/ui/code-block";
import { Cube, CubeStill } from "@/cube/Cube";
import { hasPreview, isEditable, isLooked, isTextKind, KIND_LABEL } from "@/lib/files";
import { changesSince } from "@/lib/tree";
import { RightClick } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { BROWSER, SCREEN, useActiveConv, useBusy, useCube, type Artifact, type Follow, type Shot, type ViewMode } from "@/state/store";

// The editor is a large piece of code; it loads the first time a file is opened as text.
const CodeEditor = lazy(() => import("@/components/stage/CodeEditor"));
const TerminalPanel = lazy(() => import("@/components/stage/TerminalPanel"));
const ImageEditor = lazy(() => import("@/components/stage/ImageEditor"));
const BrowserPane = lazy(() => import("@/components/stage/BrowserPane"));
const Notebook = lazy(() => import("@/components/stage/Notebook"));
const MdEditor = lazy(() => import("@/components/stage/MdEditor"));
const SheetEditor = lazy(() => import("@/components/stage/SheetEditor"));

const NONE: Artifact[] = [];
const NO_SHOTS: Shot[] = [];
const NO_TABS: string[] = [];
const MODE_NAME: Record<ViewMode, string> = { preview: "Preview", code: "Code", diff: "Changes", edit: "Edit" };

/**
 * The top of the Screen tab: which app window is being watched, or the windows there are to pick
 * from. The list is there as soon as the tab opens, so "the screen" is one thing: a window you watch.
 */
function WatchBar({ convId, follow, problem }: { convId: string; follow: Follow | undefined; problem: string }) {
  const setFollow = useCube((s) => s.setFollow);
  const [wins, setWins] = useState<Win[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    windowsList()
      .then((list) => {
        // One entry per app, its largest window, with the browsers cubes drive listed first.
        const best = new Map<string, Win>();
        for (const w of list) {
          const had = best.get(w.app);
          // Cube itself and the system's own permission prompts are not things to watch.
          if (w.app !== "Cube" && !/AuthWarn|^loginwindow$/i.test(w.app) && (!had || w.w * w.h > had.w * had.h)) best.set(w.app, w);
        }
        const browser = (w: Win) => (/aside|ego lite|chrome|safari|arc|edge|firefox|brave/i.test(w.app) ? 0 : 1);
        setWins([...best.values()].sort((x, y) => browser(x) - browser(y)));
      })
      .catch((e) => setError(String(e)));
  }, []);
  // Windows come and go: look again whenever the choice is on screen.
  useEffect(() => { if (!follow) load(); }, [follow, load]);
  const pill = "h-7 flex-none rounded-full bg-white/10 px-3 text-xs font-semibold text-white hover:bg-white/20";
  const icon = (data: string | undefined, size: number) =>
    data
      ? <img src={`data:image/png;base64,${data}`} width={size} height={size} alt="" draggable={false} />
      // An app whose icon could not be read still gets a tile of the same size.
      : <span className="rounded-[22%] bg-white/15" style={{ width: size * 0.82, height: size * 0.82, margin: size * 0.09 }} />;
  return (
    <div className="flex flex-none flex-col gap-2 px-4 pt-3 text-xs text-white/70">
      {follow ? (
        <div className="flex items-center gap-2">
          {icon(follow.icon, 22)}
          <span className="flex items-center gap-1.5 font-semibold text-white"><span className="size-2 animate-pulse rounded-full bg-[#ff453a]" /> Watching {follow.app}</span>
          <button type="button" className={pill} onClick={() => setFollow(convId, undefined)}>Pick another window</button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-white">Pick a window to watch</span>
            <button type="button" className="font-semibold text-white/70 hover:text-white" onClick={load}>Refresh</button>
            {wins.length === 0 && !error && <span>No other windows are open.</span>}
          </div>
          <ul className="flex flex-wrap gap-1" aria-label="Windows to watch">
            {wins.slice(0, 18).map((w) => (
              <li key={w.id}>
                <button type="button" title={w.app} className="flex w-[76px] flex-col items-center gap-1 rounded-xl px-1 py-2 text-white/80 hover:bg-white/10 hover:text-white" onClick={() => setFollow(convId, { id: w.id, app: w.app, icon: w.icon })}>
                  {icon(w.icon, 44)}
                  <span className="w-full truncate text-center text-[11px] font-medium" data-notranslate>{w.app}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {(problem || error) && <span className="text-[#ff9f8f]" role="alert">{problem || error}</span>}
    </div>
  );
}

/**
 * What an agent is looking at while it uses a browser or the computer: the window it drives,
 * followed live, or else the latest picture a tool handed back and the ones before it.
 */
function ScreenView({ convId, shots, follow }: { convId: string; shots: Shot[]; follow: Follow | undefined }) {
  // Follows the newest picture until the person picks an older one.
  const [picked, setPicked] = useState<string>();
  const [live, setLive] = useState<string>();
  const [problem, setProblem] = useState("");
  const setFollow = useCube((s) => s.setFollow);
  const latest = shots[shots.length - 1];
  const shot = shots.find((s) => s.id === picked) ?? latest;

  useEffect(() => {
    setLive(undefined);
    if (!follow || !inTauri) return;
    // A new window to follow starts clean; a failure stays on screen after following has stopped.
    setProblem("");
    let alive = true;
    let busy = false;
    let beat = 0;
    const tick = () => {
      // With the window out of sight a picture now and then is enough to be current when it comes back.
      if (busy || (document.hidden && beat++ % 5 !== 0)) return;
      busy = true;
      windowShot(follow.id)
        .then((data) => {
          useCube.getState().setCaptureDenied(false);
          if (alive) setLive(`data:image/jpeg;base64,${data}`);
        })
        .catch((e) => {
          useCube.getState().setCaptureDenied(true);
          if (alive) { setProblem(String(e)); setFollow(convId, undefined); }
        })
        .finally(() => { busy = false; });
    };
    tick();
    const timer = window.setInterval(tick, 800);
    return () => { alive = false; window.clearInterval(timer); };
  }, [follow?.id, convId, setFollow]);

  const showLive = follow && !picked;
  return (
    <div className="flex size-full flex-col bg-[#111113]">
      {inTauri && <WatchBar convId={convId} follow={follow} problem={problem} />}
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {showLive ? (
          live ? <img className="max-h-full max-w-full rounded-lg object-contain" src={live} alt={`${follow.app}, live`} /> : <p className="text-[13px] text-white/60">Opening {follow.app}…</p>
        ) : shot ? (
          <img className="max-h-full max-w-full rounded-lg object-contain" src={shot.url} alt={shot.label} />
        ) : (
          <p className="max-w-[380px] text-center text-[13px] text-white/60">Pick a window above to watch it live here, for example the browser a cube is driving. It starts by itself when a cube uses Aside or ego lite. Screenshots cubes take are kept here too.</p>
        )}
      </div>
      {shots.length > (follow ? 0 : 1) && (
        <div className="flex flex-none gap-2 overflow-x-auto px-4 pb-4 [scrollbar-width:none]" role="tablist" aria-label="Earlier screens">
          {follow && (
            <button type="button" role="tab" aria-selected={!picked} className={cn("flex h-14 w-24 flex-none items-center justify-center rounded-lg border-2 bg-black text-xs font-semibold text-white", !picked ? "border-[#2997ff]" : "border-transparent opacity-60 hover:opacity-100")} onClick={() => setPicked(undefined)}>Live</button>
          )}
          {shots.map((s) => {
            const on = !showLive && s.id === shot?.id;
            return (
              <button
                type="button"
                role="tab"
                aria-selected={on}
                aria-label={`${s.label}, ${new Date(s.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`}
                key={s.id}
                className={cn("h-14 w-24 flex-none overflow-hidden rounded-lg border-2 bg-black", on ? "border-[#2997ff]" : "border-transparent opacity-60 hover:opacity-100")}
                onClick={() => setPicked(!follow && s.id === latest.id ? undefined : s.id)}
              >
                <img className="size-full object-cover" src={s.url} alt="" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** How much of a file is read to draw it. Notebooks carry their pictures inside, so they get more room. */
const readLimit = (kind: Artifact["kind"]) => (kind === "notebook" ? 30_000_000 : EDIT_LIMIT);

/**
 * Loads a text file again whenever the agent rewrites it, so the Stage follows the work live.
 * The second value puts text in place at once, for an edit the person just made here.
 */
function useText(a: Artifact | undefined): [string, (text: string) => void] {
  const [text, setText] = useState("");
  useEffect(() => {
    let alive = true;
    if (!a || !isTextKind(a.kind)) return setText("");
    if (a.content !== undefined) return setText(a.content);
    if (!inTauri) return setText("");
    readText(a.path, readLimit(a.kind))
      .then((t) => alive && setText(t))
      .catch(() => alive && setText(""));
    return () => { alive = false; };
  }, [a?.path, a?.mtime, a?.kind, a?.content]);
  return [text, setText];
}

/**
 * A document the Stage does not draw itself (Word, Excel, PowerPoint, Pages, Numbers, Keynote…),
 * shown as the page the system's Quick Look makes of it. Remade whenever the file changes.
 */
function Looked({ a }: { a: Artifact }) {
  const [page, setPage] = useState<string>();
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let alive = true;
    setPage(undefined);
    setProblem("");
    if (!inTauri) return setProblem("Documents like this one open in the Cube desktop app.");
    quickLook(a.path)
      .then((p) => alive && setPage(p))
      .catch((e) => alive && setProblem(String(e)));
    return () => { alive = false; };
  }, [a.path, a.mtime]);
  if (problem) return <div className="flex min-h-full flex-col items-center justify-center gap-1 p-8 text-center text-muted-foreground"><p>{problem}</p><p>Use Open to see it in its own app.</p></div>;
  if (!page) return <p className="p-6 text-muted-foreground">Opening the document…</p>;
  // What came back is a page, a PDF or a picture.
  if (/\.pdf$/i.test(page)) return <iframe className="block size-full border-0" title={a.rel} src={pageUrl(page)} key={page} />;
  if (/\.(png|jpe?g)$/i.test(page)) return <div className="flex min-h-full items-start justify-center p-6"><img className="max-w-full rounded-xl border bg-white" src={pageUrl(page)} alt={a.rel} key={page} /></div>;
  // The page comes from a file anyone could have made: it runs in a sandbox with no access to the app.
  return <iframe className="block size-full border-0 bg-white" title={a.rel} sandbox="allow-scripts" src={pageUrl(page)} key={page} />;
}

function Viewer({ a, convId }: { a: Artifact; convId: string }) {
  const [text, setText] = useText(a);
  // Files past the limit are only partly loaded: shown, but not edited in place.
  const editable = a.size <= readLimit(a.kind);
  const save = async (next: string) => {
    setText(next);
    await saveText(convId, a, next);
  };
  const src = inTauri ? convertFileSrc(a.path) : "";
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");

  switch (a.kind) {
    case "md":
      return <Suspense fallback={null}><MdEditor text={text} editable={editable} onSave={save} /></Suspense>;
    case "html":
      // Agent-made pages run in a sandbox with no access to the app.
      return a.content !== undefined
        ? <iframe className="block size-full border-0 bg-white" title={a.rel} sandbox="allow-scripts" srcDoc={a.content} />
        : <iframe className="block size-full border-0 bg-white" title={a.rel} sandbox="allow-scripts" src={pageUrl(a.path)} key={a.mtime} />;
    case "image":
      return <div className="flex min-h-full items-center justify-center p-8"><img className="max-h-full max-w-full rounded-xl" src={src} alt={a.rel} key={a.mtime} /></div>;
    case "video":
      return <div className="flex min-h-full items-center justify-center p-8"><video className="max-h-full max-w-full rounded-xl" src={src} controls key={a.mtime} /></div>;
    case "audio":
      return <div className="flex min-h-full items-center justify-center p-8"><audio src={src} controls key={a.mtime} /></div>;
    case "pdf":
      return <iframe className="block size-full border-0" title={a.rel} src={src} key={a.mtime} />;
    case "csv":
      return <Suspense fallback={null}><SheetEditor text={text} editable={editable} onSave={save} /></Suspense>;
    case "notebook":
      return <Suspense fallback={null}><Notebook text={text} editable={editable} onSave={save} /></Suspense>;
    case "code":
    case "text":
      return (
        <CodeBlock className="selectable rounded-none border-0">
          <CodeBlockCode code={text} language={a.kind === "text" ? "text" : (a.rel.split(".").pop() ?? "text")} theme={dark ? "github-dark" : "github-light"} />
        </CodeBlock>
      );
    default:
      return isLooked(a.kind)
        ? <Looked a={a} />
        : <div className="flex min-h-full items-center justify-center p-8 text-muted-foreground">Stage cannot preview this kind of file yet. Use Open to see it.</div>;
  }
}

export function Stage() {
  const conv = useActiveConv();
  const artifacts = useCube((s) => s.files[conv.id] ?? NONE);
  const selected = useCube((s) => s.selected[conv.id]);
  const tabs = useCube((s) => s.tabs[conv.id] ?? NO_TABS);
  const modes = useCube((s) => s.mode);
  const dirty = useCube((s) => s.dirty);
  const baseline = useCube((s) => s.baseline[conv.id]);
  const showTree = useCube((s) => s.settings.tree);
  const treeW = useCube((s) => s.settings.treeW);
  const setSetting = useCube((s) => s.setSetting);
  const termOpen = useCube((s) => Boolean(s.termOpen[conv.id]));
  const setTermOpen = useCube((s) => s.setTermOpen);
  const select = useCube((s) => s.select);
  const closeTab = useCube((s) => s.closeTab);
  const setMode = useCube((s) => s.setMode);
  const setStage = useCube((s) => s.setStage);
  const busy = useBusy(conv.id);
  const shots = useCube((s) => s.shots[conv.id] ?? NO_SHOTS);
  const follow = useCube((s) => s.follow[conv.id]);
  const onBrowser = selected === BROWSER;
  const onScreen = !onBrowser && (selected === SCREEN || ((shots.length > 0 || Boolean(follow)) && artifacts.length === 0));
  const current = onScreen || onBrowser ? undefined : (artifacts.find((a) => a.rel === selected) ?? artifacts[0]);
  const lastShot = shots[shots.length - 1] as Shot | undefined;
  const author = onBrowser ? undefined : onScreen ? (lastShot ? agentById(lastShot.by) : undefined) : current?.by ? agentById(current.by) : undefined;
  const changes = useMemo(() => changesSince(artifacts, baseline), [artifacts, baseline]);
  // In a shared folder, whose version the file in view is.
  const folder = useFolder(conv);
  const about = current ? folder.about(current.rel) : undefined;
  const theirs = Boolean(about?.synced && about.other);

  // While the Stage is open, keep looking at the folder: files also change outside of agent runs
  // (the person's own editor, a script). Looking is cheap, and it stops when the window is hidden.
  useEffect(() => {
    if (!inTauri) return;
    void rescan(conv.id);
    const timer = window.setInterval(() => { if (!document.hidden) void rescan(conv.id); }, 3000);
    return () => window.clearInterval(timer);
  }, [conv.id]);

  // How the file in view is shown. Text files open in the editor; docs, pages and sheets open
  // rendered, with their text one click away; a changed file can be read against its old self.
  const editable = Boolean(current && isEditable(current.kind));
  const change = current ? changes[current.rel] : undefined;
  const was = current ? baseline?.files[current.rel]?.text : undefined;
  const canDiff = editable && (change === "added" || (change === "changed" && was !== undefined));
  const picture = Boolean(current && current.kind === "image" && inTauri);
  const options: ViewMode[] = picture ? ["preview", "edit"] : !current || !editable ? [] : [...(hasPreview(current.kind) ? ["preview" as const] : []), "code", ...(canDiff ? ["diff" as const] : [])];
  const wanted = current ? modes[`${conv.id}:${current.rel}`] : undefined;
  const view: ViewMode = wanted && options.includes(wanted) ? wanted : (options[0] ?? "preview");

  // Tabs the person or an agent opened; whatever is in view always has one.
  const strip = current && !tabs.includes(current.rel) ? [...tabs, current.rel] : tabs;
  const hasTree = showTree && artifacts.length > 0;
  // Quiet controls: they show their shape only under the pointer, so the file is what the eye lands on.
  const ghost = "flex size-8 flex-none items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground";
  const pressed = "bg-secondary text-foreground";

  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-r-[22px] border bg-background px-4 pb-4" aria-label="Stage">
      {/* One row for the whole panel: what is open, and the other things the Stage can show. What belongs to the file in view sits with the file, below. */}
      <header className="flex min-h-[52px] items-center gap-1 px-0.5 py-2" data-tauri-drag-region>
        {artifacts.length > 0 && (
          <button type="button" aria-label={showTree ? "Hide the file list" : "Show the file list"} title={showTree ? "Hide the file list" : "Show the file list"} aria-pressed={showTree} className={cn(ghost, showTree && "text-foreground")} onClick={() => setSetting("tree", !showTree)}>
            <PanelIcon width={15} height={15} />
          </button>
        )}
        {strip.length > 0 ? (
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="Open files">
          {strip.map((rel) => {
              const virtual = rel === SCREEN || rel === BROWSER;
              const a = virtual ? undefined : artifacts.find((x) => x.rel === rel);
              if (!virtual && !a) return null;
              const label = rel === BROWSER ? "Browser" : "Screen";
              const on = rel === BROWSER ? onBrowser : rel === SCREEN ? onScreen : rel === current?.rel;
              const unsaved = Boolean(a && dirty[a.path]);
              return (
                <RightClick
                  key={rel}
                  items={[
                    { label: "Close", onSelect: () => closeTab(conv.id, rel) },
                    strip.length > 1 && { label: "Close the others", onSelect: () => strip.filter((r) => r !== rel).forEach((r) => closeTab(conv.id, r)) },
                    strip.length > 1 && { label: "Close all", onSelect: () => strip.forEach((r) => closeTab(conv.id, r)) },
                    a && inTauri && "-",
                    a && inTauri && { label: "Show in Finder", onSelect: () => void revealItemInDir(a.path).catch(() => undefined) },
                  ]}
                >
                <div className={cn("group/tab flex flex-none items-center rounded-xl text-[13px] font-medium", on ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground")}>
                  <button type="button" role="tab" aria-selected={on} title={a ? rel : label} className="flex items-center gap-1.5 py-1 pl-1.5 pr-1" onClick={() => select(conv.id, rel, true)}>
                    {a ? <Glyph kind={a.kind} name={a.rel} /> : <span className="glyph glyph-screen" aria-hidden="true"><i /></span>}
                    {a ? a.rel.split("/").pop() : label}
                  </button>
                  <button type="button" aria-label={`Close ${a ? a.rel : label}${unsaved ? " (unsaved changes stay until you quit)" : ""}`} title={unsaved ? "Unsaved changes" : "Close"} className="mr-1 flex size-5 items-center justify-center rounded-md hover:bg-background/20" onClick={() => closeTab(conv.id, rel)}>
                    {unsaved ? <span className="size-2 rounded-full bg-current group-hover/tab:hidden" /> : null}
                    <CloseIcon width={11} height={11} className={cn(unsaved && "hidden group-hover/tab:block")} />
                  </button>
                </div>
                </RightClick>
              );
            })}
          </div>
        ) : (
          <h2 className="min-w-0 flex-1 truncate px-1.5 text-[15px] font-semibold">{onBrowser ? "Browser" : onScreen ? "Screen" : "Stage"}</h2>
        )}
        <div className="flex flex-none items-center">
          {inTauri && (
            <>
              <button type="button" aria-label="Screen" title="Screen: watch another app's window live" aria-pressed={onScreen} className={cn(ghost, onScreen && pressed)} onClick={() => select(conv.id, SCREEN, true)}>
                <StageIcon width={15} height={15} />
              </button>
              <button type="button" aria-label="Browser" title="Browser" aria-pressed={onBrowser} className={cn(ghost, onBrowser && pressed)} onClick={() => select(conv.id, BROWSER, true)}>
                <GlobeIcon width={15} height={15} />
              </button>
            </>
          )}
          <button type="button" aria-label={termOpen ? "Hide the terminal" : "Show the terminal"} title={termOpen ? "Hide the terminal" : "Show the terminal"} aria-pressed={termOpen} className={cn(ghost, termOpen && pressed)} onClick={() => setTermOpen(conv.id, !termOpen)}>
            <TermIcon width={15} height={15} />
          </button>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
          <button type="button" aria-label="Hide Stage" title="Hide Stage" className={ghost} onClick={() => setStage(conv.id, "closed")}>
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      </header>

      <div className={cn("flex min-h-0 flex-1", !hasTree && "gap-3")}>
        {hasTree && (
          <>
            <aside className="flex-none overflow-hidden rounded-[18px] border" style={{ width: treeW }}>
              <FileTree conv={conv} current={current?.rel} />
            </aside>
            <Resizer label="File list width" value={treeW} min={150} max={420} reset={200} onChange={(w) => setSetting("treeW", w)} className="w-3" />
          </>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <FolderNotices conv={conv} count={artifacts.length} />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] border">
          {/* About the file in view, and what can be done with it. */}
          {(current || onScreen) && (
            <div className="flex h-10 flex-none items-center gap-2 border-b pl-3 pr-1.5 text-[13px]">
              {theirs && about ? <Face pubkey={about.remote.pubkey} name={about.label} size={18} /> : author && <CubeStill color={author.color} size={18} />}
              <p className="min-w-0 flex-1 truncate text-muted-foreground" title={current ? current.rel : undefined}>
                {onScreen ? (
                  <>
                    {follow ? `Watching ${follow.app}` : (lastShot?.label ?? "Watch a window live")}
                    {author && <> · {author.name}</>}
                    {(busy || follow) && <> · live</>}
                  </>
                ) : current ? (
                  <>
                    {KIND_LABEL[current.kind]}
                    {about?.synced ? <> · <span data-notranslate>{about.label}</span></> : author && <> · by {author.name}</>}
                    {about?.touching && <> · <span data-notranslate>{about.touching}</span> <span>is working on this</span></>}
                    {change && <> · <span title={change === "added" ? "New since you last spoke" : "Changed since you last spoke"}>{change === "added" ? "new" : "changed"}</span></>}
                    {busy && <> · live</>}
                  </>
                ) : null}
              </p>
              {options.length > 1 && current && (
                <div className="flex flex-none rounded-lg bg-secondary p-0.5" role="group" aria-label="How to show this file">
                  {options.map((m) => (
                    <button type="button" key={m} aria-pressed={view === m} className={cn("h-6 rounded-md px-2 text-xs font-medium text-muted-foreground", view === m && "bg-background font-semibold text-foreground shadow-sm")} onClick={() => setMode(conv.id, current.rel, m)}>
                      {MODE_NAME[m]}
                    </button>
                  ))}
                </div>
              )}
              {current && <FileHistory conv={conv} rel={current.rel} about={about} />}
              {current && inTauri && (
                <button type="button" className="flex h-7 flex-none items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground" title="Open in its own app" onClick={() => void openPath(current.path)}>
                  <OpenIcon width={13} height={13} /> Open
                </button>
              )}
            </div>
          )}
          <div className="min-h-0 w-full flex-1 overflow-auto">
            {onBrowser ? (
              <Suspense fallback={<p className="p-6 text-muted-foreground">Opening the browser…</p>}>
                <BrowserPane />
              </Suspense>
            ) : onScreen ? (
              <ScreenView convId={conv.id} shots={shots} follow={follow} />
            ) : current && picture && view === "edit" ? (
              <Suspense fallback={<p className="p-6 text-muted-foreground">Opening the picture…</p>}>
                <ImageEditor convId={conv.id} dir={conv.dir} a={current} key={current.path} />
              </Suspense>
            ) : current && editable && view !== "preview" ? (
              <Suspense fallback={<p className="p-6 text-muted-foreground">Opening the editor…</p>}>
                <CodeEditor convId={conv.id} a={current} diff={view === "diff"} base={view === "diff" ? (was ?? "") : undefined} key={current.path} />
              </Suspense>
            ) : current ? (
              <Viewer a={current} convId={conv.id} />
            ) : (
              <div className="flex min-h-full flex-col items-center justify-center gap-2 p-8 text-center">
                <Cube color="#C7C7CC" status="idle" size={120} />
                <h3 className="font-heading text-lg font-bold tracking-[-0.02em]">Nothing on Stage yet</h3>
                <p className="max-w-[340px] text-muted-foreground">Ask a cube to make something: a doc, a page, a chart, some code. It opens here as soon as the file exists.</p>
                {conv.dir && inTauri && <p className="font-mono text-xs text-muted-foreground">{conv.dir}</p>}
              </div>
            )}
          </div>
          {busy && <BorderBeam size={140} duration={5} borderWidth={2} colorFrom="#0071e3" colorTo="#8cc4ff" />}
        </div>
        <GitBar convId={conv.id} dir={conv.dir} />
        {termOpen && (
          <div className="h-[230px] flex-none overflow-hidden rounded-[18px] border bg-background">
            <Suspense fallback={<p className="p-4 text-[13px] text-muted-foreground">Opening the terminal…</p>}>
              <TerminalPanel convId={conv.id} dir={conv.dir} />
            </Suspense>
          </div>
        )}
        </div>
      </div>
    </section>
  );
}
