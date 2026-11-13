import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { Note } from "@/agents/notes";
import { getHarness, type Harness, type HarnessItem } from "@/agents/runner";
import { ruleLabel } from "@/agents/permissions";
import { AGENTS, EFFORTS, ENGINE_CAN, ENGINES, MODEL_HINTS, TRUSTS, TRUST_ABOUT, agentById, type AgentDef, type AgentKind, PALETTES, type Palette, ROLE_DEFAULTS } from "@/agents/types";
import { BrandMark, useEngine } from "@/components/bits";
import { Section, Switch } from "@/components/Settings";
import { Input } from "@/components/ui/input";
import { Cube } from "@/cube/Cube";
import { cn } from "@/lib/utils";
import { spanOf } from "@/components/MessageItem";
import { shownEngine } from "@/components/TeamSetup";
import { statsFor } from "@/lib/stats";
import { useCube } from "@/state/store";

const KINDS = Object.keys(ENGINES) as AgentKind[];
const seg = "flex rounded-[10px] bg-secondary p-0.5";
const segItem = "flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground disabled:opacity-35";
const segOn = "bg-background font-semibold text-foreground shadow-sm";
const pill = "h-8 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold";

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-3 last:border-b-0">
      <div className="min-w-[180px] flex-1">
        <div className="font-medium">{label}</div>
        {hint && <div className="text-[13px] text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** Which program runs this role, on which model, and how hard it thinks. */
function RunsOn({ agent, engine, harness }: { agent: AgentDef; engine: AgentKind; harness?: Harness }) {
  const available = useCube((s) => s.available);
  const setEngine = useCube((s) => s.setEngine);
  const picked = useCube((s) => s.models[`${agent.id}:${engine}`]);
  const setModel = useCube((s) => s.setModel);
  const customs = useCube((s) => s.customs);
  const custom = useCube((s) => s.customFor[agent.id] ?? s.customs[0]?.id ?? "");
  const setCustomFor = useCube((s) => s.setCustomFor);
  const remotes = useCube((s) => s.remotes);
  const remote = useCube((s) => s.remoteFor[agent.id] ?? s.remotes[0]?.id ?? "");
  const setRemoteFor = useCube((s) => s.setRemoteFor);
  // A role with a model of its own on this engine (the Router) falls back to that, not to the engine's setting.
  const own = ROLE_DEFAULTS[agent.id]?.[engine]?.model ?? harness?.model;
  const hints = [...new Set([...MODEL_HINTS[engine], ...(own ? [own] : [])])];
  const listId = `models-${agent.id}`;

  return (
    <Section title="Runs on">
      <Row label="Agent program" hint="A change starts a fresh memory for this role in each conversation.">
        <div className={seg} role="group" aria-label={`Agent program for ${agent.name}`}>
          {KINDS.filter((k) => shownEngine(k, engine, available)).map((k) => (
            <button
              type="button"
              key={k}
              disabled={!available[k]}
              aria-pressed={engine === k}
              title={available[k] ? ENGINES[k].name : `${ENGINES[k].name} was not found on this computer`}
              className={cn(segItem, engine === k && segOn)}
              onClick={() => setEngine(agent.id, k)}
            >
              <BrandMark kind={k} className="size-3" /> {ENGINES[k].name.split(" ")[0]}
            </button>
          ))}
        </div>
      </Row>
      {engine === "remote" && (
        <Row label="Remote agent" hint="Agents added under Settings > Remote agents. It gets this conversation's messages and nothing from this computer.">
          <select aria-label={`Remote agent for ${agent.name}`} value={remote} onChange={(e) => setRemoteFor(agent.id, e.target.value)} className="selectable h-9 rounded-xl border bg-transparent px-2.5 text-[13px]">
            {remotes.map((r) => <option key={r.id} value={r.id}>{r.card.name}</option>)}
          </select>
        </Row>
      )}
      {engine === "custom" && (
        <Row label="Your agent" hint="Programs described in ~/CubeSpaces/.agents. See docs/custom-agents.md for how to add one.">
          <select aria-label={`Custom agent for ${agent.name}`} value={custom} onChange={(e) => setCustomFor(agent.id, e.target.value)} className="selectable h-9 rounded-xl border bg-transparent px-2.5 text-[13px]">
            {customs.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.program})</option>)}
          </select>
        </Row>
      )}
      <Row
        label="Model"
        hint={own ? <>Empty uses what {ENGINES[engine].name} is set to: <span className="font-mono">{own}</span></> : `Empty uses what ${ENGINES[engine].name} is set to.`}
      >
        {picked?.model && (
          <button type="button" className={pill} onClick={() => setModel(agent.id, engine, { model: "" })}>
            Use default
          </button>
        )}
        <Input
          aria-label={`Model for ${agent.name}`}
          list={listId}
          value={picked?.model ?? ""}
          placeholder={own || "Default"}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="selectable h-9 w-[240px] font-mono text-[13px]"
          onChange={(e) => setModel(agent.id, engine, { model: e.target.value })}
        />
        <datalist id={listId}>{hints.map((m) => <option value={m} key={m} />)}</datalist>
      </Row>
      {ENGINE_CAN[engine].effort && (
        <Row label="Effort" hint={harness?.effort ? `How hard it thinks before it answers. Default is ${harness.effort}.` : "How hard it thinks before it answers. Higher is slower and more careful."}>
          <div className={seg} role="group" aria-label={`Effort for ${agent.name}`}>
            {["", ...EFFORTS].map((e) => (
              <button type="button" key={e || "default"} aria-pressed={(picked?.effort ?? "") === e} className={cn(segItem, (picked?.effort ?? "") === e && segOn)} onClick={() => setModel(agent.id, engine, { effort: e })}>
                {e ? e.charAt(0).toUpperCase() + e.slice(1) : "Default"}
              </button>
            ))}
          </div>
        </Row>
      )}
    </Section>
  );
}

const NO_RULES: string[] = [];

/** How much the role may do before it has to ask, and what the person has already allowed for good. */
function TrustDial({ agent, engine }: { agent: AgentDef; engine: AgentKind }) {
  const trust = useCube((s) => (s.trust[agent.id] === "ask" ? "ask" : "edits"));
  const setTrust = useCube((s) => s.setTrust);
  const rules = useCube((s) => s.allow[agent.id] ?? NO_RULES);
  const removeRule = useCube((s) => s.removeRule);
  return (
    <Section title="Trust">
      <Row label="In Manual mode" hint={TRUST_ABOUT[engine][trust]}>
        <div className={seg} role="group" aria-label={`Trust for ${agent.name}`}>
          {TRUSTS.map((t) => (
            <button type="button" key={t.id} aria-pressed={trust === t.id} className={cn(segItem, trust === t.id && segOn)} onClick={() => setTrust(agent.id, t.id)}>
              {t.name}
            </button>
          ))}
        </div>
      </Row>
      <p className="border-b py-3 text-[13px] text-muted-foreground">
        To let {agent.name} work to the end without asking, pick Auto or Bypass in a conversation's message box.
      </p>
      {ENGINE_CAN[engine].ask && (
        <div className="py-3">
          <h3 className="font-medium">Always allowed <span className="font-normal text-muted-foreground tabular-nums">{rules.length}</span></h3>
          {rules.length === 0 ? (
            <p className="mt-1 text-[13px] text-muted-foreground">Nothing yet. When {agent.name} asks for your OK, you can allow that kind of thing for good, and it shows up here.</p>
          ) : (
            <ul className="mt-1">
              {rules.map((r) => (
                <li key={r} className="flex items-center gap-3 border-b py-1.5 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate">{ruleLabel(r)}</span>
                  <button type="button" className={pill} onClick={() => removeRule(agent.id, r)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

function ItemList({ title, items, empty }: { title: string; items: HarnessItem[]; empty: string }) {
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const found = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? items.filter((i) => `${i.name} ${i.about}`.toLowerCase().includes(needle)) : items;
  }, [items, q]);
  const shown = all || q ? found : found.slice(0, 6);
  return (
    <div className="border-b py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-medium">{title} <span className="font-normal text-muted-foreground tabular-nums">{items.length}</span></h3>
        {items.length > 12 && (
          <Input aria-label={`Filter ${title.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" className="selectable h-8 w-[160px] text-[13px]" />
        )}
      </div>
      {items.length === 0 ? (
        <p className="mt-1 text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-1.5 flex flex-col">
          {shown.map((i) => (
            <li key={i.name} className="flex items-baseline gap-3 py-1">
              <span className="w-[200px] flex-none truncate font-mono text-[13px]">{i.name}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground" title={i.about}>{i.about}</span>
            </li>
          ))}
          {q && found.length === 0 && <li className="py-1 text-[13px] text-muted-foreground">Nothing matches.</li>}
        </ul>
      )}
      {!q && found.length > 6 && (
        <button type="button" className="mt-1 text-[13px] font-semibold text-primary" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${found.length}`}
        </button>
      )}
    </div>
  );
}

/** What the role's program already has on this computer, and whether the role brings it to work. */
function Setup({ agent, engine, harness }: { agent: AgentDef; engine: AgentKind; harness?: Harness }) {
  const plain = useCube((s) => Boolean(s.plain[agent.id]));
  const setPlain = useCube((s) => s.setPlain);
  const name = ENGINES[engine].name;
  const can = ENGINE_CAN[engine].plain;
  return (
    <Section title="Setup it brings along">
      {can ? (
        <Switch
          label={`Use my ${name} setup`}
          hint={`${agent.name} works with the skills, plugins, MCP servers and hooks you set up in ${name}. Off: it starts plain and knows only what Cube tells it.`}
          checked={!plain}
          onChange={(v) => setPlain(agent.id, !v)}
        />
      ) : (
        <p className="border-b py-3 text-[13px] text-muted-foreground">{name} always starts with its own setup. Cube cannot switch it off yet.</p>
      )}
      <div className={cn(can && plain && "opacity-45")} aria-hidden={can && plain}>
        {!harness ? (
          <p className="py-3 text-[13px] text-muted-foreground">Looking at what {name} has set up…</p>
        ) : (
          <>
            <ItemList title="Skills" items={harness.skills} empty={`No skills are installed for ${name}.`} />
            <ItemList title="MCP servers" items={harness.mcp} empty={`No MCP servers are set up in ${name}'s own settings.`} />
            <ItemList title="Plugins" items={harness.plugins} empty={`No plugins are installed for ${name}.`} />
          </>
        )}
      </div>
      <p className="pt-3 text-[13px] text-muted-foreground">
        This list is read from {name}'s settings on this computer. Add or remove things in {name} itself.
        {engine === "claude" && " Connectors from your Claude account are not listed here but still come along."}
      </p>
    </Section>
  );
}

function NoteRow({ note, children }: { note: Note; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 border-b py-2.5 last:border-b-0">
      <p className="selectable min-w-0 flex-1 [overflow-wrap:anywhere]">{note.text}</p>
      <div className="flex flex-none gap-1.5">{children}</div>
    </li>
  );
}

/** Notes the role proposed and the ones the person approved. Only approved notes reach the agent. */
function Learned({ agent }: { agent: AgentDef }) {
  const all = useCube((s) => s.notes);
  const addNote = useCube((s) => s.addNote);
  const keepNote = useCube((s) => s.keepNote);
  const forgetNote = useCube((s) => s.forgetNote);
  const [draft, setDraft] = useState("");
  const mine = useMemo(() => all.filter((n) => n.agentId === agent.id), [all, agent.id]);
  const pending = mine.filter((n) => n.state === "pending");
  const kept = mine.filter((n) => n.state === "kept");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    addNote({ id: crypto.randomUUID(), agentId: agent.id, text, ts: Date.now(), state: "kept" });
    setDraft("");
  };
  return (
    <Section title="What it has learned">
      <p className="text-[13px] text-muted-foreground">
        When you correct {agent.name} or say how you want things done, it proposes a note. Nothing is remembered until you keep it. Kept notes are given to {agent.name} in every conversation.
      </p>
      {pending.length > 0 && (
        <>
          <h3 className="mt-3 font-medium">Waiting for you <span className="font-normal text-muted-foreground tabular-nums">{pending.length}</span></h3>
          <ul>
            {pending.map((n) => (
              <NoteRow note={n} key={n.id}>
                <button type="button" className={cn(pill, "bg-primary text-primary-foreground")} onClick={() => keepNote(n.id)}>Keep</button>
                <button type="button" className={pill} onClick={() => forgetNote(n.id)}>Forget</button>
              </NoteRow>
            ))}
          </ul>
        </>
      )}
      <h3 className="mt-3 font-medium">Remembered <span className="font-normal text-muted-foreground tabular-nums">{kept.length}</span></h3>
      {kept.length === 0 ? (
        <p className="py-1 text-[13px] text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul>
          {kept.map((n) => (
            <NoteRow note={n} key={n.id}>
              <button type="button" className={pill} onClick={() => forgetNote(n.id)}>Forget</button>
            </NoteRow>
          ))}
        </ul>
      )}
      <form className="mt-3 flex gap-2" onSubmit={submit}>
        <Input aria-label={`Add a note for ${agent.name}`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Tell ${agent.name} something to always remember`} className="selectable h-9 min-w-0 flex-1" />
        <button type="submit" disabled={!draft.trim()} className={cn(pill, "h-9 disabled:opacity-35")}>Add note</button>
      </form>
    </Section>
  );
}

/** One role's page: who it is, what runs it, what it brings along and what it has learned. */
const FACES = ["Front", "Top", "Side"] as const;

/** The three face colors of a role's cube. They are only looks: the role stays the same. */
function CubeColors({ agent }: { agent: AgentDef }) {
  const mine = useCube((s) => s.palettes[agent.id]);
  const setPalette = useCube((s) => s.setPalette);
  const colors = mine ?? agent.palette;
  const change = (i: number, hex: string) => setPalette(agent.id, colors.map((c, j) => (j === i ? hex : c)) as Palette);
  return (
    <Section title="Cube colors">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Cube color={agent.color} status="idle" size={72} />
        {FACES.map((face, i) => (
          <label key={face} className="flex items-center gap-2 text-[13px] font-medium">
            <input type="color" aria-label={`${face} color`} value={colors[i]} onChange={(e) => change(i, e.target.value)} className="size-8 cursor-pointer rounded-lg border bg-transparent p-0.5" />
            {face}
          </label>
        ))}
        {mine && <button type="button" className={pill} onClick={() => setPalette(agent.id, undefined)}>Use its own colors</button>}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Ready-made colors">
        {PALETTES.map((p) => (
          <button type="button" key={p.name} title={p.name} aria-label={`${p.name} colors`} aria-pressed={colors.join() === p.colors.join()} className={cn("flex h-8 items-center gap-0.5 rounded-full border px-2", colors.join() === p.colors.join() && "border-primary")} onClick={() => setPalette(agent.id, p.colors)}>
            {p.colors.map((c) => <span key={c} className="size-4 rounded-[5px] border border-black/10" style={{ background: c }} />)}
          </button>
        ))}
      </div>
    </Section>
  );
}

/** What the role has done so far, counted from its messages in this app. */
function Work({ agent }: { agent: AgentDef }) {
  const messages = useCube((s) => s.messages);
  const st = useMemo(() => statsFor(messages, agent.id), [messages, agent.id]);
  if (!st.runs) return null;
  const tokens = st.tokensIn + st.tokensOut;
  const cells: [string, string][] = [
    ["Runs", `${st.runs}${st.week && st.week !== st.runs ? ` · ${st.week} this week` : ""}`],
    ["Finished", `${st.done}${st.failed ? ` · ${st.failed} failed` : ""}${st.stopped ? ` · ${st.stopped} stopped` : ""}`],
    ["Typical run", st.avgMs ? spanOf(st.avgMs) : "Not timed yet"],
    ["Asked you", st.asks ? `${st.asks} times · ${st.allowed} allowed` : "Never"],
    ["Tokens", tokens ? (tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`) : "Not reported"],
    ["Cost", st.cost ? `$${st.cost.toFixed(2)}` : "Not reported"],
  ];
  return (
    <Section title="Work so far">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {cells.map(([name, value]) => (
          <div key={name}>
            <dt className="text-xs text-muted-foreground">{name}</dt>
            <dd className="font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function AgentProfile() {
  const id = useCube((s) => s.profileId);
  const agent = agentById(id ?? "") ?? AGENTS[0];
  const engine = useEngine(agent);
  const live = useCube((s) => s.live[agent.id]);
  const setActive = useCube((s) => s.setActive);
  const [harness, setHarness] = useState<Harness>();

  useEffect(() => {
    let alive = true;
    setHarness(undefined);
    getHarness(engine)
      .then((h) => alive && setHarness(h))
      .catch(() => alive && setHarness({ model: "", effort: "", skills: [], mcp: [], plugins: [] }));
    return () => { alive = false; };
  }, [engine]);

  return (
    <main className="min-h-0 overflow-auto rounded-[22px] border bg-ground">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-6" data-tauri-drag-region>
        <header className="flex items-center gap-5 pt-2">
          <Cube color={agent.color} status={live?.status ?? "idle"} size={112} />
          <div className="min-w-0 flex-1">
            <h1 className="font-heading text-[24px] font-bold leading-tight tracking-[-0.03em]">{agent.name}</h1>
            <p className="text-muted-foreground">{live?.statement || agent.role}</p>
            <p className="mt-1 max-w-[460px] text-[13px] text-muted-foreground">{agent.brief.replace(/^You /, "I ").replace(/\byou\b/g, "I")}</p>
          </div>
          <button type="button" className="h-9 flex-none rounded-full bg-primary px-4 font-semibold text-primary-foreground" onClick={() => setActive(`dm-${agent.id}`)}>
            Message
          </button>
        </header>
        <CubeColors agent={agent} />
        <RunsOn agent={agent} engine={engine} harness={harness} />
        <Work agent={agent} />
        <TrustDial agent={agent} engine={engine} />
        <Learned agent={agent} />
        <Setup agent={agent} engine={engine} harness={harness} />
      </div>
    </main>
  );
}
