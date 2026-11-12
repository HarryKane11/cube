import { describe, expect, it } from "vitest";
import { editNotebook, parseNotebook } from "./notebook";

const nb = (cells: unknown[], metadata: unknown = {}) => JSON.stringify({ nbformat: 4, metadata, cells });

describe("parseNotebook", () => {
  it("is null for text that is not a notebook", () => {
    expect(parseNotebook("not json")).toBeNull();
    expect(parseNotebook('{"a":1}')).toBeNull();
    expect(parseNotebook("null")).toBeNull();
  });

  it("reads markdown and code cells, with source as a list of lines or one string", () => {
    const got = parseNotebook(nb([
      { cell_type: "markdown", source: ["# Title\n", "text"] },
      { cell_type: "code", source: "print(1)", execution_count: 3, outputs: [] },
    ], { language_info: { name: "julia" } }));
    expect(got?.language).toBe("julia");
    expect(got?.cells).toEqual([
      { kind: "markdown", source: "# Title\ntext", count: undefined, outputs: [] },
      { kind: "code", source: "print(1)", count: 3, outputs: [] },
    ]);
  });

  it("defaults the language to python", () => {
    expect(parseNotebook(nb([]))?.language).toBe("python");
  });

  it("reads printed text and marks what went to stderr", () => {
    const got = parseNotebook(nb([{ cell_type: "code", source: "", outputs: [
      { output_type: "stream", name: "stdout", text: ["a\n", "b\n"] },
      { output_type: "stream", name: "stderr", text: "warn" },
    ] }]));
    expect(got?.cells[0].outputs).toEqual([
      { type: "text", text: "a\nb\n", stream: "stdout" },
      { type: "text", text: "warn", stream: "stderr" },
    ]);
  });

  it("picks the richest form of a result: picture, then table, then text", () => {
    const got = parseNotebook(nb([{ cell_type: "code", source: "", outputs: [
      { output_type: "display_data", data: { "image/png": "iVBOR\nw0KG", "text/plain": "<Figure>" } },
      { output_type: "execute_result", data: { "text/html": "<table><tr><td>1</td></tr><tr><td>2</td></tr></table>", "text/plain": "1\n2" } },
      { output_type: "execute_result", data: { "text/plain": ["42"] } },
    ] }]));
    expect(got?.cells[0].outputs).toEqual([
      { type: "image", src: "data:image/png;base64,iVBORw0KG" },
      { type: "html", html: "<table><tr><td>1</td></tr><tr><td>2</td></tr></table>", rows: 2 },
      { type: "text", text: "42" },
    ]);
  });

  it("reads an error without the terminal colour codes", () => {
    const got = parseNotebook(nb([{ cell_type: "code", source: "", outputs: [
      { output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: ["\u001b[0;31mZeroDivisionError\u001b[0m: division by zero"] },
    ] }]));
    expect(got?.cells[0].outputs).toEqual([{ type: "error", name: "ZeroDivisionError", text: "ZeroDivisionError: division by zero" }]);
  });

  it("reads version 3 notebooks, whose cells sit in worksheets", () => {
    const got = parseNotebook(JSON.stringify({ nbformat: 3, worksheets: [{ cells: [
      { cell_type: "heading", level: 2, source: "Part" },
      { cell_type: "code", input: ["x = 1"], prompt_number: 1, outputs: [{ output_type: "pyout", text: "1" }] },
    ] }] }));
    expect(got?.cells).toEqual([
      { kind: "markdown", source: "## Part", count: undefined, outputs: [] },
      { kind: "code", source: "x = 1", count: 1, outputs: [{ type: "text", text: "1" }] },
    ]);
  });
});

describe("editNotebook", () => {
  const file = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3" } }, cells: [
    { cell_type: "markdown", id: "a1", metadata: {}, source: ["# Title\n", "text"] },
    { cell_type: "code", id: "b2", metadata: { tags: ["keep"] }, execution_count: 2, source: "x = 1", outputs: [{ output_type: "stream", name: "stdout", text: "1" }] },
  ] });

  it("changes a cell's text in the form the file used, and keeps everything else", () => {
    const next = JSON.parse(editNotebook(file, { op: "source", index: 0, source: "# New\nline two\n" })!);
    expect(next.cells[0].source).toEqual(["# New\n", "line two\n"]);
    expect(next.cells[1]).toEqual(JSON.parse(file).cells[1]);
    expect(next.metadata).toEqual({ kernelspec: { name: "python3" } });
    const code = JSON.parse(editNotebook(file, { op: "source", index: 1, source: "x = 2" })!);
    expect(code.cells[1].source).toBe("x = 2");
    expect(code.cells[1].outputs).toHaveLength(1);
    expect(code.cells[1].metadata).toEqual({ tags: ["keep"] });
  });

  it("adds a cell after another, with an id when the notebook uses ids", () => {
    const next = JSON.parse(editNotebook(file, { op: "add", after: 0, kind: "code" })!);
    expect(next.cells).toHaveLength(3);
    expect(next.cells[1]).toMatchObject({ cell_type: "code", execution_count: null, outputs: [], source: [] });
    expect(typeof next.cells[1].id).toBe("string");
    expect(next.cells[2].id).toBe("b2");
  });

  it("deletes a cell", () => {
    const next = JSON.parse(editNotebook(file, { op: "delete", index: 0 })!);
    expect(next.cells.map((c: { id: string }) => c.id)).toEqual(["b2"]);
  });

  it("is null for what it cannot edit", () => {
    expect(editNotebook("nope", { op: "delete", index: 0 })).toBeNull();
    expect(editNotebook(JSON.stringify({ worksheets: [] }), { op: "delete", index: 0 })).toBeNull();
    expect(editNotebook(file, { op: "source", index: 9, source: "" })).toBeNull();
  });

  it("writes the file the way Jupyter does: one space of indent and a final line break", () => {
    const out = editNotebook(file, { op: "delete", index: 0 })!;
    expect(out.split("\n")[1]).toMatch(/^ "[a-z_]+": /);
    expect(out.endsWith("}\n")).toBe(true);
  });
});
