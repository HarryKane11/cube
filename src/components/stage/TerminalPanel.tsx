import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { inTauri, onTermData, termOpen, termResize, termWrite } from "@/agents/runner";

/** One shell per conversation. It keeps running, with its scrollback, while the panel is closed. */
interface Session {
  term: Terminal;
  fit: FitAddon;
  /** The element xterm draws into. It moves between panels instead of being rebuilt. */
  host: HTMLDivElement;
  opened: boolean;
  /** False once the shell has exited; the next key press starts a new one. */
  running: boolean;
  dir: string;
}

const sessions = new Map<string, Session>();

const LIGHT = { background: "#ffffff", foreground: "#1d1d1f", cursor: "#0071e3", cursorAccent: "#ffffff", selectionBackground: "#b4d7ff" };
const DARK = { background: "#1c1c1e", foreground: "#f5f5f7", cursor: "#2997ff", cursorAccent: "#1c1c1e", selectionBackground: "#3a5a8c" };
const themeNow = () => (document.documentElement.classList.contains("dark") ? DARK : LIGHT);

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  void onTermData(({ id, data, ended }) => {
    const s = sessions.get(id);
    if (!s) return;
    if (data) s.term.write(data);
    if (ended) {
      s.running = false;
      s.term.write("\r\n\x1b[2m[The shell ended. Press any key to start a new one.]\x1b[0m\r\n");
    }
  });
  new MutationObserver(() => sessions.forEach((s) => { s.term.options.theme = themeNow(); })).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

function start(id: string, s: Session): void {
  s.running = true;
  termOpen(id, s.dir, s.term.cols, s.term.rows).catch((e) => {
    s.running = false;
    s.term.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`);
  });
}

function sessionFor(id: string, dir: string): Session {
  let s = sessions.get(id);
  if (!s) {
    const host = document.createElement("div");
    host.style.cssText = "width:100%;height:100%";
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeNow(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    s = { term, fit, host, opened: false, running: false, dir };
    const session = s;
    term.onData((data) => {
      if (session.running) void termWrite(id, data);
      else start(id, session);
    });
    term.onResize(({ cols, rows }) => void termResize(id, cols, rows));
    sessions.set(id, s);
  }
  s.dir = dir;
  return s;
}

/** The person's own shell, opened in the conversation's folder. */
export default function TerminalPanel({ convId, dir }: { convId: string; dir: string }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || !inTauri || !dir) return;
    wire();
    const s = sessionFor(convId, dir);
    el.appendChild(s.host);
    if (!s.opened) {
      // xterm measures its element, so it can only be opened once that element is on the page.
      s.term.open(s.host);
      s.opened = true;
    }
    const fit = () => {
      try {
        s.fit.fit();
      } catch {
        // The panel can be zero-sized for a frame while it opens.
      }
    };
    fit();
    if (!s.running) start(convId, s);
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    s.term.focus();
    return () => {
      watch.disconnect();
      s.host.remove();
    };
  }, [convId, dir]);

  if (!inTauri) return <p className="p-4 text-[13px] text-muted-foreground">The terminal runs in the Cube desktop app. This browser preview has no shell.</p>;
  return <div ref={box} className="size-full overflow-hidden py-1.5 pl-3 pr-1" aria-label="Terminal" />;
}
