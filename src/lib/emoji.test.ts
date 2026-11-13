import { describe, expect, it } from "vitest";
import { splitNotes } from "@/agents/notes";
import { cleanName, codeOf, inlineEmoji, nameOfCode, readEmojiFile } from "./emoji";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("names of the workspace's emoji", () => {
  it("makes what a person typed into a name", () => {
    expect(cleanName(" Party Parrot.gif ")).toBe("party_parrotgif");
    expect(cleanName(":shipit:")).toBe("shipit");
    expect(cleanName("감사 합니다!")).toBe("감사_합니다");
  });

  it("writes one between colons, and reads it back", () => {
    expect(codeOf("party_parrot")).toBe(":party_parrot:");
    expect(nameOfCode(":감사:")).toBe("감사");
    expect(nameOfCode("🎉")).toBeUndefined();
    expect(nameOfCode(":two words:")).toBeUndefined();
  });
});

describe("the file of emoji", () => {
  it("keeps named small pictures and nothing else", () => {
    const file = JSON.stringify({ shipit: PNG, "bad name": PNG, script: "data:text/html;base64,PHNjcmlwdD4=", remote: "https://example.com/a.png", huge: `data:image/png;base64,${"A".repeat(90_000)}`, n: 3 });
    expect(readEmojiFile(file)).toEqual({ shipit: PNG });
  });

  it("is empty for a file that is not one", () => {
    expect(readEmojiFile("not json")).toEqual({});
    expect(readEmojiFile("[1,2]")).toEqual({});
  });
});

describe("the reaction a cube chooses", () => {
  it("is read from a line of its own and taken out of the reply", () => {
    const said = splitNotes("Done, the report is in report.md.\nREACT: 🎉");
    expect(said.react).toBe("🎉");
    expect(said.text).toBe("Done, the report is in report.md.");
    expect(splitNotes("All set.\nREACT: :party_parrot:").react).toBe(":party_parrot:");
  });

  it("is read at the end of the last sentence too, and never shows while it is being written", () => {
    const said = splitNotes("Hello, Kane! The cubes are here and ready. REACT: :cubimal_chick:");
    expect(said.react).toBe(":cubimal_chick:");
    expect(said.text).toBe("Hello, Kane! The cubes are here and ready.");
    expect(splitNotes("All good. REACT: 🎉").react).toBe("🎉");
    // Half written: nothing of it is shown, and nothing is taken for a reaction yet.
    const half = splitNotes("Hello, Kane! REACT: :cubimal_ch");
    expect(half.text).toBe("Hello, Kane!");
    expect(half.react).toBeUndefined();
    expect(splitNotes("Hello, Kane! REACT:").text).toBe("Hello, Kane!");
  });

  it("is one emoji, never words, and never a line of prose", () => {
    expect(splitNotes("Fine.\nREACT: great job").react).toBeUndefined();
    expect(splitNotes("Fine.\nREACT: 🎉🎉").react).toBeUndefined();
    const prose = splitNotes("React: a library for building interfaces.");
    expect(prose.react).toBeUndefined();
    expect(prose.text).toBe("React: a library for building interfaces.");
  });
});

describe("emoji written into a message", () => {
  const has = (name: string) => ["shipit", "커비", "fast_meow_party"].includes(name);

  it("become pictures where the name exists, and stay as written where it does not", () => {
    expect(inlineEmoji("Done :shipit: and :커비: but not :nope:", has)).toBe("Done ![:shipit:](#emoji) and ![:커비:](#emoji) but not :nope:");
    expect(inlineEmoji(":fast_meow_party::shipit:", has)).toBe("![:fast_meow_party:](#emoji)![:shipit:](#emoji)");
  });

  it("are left alone inside code", () => {
    expect(inlineEmoji("Use `:shipit:` like this:\n```\n:shipit:\n```\nthen :shipit:", has)).toBe("Use `:shipit:` like this:\n```\n:shipit:\n```\nthen ![:shipit:](#emoji)");
    expect(inlineEmoji("Open block ```\n:shipit:", has)).toBe("Open block ```\n:shipit:");
  });

  it("leaves text without a colon untouched, and times of day too", () => {
    expect(inlineEmoji("no emoji here", has)).toBe("no emoji here");
    expect(inlineEmoji("at 10:30:45 sharp", has)).toBe("at 10:30:45 sharp");
  });
});

describe("what Cube picks up about how it is spoken to", () => {
  it("is read from a line of its own and taken out of the reply", () => {
    const said = splitNotes("ㅋㅋ 알겠어!\nSELF: Kane speaks casually in Korean and likes short answers.\nREACT: 🫡");
    expect(said.selves).toEqual(["Kane speaks casually in Korean and likes short answers."]);
    expect(said.react).toBe("🫡");
    expect(said.text).toBe("ㅋㅋ 알겠어!");
  });

  it("is absent from a reply that has none", () => {
    expect(splitNotes("Sure.").selves).toBeUndefined();
  });
});
