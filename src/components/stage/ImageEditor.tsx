import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { rescan } from "@/agents/orchestrator";
import { readBytes, writeBytes } from "@/agents/runner";
import { agentById } from "@/agents/types";
import { CropIcon, PencilIcon, ReloadIcon, RewindIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useCube, type Artifact } from "@/state/store";

interface Box { x: number; y: number; w: number; h: number }
type Tool = "select" | "pen";

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
const INK = "#ff3b30";

/** The box between two points, kept inside the picture, in whole pixels. */
export function boxOf(ax: number, ay: number, bx: number, by: number, width: number, height: number): Box {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  const x0 = clamp(Math.min(ax, bx), width);
  const y0 = clamp(Math.min(ay, by), height);
  return { x: x0, y: y0, w: clamp(Math.max(ax, bx), width) - x0, h: clamp(Math.max(ay, by), height) - y0 };
}

/**
 * Small edits to a picture on the Stage: crop, draw on it, turn it, and point at a part of it to
 * ask a cube for a change there. Edits stay in memory until saved.
 */
export default function ImageEditor({ convId, dir, a }: { convId: string; dir: string; a: Artifact }) {
  const view = useRef<HTMLCanvasElement>(null);
  // The picture as edited so far, at its real size. The canvas on screen is a scaled drawing of it.
  const work = useRef<HTMLCanvasElement | null>(null);
  const undo = useRef<HTMLCanvasElement[]>([]);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [sel, setSel] = useState<Box | null>(null);
  const [dirty, setDirty] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const setQuote = useCube((s) => s.setQuote);
  const kind = useCube((s) => s.convs.find((c) => c.id === convId)?.kind);
  const ext = a.rel.split(".").pop()?.toLowerCase() ?? "";
  // Only formats the app can write back faithfully are saved over; the rest are saved as a PNG copy.
  const canOverwrite = ext === "png" || ext === "jpg" || ext === "jpeg";

  const paint = useCallback((box: Box | null = sel) => {
    const c = view.current;
    const w = work.current;
    if (!c || !w) return;
    c.width = w.width;
    c.height = w.height;
    const g = c.getContext("2d")!;
    g.drawImage(w, 0, 0);
    if (box && box.w > 0 && box.h > 0) {
      // Dim everything but the chosen part.
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(0, 0, w.width, box.y);
      g.fillRect(0, box.y + box.h, w.width, w.height - box.y - box.h);
      g.fillRect(0, box.y, box.x, box.h);
      g.fillRect(box.x + box.w, box.y, w.width - box.x - box.w, box.h);
      g.strokeStyle = "#ffffff";
      g.lineWidth = Math.max(1, w.width / 600);
      g.setLineDash([g.lineWidth * 5, g.lineWidth * 4]);
      g.strokeRect(box.x, box.y, box.w, box.h);
    }
  }, [sel]);

  useEffect(() => {
    let alive = true;
    setNote("");
    readBytes(a.path)
      .then((b64) => {
        const img = new Image();
        img.onload = () => {
          if (!alive) return;
          const c = document.createElement("canvas");
          c.width = img.naturalWidth || 800;
          c.height = img.naturalHeight || 600;
          c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
          work.current = c;
          undo.current = [];
          setSize({ w: c.width, h: c.height });
          setSel(null);
          setDirty(false);
          paint(null);
        };
        img.onerror = () => alive && setNote("This picture could not be opened for editing.");
        img.src = `data:${MIME[ext] ?? "image/png"};base64,${b64}`;
      })
      .catch((e) => alive && setNote(String(e)));
    return () => { alive = false; };
    // Reload only when the file itself changes on disk, not on every repaint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.path, a.mtime]);

  useEffect(() => paint(), [paint]);

  const remember = () => {
    const w = work.current;
    if (!w) return;
    const copy = document.createElement("canvas");
    copy.width = w.width;
    copy.height = w.height;
    copy.getContext("2d")!.drawImage(w, 0, 0);
    undo.current = [...undo.current, copy].slice(-12);
  };
  const replace = (next: HTMLCanvasElement) => {
    work.current = next;
    setSize({ w: next.width, h: next.height });
    setSel(null);
    setDirty(true);
    paint(null);
  };

  /** Where a pointer is, in the picture's own pixels. */
  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * size.w, y: ((e.clientY - r.top) / r.height) * size.h };
  };
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!work.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    drag.current = p;
    if (tool === "pen") {
      remember();
      const g = work.current.getContext("2d")!;
      g.strokeStyle = INK;
      g.lineWidth = Math.max(3, size.w / 220);
      g.lineCap = "round";
      g.lineJoin = "round";
      g.beginPath();
      g.moveTo(p.x, p.y);
    } else setSel(null);
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const from = drag.current;
    if (!from || !work.current) return;
    const p = at(e);
    if (tool === "pen") {
      const g = work.current.getContext("2d")!;
      g.lineTo(p.x, p.y);
      g.stroke();
      setDirty(true);
      paint(null);
    } else paint(boxOf(from.x, from.y, p.x, p.y, size.w, size.h));
  };
  const up = (e: PointerEvent<HTMLCanvasElement>) => {
    const from = drag.current;
    drag.current = null;
    if (!from || tool === "pen") return;
    const p = at(e);
    const box = boxOf(from.x, from.y, p.x, p.y, size.w, size.h);
    setSel(box.w > 3 && box.h > 3 ? box : null);
  };

  const crop = () => {
    const w = work.current;
    if (!w || !sel) return;
    remember();
    const c = document.createElement("canvas");
    c.width = sel.w;
    c.height = sel.h;
    c.getContext("2d")!.drawImage(w, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
    replace(c);
  };
  const turn = () => {
    const w = work.current;
    if (!w) return;
    remember();
    const c = document.createElement("canvas");
    c.width = w.height;
    c.height = w.width;
    const g = c.getContext("2d")!;
    g.translate(c.width, 0);
    g.rotate(Math.PI / 2);
    g.drawImage(w, 0, 0);
    replace(c);
  };
  const back = () => {
    const prev = undo.current.pop();
    if (prev) replace(prev);
  };

  const bytes = (c: HTMLCanvasElement, mime: string) => c.toDataURL(mime, 0.92).split(",", 2)[1] ?? "";
  const save = async (copy: boolean) => {
    const w = work.current;
    if (!w || busy) return;
    setBusy(true);
    try {
      const stem = a.rel.replace(/\.[^./]+$/, "");
      if (copy || !canOverwrite) {
        const rel = await writeBytes(dir, `${stem}-edit.png`, bytes(w, "image/png"));
        setNote(`Saved as ${rel}.`);
      } else {
        await writeBytes(dir, a.rel, bytes(w, ext === "png" ? "image/png" : "image/jpeg"), true);
        setDirty(false);
        setNote("Saved.");
      }
      await rescan(convId);
    } catch (e) {
      setNote(String(e));
    }
    setBusy(false);
  };

  /** Saves a copy with the chosen part boxed in red and drops a request about it into the message box. */
  const ask = async () => {
    const w = work.current;
    if (!w || !sel || busy) return;
    setBusy(true);
    try {
      const c = document.createElement("canvas");
      c.width = w.width;
      c.height = w.height;
      const g = c.getContext("2d")!;
      g.drawImage(w, 0, 0);
      g.strokeStyle = INK;
      g.lineWidth = Math.max(4, w.width / 180);
      g.strokeRect(sel.x, sel.y, sel.w, sel.h);
      const name = (a.rel.split("/").pop() ?? "image").replace(/\.[^.]+$/, "");
      const mark = await writeBytes(dir, `marks/${name}-mark.png`, bytes(c, "image/png"));
      const to = kind === "channel" ? `@${agentById(a.by ?? "")?.name ?? "Designer"} ` : "";
      setQuote({ convId, text: `${to}In \`${a.rel}\`, change the part inside the red box (see \`${mark}\`; the box starts at x ${sel.x}, y ${sel.y} and is ${sel.w}×${sel.h} px of ${w.width}×${w.height}): ` });
      setNote("Say what should change there in the message box.");
      await rescan(convId);
    } catch (e) {
      setNote(String(e));
    }
    setBusy(false);
  };

  const btn = "flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold disabled:opacity-35";
  return (
    <div className="flex size-full flex-col bg-muted/40">
      <div className="flex flex-none flex-wrap items-center gap-1.5 border-b bg-background px-3 py-2" role="toolbar" aria-label="Picture tools">
        <button type="button" aria-pressed={tool === "select"} className={cn(btn, tool === "select" ? "bg-foreground text-background" : "bg-secondary")} onClick={() => setTool("select")}><CropIcon width={14} height={14} /> Select</button>
        <button type="button" aria-pressed={tool === "pen"} className={cn(btn, tool === "pen" ? "bg-foreground text-background" : "bg-secondary")} onClick={() => { setTool("pen"); setSel(null); }}><PencilIcon width={14} height={14} /> Draw</button>
        <button type="button" className={cn(btn, "bg-secondary")} onClick={turn}><ReloadIcon width={14} height={14} /> Turn</button>
        <button type="button" className={cn(btn, "bg-secondary")} disabled={!undo.current.length} onClick={back}><RewindIcon width={14} height={14} /> Undo</button>
        <span className="mx-1 h-5 w-px bg-border" />
        <button type="button" className={cn(btn, "bg-secondary")} disabled={!sel} onClick={crop}>Crop to selection</button>
        <button type="button" className={cn(btn, "bg-primary text-primary-foreground")} disabled={!sel || busy} title="Mark this part and ask a cube to change it" onClick={() => void ask()}>Ask for a change here</button>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground tabular-nums">{size.w}×{size.h}</span>
        <button type="button" className={cn(btn, "bg-secondary")} disabled={busy || !work.current} onClick={() => void save(true)}>Save a copy</button>
        {canOverwrite && <button type="button" className={cn(btn, "bg-primary text-primary-foreground")} disabled={!dirty || busy} onClick={() => void save(false)}>Save</button>}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <canvas
          ref={view}
          aria-label={`${a.rel}, ${tool === "pen" ? "draw on it" : "drag to select a part"}`}
          className={cn("max-h-full max-w-full touch-none rounded-lg shadow-sm", tool === "pen" ? "cursor-crosshair" : "cursor-cell")}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
        />
      </div>
      <p className="flex-none px-4 pb-2 text-xs text-muted-foreground" role="status">
        {note || (sel ? `Selected ${sel.w}×${sel.h} px. Crop to it, or ask a cube to change that part.` : tool === "pen" ? "Draw on the picture. Nothing is written to disk until you save." : "Drag on the picture to select a part of it.")}
      </p>
    </div>
  );
}
