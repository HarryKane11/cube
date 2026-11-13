import { useEffect, useState, type ReactNode } from "react";
import { PROVIDERS, PROVIDER_IDS, type Provider } from "@/agents/builtin/providers";
import { modeChanged, refreshEngines } from "@/agents/orchestrator";
import { inTauri, keyDelete, keyList, keySet } from "@/agents/runner";
import { MODES } from "@/agents/types";
import { FONTS_EN, FONTS_KO, fontName } from "@/lib/fonts";
import { UI_SCALES } from "@/lib/uiScale";
import { BellIcon, BookIcon, CubeIcon, DataIcon, GearIcon, PeopleIcon, PlugIcon, UserIcon } from "@/components/icons";
import { Face } from "@/components/bits";
import { toAvatar } from "@/lib/avatar";
import { setMyAvatar } from "@/team";
import { People } from "@/components/People";
import { ShortcutList } from "@/components/Sidebar";
import { Knowledge } from "@/components/Knowledge";
import { RemoteAgents } from "@/components/RemoteAgents";
import { SlackSettings } from "@/components/SlackSettings";
import { Subagents } from "@/components/Subagents";
import { Updates } from "@/components/Updates";
import { EnginesFound, RoleEngines } from "@/components/TeamSetup";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useCube, type Settings as SettingsShape } from "@/state/store";
import { useUpdate } from "@/update";

export function Switch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-4 border-b py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        <div className="text-[13px] text-muted-foreground">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={cn("relative h-7 w-12 flex-none rounded-full transition-colors", checked ? "bg-primary" : "bg-secondary")}
        onClick={() => onChange(!checked)}
      >
        <span className={cn("absolute top-0.5 size-6 rounded-full bg-white shadow-sm transition-[left]", checked ? "left-[22px]" : "left-0.5")} />
      </button>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[22px] border bg-background p-5">
      <h2 className="mb-2 text-[13px] font-semibold text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** Where the person saves their own keys for model services. A saved key is never shown again. */
function ModelKeys() {
  const [saved, setSaved] = useState<string[]>([]);
  const [draft, setDraft] = useState<Partial<Record<Provider, string>>>({});
  const [error, setError] = useState("");
  const reload = () => keyList().then(setSaved).catch((e) => setError(String(e))).then(() => refreshEngines());
  useEffect(() => { void reload(); }, []);
  const save = (p: Provider) => {
    setError("");
    keySet(p, draft[p] ?? "").then(() => { setDraft((d) => ({ ...d, [p]: "" })); return reload(); }).catch((e) => setError(String(e)));
  };
  if (!inTauri) return <p className="text-[13px] text-muted-foreground">Model keys are kept in the Keychain, so they can only be added in the Cube desktop app.</p>;
  return (
    <div className="flex flex-col">
      <p className="mb-1 text-[13px] text-muted-foreground">With a key of your own, a role can run on the built-in agent instead of a program installed on this computer. Keys are stored in the macOS Keychain and sent only to the service they belong to. Pick the built-in agent and a model on a role's profile.</p>
      {PROVIDER_IDS.map((p) => {
        const has = saved.includes(p);
        return (
          <form key={p} className="flex flex-wrap items-center gap-2 border-b py-3 last:border-b-0" onSubmit={(e) => { e.preventDefault(); save(p); }}>
            <div className="min-w-[150px] flex-1">
              <div className="font-medium">{PROVIDERS[p].name}</div>
              <div className={cn("text-[13px]", has ? "font-semibold text-primary" : "text-muted-foreground")}>{has ? "Key saved" : "No key"}</div>
            </div>
            <Input
              type="password"
              autoComplete="off"
              aria-label={`${PROVIDERS[p].name} key`}
              placeholder={has ? "Paste a new key to replace it" : PROVIDERS[p].hint}
              value={draft[p] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))}
              className="selectable h-9 w-[260px]"
            />
            <button type="submit" disabled={!draft[p]?.trim()} className="h-8 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35">Save</button>
            {has && <button type="button" className="h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => void keyDelete(p).then(reload).catch((e) => setError(String(e)))}>Remove</button>}
          </form>
        );
      })}
      {error && <p className="pt-2 text-[13px] text-destructive" role="alert">{error}</p>}
    </div>
  );
}

const THEMES: { v: SettingsShape["theme"]; label: string }[] = [
  { v: "system", label: "Match system" },
  { v: "light", label: "Light" },
  { v: "dark", label: "Dark" },
];

type Tab = "general" | "team" | "connections" | "knowledge" | "people" | "alerts" | "data";
const TABS: { id: Tab; name: string; icon: typeof GearIcon }[] = [
  { id: "general", name: "General", icon: UserIcon },
  { id: "team", name: "Team", icon: CubeIcon },
  { id: "connections", name: "Models and agents", icon: PlugIcon },
  { id: "knowledge", name: "Knowledge", icon: BookIcon },
  { id: "people", name: "People", icon: PeopleIcon },
  { id: "alerts", name: "Notifications and Stage", icon: BellIcon },
  { id: "data", name: "Data", icon: DataIcon },
];
/** The tab Settings was last on, for as long as the app is open. */
let lastTab: Tab = "general";
/** The last request to be shown the update that Settings answered. */
let shownUpdate = 0;

export function SettingsView() {
  const [tab, setTab] = useState<Tab>(lastTab);
  const pick = (t: Tab) => { lastTab = t; setTab(t); };
  const settings = useCube((s) => s.settings);
  const set = useCube((s) => s.setSetting);
  const name = useCube((s) => s.name);
  const setName = useCube((s) => s.setName);
  const hasPicture = useCube((s) => Boolean(s.avatar));
  const [pictureError, setPictureError] = useState("");
  const clearHistory = useCube((s) => s.clearHistory);
  const restartOnboarding = useCube((s) => s.restartOnboarding);
  const [confirming, setConfirming] = useState(false);
  const pill = "h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold";

  // Asked to show the update (from the sidebar): go to where it is and bring it into view.
  const showUpdate = useUpdate((s) => s.show);
  useEffect(() => {
    if (showUpdate === shownUpdate) return;
    shownUpdate = showUpdate;
    pick("general");
    window.setTimeout(() => document.getElementById("set-updates")?.scrollIntoView({ block: "center" }), 0);
  }, [showUpdate]);

  return (
    <main className="grid min-h-0 grid-cols-[212px_minmax(0,1fr)] overflow-hidden rounded-[22px] border bg-ground">
      <nav className="flex min-h-0 flex-col gap-0.5 overflow-auto border-r p-3 pt-6" aria-label="Settings" data-tauri-drag-region>
        <h1 className="px-2.5 pb-3 font-heading text-[24px] font-bold leading-tight tracking-[-0.03em]">Settings</h1>
        {TABS.map((t) => (
          <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined} className={cn("flex h-9 items-center gap-2.5 rounded-xl px-2.5 text-left text-[14px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground", tab === t.id && "bg-secondary font-semibold text-foreground")} onClick={() => pick(t.id)}>
            <t.icon width={17} height={17} className="flex-none" />
            <span className="min-w-0 truncate">{t.name}</span>
          </button>
        ))}
      </nav>
      <div className="min-h-0 overflow-auto" key={tab}>
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-6" data-tauri-drag-region>
        <h2 className="pt-2 font-heading text-[24px] font-bold leading-tight tracking-[-0.03em]">{TABS.find((t) => t.id === tab)?.name}</h2>

        {tab === "general" && (
          <>
        <Section title="You">
          <div className="mb-4 flex items-center gap-4">
            <Face size={64} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap gap-2">
                <label className={cn(pill, "flex cursor-pointer items-center")}>
                  Choose a picture
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/heic" className="sr-only" onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    setPictureError("");
                    if (file) void toAvatar(file).then(setMyAvatar).catch((err) => setPictureError(String(err)));
                  }} />
                </label>
                {hasPicture && <button type="button" className={pill} onClick={() => setMyAvatar(undefined)}>Remove</button>}
              </div>
              <p className="text-[13px] text-muted-foreground">Shown next to your messages. In a team, teammates see it too.</p>
              {pictureError && <p className="text-[13px] text-destructive" role="alert" data-notranslate>{pictureError}</p>}
            </div>
          </div>
          <label htmlFor="set-name" className="mb-1.5 block font-medium">Name</label>
          <Input id="set-name" value={name} onChange={(e) => setName(e.target.value)} className="selectable h-9 max-w-[320px]" />
          <p className="mt-1.5 text-[13px] text-muted-foreground">Agents use this name when they talk to you.</p>
        </Section>

        <Section title="Language and type">
          <div className="flex items-center gap-4 border-b py-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">Language</div>
              <div className="text-[13px] text-muted-foreground">The language of Cube's own words. What you and the cubes write stays as it is.</div>
            </div>
            <div className="flex rounded-[10px] bg-secondary p-0.5" role="group" aria-label="Language" data-notranslate>
              {([["en", "English"], ["ko", "한국어"]] as const).map(([id, name]) => (
                <button key={id} type="button" aria-pressed={settings.lang === id} className={cn("h-7 rounded-lg px-3 text-[13px] font-medium text-muted-foreground", settings.lang === id && "bg-background font-semibold text-foreground shadow-sm")} onClick={() => set("lang", id)}>
                  {name}
                </button>
              ))}
            </div>
          </div>
          {([["fontEn", "Typeface for English", FONTS_EN], ["fontKo", "Typeface for Korean", FONTS_KO]] as const).map(([key, label, list]) => (
            <div key={key} className="flex items-center gap-4 border-b py-3">
              <div className="min-w-0 flex-1 font-medium">{label}</div>
              <select aria-label={label} value={settings[key]} onChange={(e) => set(key, e.target.value)} className="selectable h-9 rounded-xl border bg-transparent px-2.5 text-[13px]" data-notranslate>
                {list.map((f) => <option key={f.id} value={f.id}>{fontName(f, settings.lang)}</option>)}
              </select>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-4 border-b py-3">
            <div className="min-w-[160px] flex-1">
              <label htmlFor="set-ui-scale" className="font-medium">Screen size</label>
              <div className="text-[13px] text-muted-foreground">Scale text and controls together. ⌘+ / ⌘− / ⌘0 (Ctrl on Windows/Linux).</div>
            </div>
            <select id="set-ui-scale" value={settings.uiScale} onChange={(e) => set("uiScale", Number(e.target.value))} className="selectable h-9 rounded-xl border bg-transparent px-2.5 text-[13px]" data-notranslate>
              {UI_SCALES.map((scale) => <option key={scale} value={scale}>{scale}%</option>)}
            </select>
          </div>
          <div className="flex items-center gap-4 border-t py-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="set-chat-size" className="font-medium">Message text size</label>
              <div className="text-[13px] text-muted-foreground">Only what is said in conversations. Everything else keeps its size.</div>
            </div>
            <select id="set-chat-size" value={settings.chatSize || 0} onChange={(e) => set("chatSize", Number(e.target.value))} className="selectable h-9 rounded-xl border bg-transparent px-2.5 text-[13px]">
              <option value={0}>Default</option>
              {[13, 14, 16, 17, 18, 20].map((px) => <option key={px} value={px} data-notranslate>{px}px</option>)}
            </select>
          </div>
          <p className="pt-3 text-[17px] leading-relaxed" data-notranslate>The quick brown fox jumps over the lazy dog. 0123456789<br />다람쥐 헌 쳇바퀴에 타고파. 큐브와 함께 일하는 작업 공간.</p>
        </Section>

        <Section title="Keyboard shortcuts">
          <ShortcutList />
        </Section>

        <Section title="Look">
          <div className="flex items-center gap-4 border-b py-3">
            <div className="min-w-0 flex-1 font-medium">Appearance</div>
            <div className="flex rounded-[10px] bg-secondary p-0.5" role="group" aria-label="Appearance">
              {THEMES.map((t) => (
                <button key={t.v} type="button" aria-pressed={settings.theme === t.v} className={cn("h-7 rounded-lg px-3 text-[13px] font-medium text-muted-foreground", settings.theme === t.v && "bg-background font-semibold text-foreground shadow-sm")} onClick={() => set("theme", t.v)}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <Switch label="Calm cubes" hint="Cubes stop twisting their layers while they work. Their faces still change." checked={settings.calm} onChange={(v) => set("calm", v)} />
        </Section>

        <div id="set-updates">
          <Section title="Updates">
            <Updates />
          </Section>
        </div>
          </>
        )}

        {tab === "team" && (
          <>
        <Section title="Team">
          <p className="mb-3 text-[13px] text-muted-foreground">Each role runs on one of the agent programs installed on this computer. Open a role to pick its model, see the skills and tools it brings along, and review what it has learned.</p>
          <EnginesFound />
          <div className="mt-2"><RoleEngines /></div>
        </Section>

        <Section title="Your sub-agents">
          <Subagents />
        </Section>

        <Section title="How work is handed out">
          <Switch label="Pick the cube for me" hint="When a channel message names nobody, the Router reads it and passes it to the right cube, or to the Orchestrator when it takes a team. Off: whoever spoke last answers." checked={settings.autoAssign} onChange={(v) => set("autoAssign", v)} />
          <div className="flex items-center gap-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">Handoffs before you step in</div>
              <div className="text-[13px] text-muted-foreground">How many times cubes may pass work to each other after one message from you.</div>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" aria-label="Fewer handoffs" className="size-8 rounded-full bg-secondary font-semibold disabled:opacity-35" disabled={settings.maxHops <= 0} onClick={() => set("maxHops", settings.maxHops - 1)}>−</button>
              <span className="w-8 text-center font-semibold tabular-nums" aria-live="polite">{settings.maxHops}</span>
              <button type="button" aria-label="More handoffs" className="size-8 rounded-full bg-secondary font-semibold disabled:opacity-35" disabled={settings.maxHops >= 8} onClick={() => set("maxHops", settings.maxHops + 1)}>+</button>
            </div>
          </div>
        </Section>

        <Section title="Asking before acting">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-[200px] flex-1">
              <div className="font-medium">Mode for new conversations</div>
              <div className="text-[13px] text-muted-foreground">{MODES.find((m) => m.id === settings.mode)?.about} You can change it for one conversation in its message box.</div>
            </div>
            <div className="flex rounded-[10px] bg-secondary p-0.5" role="group" aria-label="Mode for new conversations">
              {MODES.filter((m) => m.id !== "plan").map((m) => (
                <button key={m.id} type="button" aria-pressed={settings.mode === m.id} className={cn("h-7 rounded-lg px-3 text-[13px] font-medium text-muted-foreground", settings.mode === m.id && "bg-background font-semibold text-foreground shadow-sm")} onClick={() => { set("mode", m.id); useCube.getState().convs.forEach((c) => modeChanged(c.id)); }}>
                  {m.name}
                </button>
              ))}
            </div>
          </div>
        </Section>
          </>
        )}

        {tab === "connections" && (
          <>
        <Section title="Model keys">
          <ModelKeys />
        </Section>

        <Section title="Remote agents">
          <RemoteAgents />
        </Section>

        <Section title="Slack">
          <SlackSettings />
        </Section>
          </>
        )}

        {tab === "knowledge" && <Knowledge />}

        {tab === "people" && <People />}

        {tab === "alerts" && (
          <>
        <Section title="Notifications">
          <Switch label="Tell me when a cube needs me" hint="A system notification when a cube asks for your OK, has a question, gets stuck or finishes while Cube is in the background. The Dock icon shows how many things wait on you." checked={settings.notify} onChange={(v) => set("notify", v)} />
        </Section>

        <Section title="Stage">
          <Switch label="Open the Stage by itself" hint="When a cube makes or changes a file, show it beside the conversation. Off: the Stage opens only when you ask." checked={settings.stageAuto} onChange={(v) => set("stageAuto", v)} />
        </Section>
          </>
        )}

        {tab === "data" && (
          <>
        <Section title="Data">
          <p className="mb-3 text-[13px] text-muted-foreground">Conversations are kept in this app. Files your team makes live in the CubeSpaces folder in your home folder and are never deleted from here.</p>
          <div className="flex flex-wrap items-center gap-2">
            {confirming ? (
              <>
                <span className="text-[13px]">Forget every message and each cube's memory?</span>
                <button type="button" className="h-8 rounded-full bg-destructive px-3 text-[13px] font-semibold text-white" onClick={() => { clearHistory(); setConfirming(false); }}>Forget everything</button>
                <button type="button" className={pill} onClick={() => setConfirming(false)}>Keep</button>
              </>
            ) : (
              <>
                <button type="button" className={pill} onClick={() => setConfirming(true)}>Clear conversations</button>
                <button type="button" className={pill} onClick={restartOnboarding}>Show the welcome again</button>
              </>
            )}
          </div>
        </Section>
          </>
        )}
      </div>
      </div>
    </main>
  );
}
