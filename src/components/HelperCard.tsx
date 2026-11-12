import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { postPicture } from "@/agents/orchestrator";
import { inTauri } from "@/agents/runner";
import { ENGINES } from "@/agents/types";
import { BrandMark } from "@/components/bits";
import { Rolling } from "@/components/Rolling";
import { cn } from "@/lib/utils";
import { useCube, type Msg } from "@/state/store";

/** Longer than any helper is allowed to run: one still "working" after this was cut off, by a restart for one. */
const CUT_OFF = 6 * 60_000;

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/**
 * Someone a cube brought in for part of the job, shown at work under the cube's message: who it
 * is, what it runs on, what it is doing this second, and, once it is done, what it made.
 */
export function HelperCard({ msg }: { msg: Msg }) {
  const helper = msg.helper;
  const select = useCube((s) => s.select);
  const setStage = useCube((s) => s.setStage);
  const [now, setNow] = useState(() => Date.now());
  const running = helper?.state === "working";
  useEffect(() => {
    if (!running) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [running]);
  if (!helper) return null;
  const lost = running && now - helper.startedAt > CUT_OFF;
  const working = running && !lost;
  const line = helper.said[helper.said.length - 1] ?? "Getting ready";
  const open = () => {
    if (!helper.rel) return;
    select(msg.convId, helper.rel, true);
    setStage(msg.convId, "open");
  };
  return (
    <div className={cn("helper-card", working && "helper-live")}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="helper-mark" aria-hidden="true"><BrandMark kind={helper.engine} className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 text-[13px]">
            <span className="font-semibold">{helper.name}</span>
            <span className="text-muted-foreground" data-notranslate>{ENGINES[helper.engine].name}</span>
          </div>
          {working && <Rolling text={line} className="text-[13px]" duration={1.8} />}
          {helper.state === "done" && (
            <div className="truncate text-[13px] text-muted-foreground">
              <span>Done</span>{helper.took ? <span data-notranslate> · {clock(helper.took)}</span> : null}{helper.rel ? <span data-notranslate> · {helper.rel}</span> : null}
            </div>
          )}
          {(helper.state === "failed" || lost) && <div className="text-[13px] text-destructive" role="alert">{lost ? "Stopped before it finished" : helper.error}</div>}
        </div>
        {working && <span className="flex-none text-xs tabular-nums text-muted-foreground" data-notranslate>{clock(now - helper.startedAt)}</span>}
      </div>
      {working && <div className="helper-canvas" aria-hidden="true" />}
      {helper.state === "done" && helper.posted && helper.posted !== "sent" && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          {helper.posted === "sending"
            ? <span className="text-muted-foreground">Sending to Slack</span>
            : <><span className="min-w-0 flex-1 text-destructive" role="alert"><span>Not in Slack yet.</span> <span data-notranslate>{helper.posted}</span></span>
              <button type="button" className="h-7 flex-none rounded-full bg-secondary px-2.5 text-xs font-semibold" onClick={() => void postPicture(msg.id)}>Send to Slack</button></>}
        </div>
      )}
      {helper.state === "done" && helper.posted === "sent" && <div className="text-xs text-muted-foreground">Posted in the Slack thread</div>}
      {helper.state === "done" && helper.path && inTauri && (
        <button type="button" className="helper-result" onClick={open} title="Open on the Stage">
          <img src={convertFileSrc(helper.path)} alt={helper.rel ?? "The picture"} loading="lazy" />
        </button>
      )}
    </div>
  );
}
