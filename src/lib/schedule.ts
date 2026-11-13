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

/** A schedule Cube offers because a tool it could use is connected. `key` names the tool it rests on. */
export interface Suggestion {
  key: string;
  /** What it is, as a line in the list. Interface text, written in English. */
  title: string;
  /** The message it sends. Written in the person's language: it is what a cube reads. */
  text: string;
  time: string;
  days: number[];
}

const WEEKDAYS = [1, 2, 3, 4, 5];
/** What each kind of connected tool makes worth scheduling. The first words that match a tool's name pick the kind. */
const OFFERS: { key: string; match: RegExp; title: string; time: string; en: string; ko: string }[] = [
  { key: "calendar", match: /calendar|gcal/i, title: "A briefing on today's meetings", time: "08:30", en: "@Researcher Look at today's calendar and tell me, meeting by meeting, what I should have ready. Five lines at most.", ko: "@Researcher 오늘 캘린더 일정을 보고, 회의마다 제가 준비할 것을 다섯 줄 안으로 정리해 주세요." },
  { key: "mail", match: /gmail|mail|outlook/i, title: "Mail that needs an answer", time: "09:00", en: "@Writer Go through the mail that came in since yesterday morning and list what needs an answer from me, most pressing first.", ko: "@Writer 어제 아침 이후로 온 메일 중에서 제 답이 필요한 것을 급한 순서로 정리해 주세요." },
  { key: "issues", match: /linear|jira|asana/i, title: "My issues and what is due this week", time: "09:30", en: "@Researcher List the issues assigned to me and the ones due this week, with what is blocked.", ko: "@Researcher 저에게 배정된 이슈와 이번 주 마감인 이슈를, 막힌 것과 함께 정리해 주세요." },
  { key: "code", match: /github|gitlab/i, title: "Pull requests waiting on me", time: "10:00", en: "@Reviewer List the pull requests waiting for my review and where my own stand.", ko: "@Reviewer 제 리뷰를 기다리는 PR과 제가 올린 PR의 상태를 정리해 주세요." },
  { key: "chat", match: /slack|teams|discord/i, title: "Mentions I have not answered", time: "09:15", en: "@Researcher Find where I was mentioned since yesterday and have not answered, and say in a line what each one wants.", ko: "@Researcher 어제 이후로 저를 멘션했는데 제가 답하지 않은 글을 찾아, 각각 무엇을 원하는지 한 줄씩 알려 주세요." },
  { key: "docs", match: /notion|confluence|drive|docs/i, title: "Documents that changed yesterday", time: "09:45", en: "@Researcher Tell me which documents I follow changed since yesterday, and what changed in each.", ko: "@Researcher 제가 보는 문서 중 어제 이후로 바뀐 것과 무엇이 바뀌었는지 알려 주세요." },
];

/**
 * Schedules worth offering, from the names of the tools the agent programs have connected (their
 * MCP servers). One per kind of tool, and none that is already scheduled word for word.
 */
export function suggestSchedules(tools: string[], lang: string, have: Schedule[] = []): Suggestion[] {
  const taken = new Set(have.map((s) => s.text));
  return OFFERS
    .filter((o) => tools.some((t) => o.match.test(t)))
    .map((o) => ({ key: o.key, title: o.title, text: lang === "ko" ? o.ko : o.en, time: o.time, days: WEEKDAYS }))
    .filter((s) => !taken.has(s.text));
}
