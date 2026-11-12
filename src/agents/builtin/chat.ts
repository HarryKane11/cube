import Anthropic from "@anthropic-ai/sdk";
import { PROVIDERS, type Provider } from "./providers";
import { TOOLS } from "./tools";

export interface Call {
  id: string;
  name: string;
  input: unknown;
}

/** One reply from the model: what it said, the tools it wants run, and why it stopped. */
export interface Turn {
  text: string;
  calls: Call[];
  /** "max": cut off at the output limit. "refusal": the model declined. */
  stop: "end" | "tools" | "max" | "refusal";
  usage: { in: number; out: number };
}

/** A conversation with one model. It keeps its own history, in the shape its service wants. */
export interface Chat {
  say(text: string): void;
  turn(onText: (delta: string) => void, signal: AbortSignal): Promise<Turn>;
  results(list: { id: string; content: string; isError?: boolean }[]): void;
}

export interface ChatOpts {
  provider: Provider;
  model: string;
  key: string;
  system: string;
  effort?: string;
}

/** Models whose refusals the API can hand to another model inside the same request. */
const HAS_FALLBACK = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/;

/** The Claude API, through Anthropic's SDK, with text streamed as it is written. */
function claudeChat(o: ChatOpts): Chat {
  // The key is the person's own, read from the Keychain for this run and held only in memory.
  const client = new Anthropic({ apiKey: o.key, dangerouslyAllowBrowser: true });
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const tools: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    // Large inputs (a whole file) arrive as they are written. The loop checks every input itself.
    eager_input_streaming: true,
    input_schema: { type: "object", properties: t.properties, required: t.required },
  }));
  let badJson = 0;
  return {
    say: (text) => { messages.push({ role: "user", content: text }); },
    results: (list) => {
      messages.push({ role: "user", content: list.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.isError || undefined })) });
    },
    async turn(onText, signal) {
      for (;;) {
        const stream = client.beta.messages.stream(
          {
            model: o.model,
            max_tokens: 64000,
            system: o.system,
            tools,
            messages,
            ...(o.effort ? { output_config: { effort: o.effort as "low" | "medium" | "high" | "xhigh" } } : {}),
            // If the model declines on policy grounds, the API re-runs the request on a fallback model.
            ...(HAS_FALLBACK.test(o.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal },
        );
        stream.on("text", onText);
        let message: Anthropic.Beta.BetaMessage;
        try {
          message = await stream.finalMessage();
          badJson = 0;
        } catch (e) {
          // A tool input that was not JSON at all: ask again, a couple of times at most.
          if (e instanceof Anthropic.APIError || signal.aborted || badJson++ >= 2) throw e;
          continue;
        }
        const usage = { in: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0), out: message.usage.output_tokens };
        const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input }));
        // A refusal, or the output limit, can cut a tool call off mid-input: such a turn is never run or kept.
        if (message.stop_reason === "refusal") return { text, calls: [], stop: "refusal", usage };
        if (message.stop_reason === "max_tokens" && calls.length) return { text, calls: [], stop: "max", usage };
        // The whole content goes back as it came, thinking blocks included.
        messages.push({ role: "assistant", content: message.content });
        if (message.stop_reason === "pause_turn") continue;
        return { text, calls, stop: calls.length ? "tools" : message.stop_reason === "max_tokens" ? "max" : "end", usage };
      }
    },
  };
}

interface OpenAiCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** What a streamed OpenAI-style reply adds up to so far. */
export interface Building {
  text: string;
  calls: OpenAiCall[];
  finish?: string;
  usage: { in: number; out: number };
}

/** Folds one streamed chunk into the reply being built. Tool calls arrive in pieces, keyed by index. */
export function addChunk(b: Building, chunk: any): string {
  if (chunk?.usage) b.usage = { in: chunk.usage.prompt_tokens ?? 0, out: chunk.usage.completion_tokens ?? 0 };
  const choice = chunk?.choices?.[0];
  if (!choice) return "";
  if (choice.finish_reason) b.finish = choice.finish_reason;
  const delta = choice.delta ?? {};
  for (const part of delta.tool_calls ?? []) {
    const at = part.index ?? 0;
    const call = (b.calls[at] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
    if (part.id) call.id = part.id;
    if (part.function?.name) call.function.name += part.function.name;
    if (part.function?.arguments) call.function.arguments += part.function.arguments;
  }
  const said = typeof delta.content === "string" ? delta.content : "";
  b.text += said;
  return said;
}

/** OpenAI's chat completions, which OpenRouter speaks too. */
function openAiChat(o: ChatOpts): Chat {
  const messages: any[] = [{ role: "system", content: o.system }];
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: { type: "object", properties: t.properties, required: t.required } } }));
  return {
    say: (text) => { messages.push({ role: "user", content: text }); },
    results: (list) => { for (const r of list) messages.push({ role: "tool", tool_call_id: r.id, content: r.content }); },
    async turn(onText, signal) {
      const res = await fetch(`${PROVIDERS[o.provider].base}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.key}` },
        body: JSON.stringify({ model: o.model, messages, tools, stream: true, stream_options: { include_usage: true }, ...(o.effort && o.provider === "openai" ? { reasoning_effort: o.effort === "xhigh" ? "high" : o.effort } : {}) }),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        let said = body.slice(0, 300);
        try { said = JSON.parse(body).error?.message ?? said; } catch { /* not JSON: show it as it is */ }
        throw new Error(res.status === 401 ? `The ${PROVIDERS[o.provider].name} key was not accepted.` : `${PROVIDERS[o.provider].name} answered ${res.status}: ${said}`);
      }
      const built: Building = { text: "", calls: [], usage: { in: 0, out: 0 } };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!data || data === "[DONE]") continue;
          try {
            const said = addChunk(built, JSON.parse(data));
            if (said) onText(said);
          } catch {
            // A broken chunk is skipped; the reply is judged by what did arrive.
          }
        }
      }
      const calls = built.calls.filter((c) => c?.function.name);
      if (built.finish === "length" && calls.length) return { text: built.text, calls: [], stop: "max", usage: built.usage };
      if (built.finish === "content_filter") return { text: built.text, calls: [], stop: "refusal", usage: built.usage };
      messages.push({ role: "assistant", content: built.text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      const parsed = calls.map((c) => {
        let input: unknown = null;
        try { input = JSON.parse(c.function.arguments || "{}"); } catch { input = c.function.arguments; }
        return { id: c.id, name: c.function.name, input };
      });
      return { text: built.text, calls: parsed, stop: parsed.length ? "tools" : built.finish === "length" ? "max" : "end", usage: built.usage };
    },
  };
}

export function makeChat(o: ChatOpts): Chat {
  return o.provider === "anthropic" ? claudeChat(o) : openAiChat(o);
}

/** A failed request, in words for the person. */
export function explain(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The Claude API key was not accepted. Check it in Settings under Model keys.";
  if (e instanceof Anthropic.PermissionDeniedError) return "This key may not use that model.";
  if (e instanceof Anthropic.NotFoundError) return "The Claude API does not know that model name. Check the role's model on its profile.";
  if (e instanceof Anthropic.RateLimitError) return "The Claude API is rate limiting this key. Try again in a moment.";
  if (e instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API. Check the network connection.";
  if (e instanceof Anthropic.APIError) return `The Claude API answered ${e.status ?? "with an error"}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
