/**
 * The workspace's own emoji: small pictures with a name, put on messages as reactions next to
 * the ordinary ones. A person adds them one by one from a picture, or brings in the ones their
 * Slack workspace has. On a message such an emoji is written `:name:`, as in Slack.
 *
 * They are kept in one file in the workspace's knowledge folder (emoji.json: name → picture),
 * never as a file each: this Mac's ransomware guard stops an app that makes hundreds of files
 * at once, and a Slack workspace can have that many emoji.
 */
import { invoke } from "@tauri-apps/api/core";
import { inTauri, knowledgeList, readText, writeText } from "@/agents/runner";
import { useCube } from "@/state/store";

/** A name as Slack allows them: letters of any script, digits, and a few marks. No spaces, no colons. */
export const EMOJI_NAME = /^[\p{L}\p{N}_+'-]{1,40}$/u;
/** An emoji of the workspace as it is written on a message. */
export const EMOJI_CODE = /^:([\p{L}\p{N}_+'-]{1,40}):$/u;

export const codeOf = (name: string): string => `:${name}:`;
export const nameOfCode = (code: string): string | undefined => EMOJI_CODE.exec(code)?.[1];

/** Where a picture written into a message's Markdown points when it is one of the workspace's emoji. The name is in its alt text. */
export const EMOJI_HREF = "#emoji";

/**
 * A message's text with the workspace's emoji written as pictures for the Markdown renderer:
 * `:party_parrot:` becomes a picture whose alt text is the code. Only names that exist are
 * touched, and nothing inside code, where a colon is a colon.
 */
export function inlineEmoji(text: string, has: (name: string) => boolean): string {
  if (!text.includes(":")) return text;
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/:([\p{L}\p{N}_+'-]{1,40}):/gu, (code, name: string) => (has(name) ? `![${code}](${EMOJI_HREF})` : code))))
    .join("");
}

/** What a person typed as a name, made into one: lower case, spaces as underscores, nothing a name may not hold. */
export function cleanName(raw: string): string {
  return raw.trim().toLowerCase().replace(/^:|:$/g, "").replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_+'-]/gu, "").slice(0, 40);
}

/** The ordinary emoji offered for a reaction, in the order people reach for them. */
export const COMMON = ["👍", "✅", "👀", "❤️", "🎉", "🙏", "😂", "🔥", "🙌", "👏", "💯", "🤔", "😮", "😢", "🚀", "✨", "💡", "📌", "⚠️", "❌", "🫡", "😅", "🥳", "🤝", "💪", "👌", "🙆", "🙇", "😍", "🤯", "📝", "🔍", "🛠️", "🎨", "📈", "🧪", "⏳", "☕", "🌱", "🐛"];

/** How many emoji a workspace may hold, and how large each picture may be once stored, in characters. */
const MOST = 1500;
const LARGEST = 80_000;
/** The most of the file that is read, in bytes: room for every emoji a workspace may hold at its largest. */
const FILE_LIMIT = 40_000_000;
/** The side of a stored picture, in pixels: twice what is shown, for sharp screens. */
const SIDE = 64;

/** What a file of emoji holds, with anything that is not a named small picture left out. */
export function readEmojiFile(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [name, picture] of Object.entries(parsed as Record<string, unknown>)) {
    if (Object.keys(out).length >= MOST) break;
    if (EMOJI_NAME.test(name) && typeof picture === "string" && /^data:image\/(png|gif|jpeg|webp);base64,/.test(picture) && picture.length <= LARGEST) out[name] = picture;
  }
  return out;
}

/** A picture drawn into a small square, as the picture of an emoji. Whatever it was, it comes out a PNG. */
function shrink(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIDE;
      const g = canvas.getContext("2d");
      if (!g || !img.width || !img.height) return reject(new Error("That picture could not be read."));
      const k = Math.min(SIDE / img.width, SIDE / img.height);
      const [w, h] = [img.width * k, img.height * k];
      g.drawImage(img, (SIDE - w) / 2, (SIDE - h) / 2, w, h);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("That picture could not be read."));
    img.src = source;
  });
}

const asDataUrl = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("That file could not be read."));
    reader.readAsDataURL(file);
  });

async function fileOf(): Promise<string | undefined> {
  if (!inTauri) return undefined;
  const dir = useCube.getState().knowledgeDir || (await knowledgeList()).dir;
  return dir ? `${dir}/emoji.json` : undefined;
}

/** Reads the workspace's emoji into the app. Called once when it opens. */
export async function loadEmojis(): Promise<void> {
  const path = await fileOf().catch(() => undefined);
  if (!path) return;
  // The file holds every picture, so it is far larger than a note: it is read whole, up to a size no workspace reaches.
  const text = await readText(path, FILE_LIMIT).catch(() => "");
  if (text) useCube.getState().setEmojis(readEmojiFile(text));
}

async function keep(emojis: Record<string, string>): Promise<void> {
  useCube.getState().setEmojis(emojis);
  const path = await fileOf();
  if (path) await writeText(path, JSON.stringify(emojis));
}

/** Adds an emoji from a picture the person picked. Returns what is wrong, or null. */
export async function addEmoji(rawName: string, file: Blob): Promise<string | null> {
  const name = cleanName(rawName);
  if (!EMOJI_NAME.test(name)) return "Give it a name of letters, digits, - or _, with no spaces.";
  const have = useCube.getState().emojis;
  if (have[name]) return "An emoji with that name is already here.";
  if (Object.keys(have).length >= MOST) return "This workspace holds as many emoji as it can.";
  try {
    await keep({ ...have, [name]: await shrink(await asDataUrl(file)) });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function removeEmoji(name: string): Promise<void> {
  const next = { ...useCube.getState().emojis };
  delete next[name];
  await keep(next);
}

/**
 * Brings in the emoji of the Slack workspace Cube is connected to. The ones already here are
 * left as they are. `onProgress` hears how far it is. Resolves with how many came in and how
 * many could not be fetched; rejects with words for the person when Slack refuses.
 */
export async function importSlackEmoji(onProgress: (done: number, total: number) => void, stop: { now: boolean }): Promise<{ added: number; failed: number }> {
  const listed = await invoke<[string, string][]>("slack_emoji");
  let emojis = { ...useCube.getState().emojis };
  const fresh = listed.filter(([name]) => EMOJI_NAME.test(name) && !emojis[name]).slice(0, Math.max(0, MOST - Object.keys(emojis).length));
  let added = 0;
  let failed = 0;
  for (let i = 0; i < fresh.length && !stop.now; i++) {
    const [name, url] = fresh[i];
    try {
      emojis = { ...emojis, [name]: await shrink(await invoke<string>("slack_emoji_image", { url })) };
      added += 1;
    } catch {
      failed += 1;
    }
    onProgress(i + 1, fresh.length);
    // Written now and then, in one file, so a long import that is stopped keeps what it has.
    if (added && added % 40 === 0) await keep(emojis);
  }
  if (added) await keep(emojis);
  return { added, failed };
}
