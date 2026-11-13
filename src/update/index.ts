import { create } from "zustand";
import { inTauri, logLine, updateCheck, updateInfo, updateInstall, updateListen } from "@/agents/runner";
import type { Live } from "@/state/store";

/**
 * Updating Cube from inside the app. The desktop side asks the release page, downloads, checks
 * the signature and replaces the app (src-tauri/src/update.rs); this side keeps what the person
 * is shown: whether there is a newer version, and how far along installing it is.
 *
 * Nothing is installed by itself. Installing restarts Cube, which stops every cube that is
 * working, so it only happens when the person says so.
 */
export type Phase = "idle" | "checking" | "current" | "found" | "installing" | "failed";

export interface UpdateState {
  /** This copy's version. Empty until the app has said, and in the browser preview. */
  current: string;
  /** Whether this copy updates itself. A build made from source and the browser preview do not. */
  updates: boolean;
  phase: Phase;
  /** The newer version a check found, and what its release says about it. */
  version: string;
  notes: string;
  /** How much of the download has arrived, 0 to 1, or -1 when the size is not known. */
  progress: number;
  /** Why the last check or install did not work. */
  error: string;
  /** Goes up each time something asks to be shown the update, so Settings can bring it into view. */
  show: number;
}

export const useUpdate = create<UpdateState>(() => ({ current: "", updates: false, phase: "idle", version: "", notes: "", progress: 0, error: "", show: 0 }));

/** What this module needs from the desktop side, so tests can stand in for it. */
export interface UpdateApi {
  check(): Promise<{ version: string; notes: string } | null>;
  install(): Promise<void>;
}
const desktop: UpdateApi = { check: updateCheck, install: updateInstall };

/** How often an open app looks again. People leave Cube open for days. */
const EVERY = 6 * 60 * 60 * 1000;

/** How many cubes a restart would cut off: the ones thinking, working, or waiting for an answer. */
export function busyCubes(live: Record<string, Live>): number {
  return Object.values(live).filter((l) => l.status === "thinking" || l.status === "working" || l.status === "needs").length;
}

/** The share of a download that has arrived, 0 to 1, or -1 when the server did not say how big it is. */
export function progressOf(done: number, total: number): number {
  return total > 0 ? Math.min(1, done / total) : -1;
}

/**
 * Looks for a newer version. A quiet check is the one Cube makes by itself: it never shows
 * "checking", and a failure (no network, no release yet) changes nothing the person sees.
 */
export async function checkForUpdate(quiet = false, api: UpdateApi = desktop): Promise<void> {
  const before = useUpdate.getState();
  if (!before.updates || before.phase === "checking" || before.phase === "installing") return;
  if (!quiet) useUpdate.setState({ phase: "checking", error: "" });
  try {
    const found = await api.check();
    if (found) useUpdate.setState({ phase: "found", version: found.version, notes: found.notes, error: "" });
    // A quiet check that finds nothing leaves a failure the person was shown where it is.
    else if (!quiet || before.phase !== "failed") useUpdate.setState({ phase: "current", version: "", notes: "", error: "" });
  } catch (e) {
    if (quiet) logLine(`update check: ${String(e)}`);
    else useUpdate.setState({ phase: "failed", error: String(e) });
  }
}

/** Installs the version the last check found. Cube restarts into it, so nothing comes after this on success. */
export async function installUpdate(api: UpdateApi = desktop): Promise<void> {
  const s = useUpdate.getState();
  if (!s.updates || s.phase !== "found") return;
  useUpdate.setState({ phase: "installing", progress: 0, error: "" });
  try {
    await api.install();
  } catch (e) {
    useUpdate.setState({ phase: "failed", error: String(e) });
  }
}

/** Asks to be shown the update: Settings opens on it. */
export function showUpdate(): void {
  useUpdate.setState((s) => ({ show: s.show + 1 }));
}

let started = false;

/** Called once when the app opens: learns this copy's version, then looks for a newer one now and then. */
export function startUpdates(): void {
  if (started || !inTauri) return;
  started = true;
  void updateListen((p) => useUpdate.setState({ progress: progressOf(p.done, p.total) }));
  void updateInfo()
    .then((info) => {
      useUpdate.setState({ current: info.version, updates: info.updates });
      if (!info.updates) return;
      // Not in the first seconds, when the app is busy opening.
      window.setTimeout(() => void checkForUpdate(true), 5000);
      window.setInterval(() => void checkForUpdate(true), EVERY);
    })
    .catch((e) => logLine(`update info: ${String(e)}`));
}
