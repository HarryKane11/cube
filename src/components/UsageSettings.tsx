import { useEffect, useMemo, useState } from "react";
import { ENGINES, type AgentKind } from "@/agents/types";
import type { UsageProgram } from "@/agents/usage";
import { refreshUsage } from "@/agents/usageRun";
import { BrandMark } from "@/components/bits";
import { Section } from "@/components/Settings";
import { ReadAt, UsageBars } from "@/components/UsageBits";
import { useCube } from "@/state/store";

const PLANS: UsageProgram[] = ["claude", "codex"];
const WEEK = 7 * 86_400_000;
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/** One program's plan: its name, what it is signed in with, and how much of each window is left. */
function Plan({ program }: { program: UsageProgram }) {
  const plan = useCube((s) => s.usage[program]?.plan);
  return (
    <div className="flex flex-col gap-3 border-b py-4 first:pt-1 last:border-b-0 last:pb-1">
      <div className="flex flex-wrap items-center gap-2">
        <BrandMark kind={program} className="size-4" />
        <span className="font-semibold">{ENGINES[program].name}</span>
        {plan && <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold capitalize" data-notranslate>{plan}</span>}
        <span className="flex-1" />
        <ReadAt program={program} />
      </div>
      <UsageBars program={program} />
    </div>
  );
}

/** What Cube itself counted of each program's runs: how many, and the tokens and cost the program reported for them. */
function Counted() {
  const messages = useCube((s) => s.messages);
  const rows = useMemo(() => {
    const since = Date.now() - WEEK;
    const by = new Map<string, { runs: number; week: number; in: number; out: number; cost: number }>();
    for (const m of messages) {
      if (m.author === "you" || m.streaming || (!m.usage && !m.engine)) continue;
      const key = m.engine ?? "";
      const row = by.get(key) ?? { runs: 0, week: 0, in: 0, out: 0, cost: 0 };
      row.runs += 1;
      if (m.ts >= since) row.week += 1;
      row.in += m.usage?.in ?? 0;
      row.out += m.usage?.out ?? 0;
      row.cost += m.usage?.cost ?? 0;
      by.set(key, row);
    }
    return [...by.entries()].sort((a, b) => b[1].runs - a[1].runs);
  }, [messages]);
  if (!rows.length) return <p className="text-[13px] text-muted-foreground">Nothing has run yet.</p>;
  return (
    <table className="w-full border-collapse text-left text-[13px]">
      <thead>
        <tr className="border-b text-xs text-muted-foreground">
          <th className="py-1.5 pr-3 font-semibold">Agent program</th>
          <th className="py-1.5 pr-3 text-right font-semibold">Runs</th>
          <th className="py-1.5 pr-3 text-right font-semibold">This week</th>
          <th className="py-1.5 pr-3 text-right font-semibold">Tokens</th>
          <th className="py-1.5 text-right font-semibold">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, r]) => (
          <tr key={key} className="border-b last:border-b-0">
            <td className="py-2 pr-3">
              {key ? <span className="inline-flex items-center gap-1.5 font-medium"><BrandMark kind={key as AgentKind} className="size-3.5" /> {ENGINES[key as AgentKind]?.name ?? key}</span> : <span className="text-muted-foreground">Earlier runs</span>}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums" data-notranslate>{r.runs}</td>
            <td className="py-2 pr-3 text-right tabular-nums" data-notranslate>{r.week}</td>
            <td className="py-2 pr-3 text-right tabular-nums">{r.in + r.out ? <span data-notranslate>{tokens(r.in + r.out)}</span> : <span className="text-muted-foreground">Not reported</span>}</td>
            <td className="py-2 text-right tabular-nums">{r.cost ? <span data-notranslate>${r.cost.toFixed(2)}</span> : <span className="text-muted-foreground">Not reported</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * How much the connected AI services have been used: what is left of each plan, as the agent
 * programs themselves say it, and what Cube counted of their runs.
 */
export function UsageSettings() {
  const available = useCube((s) => s.available);
  const [busy, setBusy] = useState(false);
  const read = (force: boolean) => {
    setBusy(true);
    void refreshUsage(force).finally(() => setBusy(false));
  };
  // The numbers move while the person works elsewhere: they are read again whenever this is opened.
  useEffect(() => read(false), []);
  const plans = PLANS.filter((p) => available[p]);
  return (
    <>
      <Section title="What is left of each plan">
        <p className="mb-2 text-[13px] text-muted-foreground">Claude Code and Codex count what you use inside windows of time. Cube asks each program how full its windows are; it never reads their sign-in. Every cube that runs on a program draws on the same plan.</p>
        {plans.map((p) => <Plan key={p} program={p} />)}
        {!plans.length && <p className="py-2 text-[13px] text-muted-foreground">Neither Claude Code nor Codex was found on this computer.</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-40" disabled={busy || !plans.length} onClick={() => read(true)}>{busy ? "Checking…" : "Check again"}</button>
        </div>
      </Section>
      <Section title="Services that do not say">
        <ul className="flex flex-col gap-2 text-[13px] text-muted-foreground">
          {available.hermes && <li><span className="font-medium text-foreground">Hermes</span> does not report how much of its plan is left outside its own window. Its runs are counted below.</li>}
          <li><span className="font-medium text-foreground">Model keys</span> (Anthropic, OpenAI, OpenRouter) are billed by use, with no plan to run out of. What their runs used is counted below; the balance is on the service's own page.</li>
        </ul>
      </Section>
      <Section title="Counted by Cube">
        <p className="mb-2 text-[13px] text-muted-foreground">Runs made in this app, with the tokens and cost each program reported for them.</p>
        <Counted />
      </Section>
    </>
  );
}
