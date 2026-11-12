import { useMemo, useRef, useState } from "react";
import { RichText } from "@/components/bits";
import { GrowingText } from "@/components/stage/MdEditor";
import { CodeBlock, CodeBlockCode } from "@/components/ui/code-block";
import { editNotebook, parseNotebook, type NbEdit, type NbOutput } from "@/lib/notebook";
import { cn } from "@/lib/utils";

function Output({ o }: { o: NbOutput }) {
  switch (o.type) {
    case "image":
      return <img className="max-w-full rounded-lg bg-white" src={o.src} alt="Cell output" />;
    case "markdown":
      return <RichText text={o.text} className="doc selectable !p-0" />;
    case "html":
      // Tables and other rich results come as a page the notebook's author controls: it is shown
      // in a frame that can run nothing and reach nothing.
      return (
        <iframe
          className="block w-full rounded-lg border-0 bg-white"
          style={{ height: Math.min(440, Math.max(72, o.rows * 30 + 48)) }}
          title="Cell output"
          sandbox=""
          srcDoc={`<!doctype html><meta charset="utf-8"><style>body{margin:8px;font:13px/1.5 -apple-system,sans-serif;color:#1d1d1f}table{border-collapse:collapse}th,td{padding:4px 10px;border-bottom:1px solid #e5e5ea;text-align:right}th{font-weight:600}img{max-width:100%}</style>${o.html}`}
        />
      );
    case "error":
      return <pre className="selectable overflow-x-auto whitespace-pre-wrap rounded-lg bg-destructive/10 p-3 font-mono text-xs text-destructive">{o.text}</pre>;
    default:
      return <pre className={cn("selectable overflow-x-auto whitespace-pre-wrap font-mono text-xs", o.stream === "stderr" && "rounded-lg bg-destructive/10 p-3")}>{o.text}</pre>;
  }
}

const chip = "h-7 rounded-full border border-dashed px-2.5 text-xs text-muted-foreground hover:text-foreground";

/**
 * A Jupyter notebook as it reads in Jupyter: text cells rendered, code cells with what they
 * produced. Cells can be rewritten, added and removed here; running them is Jupyter's job (or a
 * cube's), so outputs stay as they were last run.
 */
export default function Notebook({ text, editable, onSave }: { text: string; editable?: boolean; onSave?: (next: string) => Promise<void> }) {
  const nb = useMemo(() => parseNotebook(text), [text]);
  const [edit, setEdit] = useState<{ index: number; was: string; draft: string }>();
  const [problem, setProblem] = useState("");
  const cancelled = useRef(false);
  if (!text) return null;
  if (!nb) return <p className="p-6 text-muted-foreground">This file is not a notebook Stage can read. Switch to Code to see its text.</p>;
  const can = Boolean(editable && onSave);

  const apply = (change: NbEdit) => {
    const next = editNotebook(text, change);
    if (next === null) return setProblem("This notebook is in an older format that Stage shows but does not edit.");
    setProblem("");
    onSave?.(next).catch((e) => setProblem(`Could not save: ${String(e)}`));
  };
  const done = () => {
    const e = edit;
    if (!e) return;
    setEdit(undefined);
    if (cancelled.current) { cancelled.current = false; return; }
    if (e.draft === e.was) return;
    // A cube may have rewritten the notebook meanwhile: only save over the text this edit started from.
    if (nb.cells[e.index]?.source !== e.was) {
      setProblem("The notebook changed while you were editing, so this edit was not saved. Your text is on the clipboard.");
      void navigator.clipboard?.writeText(e.draft).catch(() => {});
      return;
    }
    apply({ op: "source", index: e.index, source: e.draft });
  };
  const cancel = () => { cancelled.current = true; setEdit(undefined); };
  const open = (index: number, source: string) => { if (can && !window.getSelection()?.toString()) setEdit({ index, was: source, draft: source }); };
  const editor = (label: string) => edit && <GrowingText label={label} mono value={edit.draft} onChange={(draft) => setEdit({ ...edit, draft })} onDone={done} onCancel={cancel} />;
  const tools = (i: number) => can && (
    <div className="nb-tools col-start-2 flex gap-1.5" data-ui>
      <button type="button" className={chip} onClick={() => apply({ op: "add", after: i, kind: "markdown" })}>Add text below</button>
      <button type="button" className={chip} onClick={() => apply({ op: "add", after: i, kind: "code" })}>Add code below</button>
      <button type="button" className={chip} onClick={() => apply({ op: "delete", index: i })}>Delete cell</button>
    </div>
  );

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-3 p-6">
      {problem && <p role="alert" data-ui className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{problem}</p>}
      {!nb.cells.length && <p className="text-muted-foreground">This notebook has no cells yet.</p>}
      {nb.cells.map((cell, i) => (
        <div key={i} className="nb-cell grid grid-cols-[44px_minmax(0,1fr)] gap-x-2 gap-y-2">
          {cell.kind === "code"
            ? <span className="pt-2.5 text-right font-mono text-[11px] text-muted-foreground" aria-hidden="true">[{cell.count ?? " "}]</span>
            : <span aria-hidden="true" />}
          {edit?.index === i ? (
            <div className="min-w-0">{editor(cell.kind === "code" ? "Edit this code" : "Edit this text")}</div>
          ) : cell.kind === "markdown" ? (
            <div className={cn("min-w-0", can && "md-block")} title={can ? "Click to edit" : undefined} onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) open(i, cell.source); }}>
              {cell.source.trim() ? <RichText text={cell.source} className="doc selectable !m-0 !max-w-none !p-0" /> : <p data-ui className="text-muted-foreground">Empty text cell</p>}
            </div>
          ) : cell.kind === "raw" ? (
            <pre className="selectable whitespace-pre-wrap font-mono text-xs text-muted-foreground" onClick={() => open(i, cell.source)}>{cell.source}</pre>
          ) : (
            <div className={cn("min-w-0", can && "cursor-text")} title={can ? "Click to edit" : undefined} onClick={() => open(i, cell.source)}>
              <CodeBlock className="selectable"><CodeBlockCode code={cell.source || " "} language={nb.language} /></CodeBlock>
            </div>
          )}
          {cell.outputs.length > 0 && (
            <div className="col-start-2 flex min-w-0 flex-col gap-2">
              {cell.outputs.map((o, j) => <Output key={j} o={o} />)}
            </div>
          )}
          {tools(i)}
        </div>
      ))}
      {can && !nb.cells.length && (
        <div className="flex gap-1.5">
          <button type="button" className={chip} onClick={() => apply({ op: "add", after: -1, kind: "markdown" })}>Add text</button>
          <button type="button" className={chip} onClick={() => apply({ op: "add", after: -1, kind: "code" })}>Add code</button>
        </div>
      )}
    </div>
  );
}
