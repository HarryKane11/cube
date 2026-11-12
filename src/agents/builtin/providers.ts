/** The model services the built-in agent can talk to with the person's own API key. */
export type Provider = "anthropic" | "openai" | "openrouter";

export const PROVIDERS: Record<Provider, { name: string; hint: string; base?: string }> = {
  anthropic: { name: "Claude API", hint: "Starts with sk-ant-" },
  openai: { name: "OpenAI API", hint: "Starts with sk-", base: "https://api.openai.com/v1" },
  openrouter: { name: "OpenRouter", hint: "Starts with sk-or-", base: "https://openrouter.ai/api/v1" },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[];

/** The model used when a role on the Claude API names none. */
export const DEFAULT_CLAUDE = "claude-opus-5-5";

/**
 * Which service and model a role's model setting means. `anthropic/…`, `openai/…` and
 * `openrouter/…` say it outright; a bare `claude-…` is the Claude API, a bare `vendor/model`
 * is OpenRouter, anything else the OpenAI API. With nothing set, the Claude API's default
 * model is used when a key for it is saved.
 */
export function parseModel(setting: string | undefined, keys: string[]): { provider: Provider; model: string } | { error: string } {
  const raw = (setting ?? "").trim();
  if (!raw) {
    if (keys.includes("anthropic")) return { provider: "anthropic", model: DEFAULT_CLAUDE };
    const other = PROVIDER_IDS.find((p) => keys.includes(p));
    return { error: other ? `Pick a model for this role on its profile, for example ${other}/<model name>.` : "No API key is saved. Add one in Settings under Model keys." };
  }
  const lead = raw.slice(0, raw.indexOf("/"));
  const found = PROVIDER_IDS.includes(lead as Provider)
    ? { provider: lead as Provider, model: raw.slice(lead.length + 1) }
    : raw.startsWith("claude") ? { provider: "anthropic" as const, model: raw }
    : raw.includes("/") ? { provider: "openrouter" as const, model: raw }
    : { provider: "openai" as const, model: raw };
  if (!found.model) return { error: `Add a model name after ${found.provider}/.` };
  if (!keys.includes(found.provider)) return { error: `No ${PROVIDERS[found.provider].name} key is saved. Add one in Settings under Model keys.` };
  return found;
}
