import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { inTauri } from "../agents/runner";
import { say } from "../i18n/dom";
import { useCube } from "../state/store";

let allowed: boolean | undefined;

/**
 * Tells the person through the system that a cube needs them or finished, but only while Cube
 * is not what they are looking at. Asks for the system's permission the first time.
 */
export async function notify(title: string, body: string): Promise<void> {
  if (!inTauri || !useCube.getState().settings.notify) return;
  if (!document.hidden && document.hasFocus()) return;
  try {
    if (allowed === undefined) allowed = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (allowed) sendNotification({ title: say(title), body: body.length > 180 ? body.slice(0, 179) + "…" : body });
  } catch {
    // No notification is better than a broken run.
  }
}

/** Shows how many things wait on the person on the app's Dock icon. */
export function setBadge(count: number): void {
  if (!inTauri) return;
  void getCurrentWindow().setBadgeCount(count > 0 ? count : undefined).catch(() => undefined);
}
