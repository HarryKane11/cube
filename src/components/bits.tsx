import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo, type ComponentProps } from "react";
import claudeMark from "@/assets/brands/claude-code.svg";
import codexMark from "@/assets/brands/codex-openai.svg";
import hermesMark from "@/assets/brands/nousresearch-hermes.svg";
import cubeMark from "@/assets/brands/cube-built-in.svg";
import { inTauri } from "@/agents/runner";
import { AGENTS, ENGINES, KO_NAMES, koNames, pickEngine, type AgentDef, type AgentKind } from "@/agents/types";
import { Markdown } from "@/components/ui/markdown";
import { EMOJI_HREF, inlineEmoji, nameOfCode } from "@/lib/emoji";
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

/**
 * A person: their picture if they set one, otherwise the first letter of their name. With no
 * `pubkey` it is the person using this Cube.
 */
export function Face({ pubkey, name, size = 28, className }: { pubkey?: string; name?: string; size?: number; className?: string }) {
  const me = useCube((s) => s.team.info?.pubkey);
  const own = !pubkey || pubkey === me;
  const picture = useCube((s) => (own ? s.avatar : s.team.avatars?.[pubkey]));
  const myName = useCube((s) => s.name);
  const shown = (own ? (name ?? myName) : (name ?? "")).trim();
  if (picture) return <img src={picture} alt="" width={size} height={size} className={cn("flex-none rounded-full object-cover", className)} style={{ width: size, height: size }} />;
  return (
    <span
      className={cn("flex flex-none items-center justify-center rounded-full font-semibold", own ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground", className)}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
      data-notranslate
    >
      {shown.charAt(0).toUpperCase() || (own ? "Y" : "?")}
    </span>
  );
}

/** The person using this Cube. */
export function PersonAvatar({ size = 28 }: { size?: number }) {
  return <Face size={size} />;
}

export function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Matches a mention of anyone on the team as it is now, sub-agents included. */
const mention = () => new RegExp(`@(${[...AGENTS.map((a) => a.name), ...Object.values(KO_NAMES), "You", ...useCube.getState().team.members.map((m) => m.name.replace(/\s+/g, "")).filter(Boolean)].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![A-Za-z0-9_])`, "giu");

/** A name after an @. A built-in cube is shown by its name in the language Cube is in, whichever one it was written with. */
function Mention({ children }: { children?: ComponentProps<"a">["children"] }) {
  const lang = useCube((s) => s.settings.lang);
  return <span className="at">{lang === "ko" && typeof children === "string" ? koNames(children) : children}</span>;
}

function Anchor({ href, children }: ComponentProps<"a">) {
  if (href === "#mention") return <Mention>{children}</Mention>;
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

/** A picture in a message. One that stands for an emoji of the workspace is drawn small, in the line, like a letter. */
function Picture({ src, alt, node: _node, ...rest }: ComponentProps<"img"> & { node?: unknown }) {
  const name = src === EMOJI_HREF && alt ? nameOfCode(alt) : undefined;
  const picture = useCube((s) => (name ? s.emojis[name] : undefined));
  if (name) return picture ? <img src={picture} alt={alt} title={alt} draggable={false} style={{ display: "inline-block", height: "1.45em", width: "1.45em", objectFit: "contain", verticalAlign: "-0.32em", margin: "0 0.05em" }} /> : <>{alt}</>;
  return <img src={src} alt={alt} {...rest} />;
}

const COMPONENTS = { a: Anchor, img: Picture };

/** Agent text is untrusted. react-markdown renders no raw HTML, and mentions become styled chips. */
export function RichText({ text, className }: { text: string; className?: string }) {
  // The workspace's own emoji, written `:name:` as in Slack, are drawn as their pictures.
  const emojis = useCube((s) => s.emojis);
  const shown = useMemo(() => inlineEmoji(text.replace(mention(), (m) => `[${m}](#mention)`), (name) => name in emojis), [text, emojis]);
  return (
    <Markdown className={cn("md", className)} components={COMPONENTS}>
      {shown}
    </Markdown>
  );
}
