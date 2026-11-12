/**
 * What looks like a credential, replaced before text leaves this computer or is kept for the
 * long term: agents read files and command output that people would never paste into a team
 * channel or a memory note.
 */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(\b(?:authorization|bearer)\b["']?\s*[:=]?\s*["']?(?:bearer\s+)?)[A-Za-z0-9._~+/-]{24,}=*/gi,
  /(\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|passwd|password)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"'`,;]{12,}/gi,
];

export const MASK = "[hidden: looked like a credential]";

/** The text with anything that looks like a credential replaced by a marker. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, (_m, lead?: unknown) => `${typeof lead === "string" ? lead : ""}${MASK}`);
  return out;
}
