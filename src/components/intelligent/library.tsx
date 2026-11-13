/**
 * What a cube can show besides text: a card, a table, a chart, a few numbers, a button, a short
 * form. A cube writes such a view as a small program in OpenUI Lang (the language of the
 * open-intelligent-ui project) inside a fenced block of its reply, and Cube draws it here with
 * its own components, so it looks like the rest of the app in both themes.
 *
 * Only what is defined in this file can be drawn. The program is not code that runs: it names
 * components and fills in their values, and anything it names that is not here is left out.
 */
import "./noDevtools";
import { action, createLibrary, defineComponent, useFormName, useGetFieldValue, useIsStreaming, useSetFieldValue, useTriggerAction, FormNameContext } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { cn } from "@/lib/utils";

const GAP = { sm: "gap-1.5", md: "gap-3", lg: "gap-5" } as const;
const gap = z.enum(["sm", "md", "lg"]).optional().describe("Space between the children. md when left out");
/** What may stand inside a container: any of the components of this file. */
const children = z.array(z.any()).describe("The components inside, in order");

const Col = defineComponent({
  name: "Col",
  description: "Children stacked top to bottom. The root of every view is a Col.",
  props: z.object({ children, gap }),
  component: ({ props, renderNode }) => <div className={cn("flex min-w-0 flex-col", GAP[props.gap ?? "md"])}>{renderNode(props.children)}</div>,
});

const Row = defineComponent({
  name: "Row",
  description: "Children side by side, wrapping when there is no room. For a few Stats or Buttons, or a title with a Badge.",
  props: z.object({ children, gap }),
  component: ({ props, renderNode }) => <div className={cn("flex min-w-0 flex-wrap items-center", GAP[props.gap ?? "md"])}>{renderNode(props.children)}</div>,
});

const Card = defineComponent({
  name: "Card",
  description: "A bordered box that groups what belongs together, with an optional heading.",
  props: z.object({ title: z.string().optional().describe("A short heading"), children }),
  component: ({ props, renderNode }) => (
    <section className="flex min-w-[180px] flex-1 flex-col gap-2.5 rounded-[14px] border bg-background p-3.5">
      {props.title && <h4 className="text-[13px] font-semibold text-muted-foreground">{props.title}</h4>}
      {renderNode(props.children)}
    </section>
  ),
});

const Title = defineComponent({
  name: "Title",
  description: "A heading for the view or a part of it.",
  props: z.object({ text: z.string(), size: z.enum(["md", "lg"]).optional().describe("lg for the heading of the whole view") }),
  component: ({ props }) => <h3 className={cn("font-heading font-bold tracking-[-0.02em]", props.size === "lg" ? "text-[19px]" : "text-[15px]")}>{props.text}</h3>,
});

const Text = defineComponent({
  name: "Text",
  description: "A sentence or two of plain text. Long explanations belong in the reply itself, outside the view.",
  props: z.object({ text: z.string(), tone: z.enum(["normal", "muted", "strong"]).optional() }),
  component: ({ props }) => <p className={cn("text-[14px] leading-relaxed [overflow-wrap:anywhere]", props.tone === "muted" && "text-[13px] text-muted-foreground", props.tone === "strong" && "font-semibold")}>{props.text}</p>,
});

const TONES = {
  neutral: "bg-secondary text-foreground",
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  bad: "bg-red-500/15 text-red-700 dark:text-red-300",
  info: "bg-primary/10 text-primary",
} as const;
const tone = z.enum(["neutral", "good", "warn", "bad", "info"]).optional();

const Badge = defineComponent({
  name: "Badge",
  description: "A word or two in a small pill: a state, a category, a verdict.",
  props: z.object({ text: z.string(), tone }),
  component: ({ props }) => <span className={cn("inline-flex h-6 w-fit items-center rounded-full px-2 text-xs font-semibold", TONES[props.tone ?? "neutral"])}>{props.text}</span>,
});

const Stat = defineComponent({
  name: "Stat",
  description: "One number that matters, with what it is and an optional note (a change, a unit, a period).",
  props: z.object({ label: z.string(), value: z.string().describe("The number as it should read, with its unit: \"42\", \"$1.2M\", \"87%\""), note: z.string().optional(), tone }),
  component: ({ props }) => (
    <div className="flex min-w-[120px] flex-1 flex-col gap-0.5 rounded-[14px] border bg-background p-3">
      <span className="truncate text-xs text-muted-foreground">{props.label}</span>
      <span className="font-heading text-[22px] font-bold leading-tight tracking-[-0.02em] tabular-nums">{props.value}</span>
      {props.note && <span className={cn("w-fit rounded-full px-1.5 text-xs font-medium", props.tone ? TONES[props.tone] : "px-0 text-muted-foreground")}>{props.note}</span>}
    </div>
  ),
});

const cell = z.union([z.string(), z.number()]);

const Table = defineComponent({
  name: "Table",
  description: "Rows of values under column headings. For comparing things across the same few properties.",
  props: z.object({ columns: z.array(z.string()).describe("The headings"), rows: z.array(z.array(cell)).describe("One array per row, a value per column") }),
  component: ({ props }) => (
    <div className="min-w-[200px] flex-1 overflow-x-auto rounded-[14px] border bg-background">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b bg-muted/50">
            {(props.columns ?? []).map((c, i) => <th key={i} className="whitespace-nowrap px-3 py-2 text-xs font-semibold text-muted-foreground">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {(props.rows ?? []).map((row, r) => (
            <tr key={r} className="border-b last:border-b-0">
              {(Array.isArray(row) ? row : []).map((v, i) => <td key={i} className={cn("px-3 py-2 align-top [overflow-wrap:anywhere]", typeof v === "number" && "text-right tabular-nums", i === 0 && "font-medium")}>{typeof v === "number" ? v.toLocaleString() : String(v ?? "")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
});

/** Colors for the parts of a chart, readable on a light and a dark background alike. */
const SERIES = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
const short = (n: number) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n * 100) / 100));

function Bars({ labels, values }: { labels: string[]; values: number[] }) {
  const most = Math.max(...values.map(Math.abs), 1);
  return (
    <div className="flex flex-col gap-1.5">
      {values.map((v, i) => (
        <div key={i} className="grid grid-cols-[minmax(64px,28%)_1fr_auto] items-center gap-2 text-[13px]">
          <span className="truncate text-muted-foreground" title={labels[i]}>{labels[i] ?? ""}</span>
          <span className="h-3.5 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full" style={{ width: `${(Math.abs(v) / most) * 100}%`, background: SERIES[0] }} /></span>
          <span className="tabular-nums">{short(v)}</span>
        </div>
      ))}
    </div>
  );
}

function Line({ labels, values }: { labels: string[]; values: number[] }) {
  const [w, h, pad] = [320, 120, 8];
  const [lo, hi] = [Math.min(...values, 0), Math.max(...values, 1)];
  const x = (i: number) => pad + (values.length > 1 ? (i / (values.length - 1)) * (w - pad * 2) : (w - pad * 2) / 2);
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo || 1)) * (h - pad * 2);
  const path = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  return (
    <div className="flex flex-col gap-1">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[140px] w-full" preserveAspectRatio="none" role="img" aria-label={labels.map((l, i) => `${l}: ${values[i]}`).join(", ")}>
        <path d={`${path}L${x(values.length - 1).toFixed(1)} ${h - pad}L${x(0).toFixed(1)} ${h - pad}Z`} fill={SERIES[0]} opacity={0.12} />
        <path d={path} fill="none" stroke={SERIES[0]} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{labels[0]} · {short(values[0])}</span>
        <span className="truncate">{labels[labels.length - 1]} · {short(values[values.length - 1])}</span>
      </div>
    </div>
  );
}

function Pie({ labels, values }: { labels: string[]; values: number[] }) {
  const total = values.reduce((a, b) => a + Math.max(b, 0), 0) || 1;
  let turned = 0;
  const stops = values.map((v, i) => {
    const from = turned;
    turned += (Math.max(v, 0) / total) * 360;
    return `${SERIES[i % SERIES.length]} ${from.toFixed(2)}deg ${turned.toFixed(2)}deg`;
  });
  return (
    <div className="flex flex-wrap items-center gap-4">
      <span className="size-[112px] flex-none rounded-full" style={{ background: `conic-gradient(${stops.join(", ")})`, mask: "radial-gradient(circle, transparent 38%, #000 39%)", WebkitMask: "radial-gradient(circle, transparent 38%, #000 39%)" }} role="img" aria-label={labels.map((l, i) => `${l}: ${values[i]}`).join(", ")} />
      <ul className="flex min-w-[140px] flex-1 flex-col gap-1 text-[13px]">
        {values.map((v, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="size-2.5 flex-none rounded-[3px]" style={{ background: SERIES[i % SERIES.length] }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{labels[i] ?? ""}</span>
            <span className="tabular-nums">{Math.round((Math.max(v, 0) / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const Chart = defineComponent({
  name: "Chart",
  description: "One series of numbers drawn: bar to compare a few things, line for change over time, pie for parts of a whole. At most 12 values.",
  props: z.object({ kind: z.enum(["bar", "line", "pie"]), labels: z.array(z.string()).describe("What each value is"), values: z.array(z.number()).describe("One number per label"), title: z.string().optional() }),
  component: ({ props }) => {
    const values = (props.values ?? []).filter((v): v is number => typeof v === "number" && Number.isFinite(v)).slice(0, 12);
    const labels = (props.labels ?? []).map(String).slice(0, values.length);
    if (!values.length) return null;
    return (
      <figure className="flex min-w-[200px] flex-1 flex-col gap-2.5 rounded-[14px] border bg-background p-3.5">
        {props.title && <figcaption className="text-[13px] font-semibold text-muted-foreground">{props.title}</figcaption>}
        {props.kind === "line" ? <Line labels={labels} values={values} /> : props.kind === "pie" ? <Pie labels={labels} values={values} /> : <Bars labels={labels} values={values} />}
      </figure>
    );
  },
});

const Progress = defineComponent({
  name: "Progress",
  description: "How far along something is, as a bar.",
  props: z.object({ label: z.string(), percent: z.number().describe("0 to 100") }),
  component: ({ props }) => {
    const p = Math.min(100, Math.max(0, Number(props.percent) || 0));
    return (
      <div className="flex min-w-[160px] flex-1 flex-col gap-1 text-[13px]">
        <div className="flex justify-between gap-2"><span className="truncate">{props.label}</span><span className="tabular-nums text-muted-foreground">{Math.round(p)}%</span></div>
        <span className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}><span className="block h-full rounded-full bg-primary" style={{ width: `${p}%` }} /></span>
      </div>
    );
  },
});

const List = defineComponent({
  name: "List",
  description: "Short lines one under another: options, findings, steps.",
  props: z.object({ items: z.array(z.string()), ordered: z.boolean().optional().describe("Numbered when true") }),
  component: ({ props }) => {
    const Tag = props.ordered ? "ol" : "ul";
    return <Tag className={cn("flex flex-col gap-1 pl-5 text-[14px]", props.ordered ? "list-decimal" : "list-disc")}>{(props.items ?? []).map((t, i) => <li key={i} className="[overflow-wrap:anywhere]">{String(t)}</li>)}</Tag>;
  },
});

const Button = defineComponent({
  name: "Button",
  description: "Something the person can press to go on: with @ToAssistant(\"...\") it writes that message to the cubes for them, with @OpenUrl(\"https://...\") it opens a web page. Inside a Form it sends what was filled in.",
  props: z.object({ label: z.string(), action: action().optional(), primary: z.boolean().optional().describe("The one main thing to do") }),
  component: ({ props }) => {
    const trigger = useTriggerAction();
    const form = useFormName();
    const streaming = useIsStreaming();
    return (
      <button type="button" disabled={streaming} className={cn("h-8 w-fit rounded-full px-3.5 text-[13px] font-semibold disabled:opacity-40", props.primary ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-accent")} onClick={() => void trigger(props.label, form, props.action as Parameters<typeof trigger>[2])}>
        {props.label}
      </button>
    );
  },
});

const field = "selectable h-9 w-full rounded-xl border bg-background px-3 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const Input = defineComponent({
  name: "Input",
  description: "A line of text the person fills in. Only inside a Form.",
  props: z.object({ name: z.string().describe("What the value is called when the form is sent"), label: z.string(), placeholder: z.string().optional() }),
  component: ({ props }) => {
    const form = useFormName();
    const get = useGetFieldValue();
    const set = useSetFieldValue();
    const streaming = useIsStreaming();
    return (
      <label className="flex min-w-[160px] flex-1 flex-col gap-1 text-[13px] font-medium">
        {props.label}
        <input className={field} disabled={streaming} placeholder={props.placeholder} value={String(get(form, props.name) ?? "")} onChange={(e) => set(form, "Input", props.name, e.target.value, false)} />
      </label>
    );
  },
});

const Select = defineComponent({
  name: "Select",
  description: "One choice out of a few. Only inside a Form.",
  props: z.object({ name: z.string(), label: z.string(), options: z.array(z.string()) }),
  component: ({ props }) => {
    const form = useFormName();
    const get = useGetFieldValue();
    const set = useSetFieldValue();
    const streaming = useIsStreaming();
    const options = (props.options ?? []).map(String);
    return (
      <label className="flex min-w-[160px] flex-1 flex-col gap-1 text-[13px] font-medium">
        {props.label}
        <select className={field} disabled={streaming} value={String(get(form, props.name) ?? "")} onChange={(e) => set(form, "Select", props.name, e.target.value, false)}>
          <option value="" />
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
    );
  },
});

const Form = defineComponent({
  name: "Form",
  description: "Inputs and Selects the person fills in, with a Button that sends them. Use it when you need a few answers at once before you can go on.",
  props: z.object({ name: z.string().describe("A short name for the form, letters only"), children }),
  component: ({ props, renderNode }) => (
    <FormNameContext.Provider value={props.name}>
      <div className="flex min-w-0 flex-col gap-2.5 rounded-[14px] border bg-background p-3.5">{renderNode(props.children)}</div>
    </FormNameContext.Provider>
  ),
});

export const cubeLibrary = createLibrary({
  root: "Col",
  components: [Col, Row, Card, Title, Text, Badge, Stat, Table, Chart, Progress, List, Button, Form, Input, Select],
});

/** The name of the fenced block a view is written in. */
export const UI_FENCE = "openui-lang";

/**
 * What a cube is told so that it can show a view: when to, how to write one, and what there is
 * to build it from. Made once: the list of components does not change while the app runs.
 */
let told: string | undefined;
export function uiRule(): string {
  told ??= cubeLibrary.prompt({
    preamble: [
      "Showing a view. You reply in plain text or Markdown as usual. When the answer is easier to take in as a view (numbers to compare, a table of options, a chart, a status at a glance, a choice or a few questions for the person), you may add ONE view to your reply: a block fenced with ```" + UI_FENCE + " holding a small program in the language described below. Cube draws it in the chat where the block stands. Text outside the block is shown as normal chat, so say in a sentence what the view shows.",
      "Do not use a view for prose, for code, for a single fact, or when the person asked for a file. Most replies need none.",
    ].join("\n"),
    additionalRules: [
      "Write `root = Col([...])` as the first statement, then the statements it refers to.",
      "Use only the components listed here, with their arguments in the order given. There are no others.",
      "Keep it small: at most about 25 statements. Put real values in it, never placeholders.",
      "A Button with @ToAssistant(\"...\") offers the person a next step: the text is what they would say to you. They see it before it is sent.",
    ],
    examples: [
      [
        "root = Col([head, stats, table, next])",
        "head = Title(\"Signup funnel, last 7 days\", \"lg\")",
        "stats = Row([Stat(\"Visitors\", \"12,480\"), Stat(\"Signed up\", \"936\", \"7.5%\", \"good\"), Stat(\"Paid\", \"118\", \"-2 vs last week\", \"warn\")])",
        "table = Table([\"Step\", \"People\", \"Kept\"], [[\"Landing\", 12480, \"100%\"], [\"Signup\", 936, \"7.5%\"], [\"Paid\", 118, \"12.6%\"]])",
        "next = Row([Button(\"Break it down by channel\", @ToAssistant(\"Break the signup funnel down by channel\"), true), Button(\"Open the dashboard\", @OpenUrl(\"https://example.com/funnel\"))])",
      ].join("\n"),
    ],
  });
  return told;
}
