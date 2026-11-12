import { describe, expect, it } from "vitest";
import { MASK, maskSecrets } from "./secrets";

describe("maskSecrets", () => {
  it("hides keys by their well-known shapes", () => {
    for (const secret of [
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
      "sk-proj-abcdefghijklmnopqrstuvwx",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "xoxb-123456789012-abcdefghijkl",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    ]) {
      const out = maskSecrets(`before ${secret} after`);
      expect(out).toBe(`before ${MASK} after`);
    }
  });

  it("hides a private key block whole", () => {
    expect(maskSecrets("a\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----\nb")).toBe(`a\n${MASK}\nb`);
  });

  it("hides the value of something named like a credential, and keeps the name", () => {
    expect(maskSecrets("OPENAI_API_KEY=abcdef1234567890xyz")).toBe(`OPENAI_API_KEY=${MASK}`);
    expect(maskSecrets('"db_password": "correct-horse-battery"')).toBe(`"db_password": "${MASK}"`);
    expect(maskSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345")).toBe(`Authorization: Bearer ${MASK}`);
  });

  it("leaves ordinary text alone", () => {
    const text = "The token limit is 4000 and the password policy needs 12 characters. See task-1234 and commit 9f8e7d6c5b4a.";
    expect(maskSecrets(text)).toBe(text);
  });
});
