import { openUrl } from "@tauri-apps/plugin-opener";
import type { ComponentProps } from "react";
import claudeMark from "@/assets/brands/claude-code.svg";
import codexMark from "@/assets/brands/codex-openai.svg";
import hermesMark from "@/assets/brands/nousresearch-hermes.svg";
import cubeMark from "@/assets/brands/cube-built-in.svg";
import { inTauri } from "@/agents/runner";
import { AGENTS, ENGINES, pickEngine, type AgentDef, type AgentKind } from "@/agents/types";
import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

const MARKS: Record<AgentKind, string> = { codex: codexMark, claude: claudeMark, hermes: hermesMark, api: cubeMark, custom: cubeMark, remote: cubeMark };

/** The logo of a program that runs agents. Used only to say what an agent runs on. */
export function BrandMark({ kind, className }: { kind: AgentKind; className?: string }) {
  return <span className={cn("brand-mark", className)} style={{ ["--src" as string]: `url("${MARKS[kind]}")` }} aria-hidden="true" />;
}

/** The engine that powers a role right now: the person's choice, or the best installed one. */
export function useEngine(agent: AgentDef): AgentKind {
  return useCube((s) => s.engines[agent.id] ?? pickEngine(agent, s.available));
}

export function EngineLabel({ agent }: { agent: AgentDef }) {
  const kind = useEngine(agent);
  return (
    <span className="inline-flex items-center gap-1">
      <BrandMark kind={kind} className="size-3" /> {ENGINES[kind].name}
    </span>
  );
}

export function PersonAvatar({ size = 28 }: { size?: number }) {
  const initial = useCube((s) => s.name.trim().charAt(0).toUpperCase() || "Y");
  return (
    <span
      className="flex flex-none items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

export function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Matches a mention of anyone on the team as it is now, sub-agents included. */
const mention = () => new RegExp(`@(${[...AGENTS.map((a) => a.name), "You"].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "giu");

function Anchor({ href, children }: ComponentProps<"a">) {
  if (href === "#mention") return <span className="at">{children}</span>;
  return (
    <a
      href={href}
      onClick={(e) => {
        // Never let a link replace the app itself; hand it to the system browser.
        e.preventDefault();
        if (inTauri && href && /^https?:/.test(href)) void openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

const COMPONENTS = { a: Anchor };

/** Agent text is untrusted. react-markdown renders no raw HTML, and mentions become styled chips. */
export function RichText({ text, className }: { text: string; className?: string }) {
  return (
    <Markdown className={cn("md", className)} components={COMPONENTS}>
      {text.replace(mention(), (m) => `[${m}](#mention)`)}
    </Markdown>
  );
}
