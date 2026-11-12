import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { init } from "@/agents/orchestrator";
import { inTauri, logLine } from "@/agents/runner";
import { AgentProfile } from "@/components/AgentProfile";
import { Conversation, ThreadPanel } from "@/components/Conversation";
import { Home } from "@/components/Home";
import { Inbox, useInboxCount } from "@/components/Inbox";
import { Library } from "@/components/Library";
import { applyFonts } from "@/lib/fonts";
import { uiScaleForKey } from "@/lib/uiScale";
import { setBadge } from "@/lib/notify";
import { setLanguage } from "@/i18n/dom";
import { JoinFromLink } from "@/components/JoinFromLink";
import { Onboarding } from "@/components/Onboarding";
import { Resizer } from "@/components/Resizer";
import { SettingsView } from "@/components/Settings";
import { Sidebar } from "@/components/Sidebar";
import { Stage } from "@/components/Stage";
import { motion } from "@/cube/engine";
import { useCube, useStageOpen } from "@/state/store";
import "./index.css";

export default function App() {
  const onboarded = useCube((s) => s.onboarded);
  const view = useCube((s) => s.view);
  const theme = useCube((s) => s.settings.theme);
  const calm = useCube((s) => s.settings.calm);
  const activeId = useCube((s) => s.activeId);
  const threadOpen = useCube((s) => Boolean(s.threadId && s.messages.some((m) => m.id === s.threadId)));
  const stageOpen = useStageOpen(activeId);
  const wide = useCube((s) => s.settings.sidebar);

  useEffect(() => {
    void init();
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && mq.matches));
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    motion.calm = calm;
    document.documentElement.classList.toggle("calm", calm);
  }, [calm]);

  const fontEn = useCube((s) => s.settings.fontEn);
  const fontKo = useCube((s) => s.settings.fontKo);
  useEffect(() => applyFonts(fontEn, fontKo), [fontEn, fontKo]);

  const uiScale = useCube((s) => s.settings.uiScale);
  useEffect(() => {
    if (inTauri) {
      void getCurrentWebview().setZoom(uiScale / 100).catch((e) => logLine(`Could not set screen size: ${String(e)}`));
    } else {
      // The browser preview has no native webview zoom. Keep the scaled body inside its viewport.
      document.body.style.zoom = String(uiScale / 100);
      document.body.style.width = `${10000 / uiScale}%`;
      document.body.style.height = `${10000 / uiScale}%`;
    }
  }, [uiScale]);

  const chatSize = useCube((s) => s.settings.chatSize);
  useEffect(() => {
    if (chatSize) document.documentElement.style.setProperty("--chat-size", `${chatSize}px`);
    else document.documentElement.style.removeProperty("--chat-size");
  }, [chatSize]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing || e.defaultPrevented) return;
      const s = useCube.getState();
      const next = uiScaleForKey(s.settings.uiScale, e.key);
      if (next === undefined) return;
      e.preventDefault();
      s.setSetting("uiScale", next);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const lang = useCube((s) => s.settings.lang);
  useEffect(() => setLanguage(lang), [lang]);

  // The Dock icon carries the number of things waiting on the person, plus unread messages.
  const waiting = useInboxCount();
  const unread = useCube((s) => Object.values(s.unread).reduce((n, v) => n + v, 0));
  const badge = useCube((s) => s.settings.notify);
  useEffect(() => setBadge(badge ? waiting + unread : 0), [waiting, unread, badge]);

  // A message someone jumped to: wait for it to be on the page, bring it into view and flash it.
  const focus = useCube((s) => s.focus);
  useEffect(() => {
    if (!focus) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const el = document.querySelector(`[data-mid="${focus.id}"]`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.remove("msg-flash");
        void (el as HTMLElement).offsetWidth;
        el.classList.add("msg-flash");
      }
      if (el || ++tries > 20) window.clearInterval(timer);
    }, 60);
    return () => window.clearInterval(timer);
  }, [focus]);

  const pane = view === "conv" && (threadOpen || stageOpen);
  const sidebarW = useCube((s) => s.settings.sidebarW);
  const chatW = useCube((s) => s.settings.chatW);
  const setSetting = useCube((s) => s.setSetting);
  const side = wide ? sidebarW : 60;

  return (
    <div className="flex h-full flex-col">
      {!inTauri && (
        <div className="bg-foreground px-4 py-1 text-center text-xs text-background" role="status" data-preview-note>
          Preview in a browser: the agents here are scripted stand-ins. Open the Cube desktop app to work with real ones.
        </div>
      )}
      {!onboarded ? (
        <div className="min-h-0 flex-1"><Onboarding /></div>
      ) : (
        <div
          className="relative grid min-h-0 flex-1 py-2.5 pr-2.5"
          // The conversation keeps the width the person gave it, but never squeezes what is beside it out of sight.
          style={{ gridTemplateColumns: pane ? `${side}px minmax(320px, min(${chatW}px, calc(100% - ${side}px - 360px))) minmax(0, 1fr)` : `${side}px minmax(0, 1fr)` }}
        >
          {wide && <Resizer label="Sidebar width" value={sidebarW} min={200} max={380} reset={244} onChange={(w) => setSetting("sidebarW", w)} className="absolute inset-y-2.5" style={{ left: side - 5 }} />}
          {pane && <Resizer label="Conversation width" value={chatW} min={320} max={900} reset={480} onChange={(w) => setSetting("chatW", w)} className="absolute inset-y-2.5" style={{ left: `calc(${side}px + min(${chatW}px, 100% - ${side}px - 360px) - 5px)` }} />}
          <Sidebar />
          <JoinFromLink />
          {view === "home" && <Home />}
          {view === "settings" && <SettingsView />}
          {view === "inbox" && <Inbox />}
          {view === "library" && <Library />}
          {view === "agent" && <AgentProfile />}
          {view === "conv" && <Conversation />}
          {view === "conv" && (threadOpen ? <ThreadPanel /> : stageOpen ? <Stage /> : null)}
        </div>
      )}
    </div>
  );
}
