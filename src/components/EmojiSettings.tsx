import { useEffect, useMemo, useRef, useState } from "react";
import { inTauri, slackConfigured } from "@/agents/runner";
import { addEmoji, cleanName, codeOf, importSlackEmoji, removeEmoji } from "@/lib/emoji";
import { useCube } from "@/state/store";

const pill = "h-8 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-35";
const primary = "h-8 flex-none rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35";

/**
 * The workspace's own emoji: add one from a picture, bring in the ones a connected Slack
 * workspace has, take one away. People and cubes alike can put them on messages.
 */
export function EmojiSettings() {
  const emojis = useCube((s) => s.emojis);
  const names = useMemo(() => Object.keys(emojis).sort(), [emojis]);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File>();
  const [error, setError] = useState("");
  const [slack, setSlack] = useState(false);
  /** A bringing-in from Slack that is under way: how far it is. */
  const [bringing, setBringing] = useState<{ done: number; total: number }>();
  const [brought, setBrought] = useState("");
  const stop = useRef({ now: false });
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inTauri) void slackConfigured().then(setSlack).catch(() => setSlack(false));
    // Leaving the page stops a bringing-in: what came in so far is kept.
    const flag = stop.current;
    return () => { flag.now = true; };
  }, []);

  const add = async () => {
    if (!file) return;
    const problem = await addEmoji(name || file.name.replace(/\.[^.]+$/, ""), file);
    setError(problem ?? "");
    if (!problem) {
      setName("");
      setFile(undefined);
      if (picker.current) picker.current.value = "";
    }
  };

  const bring = () => {
    stop.current = { now: false };
    setError("");
    setBrought("");
    setBringing({ done: 0, total: 0 });
    importSlackEmoji((done, total) => setBringing({ done, total }), stop.current)
      .then(({ added, failed }) => setBrought(failed ? `Brought in ${added}. ${failed} could not be fetched.` : added ? `Brought in ${added}.` : "Nothing new to bring in."))
      .catch((e) => setError(String(e instanceof Error ? e.message : e)))
      .finally(() => setBringing(undefined));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">Emoji of your own, for reactions. You and your cubes can both use them. On a message one is written as its name between colons.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={picker} type="file" accept="image/png,image/gif,image/jpeg,image/webp" aria-label="Picture for the emoji" className="max-w-[220px] text-[13px] file:mr-2 file:h-8 file:rounded-full file:border-0 file:bg-secondary file:px-3 file:text-[13px] file:font-semibold" onChange={(e) => { const f = e.target.files?.[0]; setFile(f); setError(""); if (f && !name) setName(cleanName(f.name.replace(/\.[^.]+$/, ""))); }} />
        <input aria-label="Name of the emoji" placeholder="name" value={name} onChange={(e) => setName(cleanName(e.target.value))} autoCapitalize="off" spellCheck={false} className="selectable h-8 w-[150px] rounded-lg border bg-transparent px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring" data-notranslate />
        <button type="button" className={primary} disabled={!file} onClick={() => void add()}>Add emoji</button>
        {slack && (bringing
          ? <button type="button" className={pill} onClick={() => { stop.current.now = true; }}>Stop</button>
          : <button type="button" className={pill} onClick={bring}>Bring in from Slack</button>)}
        {bringing && <span className="text-[13px] tabular-nums text-muted-foreground" role="status" data-notranslate>{bringing.total ? `${bringing.done} / ${bringing.total}` : "…"}</span>}
      </div>
      {error && <p className="text-[13px] text-destructive" role="alert">{error}</p>}
      {brought && <p className="text-[13px] text-muted-foreground" role="status">{brought}</p>}
      {!slack && inTauri && <p className="text-xs text-muted-foreground">Connect Slack under Notifications and Stage to bring in the emoji of your Slack workspace.</p>}
      {names.length > 0 && (
        <ul className="flex max-h-[260px] flex-wrap gap-1 overflow-y-auto" aria-label="This workspace's emoji">
          {names.map((n) => (
            <li key={n} className="group flex h-8 items-center gap-1.5 rounded-full bg-secondary pl-1.5 pr-1 text-[13px]" data-notranslate>
              <img src={emojis[n]} width={20} height={20} alt="" draggable={false} className="object-contain" />
              <span className="max-w-[140px] truncate">{codeOf(n)}</span>
              <button type="button" aria-label={`Remove ${codeOf(n)}`} className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => void removeEmoji(n)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
