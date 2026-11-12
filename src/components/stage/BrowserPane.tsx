import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { browserCloseTab, browserNew, browserSend, browserStart, browserTabs, browserView, inTauri, onBrowser, type BrowserTab } from "@/agents/runner";
import { BackIcon, ChevronIcon, CloseIcon, OpenIcon, PlusIcon, ReloadIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

/** What the person typed in the address bar, as an address: a URL as it is, anything else as a web search. */
export function toUrl(typed: string): string {
  const t = typed.trim();
  if (!t) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^localhost:\d/i.test(t)) return t;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (!/\s/.test(t) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

/** Keys that are not text, with the code Chromium knows each by. */
const KEYS: Record<string, number> = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };

const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

/**
 * Cube's own browser, shown live. It runs without a window; what is drawn here are its frames,
 * and clicks, scrolling and typing are passed on to it. Agents can drive the same browser, so
 * the person sees their browsing as it happens and can take over at any point.
 */
export default function BrowserPane() {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [target, setTarget] = useState<string>();
  const [url, setUrl] = useState("");
  const [typed, setTyped] = useState<string>();
  const [error, setError] = useState("");
  const [blank, setBlank] = useState(true);
  const port = useCube((s) => s.browserPort);
  const setPort = useCube((s) => s.setBrowserPort);
  const img = useRef<HTMLImageElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const frame = useRef({ w: 1280, h: 800 });
  const now = useRef<string | undefined>(undefined);
  const known = useRef(new Set<string>());
  const composing = useRef(false);
  const lastMove = useRef(0);
  now.current = target;

  const refresh = async (first = false) => {
    let list = await browserTabs();
    if (!list.length) {
      await browserNew();
      list = await browserTabs();
    }
    setTabs(list);
    // A tab nobody here opened is an agent's: follow it.
    const fresh = list.find((t) => !known.current.has(t.id));
    list.forEach((t) => known.current.add(t.id));
    setTarget((cur) => (first ? (cur ?? list[0]?.id) : fresh && cur ? fresh.id : cur && list.some((t) => t.id === cur) ? cur : list[0]?.id));
  };

  useEffect(() => {
    if (!inTauri) return;
    let alive = true;
    browserStart()
      .then((p) => { if (alive) { setPort(p); return refresh(true); } })
      .catch((e) => alive && setError(String(e)));
    const timer = window.setInterval(() => { if (!document.hidden) void refresh().catch(() => undefined); }, 2000);
    const off = [
      onBrowser<{ target: string; data: string; w: number; h: number }>("browser-frame", (f) => {
        if (f.target !== now.current || !img.current) return;
        frame.current = { w: f.w || 1280, h: f.h || 800 };
        img.current.src = `data:image/jpeg;base64,${f.data}`;
        setBlank(false);
      }),
      onBrowser<{ target: string; url: string }>("browser-nav", (n) => { if (n.target === now.current) { setUrl(n.url); setTyped(undefined); } }),
    ];
    return () => {
      alive = false;
      window.clearInterval(timer);
      off.forEach((p) => void p.then((stop) => stop()));
    };
    // Runs once: the browser outlives this pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch the tab in view, sized to the space it is drawn in.
  useEffect(() => {
    if (!target) return;
    setBlank(true);
    setUrl(tabs.find((t) => t.id === target)?.url ?? "");
    const el = box.current;
    const fit = () => {
      if (!el || el.clientWidth < 50) return;
      void browserSend("Emulation.setDeviceMetricsOverride", { width: Math.round(el.clientWidth), height: Math.round(el.clientHeight), deviceScaleFactor: 2, mobile: false });
    };
    let timer = 0;
    void browserView(target).then(fit).catch((e) => setError(String(e)));
    const watch = new ResizeObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(fit, 180); });
    if (el) watch.observe(el);
    return () => { watch.disconnect(); window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const go = (to: string) => { setTyped(undefined); setUrl(to); void browserSend("Page.navigate", { url: to }); };
  const point = (e: MouseEvent | WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * frame.current.w, y: ((e.clientY - r.top) / r.height) * frame.current.h, modifiers: mods(e) };
  };
  const mouse = (type: "mousePressed" | "mouseReleased" | "mouseMoved") => (e: MouseEvent) => {
    if (type === "mouseMoved") {
      // Moves are only worth sending while dragging, or now and then for hover.
      if (!e.buttons && Date.now() - lastMove.current < 60) return;
      lastMove.current = Date.now();
    } else keys.current?.focus();
    void browserSend("Input.dispatchMouseEvent", { type, ...point(e), button: type === "mouseMoved" && !e.buttons ? "none" : "left", buttons: e.buttons, clickCount: type === "mouseMoved" ? 0 : e.detail || 1 });
  };
  const wheel = (e: WheelEvent) => void browserSend("Input.dispatchMouseEvent", { type: "mouseWheel", ...point(e), deltaX: e.deltaX, deltaY: e.deltaY });
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || e.nativeEvent.isComposing) return;
    const code = KEYS[e.key];
    if (code) {
      e.preventDefault();
      const base = { key: e.key, code: e.key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: mods(e) };
      void browserSend("Input.dispatchKeyEvent", { type: e.key === "Enter" ? "keyDown" : "rawKeyDown", ...base, ...(e.key === "Enter" ? { text: "\r" } : {}) });
      void browserSend("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      void browserSend("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] });
    }
  };
  /** Text arrives through a hidden field, so typing in any language (and pasting) works as it does everywhere else. */
  const text = () => {
    const el = keys.current;
    if (!el || composing.current || !el.value) return;
    void browserSend("Input.insertText", { text: el.value });
    el.value = "";
  };

  if (!inTauri) return <p className="p-6 text-muted-foreground">The built-in browser runs in the Cube desktop app.</p>;
  const tool = "flex size-8 flex-none items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground";
  const tab = tabs.find((t) => t.id === target);
  return (
    <div className="flex size-full flex-col">
      <div className="flex flex-none items-center gap-1 border-b px-2 py-1.5">
        <button type="button" aria-label="Back" title="Back" className={tool} onClick={() => void browserSend("Runtime.evaluate", { expression: "history.back()" })}><BackIcon /></button>
        <button type="button" aria-label="Forward" title="Forward" className={tool} onClick={() => void browserSend("Runtime.evaluate", { expression: "history.forward()" })}><ChevronIcon /></button>
        <button type="button" aria-label="Reload" title="Reload" className={tool} onClick={() => void browserSend("Page.reload")}><ReloadIcon width={16} height={16} /></button>
        <form className="min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); go(toUrl(typed ?? url)); keys.current?.focus(); }}>
          <input
            aria-label="Address"
            value={typed ?? (url === "about:blank" ? "" : url)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Type an address or search"
            className="selectable h-8 w-full rounded-full bg-muted px-3.5 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(e) => setTyped(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </form>
        <button type="button" aria-label="Open this page in my own browser" title="Open in my own browser" className={tool} disabled={!/^https?:/.test(url)} onClick={() => void openUrl(url)}><OpenIcon width={15} height={15} /></button>
      </div>
      <div className="flex flex-none items-center gap-1 overflow-x-auto border-b px-2 py-1 [scrollbar-width:none]" role="tablist" aria-label="Browser tabs">
        {tabs.map((t) => (
          <div key={t.id} className={cn("flex max-w-[190px] flex-none items-center rounded-lg text-xs", t.id === target ? "bg-secondary font-semibold" : "text-muted-foreground hover:bg-accent")}>
            <button type="button" role="tab" aria-selected={t.id === target} title={t.url} className="min-w-0 truncate py-1 pl-2.5 pr-1" onClick={() => setTarget(t.id)}>{t.title || t.url || "New tab"}</button>
            <button type="button" aria-label={`Close ${t.title || "tab"}`} className="mr-1 flex size-4 flex-none items-center justify-center rounded hover:bg-background" onClick={() => void browserCloseTab(t.id).then(() => refresh())}><CloseIcon width={9} height={9} /></button>
          </div>
        ))}
        <button type="button" aria-label="New tab" title="New tab" className="flex size-6 flex-none items-center justify-center rounded-lg text-muted-foreground hover:bg-accent" onClick={() => void browserNew().then((id) => refresh().then(() => setTarget(id)))}><PlusIcon width={13} height={13} /></button>
        {port && <span className="ml-auto flex-none pl-3 text-[11px] text-muted-foreground" title={`Cubes are told to use this browser at http://127.0.0.1:${port}`}>Shared with cubes · port {port}</span>}
      </div>
      <div ref={box} className="relative min-h-0 flex-1 bg-white">
        {error ? (
          <p className="p-6 text-[13px] text-destructive" role="alert">{error}</p>
        ) : (
          <>
            <img
              ref={img}
              alt={tab?.title || "Browser page"}
              draggable={false}
              className={cn("absolute inset-0 size-full select-none", blank && "opacity-0")}
              onMouseDown={mouse("mousePressed")}
              onMouseUp={mouse("mouseReleased")}
              onMouseMove={mouse("mouseMoved")}
              onWheel={wheel}
              onContextMenu={(e) => e.preventDefault()}
            />
            {blank && <p className="absolute inset-0 flex items-center justify-center text-[13px] text-neutral-500">{url && url !== "about:blank" ? "Loading…" : "Type an address above. Cubes that browse show up here too."}</p>}
            <textarea
              ref={keys}
              aria-label="Type into the page"
              className="pointer-events-none absolute left-0 top-0 size-px opacity-0"
              onKeyDown={key}
              onInput={text}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; text(); }}
            />
          </>
        )}
      </div>
    </div>
  );
}
