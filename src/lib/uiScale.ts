/** App-wide percentages offered in Settings and used by the zoom shortcuts. */
export const UI_SCALES = [80, 90, 100, 110, 120, 130, 140, 150];

/** Undefined means this key is unrelated to zoom. The caller checks the modifier keys. */
export function uiScaleForKey(current: number, key: string): number | undefined {
  if (key === "0") return 100;
  if (key === "+" || key === "=") return Math.min(UI_SCALES[UI_SCALES.length - 1], current + 10);
  if (key === "-") return Math.max(UI_SCALES[0], current - 10);
  return undefined;
}
