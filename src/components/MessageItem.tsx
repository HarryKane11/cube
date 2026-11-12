import { Lottie } from "lottie-react";
import { useState } from "react";
import typing from "@/assets/typing.json";
import { splitNotes, splitPlan, type PlanStep } from "@/agents/notes";
import { convertFileSrc } from "@tauri-apps/api/core";
import { answerAsk, approvePlan, rescan, restoreTo } from "@/agents/orchestrator";
import { branchDiff, dropBranch, mergeBranch } from "@/agents/trees";
import { inTauri } from "@/agents/runner";
import type { Question } from "@/agents/permissions";
import { ORCH, ROUTER, agentById, authorName, type Status } from "@/agents/types";
import { PersonAvatar, RichText, timeOf } from "@/components/bits";
import { CheckIcon } from "@/components/icons";
import { CopyIcon, PencilIcon, PinIcon, RewindIcon, ThreadIcon, TrashIcon } from "@/components/icons";
import { kindOf } from "@/lib/files";
import { Steps, StepsContent, StepsItem, StepsTrigger } from "@/components/ui/steps";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { Cube, CubeStill } from "@/cube/Cube";
import { cn } from "@/lib/utils";
import { useCube, type Ask, type Msg } from "@/state/store";

const QUICK = ["👍", "✅", "👀", "❤️"];

function Reactions({ msg }: { msg: Msg }) {
  const react = useCube((s) => s.react);
  const entries = Object.entries(msg.reactions ?? {});
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([emoji, who]) => (
        <button
          type="button"
          key={emoji}
          aria-pressed={who.includes("you")}
          title={who.map(authorName).join(", ")}
          className={cn(
            "flex h-6 items-center gap-1 rounded-full border bg-background px-2 text-xs tabular-nums",
            who.includes("you") && "border-primary bg-primary/10 text-primary",
          )}
          onClick={() => react(msg.id, emoji, "you")}
        >
          <span>{emoji}</span>
          {who.length}
        </button>
      ))}
    </div>
  );
}

/** How long something took, in the largest unit that fits. */
export function spanOf(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Files sent with a message. Pictures show small; everything opens on the Stage. */
function Sent({ msg }: { msg: Msg }) {
  const dir = useCube((s) => s.convs.find((c) => c.id === msg.convId)?.dir ?? "");
  const select = useCube((s) => s.select);
  const setStage = useCube((s) => s.setStage);
  const open = (rel: string) => { select(msg.convId, rel, true); setStage(msg.convId, "open"); };
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Files sent with this message">
      {msg.files!.map((rel) => {
        const name = rel.split("/").pop() ?? rel;
        return (
          <li key={rel}>
            {kindOf(rel) === "image" && inTauri && dir ? (
              <button type="button" className="block overflow-hidden rounded-xl border" title={name} onClick={() => open(rel)}>
                <img src={convertFileSrc(`${dir}/${rel}`)} alt={name} className="max-h-40 max-w-[240px] object-cover" />
              </button>
            ) : (
              <button type="button" className="flex h-8 items-center gap-1.5 rounded-full border bg-background px-3 text-[13px] font-medium hover:bg-accent" onClick={() => open(rel)}>
                <span className={`glyph glyph-sm glyph-${kindOf(rel)}`} aria-hidden="true"><i /></span>
                <span className="max-w-[200px] truncate">{name}</span>
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Toolbar({ msg, mine, canThread, onRestore, onEdit }: { msg: Msg; mine: boolean; canThread: boolean; onRestore?: () => void; onEdit?: () => void }) {
  const react = useCube((s) => s.react);
  const patchMsg = useCube((s) => s.patchMsg);
  const openThread = useCube((s) => s.openThread);
  const deleteMsg = useCube((s) => s.deleteMsg);
  const tool = "flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <div
      className={cn(
        "absolute -top-3 z-10 hidden items-center rounded-xl border bg-popover p-0.5 shadow-sm group-hover:flex group-focus-within:flex",
        mine ? "right-4" : "left-14",
      )}
    >
      {QUICK.map((e) => (
        <button type="button" key={e} className={tool} aria-label={`React with ${e}`} onClick={() => react(msg.id, e, "you")}>
          <span className="text-[15px] leading-none">{e}</span>
        </button>
      ))}
      <span className="mx-0.5 h-4 w-px bg-border" />
      {canThread && (
        <button type="button" className={tool} aria-label="Reply in thread" title="Reply in thread" onClick={() => openThread(msg.parentId ?? msg.id)}>
          <ThreadIcon width={16} height={16} />
        </button>
      )}
      {!msg.streaming && (
        <button type="button" className={cn(tool, msg.pinned && "text-primary")} aria-pressed={Boolean(msg.pinned)} aria-label={msg.pinned ? "Unpin" : "Pin to this conversation"} title={msg.pinned ? "Unpin" : "Pin to this conversation"} onClick={() => patchMsg(msg.id, { pinned: !msg.pinned })}>
          <PinIcon width={16} height={16} />
        </button>
      )}
      {onEdit && (
        <button type="button" className={tool} aria-label="Edit message" title="Edit message" onClick={onEdit}>
          <PencilIcon width={16} height={16} />
        </button>
      )}
      {onRestore && (
        <button type="button" className={tool} aria-label="Put files back to before this message" title="Put files back to before this message" onClick={onRestore}>
          <RewindIcon width={16} height={16} />
        </button>
      )}
      <button type="button" className={tool} aria-label="Copy text" title="Copy text" onClick={() => void navigator.clipboard?.writeText(splitNotes(msg.text).text).catch(() => undefined)}>
        <CopyIcon width={16} height={16} />
      </button>
      {!msg.streaming && (
        <button type="button" className={tool} aria-label="Delete message" title="Delete message" onClick={() => deleteMsg(msg.id)}>
          <TrashIcon width={16} height={16} />
        </button>
      )}
    </div>
  );
}

/** What a cube did in its own copy of the folder: look at it, bring it into the shared folder, or drop it. */
function BranchCard({ msg, name }: { msg: Msg; name: string }) {
  const dir = useCube((s) => s.convs.find((c) => c.id === msg.convId)?.dir ?? "");
  const patchMsg = useCube((s) => s.patchMsg);
  const [diff, setDiff] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const b = msg.branch!;
  if (b.state !== "open") return <p className="px-1 text-xs text-muted-foreground"><span className="font-semibold text-foreground">{b.state === "merged" ? "Merged into the shared folder" : "Dropped"}</span> · {b.files === 1 ? "1 file" : `${b.files} files`} from {name}'s copy</p>;
  const act = (what: "merge" | "drop") => {
    setBusy(true);
    setError("");
    (what === "merge" ? mergeBranch(dir, b.name) : dropBranch(dir, b.tree).then(() => null))
      .then((problem) => {
        if (problem) return setError(problem);
        patchMsg(msg.id, { branch: { ...b, state: what === "merge" ? "merged" : "dropped" } });
        return rescan(msg.convId);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  const pill = "h-8 rounded-full px-3 text-[13px] font-semibold disabled:opacity-50";
  return (
    <section className="flex w-full max-w-[520px] flex-col gap-2 rounded-[18px] border bg-background p-3" aria-label={`${name}'s changes in its own copy`}>
      <p className="text-xs font-semibold text-muted-foreground">{name} worked in its own copy · {b.files === 1 ? "1 file changed" : `${b.files} files changed`} · not in the shared folder yet</p>
      <pre className="selectable max-h-28 overflow-auto whitespace-pre-wrap rounded-xl bg-muted px-3 py-2 font-mono text-xs">{b.summary}</pre>
      {diff !== undefined && (
        <pre className="selectable max-h-72 overflow-auto rounded-xl bg-muted px-3 py-2 font-mono text-xs">
          {(diff || "No differences.").split("\n").map((line, i) => (
            <span key={i} className={cn("block whitespace-pre-wrap", line.startsWith("+") && !line.startsWith("+++") && "text-[#1a7f37] dark:text-[#3fb950]", line.startsWith("-") && !line.startsWith("---") && "text-destructive", line.startsWith("@@") && "text-muted-foreground")}>{line || " "}</span>
          ))}
        </pre>
      )}
      {error && <p className="text-[13px] text-destructive" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={busy} className={cn(pill, "bg-primary text-primary-foreground")} onClick={() => act("merge")}>Merge into the shared folder</button>
        <button type="button" className={cn(pill, "bg-secondary")} onClick={() => (diff === undefined ? void branchDiff(dir, b.name).then(setDiff).catch((e) => setError(String(e))) : setDiff(undefined))}>{diff === undefined ? "See changes" : "Hide changes"}</button>
        <button type="button" disabled={busy} className={cn(pill, "bg-secondary")} onClick={() => act("drop")}>Drop</button>
      </div>
    </section>
  );
}

/** The Orchestrator's plan, step by step, with where it stands. */
function PlanCard({ msg, steps }: { msg: Msg; steps: PlanStep[] }) {
  const now = msg.stepNow ?? steps[0]?.n;
  const over = Boolean(msg.stepsDone);
  // A plan whose run ended without finishing (stopped, or it failed) is no longer moving.
  const moving = !over && !msg.stopped && !msg.error;
  return (
    <section className="flex w-full max-w-[520px] flex-col gap-1.5 rounded-[18px] border bg-background p-3" aria-label="Plan">
      <p className="text-xs font-semibold text-muted-foreground">{over ? "Plan · done" : `Plan · ${steps.length} ${steps.length === 1 ? "step" : "steps"}`}</p>
      <ol className="flex flex-col gap-1">
        {steps.map((s) => {
          const done = over || s.n < now;
          const current = !over && s.n === now;
          return (
            <li key={s.n} className={cn("flex items-start gap-2 text-[13px]", !done && !current && "text-muted-foreground")} aria-current={current ? "step" : undefined}>
              <span className={cn("mt-0.5 flex size-5 flex-none items-center justify-center rounded-full text-[11px] font-bold tabular-nums", done ? "bg-primary text-primary-foreground" : current ? "bg-primary/15 text-primary" : "bg-secondary")}>
                {done ? <CheckIcon width={12} height={12} strokeWidth={2.5} /> : s.n}
              </span>
              <span className={cn("min-w-0 flex-1", current && moving && "font-medium")}><RichText text={s.text} /></span>
              {current && moving && <span className="mt-1.5 size-2 flex-none animate-pulse rounded-full bg-primary" aria-label="In progress" />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const ASK_DONE: Record<Exclude<Ask["state"], "waiting">, string> = {
  allowed: "You allowed",
  denied: "You did not allow",
  gone: "Not answered",
};

/** An agent's question with its suggested answers. The person picks, or writes their own. */
function QuestionCard({ msg, ask, name, questions }: { msg: Msg; ask: Ask; name: string; questions: Question[] }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const answerOf = (q: Question) => own[q.question]?.trim() || (picked[q.question] ?? []).join(", ");
  const ready = questions.every((q) => answerOf(q));
  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const had = p[q.question] ?? [];
      const next = q.multi ? (had.includes(label) ? had.filter((l) => l !== label) : [...had, label]) : [label];
      return { ...p, [q.question]: next };
    });
  const button = "h-8 rounded-full px-3 text-[13px] font-semibold";
  return (
    <section className="flex w-full max-w-[460px] flex-col gap-3 rounded-[18px] border border-primary/40 bg-background p-3" aria-label={`${name} has a question for you`}>
      <p className="text-xs font-semibold text-primary">{name} has a question for you</p>
      {questions.map((q) => (
        <fieldset key={q.question} className="flex flex-col gap-1.5">
          <legend className="selectable mb-1.5 font-semibold [overflow-wrap:anywhere]">{q.question}</legend>
          {q.options.map((o) => {
            const on = !own[q.question]?.trim() && (picked[q.question] ?? []).includes(o.label);
            return (
              <button
                type="button"
                key={o.label}
                aria-pressed={on}
                className={cn("rounded-xl border px-3 py-1.5 text-left", on ? "border-primary bg-primary/10" : "hover:bg-accent")}
                onClick={() => { setOwn((w) => ({ ...w, [q.question]: "" })); toggle(q, o.label); }}
              >
                <span className="block font-medium">{o.label}</span>
                {o.description && <span className="block text-[13px] text-muted-foreground">{o.description}</span>}
              </button>
            );
          })}
          <input
            aria-label="Your own answer"
            value={own[q.question] ?? ""}
            onChange={(e) => setOwn((w) => ({ ...w, [q.question]: e.target.value }))}
            placeholder="Or write your own answer"
            className="selectable h-9 rounded-xl border bg-transparent px-3 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={!ready}
          className={cn(button, "bg-primary text-primary-foreground disabled:opacity-35")}
          onClick={() => answerAsk(msg.id, ask.id, "once", Object.fromEntries(questions.map((q) => [q.question, answerOf(q)])))}
        >
          Answer
        </button>
        <button type="button" className={cn(button, "bg-secondary")} onClick={() => answerAsk(msg.id, ask.id, "deny")}>Skip</button>
      </div>
    </section>
  );
}

/** An agent stopped to ask before doing something. It waits here until the person answers. */
function ApprovalCard({ msg, ask, name }: { msg: Msg; ask: Ask; name: string }) {
  if (ask.plan !== undefined) {
    // The agent finished planning. Nothing has changed yet; it starts only on a yes.
    if (ask.state !== "waiting") {
      return <p className="px-1 text-xs text-muted-foreground"><span className="font-semibold text-foreground">{ask.state === "allowed" ? "You approved the plan" : ask.state === "denied" ? "You sent the plan back" : "Plan not answered"}</span></p>;
    }
    const pill = "h-8 rounded-full px-3 text-[13px] font-semibold";
    return (
      <section className="flex w-full max-w-[520px] flex-col gap-2 rounded-[18px] border border-primary/40 bg-background p-3" aria-label={`${name} has a plan for you`}>
        <p className="text-xs font-semibold text-primary">{name} has a plan. Nothing has changed yet.</p>
        <div className="selectable max-h-72 overflow-auto rounded-xl bg-muted px-3 py-2 text-[13px]"><RichText text={ask.plan || "The plan is empty."} /></div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={cn(pill, "bg-primary text-primary-foreground")} onClick={() => answerAsk(msg.id, ask.id, "once")}>Approve and start</button>
          <button type="button" className={cn(pill, "bg-secondary")} onClick={() => answerAsk(msg.id, ask.id, "deny")}>Keep planning</button>
        </div>
      </section>
    );
  }
  if (ask.questions && ask.state !== "waiting") {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{ask.state === "allowed" ? "You answered" : ask.state === "denied" ? "You skipped" : "Not answered"}</span>
        {" · "}{ask.questions[0].question.length > 70 ? ask.questions[0].question.slice(0, 69) + "…" : ask.questions[0].question}
        {ask.answer && <span className="text-foreground"> · {ask.answer}</span>}
      </p>
    );
  }
  if (ask.questions) return <QuestionCard msg={msg} ask={ask} name={name} questions={ask.questions} />;
  if (ask.state !== "waiting") {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        <span className={cn("font-semibold", ask.state === "allowed" && "text-foreground")}>{ASK_DONE[ask.state]}</span> · {ask.title}
        {ask.detail && <span className="font-mono"> · {ask.detail.length > 60 ? ask.detail.slice(0, 59) + "…" : ask.detail}</span>}
      </p>
    );
  }
  const button = "h-8 rounded-full px-3 text-[13px] font-semibold";
  return (
    <section className="flex w-full max-w-[460px] flex-col gap-2 rounded-[18px] border border-primary/40 bg-background p-3" aria-label={`${name} asks for your OK`}>
      <div>
        <p className="text-xs font-semibold text-primary">{name} needs your OK</p>
        <h4 className="font-semibold">{ask.title}</h4>
      </div>
      {ask.detail && <pre className="selectable max-h-32 overflow-auto whitespace-pre-wrap rounded-xl bg-muted px-3 py-2 font-mono text-[13px] [overflow-wrap:anywhere]">{ask.detail}</pre>}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={cn(button, "bg-primary text-primary-foreground")} onClick={() => answerAsk(msg.id, ask.id, "once")}>Allow</button>
        {ask.always && <button type="button" className={cn(button, "bg-secondary")} onClick={() => answerAsk(msg.id, ask.id, "always")}>{ask.always}</button>}
        <button type="button" className={cn(button, "bg-secondary")} onClick={() => answerAsk(msg.id, ask.id, "deny")}>Don't allow</button>
      </div>
    </section>
  );
}

interface Props {
  msg: Msg;
  /** A reply shown under its thread's first message. */
  compact?: boolean;
  /** Hide the thread button, for messages already shown inside the thread panel. */
  inPanel?: boolean;
}

export function MessageItem({ msg, compact, inPanel }: Props) {
  const mine = msg.author === "you";
  const agent = agentById(msg.author);
  const status = useCube((s) => s.live[msg.author]?.status ?? "idle") as Status;
  const openProfile = useCube((s) => s.openProfile);
  // A `NOTE:` line is a proposal for the person to review, never part of the bubble, even mid-stream.
  const said = mine ? msg.text : splitNotes(msg.text).text;
  // A plan still being written is already taken out of the text, so it never flashes as raw lines.
  const drafted = agent?.id === ORCH && !msg.steps ? splitPlan(said) : undefined;
  const text = drafted?.text ?? said;
  const steps = msg.steps ?? drafted?.steps ?? [];
  // The Router's line is a note about where a request went, not a reply: it is shown small.
  const slim = agent?.id === ROUTER && !msg.error;
  const size = compact ? 30 : 38;
  const lastAct = msg.acts?.[msg.acts.length - 1];
  // Only a message that just arrived slides in. History is drawn in place, and the slide never
  // hides the text: a paused animation (window in the background) must not leave it invisible.
  const [fresh] = useState(() => Date.now() - msg.ts < 1500);
  const [restoring, setRestoring] = useState<"ask" | "busy" | string>();
  const [editing, setEditing] = useState<string>();
  const patchMsg = useCube((s) => s.patchMsg);
  const decisions = useCube((s) => s.decisions);
  const openInbox = useCube((s) => s.openInbox);
  const saveEdit = () => {
    const next = editing?.trim();
    if (next && next !== msg.text) patchMsg(msg.id, { text: next, edited: true });
    setEditing(undefined);
  };
  const waitingCalls = msg.decided ? decisions.filter((d) => d.msgId === msg.id && d.state === "new").length : 0;

  return (
      <div data-mid={msg.id} className={cn("group relative flex items-start gap-1.5 rounded-xl px-4 py-0.5", fresh && "msg-in", mine && "mine flex-row-reverse", compact && !mine && "pl-12")}>
        {msg.from && (
          <span className="flex flex-none items-center justify-center rounded-xl bg-secondary font-semibold text-foreground" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true" data-notranslate>
            {(msg.from.agent ?? msg.from.name).trim().charAt(0).toUpperCase() || "?"}
          </span>
        )}
        {mine ? (compact ? <PersonAvatar size={24} /> : null) : agent && (
          <button type="button" className="flex-none rounded-xl" aria-label={`Open ${agent.name}'s profile`} onClick={() => openProfile(agent.id)}>
            {msg.streaming ? <Cube color={agent.color} status={status} size={size} /> : <CubeStill color={agent.color} size={size} />}
          </button>
        )}
        <div className={cn("flex min-w-0 max-w-[84%] flex-col gap-1", mine && "items-end")}>
          <div className="flex items-baseline gap-1.5 px-1 text-xs text-muted-foreground">
            {!mine && (msg.from
              ? <span className="font-semibold text-foreground" data-notranslate title={`Signed by ${msg.from.pubkey.slice(0, 12)}…`}>{msg.from.agent ? `${msg.from.agent} · ${msg.from.name}` : msg.from.name}</span>
              : <span className="font-semibold text-foreground">{agent?.name ?? msg.author}</span>)}
            {msg.from && <span>{msg.from.agent ? "teammate's cube" : "teammate"}</span>}
            {msg.auto && <span>picked this up</span>}
            {msg.stepped && <span className="font-semibold text-primary">You stepped in</span>}
            <time dateTime={new Date(msg.ts).toISOString()}>{timeOf(msg.ts)}</time>
            {msg.stopped && <span>stopped</span>}
            {msg.edited && <span>edited</span>}
            {msg.aside && <span>{mine ? "asked on the side" : "side answer"}</span>}
            {msg.scheduled && <span>scheduled</span>}
            {msg.pinned && <span className="flex items-center gap-0.5 font-semibold text-primary"><PinIcon width={11} height={11} /> pinned</span>}
          </div>

          {msg.streaming && lastAct && <TextShimmer className="px-1 text-[13px]" duration={2.2}>{lastAct.label}</TextShimmer>}

          {editing !== undefined ? (
            <form className="flex w-[min(460px,60vw)] flex-col gap-1.5 rounded-[18px] border bg-background p-2" onSubmit={(e) => { e.preventDefault(); saveEdit(); }}>
              <textarea
                autoFocus
                aria-label="Edit message"
                value={editing}
                rows={Math.min(8, editing.split("\n").length + 1)}
                onChange={(e) => setEditing(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(undefined);
                  else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); saveEdit(); }
                }}
                className="selectable resize-none rounded-xl bg-muted px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="flex items-center gap-1.5">
                <button type="submit" className="h-7 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground">Save</button>
                <button type="button" className="h-7 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => setEditing(undefined)}>Cancel</button>
                <span className="text-xs text-muted-foreground">Cubes read the new text from their next turn on.</span>
              </div>
            </form>
          ) : (text || (msg.streaming && !msg.asks?.some((a) => a.state === "waiting"))) && (
            <div
              className={cn(
                "selectable [overflow-wrap:anywhere]",
                slim ? "px-1 text-[13px] text-muted-foreground" : "rounded-[18px] px-3.5 py-2",
                mine ? "rounded-br-md bg-primary text-primary-foreground" : !slim && "rounded-bl-md bg-muted",
                msg.aside && (mine ? "bg-primary/75" : "border border-dashed bg-transparent"),
                msg.streaming && text && "caret",
              )}
            >
              {text ? <RichText text={text} /> : <Lottie src={typing} loop autoplay className="h-5 w-9" aria-label="Working" />}
            </div>
          )}

          {steps.length > 0 && <PlanCard msg={msg} steps={steps} />}

          {Boolean(msg.files?.length) && <Sent msg={msg} />}

          {agent && msg.plan && !msg.streaming && (
            <div className="flex flex-wrap items-center gap-1.5 px-1">
              <span className="text-xs text-muted-foreground">This is a plan. Nothing has changed yet.</span>
              <button type="button" className="h-7 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground" onClick={() => approvePlan(msg.id)}>Approve and start</button>
            </div>
          )}

          {restoring && (
            <section className="flex max-w-[420px] flex-col gap-2 rounded-[18px] border bg-background p-3 text-left" aria-label="Put files back">
              {restoring === "ask" || restoring === "busy" ? (
                <>
                  <p className="text-[13px]">Put this conversation's files back to how they were just before this message? Files made since then go to the Trash. Messages stay as they are, and you can undo this.</p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={restoring === "busy"}
                      className="h-8 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-50"
                      onClick={() => { setRestoring("busy"); void restoreTo(msg.convId, msg.id).then((err) => setRestoring(err ?? undefined)); }}
                    >
                      Put files back
                    </button>
                    <button type="button" className="h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => setRestoring(undefined)}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-[13px] text-destructive" role="alert">{restoring}</p>
                  <button type="button" className="h-8 w-fit rounded-full bg-secondary px-3 text-[13px] font-semibold" onClick={() => setRestoring(undefined)}>Close</button>
                </>
              )}
            </section>
          )}

          {agent && msg.asks?.map((a) => <ApprovalCard msg={msg} ask={a} name={agent.name} key={a.id} />)}

          {agent && msg.branch && <BranchCard msg={msg} name={agent.name} />}

          {msg.error && <div className="selectable whitespace-pre-wrap rounded-[18px] rounded-bl-md bg-destructive/10 px-3.5 py-2 text-[13px] text-destructive">{msg.error}</div>}

          {!msg.streaming && Boolean(msg.acts?.length) && (
            <Steps defaultOpen={false} className="px-1">
              <StepsTrigger className="text-xs text-muted-foreground">
                {msg.acts!.length === 1 ? "1 step" : `${msg.acts!.length} steps`}
                {msg.took ? ` · ${spanOf(msg.took)}` : ""}
                {msg.usage?.cost ? ` · $${msg.usage.cost.toFixed(msg.usage.cost < 0.1 ? 3 : 2)}` : ""}
              </StepsTrigger>
              <StepsContent>
                {msg.acts!.map((a, i) => <StepsItem className="text-xs" key={i}>{a.label}</StepsItem>)}
              </StepsContent>
            </Steps>
          )}

          {agent && Boolean(msg.noted) && (
            <button type="button" className="mx-1 flex w-fit items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary" onClick={() => openProfile(agent.id)}>
              {msg.noted === 1 ? "Proposed a note to remember" : `Proposed ${msg.noted} notes to remember`} · Review
            </button>
          )}

          {agent && Boolean(msg.decided) && (
            <button type="button" className={cn("mx-1 flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold", waitingCalls ? "bg-primary/10 text-primary" : "bg-secondary text-muted-foreground")} onClick={openInbox}>
              {msg.decided === 1 ? "Made 1 call on its own" : `Made ${msg.decided} calls on its own`}{waitingCalls ? " · Review" : ""}
            </button>
          )}

          <Reactions msg={msg} />
        </div>
        <Toolbar msg={msg} mine={mine} canThread={!inPanel} onRestore={mine && msg.checkpoint ? () => setRestoring("ask") : undefined} onEdit={mine && !msg.streaming ? () => setEditing(msg.text) : undefined} />
      </div>
  );
}

/** Under a message with replies: who answered, how many, and a way into the thread. */
export function ThreadSummary({ root, replies }: { root: Msg; replies: Msg[] }) {
  const openThread = useCube((s) => s.openThread);
  if (!replies.length) return null;
  const authors = [...new Set(replies.map((r) => r.author))].slice(0, 4);
  const last = replies[replies.length - 1];
  return (
    <button
      type="button"
      className={cn("mx-4 flex w-fit items-center gap-1.5 rounded-full py-0.5 pl-1 pr-2.5 text-[13px] hover:bg-accent", root.author === "you" ? "ml-auto" : "ml-14")}
      onClick={() => openThread(root.id)}
    >
      <span className="flex -space-x-1.5">
        {authors.map((id) => {
          const a = agentById(id);
          return a ? <CubeStill color={a.color} size={22} key={id} /> : <PersonAvatar size={18} key={id} />;
        })}
      </span>
      <span className="font-semibold text-primary">{replies.length === 1 ? "1 reply" : `${replies.length} replies`}</span>
      <span className="text-xs text-muted-foreground">last at {timeOf(last.ts)}</span>
    </button>
  );
}
