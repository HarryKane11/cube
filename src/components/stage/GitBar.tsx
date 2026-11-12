import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { prState, q, repoState, saveAll, sh, type PrState, type RepoState } from "@/agents/git";
import { rescan } from "@/agents/orchestrator";
import { inTauri } from "@/agents/runner";
import { BranchIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

/**
 * For a conversation folder that is a git repository: the branch, what is not recorded yet, and,
 * when the folder is tied to GitHub, its pull request and how the checks stand. Recording,
 * pushing and opening a pull request happen only when the person clicks.
 */
export function GitBar({ convId, dir }: { convId: string; dir: string }) {
  const [repo, setRepo] = useState<RepoState | null>(null);
  const [pr, setPr] = useState<PrState | null>(null);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const setQuote = useCube((s) => s.setQuote);
  // Changes whenever the folder's files do, which is when the state is worth reading again.
  const stamp = useCube((s) => (s.files[convId] ?? []).reduce((n, f) => Math.max(n, f.mtime), s.files[convId]?.length ?? 0));

  const load = useCallback(async () => {
    if (!inTauri || !dir) return;
    const state = await repoState(dir).catch(() => null);
    setRepo(state);
    setPr(state?.remote ? await prState(dir).catch(() => null) : null);
  }, [dir]);

  useEffect(() => { void load(); }, [load, stamp]);
  useEffect(() => {
    // Checks finish on their own time: look again now and then while a pull request is open.
    if (!pr) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [pr, load]);

  if (!repo) return null;
  const run = (name: string, command: string, done: string) => {
    setBusy(name);
    setNote("");
    sh(dir, command, 120)
      .then((r) => setNote(r.ok ? done : r.out.split("\n").slice(-3).join(" ") || "That did not work."))
      .catch((e) => setNote(String(e)))
      .finally(() => { setBusy(""); void load(); void rescan(convId); });
  };
  const fix = () => {
    if (!pr) return;
    setQuote({ convId, text: `The checks on pull request #${pr.number} are failing: ${pr.failing.join(", ")}. Find out why (\`gh pr checks ${pr.number}\`, then \`gh run view --log-failed\`), fix it in this folder and tell me what was wrong.` });
  };
  const pill = "h-7 flex-none rounded-full bg-secondary px-2.5 text-xs font-semibold disabled:opacity-40";
  return (
    <div className="flex flex-none flex-wrap items-center gap-1.5 rounded-[14px] border px-2.5 py-1.5 text-xs" aria-label="Git">
      <BranchIcon className="flex-none text-muted-foreground" width={14} height={14} />
      <span className="font-semibold">{repo.branch}</span>
      <span className="text-muted-foreground">
        {repo.dirty ? `${repo.dirty} not recorded` : "everything recorded"}
        {repo.ahead ? ` · ${repo.ahead} not pushed` : ""}
      </span>
      {message === undefined ? (
        <button type="button" className={pill} disabled={!repo.dirty || Boolean(busy)} onClick={() => setMessage("")}>Commit…</button>
      ) : (
        <form className="flex min-w-[220px] flex-1 items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (message.trim()) { run("commit", saveAll(message.trim()), "Recorded."); setMessage(undefined); } }}>
          <input autoFocus aria-label="What changed" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setMessage(undefined); }} placeholder="What changed, in a line" className="selectable h-7 min-w-0 flex-1 rounded-full border bg-transparent px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <button type="submit" className={cn(pill, "bg-primary text-primary-foreground")} disabled={!message.trim()}>Record</button>
        </form>
      )}
      {repo.remote && <button type="button" className={pill} disabled={!repo.ahead || Boolean(busy)} title="Send what is recorded here to the remote repository" onClick={() => run("push", "git push -u origin HEAD", "Pushed.")}>{busy === "push" ? "Pushing…" : "Push"}</button>}
      {repo.remote && !pr && <button type="button" className={pill} disabled={Boolean(busy)} title="Open a pull request for this branch on GitHub" onClick={() => run("pr", `gh pr create --fill --head ${q(repo.branch)}`, "Pull request opened.")}>{busy === "pr" ? "Opening…" : "Open pull request"}</button>}
      {pr && (
        <>
          <button type="button" className={cn(pill, "bg-transparent underline")} title={pr.title} onClick={() => void openUrl(pr.url)}>PR #{pr.number}</button>
          <span className={cn("font-semibold", pr.failing.length ? "text-destructive" : pr.pending ? "text-muted-foreground" : "text-primary")}>
            {pr.failing.length ? `${pr.failing.length} ${pr.failing.length === 1 ? "check" : "checks"} failing` : pr.pending ? `${pr.pending} running` : pr.passing ? "checks pass" : "no checks"}
          </span>
          {pr.failing.length > 0 && <button type="button" className={cn(pill, "bg-primary text-primary-foreground")} onClick={fix}>Ask a cube to fix it</button>}
        </>
      )}
      {note && <span className="min-w-0 flex-1 truncate text-muted-foreground" role="status" title={note}>{note}</span>}
    </div>
  );
}
