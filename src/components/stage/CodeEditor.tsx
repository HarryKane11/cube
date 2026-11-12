import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { useEffect, useRef, useState } from "react";
import { rescan, send } from "@/agents/orchestrator";
import { agentById } from "@/agents/types";
import { inTauri, readText, writeText } from "@/agents/runner";
import { quoteOf } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { useCube, type Artifact } from "@/state/store";

// Language services run in workers so typing never waits on them.
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// A single file is not a project: without its imports and settings, type errors would be noise.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

monaco.editor.defineTheme("cube-light", { base: "vs", inherit: true, rules: [], colors: { "editor.background": "#ffffff", "editorGutter.background": "#ffffff" } });
monaco.editor.defineTheme("cube-dark", { base: "vs-dark", inherit: true, rules: [], colors: { "editor.background": "#1c1c1e", "editorGutter.background": "#1c1c1e" } });

const themeNow = () => (document.documentElement.classList.contains("dark") ? "cube-dark" : "cube-light");
new MutationObserver(() => monaco.editor.setTheme(themeNow())).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

/** One open file: its text as the person sees it, and the text last known to be on disk. */
interface Buf {
  model: monaco.editor.ITextModel;
  saved: string;
}

/** Buffers outlive the editor view, so switching tabs never loses unsaved typing. */
const bufs = new Map<string, Buf>();

function open(path: string, text: string): Buf {
  let buf = bufs.get(path);
  if (!buf) {
    const uri = monaco.Uri.file(path);
    // The file name picks the language.
    buf = { model: monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, undefined, uri), saved: text };
    bufs.set(path, buf);
  }
  return buf;
}

/** Swaps the whole text as one edit, so it can be undone and the view does not jump to the top. */
function replaceAll(model: monaco.editor.ITextModel, text: string): void {
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
}

interface Props {
  convId: string;
  a: Artifact;
  /** Show the file against `base` instead of on its own. */
  diff: boolean;
  /** The text the file had when the person last spoke. Empty for a file that did not exist then. */
  base?: string;
}

/** The Stage's code editor: edit and save a file, or review what changed in it and take changes back. */
export default function CodeEditor({ convId, a, diff, base }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [buf, setBuf] = useState<Buf>();
  const [failed, setFailed] = useState("");
  /** Set when the file changed on disk while the person has unsaved edits: the text now on disk. */
  const [onDisk, setOnDisk] = useState<string>();
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const view = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [ready, setReady] = useState(0);
  /** The lines the person is commenting on, while the comment box is open. */
  const [noting, setNoting] = useState<{ from: number; to: number }>();
  const [note, setNote] = useState("");
  const reveal = useCube((s) => (s.reveal?.path === a.path ? s.reveal : undefined));
  const dirty = useCube((s) => Boolean(s.dirty[a.path]));
  const setDirty = useCube((s) => s.setDirty);
  // Past this size only part of the file is loaded, so saving would cut it short.
  const readOnly = a.size > 1_500_000;

  useEffect(() => {
    let alive = true;
    const apply = (text: string) => {
      if (!alive) return;
      const b = open(a.path, text);
      if (text !== b.saved) {
        if (b.model.getValue() === b.saved) {
          // Nothing unsaved here: follow the file, e.g. while an agent is rewriting it.
          // `saved` moves first, so the edit below is not mistaken for the person's typing.
          b.saved = text;
          replaceAll(b.model, text);
        } else {
          setOnDisk(text);
        }
      }
      setFailed("");
      setBuf(b);
    };
    if (a.content !== undefined) apply(a.content);
    else if (inTauri) readText(a.path, 2_000_000).then(apply).catch((e) => alive && setFailed(String(e)));
    return () => { alive = false; };
  }, [a.path, a.mtime, a.content]);

  const save = async () => {
    const b = bufs.get(a.path);
    if (!b || readOnly) return;
    const value = b.model.getValue();
    try {
      if (a.content !== undefined || !inTauri) {
        useCube.getState().putArtifact(convId, { ...a, content: value, mtime: Date.now(), size: value.length });
      } else {
        const mtime = await writeText(a.path, value);
        // Back to exactly how it was when the person last spoke: no longer a change.
        if (useCube.getState().baseline[convId]?.files[a.rel]?.text === value) useCube.getState().rebaseFile(convId, a.rel, mtime);
        void rescan(convId);
      }
      b.saved = value;
      setDirty(a.path, false);
      setOnDisk(undefined);
    } catch (e) {
      setFailed(`Could not save: ${String(e)}`);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!buf || !host.current) return;
    const options: monaco.editor.IStandaloneEditorConstructionOptions = {
      automaticLayout: true,
      glyphMargin: true,
      theme: themeNow(),
      readOnly,
      fontSize: 13,
      lineHeight: 20,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      padding: { top: 10, bottom: 10 },
      renderLineHighlight: "line",
      wordWrap: ["markdown", "plaintext"].includes(buf.model.getLanguageId()) ? "on" : "off",
      tabSize: 2,
      bracketPairColorization: { enabled: true },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    };
    let editor: monaco.editor.IStandaloneCodeEditor;
    let dispose: () => void;
    if (diff) {
      const original = monaco.editor.createModel(base ?? "", buf.model.getLanguageId());
      const view = monaco.editor.createDiffEditor(host.current, { ...options, originalEditable: false, useInlineViewWhenSpaceIsLimited: true, renderMarginRevertIcon: true });
      view.setModel({ original, modified: buf.model });
      editor = view.getModifiedEditor();
      dispose = () => { view.dispose(); original.dispose(); };
    } else {
      editor = monaco.editor.create(host.current, { ...options, model: buf.model });
      dispose = () => editor.dispose();
    }
    view.current = editor;
    setReady((n) => n + 1);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());

    // A "+" follows the pointer down the margin; clicking it opens a comment on that line,
    // or on the selected lines when the click lands inside a selection.
    const hover = editor.createDecorationsCollection();
    const ask = (line: number) => {
      const sel = editor.getSelection();
      const inside = sel && !sel.isEmpty() && line >= sel.startLineNumber && line <= sel.endLineNumber;
      setNoting(inside ? { from: sel.startLineNumber, to: sel.endColumn === 1 ? Math.max(sel.startLineNumber, sel.endLineNumber - 1) : sel.endLineNumber } : { from: line, to: line });
    };
    editor.addAction({
      id: "cube.comment",
      label: "Comment on This for a Cube",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1,
      run: (ed) => ask(ed.getPosition()?.lineNumber ?? 1),
    });
    editor.addAction({
      id: "cube.quote",
      label: "Add Selection to Chat",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      run: (ed) => {
        const sel = ed.getSelection();
        const model = ed.getModel();
        if (!sel || !model) return;
        // With nothing selected, the line under the cursor is what the person means.
        const range = sel.isEmpty() ? new monaco.Range(sel.startLineNumber, 1, sel.startLineNumber, model.getLineMaxColumn(sel.startLineNumber)) : sel;
        const endLine = range.endColumn === 1 && range.endLineNumber > range.startLineNumber ? range.endLineNumber - 1 : range.endLineNumber;
        useCube.getState().setQuote({ convId, text: quoteOf(a.rel, range.startLineNumber, endLine, model.getValueInRange(range)) });
      },
    });
    const subs = [
      editor.onMouseMove((e) => {
        const line = e.target.position?.lineNumber;
        hover.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "cube-add-comment", glyphMarginHoverMessage: { value: "Comment on this line" } } }] : []);
      }),
      editor.onMouseLeave(() => hover.clear()),
      editor.onMouseDown((e) => {
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) ask(e.target.position.lineNumber);
      }),
      buf.model.onDidChangeContent(() => setDirty(a.path, buf.model.getValue() !== buf.saved)),
      editor.onDidChangeCursorPosition((e) => setPos({ line: e.position.lineNumber, col: e.position.column })),
    ];
    return () => {
      subs.forEach((s) => s.dispose());
      view.current = null;
      dispose();
    };
  }, [buf, diff, base, readOnly, a.path, a.rel, convId, setDirty]);

  // A search hit picked in the file list: go to that place once the editor is up.
  useEffect(() => {
    const editor = view.current;
    if (!reveal || !editor) return;
    editor.revealLineInCenter(reveal.line);
    editor.setPosition({ lineNumber: reveal.line, column: reveal.col });
    editor.focus();
    useCube.getState().setReveal(undefined);
  }, [reveal, ready]);

  /** Sends the comment into the conversation, with the lines it is about, to whoever wrote the file. */
  const comment = () => {
    const model = buf?.model;
    const text = note.trim();
    if (!model || !noting || !text) return;
    const code = model.getValueInRange(new monaco.Range(noting.from, 1, noting.to, model.getLineMaxColumn(noting.to)));
    const conv = useCube.getState().convs.find((c) => c.id === convId);
    const author = a.by ? agentById(a.by) : undefined;
    const to = conv?.kind === "channel" && author && conv.members.includes(author.id) ? `@${author.name} ` : "";
    send(convId, `${to}${quoteOf(a.rel, noting.from, noting.to, code)}${text}`);
    setNoting(undefined);
    setNote("");
  };

  const revert = () => {
    if (!buf || base === undefined) return;
    replaceAll(buf.model, base);
    void save();
  };
  const small = "h-6 rounded-full bg-secondary px-2.5 text-xs font-semibold";

  return (
    <div className="flex size-full flex-col">
      {onDisk !== undefined && (
        <div className="flex flex-none flex-wrap items-center gap-2 border-b bg-primary/10 px-3 py-1.5 text-[13px]" role="alert">
          <span className="min-w-0 flex-1">This file changed on disk while you were editing it.</span>
          <button type="button" className={small} onClick={() => { if (buf) { buf.saved = onDisk; replaceAll(buf.model, onDisk); setDirty(a.path, false); } setOnDisk(undefined); }}>Load the new version</button>
          <button type="button" className={small} onClick={() => setOnDisk(undefined)}>Keep mine</button>
        </div>
      )}
      {failed ? (
        <p className="m-auto max-w-[360px] p-6 text-center text-destructive" role="alert">{failed}</p>
      ) : (
        <div ref={host} className="min-h-0 flex-1" />
      )}
      {noting && (
        <form className="flex flex-none items-center gap-2 border-t bg-primary/5 px-3 py-2" onSubmit={(e) => { e.preventDefault(); comment(); }}>
          <span className="flex-none text-xs font-semibold text-primary">{noting.from === noting.to ? `Line ${noting.from}` : `Lines ${noting.from}-${noting.to}`}</span>
          <input
            autoFocus
            aria-label="Your comment on these lines"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setNoting(undefined); }}
            placeholder="What should change here?"
            className="selectable h-8 min-w-0 flex-1 rounded-lg border bg-background px-2.5 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button type="submit" disabled={!note.trim()} className={cn(small, "h-8 bg-primary text-primary-foreground disabled:opacity-35")}>Send</button>
          <button type="button" className={cn(small, "h-8")} onClick={() => setNoting(undefined)}>Cancel</button>
        </form>
      )}
      <footer className="flex h-8 flex-none items-center gap-3 border-t px-3 text-xs text-muted-foreground">
        <span className="tabular-nums">Ln {pos.line}, Col {pos.col}</span>
        <span>{buf?.model.getLanguageId() ?? ""}</span>
        <span className={cn("flex-1 truncate", dirty && "font-semibold text-foreground")}>
          {readOnly ? "Too large to edit here" : dirty ? "Unsaved changes" : "Saved"}
        </span>
        {diff && base !== undefined && !readOnly && <button type="button" className={small} onClick={revert}>Put the old version back</button>}
        {!readOnly && <button type="button" className={cn(small, dirty && "bg-primary text-primary-foreground")} disabled={!dirty} onClick={() => void save()}>Save <kbd className="font-sans opacity-70">⌘S</kbd></button>}
      </footer>
    </div>
  );
}
