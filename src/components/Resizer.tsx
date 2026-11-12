import { useRef, type CSSProperties, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

interface Props {
  /** The width being changed, in px. */
  value: number;
  min: number;
  max: number;
  /** What a double click puts the width back to. */
  reset: number;
  onChange(width: number): void;
  label: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * A thin strip between two panels. Dragging it sideways changes the width of the panel on its
 * left; a double click puts that width back. The arrow keys work too, for people not using a mouse.
 */
export function Resizer({ value, min, max, reset, onChange, label, className, style }: Props) {
  const from = useRef<{ x: number; width: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.max(min, Math.min(max, w)));
  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    from.current = { x: e.clientX, width: value };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (from.current) onChange(clamp(from.current.width + e.clientX - from.current.x));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    // The release counts too: a quick drag can end without a single move in between.
    if (from.current && e.type === "pointerup") onChange(clamp(from.current.width + e.clientX - from.current.x));
    from.current = null;
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={label}
      className={cn("group/resize z-10 flex w-2.5 flex-none cursor-col-resize touch-none justify-center outline-none", className)}
      style={style}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => onChange(reset)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); onChange(clamp(value + (e.key === "ArrowLeft" ? -16 : 16))); }
      }}
    >
      <span className="h-full w-0.5 rounded-full bg-transparent transition-colors group-hover/resize:bg-primary/50 group-focus-visible/resize:bg-primary group-active/resize:bg-primary" />
    </div>
  );
}
