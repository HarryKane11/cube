/** A message Cube sends by itself at a set time, as if the person had typed it. */
export interface Schedule {
  id: string;
  convId: string;
  text: string;
  /** Local time of day, "HH:MM". */
  time: string;
  /** Days of the week it runs on, 0 = Sunday. Empty: every day. */
  days: number[];
  /** Set for a one-off: the local date it runs on, "YYYY-MM-DD". */
  once?: string;
  on: boolean;
  /** The local date it last ran on, so it runs at most once a day. */
  last?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function runsOn(s: Schedule, d: Date): boolean {
  return s.once ? s.once === dayKey(d) : s.days.length === 0 || s.days.includes(d.getDay());
}

/**
 * The schedules whose time has come: switched on, meant for today, at or past their time, and not
 * run yet today. One that was missed because Cube was closed runs when Cube is next open that day.
 */
export function due(schedules: Schedule[], now: Date): Schedule[] {
  return schedules.filter((s) => s.on && runsOn(s, now) && clock(now) >= s.time && s.last !== dayKey(now));
}

/** When a schedule runs next, in words. */
export function nextRun(s: Schedule, now: Date): string {
  if (!s.on) return "Off";
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!runsOn(s, d)) continue;
    if (i === 0 && (s.last === dayKey(now) || clock(now) >= s.time)) {
      if (s.last === dayKey(now)) continue;
      return "Any moment now";
    }
    return `${i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString([], { weekday: "long" })} at ${s.time}`;
  }
  return s.once ? "Done" : "Not soon";
}

/** How often a schedule repeats, in words. */
export function repeatOf(s: Schedule): string {
  if (s.once) return `Once, on ${s.once}`;
  if (s.days.length === 0 || s.days.length === 7) return "Every day";
  const set = [...s.days].sort().join("");
  if (set === "12345") return "Weekdays";
  if (set === "06") return "Weekends";
  return s.days.map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ");
}
