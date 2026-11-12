import { useEffect, useState } from "react";
import { cardPin, fetchCard, markApproved, type RemoteAgent, type RemoteCard } from "@/agents/remote";
import { inTauri, remoteSecretDelete, remoteSecretHas, remoteSecretSet } from "@/agents/runner";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const pill = "h-8 rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-35";
const primary = "h-8 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35";

/** What a card says, before the person decides to trust it. */
function CardFacts({ card, cardUrl }: { card: RemoteCard; cardUrl: string }) {
  const usable = card.schemes.filter((s) => s.kind !== "unsupported");
  return (
    <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
      <dt className="text-muted-foreground">Agent</dt>
      <dd className="selectable font-medium">{card.name}{card.provider && <span className="font-normal text-muted-foreground"> · {card.provider}</span>}</dd>
      {card.description && (<><dt className="text-muted-foreground">Says it does</dt><dd className="selectable">{card.description}</dd></>)}
      {card.skills.length > 0 && (<><dt className="text-muted-foreground">Skills</dt><dd className="selectable">{card.skills.map((s) => s.name).join(", ")}</dd></>)}
      <dt className="text-muted-foreground">Messages go to</dt>
      <dd className="selectable font-medium">{hostOf(card.endpoint)}{hostOf(card.endpoint) !== hostOf(cardUrl) && <span className="font-normal text-destructive"> (not the address the card came from)</span>}</dd>
      <dt className="text-muted-foreground">Sign-in</dt>
      <dd>
        {!card.needsAuth && !card.schemes.length ? "None: anyone can call this agent" : usable.length ? usable.map((s) => s.about).join(" · ") : card.schemes.map((s) => s.about).join(" · ")}
      </dd>
      <dt className="text-muted-foreground">Card</dt>
      <dd>{card.signed ? "Signed, but Cube does not check signatures yet. " : "Not signed. "}Cube remembers this card and stops if it later changes where messages go or how to sign in.</dd>
    </dl>
  );
}

/** One agent the person added: what it is, whether its credential is saved, and how to change that. */
function Added({ agent }: { agent: RemoteAgent }) {
  const removeRemote = useCube((s) => s.removeRemote);
  const putRemote = useCube((s) => s.putRemote);
  const [has, setHas] = useState<boolean>();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [changed, setChanged] = useState<RemoteCard>();
  const scheme = agent.card.schemes.find((s) => s.id === agent.scheme);
  useEffect(() => { void remoteSecretHas(agent.id).then(setHas).catch(() => setHas(false)); }, [agent.id]);

  const save = () => {
    setError("");
    remoteSecretSet(agent.id, agent.card.endpoint, secret).then(() => { setSecret(""); setHas(true); }).catch((e) => setError(String(e)));
  };
  const remove = () => {
    void remoteSecretDelete(agent.id).catch(() => undefined);
    removeRemote(agent.id);
  };
  const review = () => {
    setError("");
    void fetchCard(agent.cardUrl).then((got) => {
      if ("error" in got) return setError(got.error);
      if (cardPin(got.card) === agent.pin) {
        markApproved(agent.id);
        putRemote({ ...agent, card: got.card });
        return setError("Nothing that matters has changed on this agent's card.");
      }
      setChanged(got.card);
    });
  };
  const approve = () => {
    if (!changed) return;
    // A new address or sign-in means the saved credential no longer applies: it is entered again.
    void remoteSecretDelete(agent.id).catch(() => undefined);
    const usable = changed.schemes.filter((s) => s.kind !== "unsupported");
    putRemote({ ...agent, card: changed, pin: cardPin(changed), scheme: usable.find((s) => s.id === agent.scheme)?.id ?? usable[0]?.id ?? "" });
    markApproved(agent.id);
    setHas(false);
    setChanged(undefined);
  };

  return (
    <div className="flex flex-col gap-2 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[160px] flex-1">
          <div className="font-medium">{agent.card.name}</div>
          <div className="text-[13px] text-muted-foreground">
            {hostOf(agent.card.endpoint)} · {!scheme ? "no sign-in" : has === undefined ? "…" : has ? <span className="font-semibold text-primary">credential saved</span> : <span className="font-semibold text-destructive">credential missing</span>}
          </div>
        </div>
        {scheme && (
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <Input type="password" autoComplete="off" aria-label={`Credential for ${agent.card.name}`} placeholder={has ? "Paste a new one to replace it" : scheme.about} value={secret} onChange={(e) => setSecret(e.target.value)} className="selectable h-9 w-[240px]" />
            <button type="submit" className={primary} disabled={!secret.trim()}>Save</button>
          </form>
        )}
        <button type="button" className={pill} onClick={review}>Check card</button>
        <button type="button" className={pill} onClick={remove}>Remove</button>
      </div>
      {changed && (
        <div className="rounded-xl border border-destructive/40 p-3">
          <p className="mb-2 text-[13px] font-semibold text-destructive">This agent's card changed. Read it again before you approve it.</p>
          <CardFacts card={changed} cardUrl={agent.cardUrl} />
          <div className="mt-3 flex gap-2">
            <button type="button" className={primary} onClick={approve}>Approve the new card</button>
            <button type="button" className={pill} onClick={() => setChanged(undefined)}>Not now</button>
          </div>
        </div>
      )}
      {error && <p className="text-[13px] text-muted-foreground" role="status">{error}</p>}
    </div>
  );
}

/**
 * Agents that run somewhere else. The person gives an address, reads what the agent's card says,
 * and adds it; a role can then run on it. Cube speaks A2A to it.
 */
export function RemoteAgents() {
  const remotes = useCube((s) => s.remotes);
  const putRemote = useCube((s) => s.putRemote);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [found, setFound] = useState<{ cardUrl: string; card: RemoteCard }>();
  const [schemeId, setSchemeId] = useState("");
  const [secret, setSecret] = useState("");

  if (!inTauri) return <p className="text-[13px] text-muted-foreground">Remote agents are reached from the Cube desktop app.</p>;

  const usable = found?.card.schemes.filter((s) => s.kind !== "unsupported") ?? [];
  const blocked = Boolean(found?.card.needsAuth && !usable.length);
  const look = () => {
    setError("");
    setFound(undefined);
    setBusy(true);
    void fetchCard(url)
      .then((got) => {
        if ("error" in got) return setError(got.error);
        setFound(got);
        setSchemeId(got.card.needsAuth ? (got.card.schemes.find((s) => s.kind !== "unsupported")?.id ?? "") : "");
        setSecret("");
      })
      .finally(() => setBusy(false));
  };
  const add = async () => {
    if (!found) return;
    setError("");
    const id = crypto.randomUUID();
    try {
      if (schemeId) await remoteSecretSet(id, found.card.endpoint, secret);
      putRemote({ id, cardUrl: found.cardUrl, card: found.card, scheme: schemeId, pin: cardPin(found.card), addedAt: Date.now() });
      markApproved(id);
      setFound(undefined);
      setUrl("");
      setSecret("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex flex-col">
      <p className="mb-1 text-[13px] text-muted-foreground">
        An agent that runs on someone else's servers can take a role on your team. Cube reaches it with the A2A protocol. It receives the messages of conversations it takes part in, and nothing from this computer: no files, no folders, no keys.
      </p>
      {remotes.map((r) => <Added key={r.id} agent={r} />)}
      <form className="flex flex-wrap items-center gap-2 py-3" onSubmit={(e) => { e.preventDefault(); look(); }}>
        <Input autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Address of a remote agent" placeholder="https://agent.example.com" value={url} onChange={(e) => setUrl(e.target.value)} className="selectable h-9 min-w-[260px] flex-1" />
        <button type="submit" className={pill} disabled={!url.trim() || busy}>{busy ? "Reading its card…" : "Read its card"}</button>
      </form>
      {found && (
        <div className="rounded-xl border p-3">
          <CardFacts card={found.card} cardUrl={found.cardUrl} />
          {usable.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {usable.length > 1 || !found.card.needsAuth ? (
                <select aria-label="How to sign in" value={schemeId} onChange={(e) => setSchemeId(e.target.value)} className="selectable h-9 rounded-xl border bg-transparent px-2.5 text-[13px]">
                  {!found.card.needsAuth && <option value="">No sign-in</option>}
                  {usable.map((s) => <option key={s.id} value={s.id}>{s.about}</option>)}
                </select>
              ) : null}
              {schemeId && <Input type="password" autoComplete="off" aria-label="Credential" placeholder="Paste the token or key the agent's provider gave you" value={secret} onChange={(e) => setSecret(e.target.value)} className="selectable h-9 min-w-[260px] flex-1" />}
            </div>
          )}
          {blocked && <p className="mt-3 text-[13px] text-destructive">This agent needs a kind of sign-in Cube cannot do yet, so it cannot be added.</p>}
          <div className={cn("mt-3 flex gap-2", blocked && "hidden")}>
            <button type="button" className={primary} disabled={Boolean(schemeId) && !secret.trim()} onClick={() => void add()}>Add this agent</button>
            <button type="button" className={pill} onClick={() => setFound(undefined)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <p className="pt-1 text-[13px] text-destructive" role="alert">{error}</p>}
    </div>
  );
}
