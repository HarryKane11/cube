import type { AgentDef, Ev } from "./types";

/**
 * Scripted stand-in for a real agent, used only when the page runs in a plain browser.
 * It lets the screens be exercised without the desktop backend.
 */
interface Step {
  wait: number;
  ev?: Ev;
  file?: { rel: string; content: string };
  /** After an "ask" event: the script stops here until the person answers, then continues with these steps. */
  then?: (allowed: boolean) => Step[];
}

const PLAN_MD = `# Launch plan

A one-page outline for the Orbit 2.0 launch.

## Story
1. Teams that reach week four stay
2. What changed in onboarding
3. Pricing, at a glance

## Open questions
- Which chart leads the deck?
- Who signs off on pricing copy?
`;

const PREVIEW_HTML = `<!doctype html><meta charset="utf-8"><body style="font:16px -apple-system,sans-serif;margin:40px;color:#1d1d1f">
<h1 style="letter-spacing:-.02em">Orbit 2.0</h1><p>Teams that reach week four stay.</p>
<div style="display:flex;gap:10px;align-items:flex-end;height:140px;border-bottom:2px solid #1d1d1f">
<i style="flex:1;height:96%;background:#e5e5ea"></i><i style="flex:1;height:78%;background:#e5e5ea"></i><i style="flex:1;height:66%;background:#e5e5ea"></i><i style="flex:1;height:61%;background:#0071e3"></i><i style="flex:1;height:60%;background:#e5e5ea"></i></div></body>`;

const PAGE_SHOT =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#fff"/><rect width="960" height="44" fill="#e9e9eb"/><circle cx="22" cy="22" r="6" fill="#ff5f57"/><circle cx="42" cy="22" r="6" fill="#febc2e"/><circle cx="62" cy="22" r="6" fill="#28c840"/><rect x="200" y="10" width="560" height="24" rx="12" fill="#fff"/><text x="220" y="27" font-family="-apple-system,sans-serif" font-size="13" fill="#636366">orbit.example/launch</text><text x="60" y="130" font-family="-apple-system,sans-serif" font-size="44" font-weight="700" fill="#1d1d1f">Orbit 2.0</text><text x="60" y="170" font-family="-apple-system,sans-serif" font-size="18" fill="#636366">Teams that reach week four stay.</text><rect x="60" y="220" width="840" height="300" rx="16" fill="#f5f5f7"/><rect x="110" y="300" width="110" height="190" fill="#d1d1d6"/><rect x="260" y="340" width="110" height="150" fill="#d1d1d6"/><rect x="410" y="365" width="110" height="125" fill="#d1d1d6"/><rect x="560" y="375" width="110" height="115" fill="#0071e3"/><rect x="710" y="378" width="110" height="112" fill="#d1d1d6"/></svg>`,
  );

function words(text: string, gap = 45): Step[] {
  return text.split(/(?<=\s)/).map((w) => ({ wait: gap, ev: { t: "delta", text: w } as Ev }));
}

function script(agent: AgentDef, fromPerson: boolean): Step[] {
  if (agent.id === "writer") {
    return [
      { wait: 500, ev: { t: "activity", kind: "think", label: "Thinking it through" } },
      { wait: 900, ev: { t: "activity", kind: "edit", label: "Writing launch-plan.md" } },
      { wait: 700, file: { rel: "launch-plan.md", content: PLAN_MD } },
      ...words(
        fromPerson
          ? "The outline is on the Stage as **launch-plan.md**. @Designer can you turn it into a one-page preview?\n\nNOTE: Launch plans stay on one page."
          : "Looks good to me. I tightened the headline in the outline.",
      ),
    ];
  }
  if (agent.id === "designer") {
    return [
      { wait: 400, ev: { t: "activity", kind: "read", label: "Reading launch-plan.md" } },
      { wait: 900, ev: { t: "activity", kind: "edit", label: "Writing preview.html" } },
      { wait: 900, file: { rel: "preview.html", content: PREVIEW_HTML } },
      { wait: 700, ev: { t: "activity", kind: "search", label: "Using the browser: screenshot" } },
      { wait: 600, ev: { t: "shot", url: PAGE_SHOT, label: "Using the browser: screenshot" } },
      ...words("Done. **preview.html** is on the Stage with the retention chart. Should week four stay the only colored bar?"),
    ];
  }
  if (agent.id === "researcher") {
    return [
      { wait: 600, ev: { t: "activity", kind: "search", label: "Searching the web" } },
      { wait: 1200, ev: { t: "activity", kind: "read", label: "Reading a web page" } },
      ...words("This is the preview, so I cannot really search. In the desktop app I would list what I found and where."),
    ];
  }
  if (agent.id === "reviewer") {
    return [
      { wait: 500, ev: { t: "activity", kind: "read", label: "Reading the files here" } },
      {
        wait: 700,
        ev: { t: "ask", id: crypto.randomUUID(), tool: "Bash", input: { command: "pnpm test" } },
        then: (allowed) =>
          allowed
            ? [{ wait: 900, ev: { t: "activity", kind: "run", label: "Running pnpm test" } }, ...words("I ran the tests: all 28 pass. The plan reads fine to me.")]
            : words("I did not run the tests, so this is from reading only. The plan reads fine to me."),
      },
    ];
  }
  return [
    { wait: 500, ev: { t: "activity", kind: "run", label: "Running ls" } },
    { wait: 900, ev: { t: "activity", kind: "read", label: "Reading the files here" } },
    ...words(`${agent.name} here. This is the preview, so the reply is scripted. Open the desktop app to put me to real work.`),
  ];
}

export function startMock(
  agent: AgentDef,
  prompt: string,
  onEv: (ev: Ev) => void,
  onFile: (rel: string, content: string) => void,
  onDone: () => void,
): { stop: () => void; answer: (allowed: boolean) => void } {
  const steps = script(agent, /Latest message, from You/.test(prompt));
  let i = 0;
  let timer = 0;
  let stopped = false;
  let waiting: Step["then"];
  const next = () => {
    if (stopped) return;
    if (i >= steps.length) return onDone();
    const step = steps[i++];
    timer = window.setTimeout(() => {
      if (stopped) return;
      if (step.ev) onEv(step.ev);
      if (step.file) onFile(step.file.rel, step.file.content);
      if (step.then) waiting = step.then;
      else next();
    }, step.wait);
  };
  next();
  return {
    stop: () => {
      stopped = true;
      window.clearTimeout(timer);
      onDone();
    },
    answer: (allowed) => {
      if (!waiting) return;
      steps.splice(i, 0, ...waiting(allowed));
      waiting = undefined;
      next();
    },
  };
}
