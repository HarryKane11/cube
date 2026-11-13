// Fills the browser preview (pnpm dev) with a made-up team at work, for the README's pictures.
// Nothing here is real: the people, the product and the relay address are invented, so the
// pictures can be published. Run through scripts/readme/shoot.sh.
window.__seed = async (lang, theme, scene) => {
  const { useCube } = await import("/src/state/store.ts");
  const { AGENTS } = await import("/src/agents/types.ts");
  const ko = lang === "ko";
  // Times read in the language of the picture, whatever this computer is set to.
  if (!Date.prototype.__plain) {
    const time = Date.prototype.toLocaleTimeString;
    Date.prototype.__plain = time;
    Date.prototype.toLocaleTimeString = function (_locale, options) {
      return time.call(this, window.__lang === "ko" ? "ko-KR" : "en-US", options);
    };
  }
  window.__lang = lang;
  // The note that says this is the browser preview is not part of the app.
  if (!document.getElementById("readme-shot")) {
    const style = document.createElement("style");
    style.id = "readme-shot";
    style.textContent = "[data-preview-note]{display:none!important}";
    document.head.appendChild(style);
  }
  const id = Object.fromEntries(AGENTS.map((a) => [a.name, a.id]));
  const color = Object.fromEntries(AGENTS.map((a) => [a.name, a.color]));
  const ME = "1".repeat(64);
  const SAM = "2".repeat(64);
  const JULES = "3".repeat(64);
  const names = ko ? { me: "지우", sam: "민서", jules: "하준" } : { me: "Alex", sam: "Sam", jules: "Jules" };
  const sha = (c) => c.repeat(64);
  const today = new Date();
  const at = (h, m) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m).getTime();
  const conv = "launch";
  const shared = scene === "shared" || scene === "invite";

  const plan = ko
    ? `# 출시 계획\n\nOrbit 2.0 출시를 한 장으로 정리했습니다.\n\n## 이야기\n1. 4주차까지 온 팀은 남는다\n2. 온보딩에서 바뀐 것\n3. 가격, 한눈에\n\n## 숫자\n- 4주차 유지율 **61%** (이전 52%)\n- 첫 주 활성화까지 걸리는 시간 **2일 → 5시간**\n\n## 남은 질문\n- 발표 자료 첫 장에 어떤 차트를 둘까?\n- 가격 문구는 누가 확정하나?\n`
    : `# Launch plan\n\nA one-page outline for the Orbit 2.0 launch.\n\n## Story\n1. Teams that reach week four stay\n2. What changed in onboarding\n3. Pricing, at a glance\n\n## Numbers\n- Week-four retention **61%** (was 52%)\n- Time to first active week **2 days → 5 hours**\n\n## Open questions\n- Which chart leads the deck?\n- Who signs off on pricing copy?\n`;
  const page = `<!doctype html><meta charset="utf-8"><body style="font:16px -apple-system,'Apple SD Gothic Neo',sans-serif;margin:44px;color:#1d1d1f;background:#fff">
<p style="margin:0;color:#6e6e73;font-size:13px;letter-spacing:.08em">ORBIT 2.0</p>
<h1 style="margin:6px 0 4px;font-size:40px;letter-spacing:-.03em">${ko ? "4주차까지 온 팀은 남습니다" : "Teams that reach week four stay"}</h1>
<p style="margin:0 0 28px;color:#6e6e73">${ko ? "최근 다섯 기수의 4주차 유지율" : "Week-four retention, last five cohorts"}</p>
<div style="display:flex;gap:14px;align-items:flex-end;height:190px;border-bottom:2px solid #1d1d1f">
${[["52%", 52], ["54%", 54], ["55%", 55], ["58%", 58], ["61%", 61]].map(([t, h], i) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px"><b style="font-size:13px;color:${i === 4 ? "#0071e3" : "#6e6e73"}">${t}</b><i style="width:100%;height:${h * 2.6}px;border-radius:8px 8px 0 0;background:${i === 4 ? "#0071e3" : "#e5e5ea"}"></i></div>`).join("")}
</div>
<p style="margin:22px 0 0;color:#6e6e73;font-size:14px">${ko ? "출시일 21일 · 가격은 팀 단위" : "Ships on the 21st · Priced per team"}</p></body>`;
  const sheet = ko ? "기수,1주차,4주차\n3월,88%,52%\n4월,89%,54%\n5월,90%,55%\n6월,91%,58%\n7월,93%,61%\n" : "cohort,week 1,week 4\nMarch,88%,52%\nApril,89%,54%\nMay,90%,55%\nJune,91%,58%\nJuly,93%,61%\n";

  const T = ko
    ? {
        ask: "Orbit 2.0가 21일에 나갑니다. 한 장짜리 출시 계획이랑 미리보기 페이지를 팀이 같이 만들어 줄래요?",
        router: "여러 명이 필요한 일이네요. 팀장님한테 맡길게요! @Orchestrator",
        orch: "이렇게 나눠서 진행하겠습니다.",
        steps: ["Researcher: 최근 다섯 기수의 4주차 유지율 정리", "Writer: 숫자를 바탕으로 한 장짜리 출시 계획", "Designer: 유지율 차트가 들어간 미리보기 페이지", "Reviewer: 둘을 읽고 어긋나는 곳 짚기"],
        researcher: "가장 최근 기수의 4주차 유지율이 **61%**입니다. 이전 52%에서 올랐어요. 숫자는 **retention.csv**에 넣어 뒀습니다.",
        writer: "개요를 **launch-plan.md**로 스테이지에 올렸습니다. @Designer 이걸로 한 장짜리 미리보기를 만들어 줄래요?",
        designer: "**preview.html**을 올렸습니다. 4주차 차트를 맨 위에 뒀어요.",
        reviewer: "둘 다 읽었습니다. 어긋나는 곳이 하나 있어요. 계획에는 가격이 *좌석 단위*, 페이지에는 *팀 단위*로 적혀 있습니다. 나머지는 숫자와 맞습니다.",
        sam: "좋네요! 가격은 팀 단위가 맞아요. 제 Designer한테 첫 화면만 좀 다듬으라고 할게요.",
        samCube: "**preview.html**의 첫 화면을 다듬어서 공유 폴더에 저장했습니다. 제목을 한 줄로 줄였어요.",
        acts: { think: "생각 정리", search: "유지율 데이터 조회", csv: "retention.csv 작성", plan: "launch-plan.md 작성", read: "launch-plan.md 읽기", page: "preview.html 작성", read2: "launch-plan.md, preview.html 읽기" },
        working: "가격 문구 맞추는 중",
      }
    : {
        ask: "Orbit 2.0 ships on the 21st. Can the team put together a one-page launch plan and a preview page?",
        router: "This one takes a few of us. I'll ask the lead! @Orchestrator",
        orch: "Here is how we will split it.",
        steps: ["Researcher: week-four retention, last five cohorts", "Writer: a one-page launch plan from the numbers", "Designer: a preview page with the retention chart", "Reviewer: read both and flag what disagrees"],
        researcher: "Week-four retention is **61%** for the newest cohort, up from 52%. The numbers are in **retention.csv**.",
        writer: "The outline is on the Stage as **launch-plan.md**. @Designer can you turn it into a one-page preview?",
        designer: "**preview.html** is up. The week-four chart leads the page.",
        reviewer: "Read both. One thing disagrees: the plan prices *per seat*, the page says *per team*. Everything else matches the numbers.",
        sam: "Love it! Per team is right. I'll have my Designer tighten the first screen.",
        samCube: "Tightened the first screen of **preview.html** and saved it to the shared folder. The headline is one line now.",
        acts: { think: "Thinking it through", search: "Looking up retention data", csv: "Writing retention.csv", plan: "Writing launch-plan.md", read: "Reading launch-plan.md", page: "Writing preview.html", read2: "Reading launch-plan.md and preview.html" },
        working: "Fixing the pricing line",
      };

  const msgs = [
    { id: "m1", convId: conv, author: "you", text: T.ask, ts: at(9, 38), ...(shared ? { sent: T.ask } : {}) },
    { id: "m2", convId: conv, author: id.Router, text: T.router, ts: at(9, 38) },
    { id: "m3", convId: conv, author: id.Orchestrator, text: T.orch, ts: at(9, 39), steps: T.steps.map((text, i) => ({ n: i + 1, text })), stepsDone: true },
    { id: "m5", convId: conv, author: id.Writer, text: T.writer, ts: at(9, 42), acts: [{ kind: "think", label: T.acts.think }, { kind: "edit", label: T.acts.plan }] },
    { id: "m6", convId: conv, author: id.Designer, text: T.designer, ts: at(9, 44), acts: [{ kind: "read", label: T.acts.read }, { kind: "edit", label: T.acts.page }] },
    { id: "m7", convId: conv, author: id.Reviewer, text: T.reviewer, ts: at(9, 45), acts: [{ kind: "read", label: T.acts.read2 }], reactions: { "👍": ["you"] } },
    ...(shared
      ? [
          { id: "m8", convId: conv, author: "peer", text: T.sam, ts: at(9, 50), from: { pubkey: SAM, name: names.sam } },
          { id: "m9", convId: conv, author: "peer", text: T.samCube, ts: at(9, 52), from: { pubkey: SAM, name: names.sam, agent: "Designer", color: color.Designer } },
        ]
      : []),
  ];

  const base = useCube.getState();
  // The one conversation with the whole team, then each cube's own.
  const dms = base.convs.filter((c) => c.cube || c.kind === "dm");
  // A folder of the person's own, opened as a workspace, with the chats that work in it.
  const folder = "/Users/alex/dev/orbit-web";
  const chat = (cid, name, h, m) => ({ id: cid, kind: "channel", chat: true, name, members: AGENTS.map((a) => a.id), dir: folder, workspace: folder, createdAt: at(h, m) });
  const chats = [chat("chat-a", ko ? "결제 페이지 속도 개선" : "Make the checkout page faster", 9, 20), chat("chat-b", ko ? "로그인 테스트 추가" : "Add tests for sign-in", 8, 50)];
  const channel = (cid, name, extra = {}) => ({ id: cid, kind: "channel", name, members: AGENTS.map((a) => a.id), dir: `/preview/${cid}`, createdAt: 0, ...extra });
  const convs = [
    channel("general", "general"),
    channel(conv, ko ? "출시" : "launch", shared ? { shared: { id: "s1", since: 0, private: true, files: true, open: true } } : {}),
    channel("research", ko ? "리서치" : "research"),
    channel("design", ko ? "디자인" : "design-review"),
    ...chats,
    ...dms,
  ];
  const file = (rel, kind, by, content, h, m) => ({ rel, path: `/preview/${conv}/${rel}`, kind, mtime: at(h, m), size: content.length, by, content });
  const files = [file("preview.html", "html", id.Designer, page, 9, 44), file("launch-plan.md", "md", id.Writer, plan, 9, 42), file("retention.csv", "csv", id.Researcher, sheet, 9, 40)];
  const live = Object.fromEntries(AGENTS.map((a) => [a.id, { status: "idle", statement: "" }]));
  // On the home screen the team is awake: a cube's face and color follow what it is doing.
  if (scene === "home") {
    live[id.Researcher] = { status: "thinking", statement: "" };
    live[id.Writer] = { status: "working", statement: T.working };
    live[id.Builder] = { status: "done", statement: "" };
    live[id.Designer] = { status: "working", statement: "" };
    live[id.Reviewer] = { status: "thinking", statement: "" };
    live[id.Router] = { status: "done", statement: "" };
  }

  const team = shared
    ? { info: { host: "relay.example.com", ws: "w", workspace: "Orbit", pubkey: ME }, me: { name: names.me, role: "owner" }, members: [{ pubkey: ME, name: names.me, role: "owner" }, { pubkey: SAM, name: names.sam, role: "member" }, { pubkey: JULES, name: names.jules, role: "member" }], head: 9, features: ["channels", "join-page", "profiles", "files"], memberInvites: true }
    : { members: [], head: 0 };
  const open = scene === "shared" ? "preview.html" : "launch-plan.md";

  useCube.setState({
    onboarded: true,
    name: names.me,
    settings: { ...base.settings, lang, theme, tree: true, sidebar: true, chatW: 500, treeW: 160 },
    convs,
    workspaces: [{ dir: folder, name: "orbit-web", git: true }],
    messages: msgs,
    files: { [conv]: files },
    authors: Object.fromEntries(files.map((f) => [`${conv}:${f.rel}`, f.by])),
    stage: { [conv]: "open" },
    selected: { [conv]: open },
    pinned: { [conv]: true },
    tabs: { [conv]: ["launch-plan.md", "preview.html", "retention.csv"] },
    mode: { [`${conv}:launch-plan.md`]: "preview", [`${conv}:preview.html`]: "preview" },
    baseline: {},
    unread: { research: 2 },
    live,
    team,
    teamLive: shared ? { connected: true, problem: "", convMembers: { s1: [ME, SAM, JULES] }, ...(scene === "invite" ? { invite: "https://relay.example.com/join#invite=Q2hvb3NlLXlvdXItb3duLWludml0ZS10b2tlbg", inviteFor: "s1" } : {}) } : { connected: false, problem: "" },
    drive: shared
      ? { s1: {
          "preview.html": { path: "preview.html", sha: sha("a"), size: 900, seq: 9, pubkey: SAM, at: at(9, 52), by: { agent: "Designer", color: color.Designer } },
          "launch-plan.md": { path: "launch-plan.md", sha: sha("b"), size: 400, seq: 6, pubkey: ME, at: at(9, 42), by: { agent: "Writer", color: color.Writer } },
          "retention.csv": { path: "retention.csv", sha: sha("c"), size: 120, seq: 5, pubkey: JULES, at: at(9, 40), by: { agent: "Researcher", color: color.Researcher } },
          "notes/old-draft.md": { path: "notes/old-draft.md", sha: "", size: 0, seq: 7, pubkey: JULES, at: at(9, 47), deleted: true },
        } }
      : {},
    driveBase: shared ? { [conv]: { "preview.html": sha("a"), "launch-plan.md": sha("b"), "retention.csv": sha("c") } } : {},
    driveLive: shared ? { [conv]: { held: [], skipped: [], moving: 0, touched: { "launch-plan.md": { pubkey: JULES, by: { agent: "Writer" }, until: Date.now() + 3600_000 } }, notes: [] } } : {},
    view: scene === "home" ? "home" : "conv",
    activeId: conv,
    threadId: undefined,
  });
  if (scene === "invite") setTimeout(() => window.dispatchEvent(new Event("cube:invite")), 400);
  return "seeded";
};

// Each role's cube as a picture with a clear background, for the README's cast list.
window.__cubes = async () => {
  const { engine } = await import("/src/cube/engine.ts");
  const { AGENTS } = await import("/src/agents/types.ts");
  return JSON.stringify(AGENTS.map((a) => ({ name: a.name.toLowerCase(), url: engine.still(a.color) })));
};
