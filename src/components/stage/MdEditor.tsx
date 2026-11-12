import { useEffect, useMemo, useRef, useState } from "react";
import { RichText } from "@/components/bits";
import { appendBlock, replaceBlock, splitBlocks } from "@/lib/mdBlocks";
import { cn } from "@/lib/utils";

/** A text box that grows with what is typed in it. */
export function GrowingText({ value, onChange, onDone, onCancel, mono, label }: { value: string; onChange: (v: string) => void; onDone: () => void; onCancel: () => void; mono?: boolean; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      aria-label={label}
      value={value}
      spellCheck={false}
      className={cn("selectable block w-full resize-none rounded-lg border bg-background px-3 py-2 outline-none ring-2 ring-ring", mono ? "font-mono text-[13px] leading-relaxed" : "text-[15px] leading-relaxed")}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onDone(); }
      }}
    />
  );
}

/**
 * A markdown document that reads as rendered and is edited where it stands: click a heading, a
 * paragraph, a list or a table and that piece turns into its text; click away and it is saved.
 * Only the piece that was edited changes in the file.
 */
export default function MdEditor({ text, editable, onSave }: { text: string; editable: boolean; onSave: (next: string) => Promise<void> }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  /** The block being edited: its place, the source it had, and what the person has typed. */
  const [edit, setEdit] = useState<{ index: number; was: string; draft: string }>();
  const [problem, setProblem] = useState("");
  const cancelled = useRef(false);

  if (!editable) return <RichText text={text} className="doc selectable" />;

  const done = () => {
    const e = edit;
    if (!e) return;
    setEdit(undefined);
    if (cancelled.current) { cancelled.current = false; return; }
    if (e.draft === e.was) return;
    let next: string;
    if (e.index >= blocks.length) {
      next = appendBlock(text, e.draft);
    } else {
      const block = blocks[e.index];
      // The file may have been rewritten (by a cube) while this piece was open: only replace what is still there.
      if (!block || text.slice(block.start, block.end) !== e.was) {
        setProblem("The file changed while you were editing, so this edit was not saved. Your text is on the clipboard.");
        void navigator.clipboard?.writeText(e.draft).catch(() => {});
        return;
      }
      next = replaceBlock(text, block, e.draft);
    }
    setProblem("");
    onSave(next).catch((err) => setProblem(`Could not save: ${String(err)}`));
  };
  const cancel = () => { cancelled.current = true; setEdit(undefined); };

  return (
    <div className="doc selectable">
      {problem && <p role="alert" data-ui className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{problem}</p>}
      {blocks.map((b, i) => {
        const source = text.slice(b.start, b.end);
        return edit?.index === i ? (
          <div key={i} className="my-2">
            <GrowingText label="Edit this part" mono value={edit.draft} onChange={(draft) => setEdit({ ...edit, draft })} onDone={done} onCancel={cancel} />
          </div>
        ) : (
          <div
            key={i}
            className="md-block"
            title="Click to edit"
            onClick={(e) => {
              // Links and selections keep working; only a plain click starts an edit.
              if ((e.target as HTMLElement).closest("a") || window.getSelection()?.toString()) return;
              setEdit({ index: i, was: source, draft: source });
            }}
          >
            <RichText text={source} className="!m-0 !max-w-none !p-0" />
          </div>
        );
      })}
      {edit?.index === blocks.length ? (
        <div className="my-2">
          <GrowingText label="New part" mono value={edit.draft} onChange={(draft) => setEdit({ ...edit, draft })} onDone={done} onCancel={cancel} />
        </div>
      ) : (
        <button type="button" data-ui className="mt-3 h-8 rounded-full border border-dashed px-3 text-[13px] text-muted-foreground hover:text-foreground" onClick={() => setEdit({ index: blocks.length, was: "", draft: "" })}>
          Add text
        </button>
      )}
    </div>
  );
}
