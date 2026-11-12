import { useState } from "react";
import { AGENTS } from "@/agents/types";
import { EnginesFound, RoleEngines } from "@/components/TeamSetup";
import { Input } from "@/components/ui/input";
import { Cube } from "@/cube/Cube";
import { useCube } from "@/state/store";

const primary = "h-10 rounded-full bg-primary px-5 font-semibold text-primary-foreground disabled:opacity-35";
const quiet = "h-10 rounded-full bg-secondary px-5 font-semibold";

/**
 * First run. There is no account and no server: the person picks a name, sees which
 * agent programs are installed, and decides which one powers each role.
 */
export function Onboarding() {
  const [step, setStep] = useState(0);
  const name = useCube((s) => s.name);
  const setName = useCube((s) => s.setName);
  const finish = useCube((s) => s.finishOnboarding);
  const anyEngine = useCube((s) => Object.values(s.available).some(Boolean));

  return (
    <div className="flex h-full items-center justify-center overflow-auto p-6" data-tauri-drag-region>
      <div className="w-full max-w-[640px] rounded-[28px] border bg-background p-8">
        <div className="mb-6 flex gap-1.5" aria-hidden="true">
          {[0, 1, 2].map((i) => <span key={i} className={`h-1 flex-1 rounded-full ${i <= step ? "bg-primary" : "bg-secondary"}`} />)}
        </div>

        {step === 0 && (
          <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); if (name.trim()) setStep(1); }}>
            <div className="flex items-end gap-1">
              {AGENTS.map((a, i) => <Cube key={a.id} color={a.color} status={i === 2 ? "needs" : "idle"} size={i === 2 ? 92 : 64} />)}
            </div>
            <div>
              <h1 className="font-heading text-[32px] font-bold leading-tight tracking-[-0.03em]">Welcome to Cube</h1>
              <p className="mt-1.5 max-w-[46ch] text-base text-muted-foreground">
                A workspace where you and a small team of AI agents work side by side. No account is needed. Everything stays on this computer.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="your-name" className="text-[13px] font-semibold">What should the team call you?</label>
              <Input id="your-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoFocus className="selectable h-10 text-base" />
            </div>
            <div><button type="submit" className={primary} disabled={!name.trim()}>Continue</button></div>
          </form>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-5">
            <div>
              <h1 className="font-heading text-[26px] font-bold leading-tight tracking-[-0.03em]">Meet your team</h1>
              <p className="mt-1.5 text-muted-foreground">
                Five cubes, five jobs. Each one runs on an agent program already installed here. Cube picked the best match; change any of them now or later in Settings.
              </p>
            </div>
            <EnginesFound />
            <RoleEngines />
            <div className="flex gap-2">
              <button type="button" className={quiet} onClick={() => setStep(0)}>Back</button>
              <button type="button" className={primary} disabled={!anyEngine} onClick={() => setStep(2)}>Continue</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-5">
            <Cube color="#FF7A1A" status="done" size={96} />
            <div>
              <h1 className="font-heading text-[26px] font-bold leading-tight tracking-[-0.03em]">You are set, {name.trim()}</h1>
              <p className="mt-1.5 text-muted-foreground">Three things worth knowing before you start.</p>
            </div>
            <ol className="flex flex-col gap-3 text-base">
              <li><b>Just say what you need.</b> In a channel, Cube hands your request to the cube whose job it is.</li>
              <li><b>Type @ to choose.</b> Name a cube to give it the work yourself. Cubes can hand work to each other the same way.</li>
              <li><b>Watch the Stage.</b> Whatever a cube makes, a doc, a page, a chart, opens beside the conversation.</li>
            </ol>
            <div className="flex gap-2">
              <button type="button" className={quiet} onClick={() => setStep(1)}>Back</button>
              <button type="button" className={primary} onClick={finish}>Open Cube</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
