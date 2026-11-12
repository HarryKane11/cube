import { rescan } from "@/agents/orchestrator";
import { inTauri, writeText } from "@/agents/runner";
import { useCube, type Artifact } from "@/state/store";

/** Past this size a file is only partly loaded, so the Stage shows it but does not let it be edited in place. */
export const EDIT_LIMIT = 2_000_000;

/** Saves text the person edited on the Stage, the same way the code editor does. */
export async function saveText(convId: string, a: Artifact, value: string): Promise<void> {
  if (a.content !== undefined || !inTauri) {
    useCube.getState().putArtifact(convId, { ...a, content: value, mtime: Date.now(), size: value.length });
    return;
  }
  const mtime = await writeText(a.path, value);
  // Back to exactly how it was when the person last spoke: no longer a change.
  if (useCube.getState().baseline[convId]?.files[a.rel]?.text === value) useCube.getState().rebaseFile(convId, a.rel, mtime);
  void rescan(convId);
}
