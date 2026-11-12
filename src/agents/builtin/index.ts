import { createFile, keyGet, keyList, listFiles, readText, runCommand, searchText, writeText } from "../runner";
import type { Ev, RunOpts } from "../types";
import { explain, makeChat, type Chat } from "./chat";
import { parseModel } from "./providers";
import { runTool, type ToolIO } from "./tools";

/** Conversations the built-in agent is in, by session id. They live as long as the app is open. */
const chats = new Map<string, Chat>();

/** True when a session id still has its history. After a restart it does not, and the agent starts over. */
export const hasBuiltinSession = (id: string | undefined) => Boolean(id && chats.has(id));

const io: ToolIO = {
  list: async (dir) => (await listFiles(dir)).map((f) => f.rel).sort(),
  read: (path) => readText(path, 400_000),
  write: async (dir, rel, content) => {
    // Makes the file and its folders when they are not there yet; an existing file is fine.
    await createFile(dir, rel).catch(() => undefined);
    await writeText(`${dir}/${rel}`, content);
  },
  run: (dir, command) => runCommand(dir, command),
  search: (dir, query) => searchText(dir, query),
};

const SYSTEM = "You work inside one folder on the person's computer through the tools you are given. Use them to look before you answer and to do the work, not to describe what you would do. Paths are relative to that folder. When you are done, reply with a short account of what you did.";

interface Start {
  prompt: string;
  sessionId?: string;
  opts: RunOpts;
  dir: string;
  onEv(ev: Ev): void;
  onDone(): void;
}

/**
 * Runs the built-in agent for one request: a model reached with the person's own API key, working
 * in the conversation folder through a small set of tools. Returns how to stop it and how to
 * answer when it asks for an OK.
 */
export function startBuiltin({ prompt, sessionId, opts, dir, onEv, onDone }: Start): { stop(): void; answer(id: string, allow: boolean): void } {
  const abort = new AbortController();
  const waiting = new Map<string, (allow: boolean) => void>();
  let asked = 0;

  const run = async () => {
    const found = parseModel(opts.model, await keyList());
    if ("error" in found) return onEv({ t: "error", message: found.error });
    const id = sessionId && chats.has(sessionId) ? sessionId : crypto.randomUUID();
    let chat = chats.get(id);
    if (!chat) {
      chat = makeChat({ ...found, key: await keyGet(found.provider), system: SYSTEM, effort: opts.effort });
      chats.set(id, chat);
    }
    onEv({ t: "session", id });
    chat.say(prompt);
    const ctx = {
      dir,
      trust: opts.trust ?? "edits",
      io,
      onEv,
      ask: (tool: string, input: unknown) =>
        new Promise<boolean>((resolve) => {
          const askId = `ask-${++asked}`;
          waiting.set(askId, resolve);
          onEv({ t: "ask", id: askId, tool, input });
        }),
    };
    const used = { in: 0, out: 0 };
    let spoke = false;
    for (let step = 0; step < 80 && !abort.signal.aborted; step++) {
      const turn = await chat.turn((delta) => {
        if (!delta) return;
        onEv({ t: "delta", text: delta });
        spoke = true;
      }, abort.signal);
      used.in += turn.usage.in;
      used.out += turn.usage.out;
      if (turn.stop === "refusal") { onEv({ t: "error", message: "The model declined this request." }); break; }
      if (turn.stop === "max") { onEv({ t: "error", message: "The reply was cut off at the model's output limit. Ask for the work in smaller pieces." }); break; }
      if (!turn.calls.length) break;
      if (spoke) onEv({ t: "delta", text: "\n\n" });
      const results = [];
      for (const call of turn.calls) {
        results.push({ id: call.id, ...(await runTool(ctx, call.name, call.input)) });
        if (abort.signal.aborted) return;
      }
      chat.results(results);
    }
    onEv({ t: "usage", in: used.in || undefined, out: used.out || undefined });
  };

  run()
    .catch((e) => { if (!abort.signal.aborted) onEv({ t: "error", message: explain(e) }); })
    .finally(onDone);

  return {
    stop() {
      abort.abort();
      // Nobody will answer now: let the tools waiting on an OK finish as refused.
      for (const resolve of waiting.values()) resolve(false);
      waiting.clear();
    },
    answer(id, allow) {
      waiting.get(id)?.(allow);
      waiting.delete(id);
    },
  };
}
