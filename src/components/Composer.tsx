import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { modeChanged, send, stopAll } from "@/agents/orchestrator";
import { inTauri, writeBytes } from "@/agents/runner";
import { MODES, agentById, type AgentDef, type Mode, nameIn } from "@/agents/types";
import { AtIcon, ChevronIcon, ClipIcon, CloseIcon, MicIcon, SendIcon, StopIcon } from "@/components/icons";
import { kindOf } from "@/lib/files";
import { PromptInput, PromptInputActions, PromptInputTextarea } from "@/components/ui/prompt-input";
import { Face } from "@/components/bits";
import { Rolling } from "@/components/Rolling";
import { tagOf } from "@/team";
import { Cube, CubeStill } from "@/cube/Cube";
import { cn } from "@/lib/utils";
import { useBusy, useCube, type Conv } from "@/state/store";

/** Agents working in this conversation, each with a plain line saying what it is doing. */
function NowWorking({ conv }: { conv: Conv }) {
  const live = useCube((s) => s.live);
  const working = conv.members
    .map((id) => agentById(id))
    .filter((a): a is AgentDef => Boolean(a))
    .filter((a) => live[a.id]?.convId === conv.id && (live[a.id].status === "thinking" || live[a.id].status === "working"));
  if (!working.length) return null;
  return (
    <div className="flex flex-col px-2 pb-1" aria-live="polite">
      {working.map((a) => (
        <div className="flex min-w-0 items-center gap-1.5" key={a.id}>
          <Cube color={a.color} status={live[a.id].status} size={26} />
          <Rolling className="text-[13px]" duration={2.4} text={live[a.id].statement} />
        </div>
      ))}
    </div>
  );
}

/** Someone the "@" picker offers: a cube of this conversation, or a teammate in it. */
interface Pick {
  key: string;
  /** What is written after the "@". */
  name: string;
  note: string;
  agent?: AgentDef;
  pubkey?: string;
  /** A teammate's name as it is shown, spaces and all. */
  shown?: string;
}

const MODE_TONE: Record<Mode, string> = {
  manual: "text-muted-foreground hover:bg-accent hover:text-foreground",
  auto: "bg-primary/10 text-primary",
  // Still said in the warning color, but as words: a filled red pill outweighed everything else in the box.
  bypass: "text-destructive hover:bg-destructive/10",
  plan: "bg-secondary text-foreground",
};

/** A file's bytes as base64, the form the app's backend takes them in. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** A name that is safe as a file inside the conversation folder. */
const safeName = (name: string) => name.replace(/[^\w.\- ]+/g, "-").replace(/^[.\s-]+/, "").slice(0, 80) || "file";

type Recognizer = { start(): void; stop(): void; continuous: boolean; interimResults: boolean; lang: string; onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null };

/** The browser's own speech recognition, where the system offers it. */
function recognizer(): Recognizer | null {
  const Ctor = (window as any).webkitSpeechRecognition ?? (window as any).SpeechRecognition;
  return Ctor ? (new Ctor() as Recognizer) : null;
}

/** Picks how this conversation's cubes behave from the next message on: ask, run to the end, or skip every check. */
function ModePicker({ convId }: { convId: string }) {
  const mode = useCube((s) => s.modes[convId] ?? s.settings.mode);
  const shared = useCube((s) => Boolean(s.convs.find((c) => c.id === convId)?.shared));
  const setConvMode = useCube((s) => s.setConvMode);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const now = MODES.find((m) => m.id === mode) ?? MODES[0];
  // A click on a button does not focus it in the app's web view, so leaving is not always a blur:
  // the menu also closes on a press anywhere outside it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  return (
    <div
      ref={wrap}
      className="relative"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
      onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); } }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Mode: ${now.name}. ${now.about}`}
        title={now.about}
        className={cn("flex h-8 flex-none items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[13px] font-semibold", MODE_TONE[mode])}
        onClick={() => setOpen(!open)}
      >
        {now.name}
        <ChevronIcon width={11} height={11} className="-rotate-90" />
      </button>
      {open && (
        <ul role="menu" aria-label="Mode for this conversation" className="absolute bottom-full left-0 z-20 mb-1.5 w-[300px] rounded-2xl border bg-popover p-1 shadow-md">
          {MODES.map((m) => (
            <li key={m.id} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={m.id === mode}
                className={cn("flex w-full flex-col rounded-xl px-2.5 py-1.5 text-left hover:bg-accent", m.id === mode && "bg-accent")}
                onClick={() => { setConvMode(convId, m.id); modeChanged(convId); setOpen(false); }}
              >
                <span className={cn("font-semibold", m.id === "bypass" && "text-destructive")}>{m.name}</span>
                <span className="text-[13px] text-muted-foreground">{m.about}</span>
              </button>
            </li>
          ))}
          {shared && (
            <li role="none" className="mx-2.5 mt-1 border-t pt-1.5 pb-1 text-xs text-muted-foreground">
              Other people write in this channel. What you pick here is used here: with Auto or Bypass, your cubes act on what they read without asking you. A cube a teammate starts still asks, unless you change the mode while it is at work.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export function Composer({ conv, parentId }: { conv: Conv; parentId?: string }) {
  const busy = useBusy(conv.id);
  const [draft, setDraft] = useState("");
  const [pick, setPick] = useState(0);
  const [closed, setClosed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [problem, setProblem] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognizer | null>(null);
  const putArtifact = useCube((s) => s.putArtifact);

  const attach = (list: FileList | File[] | null | undefined) => {
    const next = [...(list ?? [])].filter((f) => f.size > 0);
    if (!next.length) return;
    if (next.some((f) => f.size > 50_000_000)) setProblem("Files over 50 MB cannot be attached.");
    setFiles((had) => [...had, ...next.filter((f) => f.size <= 50_000_000)].slice(0, 10));
  };
  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length) { e.preventDefault(); attach(e.clipboardData.files); }
  };
  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer.files.length) { e.preventDefault(); attach(e.dataTransfer.files); }
  };

  /** Copies the attached files into the conversation folder and returns where each one landed. */
  const upload = async (): Promise<string[]> => {
    const rels: string[] = [];
    for (const f of files) {
      const rel = `attachments/${safeName(f.name)}`;
      if (inTauri) rels.push(await writeBytes(conv.dir, rel, await toBase64(f)));
      else {
        // The browser preview has no disk: text files still open on the Stage, the rest are named only.
        const content = f.size < 300_000 && /^text\/|json|csv|markdown/.test(f.type) ? await f.text() : undefined;
        if (content !== undefined) putArtifact(conv.id, { rel, path: `/preview/${conv.id}/${rel}`, kind: kindOf(rel), mtime: Date.now(), size: f.size, by: undefined, content });
        rels.push(rel);
      }
    }
    return rels;
  };

  const dictate = () => {
    if (listening) return rec.current?.stop();
    const r = recognizer();
    if (!r) return setProblem("Dictation is not available in this window. On a Mac, press the microphone key (or Fn twice) while the message box is focused.");
    const base = draft ? `${draft}${draft.endsWith(" ") || draft.endsWith("\n") ? "" : " "}` : "";
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.onresult = (e) => {
      let heard = "";
      for (let i = 0; i < e.results.length; i++) heard += e.results[i][0].transcript;
      setDraft(base + heard);
    };
    r.onerror = (e) => {
      setListening(false);
      if (e?.error !== "aborted" && e?.error !== "no-speech") setProblem("Dictation could not start. Allow the microphone and speech recognition for Cube in System Settings, or press the microphone key (or Fn twice) to dictate.");
    };
    r.onend = () => setListening(false);
    rec.current = r;
    setProblem("");
    try {
      r.start();
      setListening(true);
    } catch {
      setProblem("Dictation could not start.");
    }
  };
  useEffect(() => () => rec.current?.stop(), []);

  // Code picked on the Stage lands here, ready for the person to say what they want done with it.
  const quote = useCube((s) => (s.quote?.convId === conv.id && !parentId ? s.quote.text : undefined));
  const setQuote = useCube((s) => s.setQuote);
  useEffect(() => {
    if (quote === undefined) return;
    setDraft((d) => `${d}${d && !d.endsWith("\n") ? "\n" : ""}${quote}`);
    setQuote(undefined);
    requestAnimationFrame(() => {
      const area = box.current?.querySelector("textarea");
      area?.focus();
      area?.setSelectionRange(area.value.length, area.value.length);
    });
  }, [quote, setQuote]);

  // An "@" being typed at the end of the draft opens the member picker.
  const partial = conv.kind === "channel" && !closed ? draft.match(/(?:^|\s)@([\p{L}\p{N}]*)$/u)?.[1] : undefined;
  const team = useCube((s) => s.team);
  const lang = useCube((s) => s.settings.lang);
  const inChannel = useCube((s) => (conv.shared ? s.teamLive.convMembers?.[conv.shared.id] : undefined));
  const options = useMemo(() => {
    if (partial === undefined) return [];
    const starts = (name: string) => name.toLowerCase().startsWith(partial.toLowerCase());
    const cubes: Pick[] = conv.members
      .map((id) => agentById(id))
      .filter((a): a is AgentDef => Boolean(a))
      // A built-in cube answers to its English name and, in Korean, to its Korean one. What is put in the draft is the one this language shows.
      .filter((a) => starts(a.name) || starts(nameIn(a, lang)))
      .map((a) => ({ key: a.id, name: nameIn(a, lang), note: a.role, agent: a }));
    // In a shared channel the people in it can be tagged too: they are told, and no cube takes the message.
    const people: Pick[] = !conv.shared ? [] : team.members
      .filter((m) => m.pubkey !== team.info?.pubkey && (!conv.shared?.private || conv.person || inChannel?.includes(m.pubkey)))
      .filter((m) => starts(tagOf(m.name)))
      .map((m) => ({ key: m.pubkey, name: tagOf(m.name), note: "Teammate", pubkey: m.pubkey, shown: m.name }));
    return [...people, ...cubes];
  }, [partial, conv.members, conv.shared, conv.person, team, inChannel, lang]);
  const open = options.length > 0;

  const change = (v: string) => {
    setDraft(v);
    setClosed(false);
    setPick(0);
  };
  const choose = (a: Pick) => change(draft.replace(/@([\p{L}\p{N}]*)$/u, `@${a.name} `));
  const submit = (aside = false) => {
    if ((!draft.trim() && !files.length) || sending) return;
    rec.current?.stop();
    if (!files.length) {
      send(conv.id, draft, parentId, { aside });
      return setDraft("");
    }
    setSending(true);
    setProblem("");
    upload()
      .then((rels) => {
        send(conv.id, draft, parentId, { files: rels, aside });
        setDraft("");
        setFiles([]);
      })
      .catch((e) => setProblem(`Could not attach: ${String(e)}`))
      .finally(() => setSending(false));
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setPick((p) => (p + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      choose(options[pick]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setClosed(true);
    }
  };

  const placeholder = parentId
    ? "Reply in thread"
    : busy
      ? "Step in: say what should change"
      : conv.kind === "dm"
        ? `Message ${conv.name}`
        : conv.person ? `Message ${conv.name}. Type @ to bring in a cube` : conv.chat ? "Message the team. Type @ to hand work to a cube" : `Message #${conv.name}. Type @ to hand work to a cube`;

  return (
    <div className="relative flex flex-col gap-1 px-3 pb-3 pt-1" ref={box} onPaste={onPaste} onDrop={onDrop} onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}>
      {!parentId && <NowWorking conv={conv} />}
      {problem && (
        <p className="flex items-start gap-2 px-2 text-[13px] text-destructive" role="alert">
          <span className="min-w-0 flex-1">{problem}</span>
          <button type="button" className="font-semibold" onClick={() => setProblem("")}>Dismiss</button>
        </p>
      )}
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-1" aria-label="Files to send">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-full bg-secondary py-0.5 pl-2.5 pr-1 text-[13px]">
              <span className="max-w-[180px] truncate font-medium">{f.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{f.size < 1_000_000 ? `${Math.max(1, Math.round(f.size / 1000))} KB` : `${(f.size / 1_000_000).toFixed(1)} MB`}</span>
              <button type="button" aria-label={`Remove ${f.name}`} className="flex size-5 items-center justify-center rounded-full hover:bg-background" onClick={() => setFiles((had) => had.filter((_, j) => j !== i))}>
                <CloseIcon width={11} height={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <ul role="listbox" aria-label="Mention a cube or a teammate" className="absolute bottom-full left-3 z-20 mb-1 w-60 overflow-hidden rounded-xl border bg-popover p-1 shadow-md">
          {options.map((a, i) => (
            <li key={a.key} role="option" aria-selected={i === pick}>
              <button
                type="button"
                className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left", i === pick && "bg-accent")}
                onMouseEnter={() => setPick(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(a); }}
              >
                {a.agent ? <CubeStill color={a.agent.color} size={28} /> : <Face pubkey={a.pubkey} name={a.shown} size={26} className="mx-px" />}
                <span className="font-medium" data-notranslate>{a.shown ?? a.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{a.note}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <PromptInput
        value={draft}
        onValueChange={change}
        onSubmit={() => submit()}
        className="rounded-[22px] border-0 bg-muted p-1.5 shadow-none focus-within:ring-2 focus-within:ring-ring"
      >
        <PromptInputTextarea
          placeholder={placeholder}
          onKeyDown={onKey}
          aria-label={placeholder}
          className="selectable min-h-9 px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground dark:bg-transparent"
        />
        {/* Narrow, the two groups stack instead of squeezing: a label never breaks across lines. */}
        <PromptInputActions className="flex-wrap justify-between gap-y-1 px-1">
          <div className="flex flex-none items-center gap-0.5">
            {conv.kind === "channel" && (
              <button
                type="button"
                aria-label="Mention an agent"
                className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => change(`${draft}${draft && !draft.endsWith(" ") ? " " : ""}@`)}
              >
                <AtIcon />
              </button>
            )}
            <input ref={picker} type="file" multiple hidden onChange={(e) => { attach(e.target.files); e.target.value = ""; }} />
            <button type="button" aria-label="Attach files" title="Attach files" className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => picker.current?.click()}>
              <ClipIcon />
            </button>
            <button
              type="button"
              aria-label={listening ? "Stop dictating" : "Dictate"}
              title={listening ? "Stop dictating" : "Dictate"}
              aria-pressed={listening}
              className={cn("flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground", listening && "animate-pulse bg-destructive/10 text-destructive")}
              onClick={dictate}
            >
              <MicIcon />
            </button>
            {!parentId && <ModePicker convId={conv.id} />}
          </div>
          <div className="ml-auto flex flex-none items-center gap-1.5">
            {busy && (
              <button
                type="button"
                className="flex h-8 flex-none items-center gap-1 whitespace-nowrap rounded-full bg-secondary px-3 text-[13px] font-semibold"
                onClick={() => stopAll(conv.id)}
              >
                <StopIcon width={14} height={14} /> Stop
              </button>
            )}
            {busy && !parentId && (
              <button
                type="button"
                disabled={!draft.trim() && !files.length}
                title="Ask without stopping the cubes. The answer changes no files."
                className="flex h-8 flex-none items-center whitespace-nowrap rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-35"
                onClick={() => submit(true)}
              >
                Ask on the side
              </button>
            )}
            <button
              type="button"
              aria-label={busy ? "Step in" : "Send"}
              disabled={(!draft.trim() && !files.length) || sending}
              className="flex h-8 flex-none items-center gap-1 whitespace-nowrap rounded-full bg-primary px-2 text-[13px] font-semibold text-primary-foreground disabled:opacity-35"
              onClick={() => submit()}
            >
              {busy && <span className="pl-1.5">Step in</span>}
              <SendIcon width={16} height={16} strokeWidth={2.25} />
            </button>
          </div>
        </PromptInputActions>
      </PromptInput>
    </div>
  );
}
