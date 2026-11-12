import { ADAPTERS } from "./adapters";
import { startBuiltin } from "./builtin";
import { isEditTool } from "./permissions";
import { endInput, inTauri, startProcess, stopProcess, writeProcess } from "./runner";
import type { AgentKind, Ev, RunOpts } from "./types";

/** The engines that can do work without a conversation: the three programs and the built-in agent. */
export type HeadlessEngine = Exclude<AgentKind, "custom" | "remote">;
export const HEADLESS: HeadlessEngine[] = ["claude", "codex", "hermes", "api"];

export interface HeadlessResult {
  text: string;
  error?: string;
}

/**
 * Runs an agent once, outside any conversation, in a folder of its own, and gives back what it
 * said. It may change files in that folder; whatever else it asks leave for is refused, since
 * nobody is there to answer.
 */
export function runHeadless(o: { engine: HeadlessEngine; model?: string; effort?: string; cwd: string; prompt: string; onActivity?(label: string): void }): { done: Promise<HeadlessResult>; stop(): void } {
  const runId = `bg-${crypto.randomUUID()}`;
  let text = "";
  let error: string | undefined;
  let stop = () => {};
  let answer: (id: string, allow: boolean, input: unknown) => void = () => {};
  // Codex is boxed into the folder by its own sandbox and never asks. The others may edit files and ask for the rest.
  const opts: RunOpts = { model: o.model?.trim() || undefined, effort: o.effort || undefined, plain: false, trust: o.engine === "codex" ? "auto" : "edits" };

  const done = new Promise<HeadlessResult>((resolve) => {
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      resolve({ text: text.trim(), error });
    };
    const onEv = (ev: Ev) => {
      if (ev.t === "delta") text += ev.text;
      else if (ev.t === "activity") o.onActivity?.(ev.label);
      else if (ev.t === "error") error = ev.message;
      else if (ev.t === "ask") answer(ev.id, isEditTool(ev.tool), ev.input);
      // Some programs are spoken to as they go: what the adapter wants written, and when it is done writing.
      else if (ev.t === "send") void writeProcess(runId, ev.line).catch(() => undefined);
      else if (ev.t === "end") void endInput(runId);
    };
    if (!inTauri) {
      error = "Background work runs in the Cube desktop app.";
      return finish();
    }
    if (o.engine === "api") {
      const built = startBuiltin({ prompt: o.prompt, opts, dir: o.cwd, onEv, onDone: finish });
      stop = built.stop;
      answer = (id, allow) => built.answer(id, allow);
      return;
    }
    const adapter = ADAPTERS[o.engine];
    const started = adapter.command(o.prompt, undefined, opts);
    const parser = started.parser ?? adapter.parser();
    const reply = parser.reply ?? adapter.reply;
    let stopped = false;
    stop = () => {
      stopped = true;
      void stopProcess(runId);
    };
    answer = (id, allow, input) => {
      if (reply) void writeProcess(runId, reply(id, allow, input)).catch(() => undefined);
    };
    startProcess(runId, started.program, started.args, o.cwd, (stream, line, code) => {
      if (stream === "stdout") parser.stdout(line).forEach(onEv);
      else if (stream === "stderr") parser.stderr(line).forEach(onEv);
      else {
        if (stopped) error = "Stopped.";
        else parser.exit(code).forEach(onEv);
        finish();
      }
    }, started.input).catch((e) => {
      error = String(e);
      finish();
    });
  });
  return { done, stop: () => stop() };
}
