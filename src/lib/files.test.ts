import { describe, expect, it } from "vitest";
import { csvSep, extOf, hasSystemIcon, kindOf, parseCsv, toCsv } from "./files";

describe("kindOf", () => {
  it("knows office documents, notebooks and Korean word processor files", () => {
    expect(kindOf("a/report.DOCX")).toBe("word");
    expect(kindOf("plan.hwp")).toBe("word");
    expect(kindOf("book.xlsx")).toBe("sheet");
    expect(kindOf("deck.pptx")).toBe("slides");
    expect(kindOf("analysis.ipynb")).toBe("notebook");
    expect(kindOf("Makefile")).toBe("other");
  });

  it("draws only office kinds with the system's icon", () => {
    expect(hasSystemIcon("word")).toBe(true);
    expect(hasSystemIcon("md")).toBe(false);
    expect(extOf("a/b/Report.Docx")).toBe("docx");
    expect(extOf("Makefile")).toBe("");
  });
});

describe("toCsv", () => {
  it("writes rows back so that reading them gives the same cells", () => {
    const rows = [["name", "note"], ["Kim, J", 'said "hi"'], ["multi", "line\nbreak"], ["plain", ""]];
    const text = toCsv(rows);
    expect(text).toBe('name,note\n"Kim, J","said ""hi"""\nmulti,"line\nbreak"\nplain,\n');
    expect(parseCsv(text)).toEqual(rows);
  });

  it("keeps tabs as the separator for tab-separated files", () => {
    const text = "a\tb\n1\t2\n";
    expect(csvSep(text)).toBe("\t");
    expect(toCsv(parseCsv(text), csvSep(text))).toBe(text);
  });
});
