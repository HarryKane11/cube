import { PROPS } from "@/cube/props/catalog";
import { cn } from "@/lib/utils";

/**
 * Picks what a cube holds, from the catalog. `value` is an id, "none" for nothing, or undefined
 * when nothing has been picked yet.
 */
export function PropPicker({ value, onChange }: { value: string | undefined; onChange: (id: string) => void }) {
  const cell = (on: boolean) => cn("flex size-9 flex-none items-center justify-center rounded-xl border", on ? "border-primary bg-primary/10" : "border-transparent bg-secondary hover:bg-accent");
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="What its cube holds">
      <button type="button" aria-pressed={value === "none"} title="Nothing" aria-label="Nothing" className={cn(cell(value === "none"), "text-[13px] text-muted-foreground")} onClick={() => onChange("none")}>
        <span aria-hidden="true" data-notranslate>–</span>
      </button>
      {PROPS.map((p) => (
        <button type="button" key={p.id} aria-pressed={value === p.id} title={p.name} aria-label={p.name} className={cell(value === p.id)} onClick={() => onChange(p.id)}>
          <img src={p.icon} alt="" width={26} height={26} draggable={false} />
        </button>
      ))}
    </div>
  );
}
