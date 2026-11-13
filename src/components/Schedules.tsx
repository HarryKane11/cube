import { useEffect, useMemo, useState } from "react";
import { getHarness, inTauri } from "@/agents/runner";
import { CloseIcon, PlusIcon } from "@/components/icons";
import { nextRun, repeatOf, suggestSchedules, type Schedule, type Suggestion } from "@/lib/schedule";
import { cn } from "@/lib/utils";
import { useCube, labelOf } from "@/state/store";

const REPEATS: { id: string; name: string; days: number[] }[] = [
  { id: "daily", name: "Every day", days: [] },
  { id: "weekdays", name: "Weekdays", days: [1, 2, 3, 4, 5] },
  { id: "weekly", name: "Once a week, on this weekday", days: [-1] },
  { id: "once", name: "Just once, today", days: [] },
];

/** Messages Cube sends by itself at set times: a morning briefing, a weekly check, a one-off reminder. */
export function Schedules() {
  const schedules = useCube((s) => s.schedules);
  const convs = useCube((s) => s.convs);
  const save = useCube((s) => s.saveSchedule);
  const remove = useCube((s) => s.removeSchedule);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [time, setTime] = useState("09:00");
  const [convId, setConvId] = useState("general");
  const [repeat, setRepeat] = useState("weekdays");
  const now = new Date();
  // What the agent programs have connected (their MCP servers) says what is worth scheduling.
  const available = useCube((s) => s.available);
  const lang = useCube((s) => s.settings.lang);
  const [tools, setTools] = useState<string[]>([]);
  useEffect(() => {
    if (!inTauri) return;
    let alive = true;
    void Promise.all((["claude", "codex", "hermes"] as const).filter((p) => available[p]).map((p) => getHarness(p).then((h) => h.mcp.map((m) => m.name)).catch(() => [] as string[])))
      .then((found) => { if (alive) setTools([...new Set(found.flat())]); });
    return () => { alive = false; };
  }, [available.claude, available.codex, available.hermes]);
  const offers = useMemo(() => suggestSchedules(tools, lang, schedules), [tools, lang, schedules]);
  const take = (o: Suggestion) => save({ id: crypto.randomUUID(), convId: convs.some((c) => c.id === "general") ? "general" : (convs[0]?.id ?? "general"), text: o.text, time: o.time, days: o.days, on: true });

  const add = () => {
    if (!text.trim() || !/^\d\d:\d\d$/.test(time)) return;
    const kind = REPEATS.find((r) => r.id === repeat) ?? REPEATS[0];
    const pad = (n: number) => String(n).padStart(2, "0");
    const next: Schedule = {
      id: crypto.randomUUID(), convId, text: text.trim(), time, on: true,
      days: kind.id === "weekly" ? [now.getDay()] : kind.days,
      once: kind.id === "once" ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` : undefined,
    };
    save(next);
    setText("");
    setAdding(false);
  };
  const field = "selectable h-9 rounded-xl border bg-transparent px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="flex flex-col gap-2">
      {schedules.length === 0 && !adding && <p className="text-muted-foreground">Nothing scheduled. A schedule sends a message for you at a set time, for example a briefing every morning. It runs while Cube is open.</p>}
      <ul className="flex flex-col">
        {schedules.map((s) => {
          const conv = convs.find((c) => c.id === s.convId);
          return (
            <li key={s.id} className="flex items-center gap-2 border-b py-2 last:border-b-0">
              <button type="button" role="switch" aria-checked={s.on} aria-label={`${s.on ? "Pause" : "Resume"} this schedule`} className={cn("relative h-6 w-10 flex-none rounded-full transition-colors", s.on ? "bg-primary" : "bg-secondary")} onClick={() => save({ ...s, on: !s.on })}>
                <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-[left]", s.on ? "left-[18px]" : "left-0.5")} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.text}</div>
                <div className="truncate text-xs text-muted-foreground">{repeatOf(s)} at {s.time} · {conv ? labelOf(conv) : "a conversation that is gone"} · next: {nextRun(s, now)}</div>
              </div>
              <button type="button" aria-label="Delete this schedule" title="Delete" className="flex size-7 flex-none items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => remove(s.id)}>
                <CloseIcon width={12} height={12} />
              </button>
            </li>
          );
        })}
      </ul>
      {adding ? (
        <form className="flex flex-col gap-2 rounded-2xl bg-muted p-3" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input autoFocus aria-label="Message to send" value={text} onChange={(e) => setText(e.target.value)} placeholder="What to send, e.g. @Writer Brief me on yesterday's work in five lines" className={cn(field, "bg-background")} />
          <div className="flex flex-wrap items-center gap-2">
            <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} className={cn(field, "bg-background")} />
            <select aria-label="How often" value={repeat} onChange={(e) => setRepeat(e.target.value)} className={cn(field, "bg-background")}>
              {REPEATS.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <select aria-label="Where to send it" value={convId} onChange={(e) => setConvId(e.target.value)} className={cn(field, "bg-background")}>
              {convs.map((c) => <option key={c.id} value={c.id}>{labelOf(c)}</option>)}
            </select>
            <span className="flex-1" />
            <button type="button" className="h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => setAdding(false)}>Cancel</button>
            <button type="submit" disabled={!text.trim()} className="h-8 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35">Add</button>
          </div>
        </form>
      ) : (
        <button type="button" className="flex h-8 w-fit items-center gap-1.5 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => setAdding(true)}>
          <PlusIcon width={13} height={13} /> New schedule
        </button>
      )}
      {offers.length > 0 && (
        <section className="mt-2 flex flex-col border-t pt-3" aria-label="Suggested schedules">
          <p className="pb-1 text-xs font-semibold text-muted-foreground">Suggested, from the tools your agent programs have connected</p>
          <ul className="flex flex-col">
            {offers.map((o) => (
              <li key={o.key} className="flex items-center gap-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{o.title}</div>
                  <div className="truncate text-xs text-muted-foreground" title={o.text}><span>Weekdays</span> <span data-notranslate>{o.time}</span> · <span data-notranslate>{o.text}</span></div>
                </div>
                <button type="button" className="h-8 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => take(o)}>Add</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
