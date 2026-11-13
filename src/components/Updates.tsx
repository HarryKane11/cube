import { useState } from "react";
import { useCube } from "@/state/store";
import { busyCubes, checkForUpdate, installUpdate, useUpdate } from "@/update";

const pill = "h-8 flex-none rounded-full bg-secondary px-3 text-[13px] font-semibold disabled:opacity-35";
const primary = "h-8 flex-none rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-35";

/**
 * Which version this is, whether there is a newer one, and the button that installs it.
 * Installing restarts Cube, so when cubes are working the person is told first what stops.
 */
export function Updates() {
  const u = useUpdate();
  const busy = useCube((s) => busyCubes(s.live));
  const [asking, setAsking] = useState(false);

  if (!u.updates) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {u.current
          ? "This copy of Cube was built from source, so it does not update itself. Pull the code and build again to update it."
          : "Cube updates itself in the desktop app."}
      </p>
    );
  }

  const install = () => {
    setAsking(false);
    void installUpdate();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-1">
        <div className="min-w-[200px] flex-1">
          <div className="font-medium">Cube</div>
          <div className="text-[13px] text-muted-foreground">{`Version ${u.current}`}</div>
        </div>
        {u.phase === "found" && !asking && <button type="button" className={primary} onClick={() => (busy ? setAsking(true) : install())}>Update and restart</button>}
        {u.phase !== "found" && u.phase !== "installing" && (
          <button type="button" className={pill} disabled={u.phase === "checking"} onClick={() => void checkForUpdate()}>
            {u.phase === "checking" ? "Checking for updates…" : "Check for updates"}
          </button>
        )}
      </div>

      {u.phase === "current" && <p className="text-[13px] font-semibold text-primary" role="status">Cube is up to date.</p>}

      {u.phase === "found" && (
        <div className="flex flex-col gap-1.5 rounded-xl bg-secondary/60 p-3 text-[13px]" role="status">
          <p className="font-semibold">{`Cube ${u.version} is ready to install.`}</p>
          {u.notes && <p className="selectable whitespace-pre-wrap text-muted-foreground" data-notranslate>{u.notes}</p>}
          <p className="text-muted-foreground">Cube restarts to finish. After an update, macOS asks once more for each secret Cube keeps in the Keychain: choose Always Allow.</p>
        </div>
      )}

      {u.phase === "found" && asking && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]" role="alert">
          <span className="min-w-[200px] flex-1">{busy === 1 ? "1 cube is working. Restarting stops it." : `${busy} cubes are working. Restarting stops them.`}</span>
          <button type="button" className={primary} onClick={install}>Restart anyway</button>
          <button type="button" className={pill} onClick={() => setAsking(false)}>Later</button>
        </div>
      )}

      {u.phase === "installing" && (
        <div className="flex flex-col gap-1.5 text-[13px]" role="status">
          <p className="font-medium">
            {u.progress >= 1 ? "Installing. Cube restarts when it is done." : u.progress >= 0 ? `Downloading… ${Math.round(u.progress * 100)}%` : "Downloading…"}
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round(Math.max(0, u.progress) * 100)}%` }} />
          </div>
        </div>
      )}

      {u.phase === "failed" && <p className="text-[13px] text-destructive" role="alert">{u.error}</p>}
    </div>
  );
}
