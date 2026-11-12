import { useState } from "react";
import { inTauri, slackClear, slackSet } from "@/agents/runner";
import { Input } from "@/components/ui/input";
import { checkScopes, connectSlack, SLACK_MANIFEST, SLACK_SCOPES } from "@/slack";
import { useCube } from "@/state/store";

const pill = "h-8 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-35";
const primary = "h-8 flex-none rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35";

/**
 * Slack: the person connects a Slack app of their own, and from then on anyone who mentions the
 * Cube bot there gets a cube's answer in that thread. The tokens go straight to the Keychain.
 */
export function SlackSettings() {
  const live = useCube((s) => s.slackLive);
  const setLive = useCube((s) => s.setSlackLive);
  const [bot, setBot] = useState("");
  const [app, setApp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  if (!inTauri) return <p className="text-[13px] text-muted-foreground">Slack is connected from the Cube desktop app, where its tokens can be kept in the Keychain.</p>;
  const save = () => {
    setBusy(true);
    setError("");
    slackSet(bot, app)
      .then(() => { setBot(""); setApp(""); return connectSlack(); })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  const disconnect = () => void slackClear().then(() => setLive({ configured: false, connected: false, team: "", problem: "" })).catch((e) => setError(String(e)));

  return (
    <div className="flex flex-col">
      <p className="mb-2 text-[13px] text-muted-foreground">
        Mention the Cube bot in a Slack channel, or write to it directly, and the team answers in that thread: the Router answers general questions itself and says who it brings in for the rest. In a thread the team is already in, people can go on without mentioning the bot. The request and the answer also show in the #slack channel here. Cubes called from Slack read and reply; before one changes a file or runs a command, it asks you in Cube. It works while Cube is open on this Mac.
      </p>
      {live.configured ? (
        <div className="flex flex-wrap items-center gap-2 py-2">
          <div className="min-w-[200px] flex-1">
            <div className="font-medium" data-notranslate>{live.team || "Slack"}</div>
            <div className="text-[13px]">{live.connected ? <span className="font-semibold text-primary">Connected</span> : <span className="font-semibold text-destructive">Not connected</span>}</div>
          </div>
          <button type="button" className={pill} onClick={disconnect}>Disconnect</button>
        </div>
      ) : null}
      {live.configured && live.missing?.length ? (
        <div className="mb-1 flex flex-col gap-2 rounded-xl bg-destructive/10 p-3 text-[13px]" role="alert">
          <p className="font-semibold">The Slack app is missing permissions, so this does not work yet:</p>
          <ul className="flex flex-col gap-0.5">
            {live.missing.map((scope) => (
              <li key={scope}><code className="rounded bg-background px-1 py-0.5 text-xs" data-notranslate>{scope}</code> <span>{SLACK_SCOPES[scope]}</span></li>
            ))}
          </ul>
          <p className="text-muted-foreground">At api.slack.com/apps, open the app, paste the current manifest under App Manifest, save, and reinstall the app when Slack asks. Then check again here.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={pill} onClick={() => void navigator.clipboard.writeText(SLACK_MANIFEST).then(() => setCopied(true))}>{copied ? "Copied" : "Copy the app manifest"}</button>
            <button type="button" className={pill} onClick={() => void checkScopes()}>Check again</button>
          </div>
        </div>
      ) : null}
      {live.configured ? null : (
        <>
          <ol className="mb-3 list-decimal pl-5 text-[13px] text-muted-foreground">
            <li>At api.slack.com/apps, create an app from a manifest and paste the manifest below.</li>
            <li>Install it to your workspace, and copy the Bot User OAuth Token (xoxb-…) from OAuth &amp; Permissions.</li>
            <li>Under Basic Information, make an App-Level Token with the connections:write scope (xapp-…).</li>
            <li>Paste both here, then invite the Cube bot to the channels where it should answer.</li>
          </ol>
          <div className="mb-3">
            <button type="button" className={pill} onClick={() => void navigator.clipboard.writeText(SLACK_MANIFEST).then(() => setCopied(true))}>{copied ? "Copied" : "Copy the app manifest"}</button>
          </div>
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <Input type="password" autoComplete="off" aria-label="Bot token" placeholder="Bot token (xoxb-…)" value={bot} onChange={(e) => setBot(e.target.value)} className="selectable h-9" />
            <div className="flex flex-wrap items-center gap-2">
              <Input type="password" autoComplete="off" aria-label="App-level token" placeholder="App-level token (xapp-…)" value={app} onChange={(e) => setApp(e.target.value)} className="selectable h-9 min-w-[240px] flex-1" />
              <button type="submit" className={primary} disabled={busy || !bot.trim() || !app.trim()}>{busy ? "Connecting…" : "Connect"}</button>
            </div>
          </form>
        </>
      )}
      {(error || live.problem) && <p className="pt-2 text-[13px] text-destructive" role="alert" data-notranslate>{error || live.problem}</p>}
    </div>
  );
}
