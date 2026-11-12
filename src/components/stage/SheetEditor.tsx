import { useMemo, useState } from "react";
import { csvSep, parseCsv, toCsv } from "@/lib/files";

/** The most rows the Stage edits in place. Longer sheets are shown, and edited as text. */
const MAX_ROWS = 2000;

/**
 * A comma- or tab-separated file as a sheet. Click a cell to change it; Enter or clicking away
 * saves, Escape puts it back, Tab moves on to the next cell.
 */
export default function SheetEditor({ text, editable, onSave }: { text: string; editable: boolean; onSave: (next: string) => Promise<void> }) {
  const rows = useMemo(() => parseCsv(text, MAX_ROWS + 1), [text]);
  const sep = useMemo(() => csvSep(text), [text]);
  const [at, setAt] = useState<{ r: number; c: number; draft: string }>();
  const [problem, setProblem] = useState("");
  const whole = rows.length <= MAX_ROWS;
  const can = editable && whole;
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const shown = whole ? rows : rows.slice(0, MAX_ROWS);

  const save = (next: string[][]) => {
    setProblem("");
    onSave(toCsv(next, sep)).catch((e) => setProblem(`Could not save: ${String(e)}`));
  };
  const commit = (move?: { r: number; c: number }) => {
    const cur = at;
    if (!cur) return;
    const was = rows[cur.r]?.[cur.c] ?? "";
    if (cur.draft !== was) {
      const next = rows.map((r) => [...r]);
      while (next[cur.r].length <= cur.c) next[cur.r].push("");
      next[cur.r][cur.c] = cur.draft;
      save(next);
    }
    setAt(move && rows[move.r] ? { ...move, draft: rows[move.r][move.c] ?? "" } : undefined);
  };
  const cell = (value: string, r: number, c: number) =>
    at?.r === r && at.c === c ? (
      <input
        autoFocus
        aria-label={`Row ${r + 1}, column ${c + 1}`}
        className="selectable -mx-3 -my-1.5 block h-[30px] w-[calc(100%+24px)] min-w-[80px] bg-background px-3 outline-none ring-2 ring-inset ring-ring"
        value={at.draft}
        onChange={(e) => setAt({ ...at, draft: e.target.value })}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); setAt(undefined); }
          if (e.key === "Enter") { e.preventDefault(); commit(r + 1 < rows.length ? { r: r + 1, c } : undefined); }
          if (e.key === "Tab") {
            e.preventDefault();
            const next = e.shiftKey ? (c > 0 ? { r, c: c - 1 } : undefined) : c + 1 < width ? { r, c: c + 1 } : r + 1 < rows.length ? { r: r + 1, c: 0 } : undefined;
            commit(next);
          }
        }}
      />
    ) : value;
  const open = (r: number, c: number) => { if (can) setAt({ r, c, draft: rows[r]?.[c] ?? "" }); };

  return (
    <div className="sheet selectable">
      {problem && <p role="alert" data-ui className="m-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{problem}</p>}
      {!whole && <p data-ui className="m-3 text-sm text-muted-foreground">Showing the first {MAX_ROWS} rows. Switch to Code to edit a sheet this long.</p>}
      <table>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              <th scope="row">
                {can && rows.length > 1 ? (
                  <button type="button" className="sheet-del" aria-label={`Delete row ${i + 1}`} title="Delete this row" onClick={() => save(rows.filter((_, j) => j !== i))}>
                    <span aria-hidden="true">{i + 1}</span>
                  </button>
                ) : i + 1}
              </th>
              {Array.from({ length: width }, (_, j) => {
                const value = r[j] ?? "";
                return i === 0
                  ? <th key={j} scope="col" onClick={() => open(i, j)}>{cell(value, i, j)}</th>
                  : <td key={j} onClick={() => open(i, j)}>{cell(value, i, j)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {can && (
        <div className="flex gap-2 p-3" data-ui>
          <button type="button" className="h-8 rounded-full border border-dashed px-3 text-[13px] text-muted-foreground hover:text-foreground" onClick={() => save([...rows, Array.from({ length: Math.max(width, 1) }, () => "")])}>Add a row</button>
          <button type="button" className="h-8 rounded-full border border-dashed px-3 text-[13px] text-muted-foreground hover:text-foreground" onClick={() => save(rows.length ? rows.map((r) => [...r, ...Array.from({ length: width - r.length + 1 }, () => "")]) : [[""]])}>Add a column</button>
        </div>
      )}
    </div>
  );
}
