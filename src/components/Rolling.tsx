import { useEffect, useRef, useState } from "react";
import { TextShimmer } from "@/components/ui/text-shimmer";
import { cn } from "@/lib/utils";

/**
 * A line that says what someone is doing right now. It shimmers while it stands, and when the
 * words change the old ones roll up and out as the new ones roll in from below, so a change is
 * seen and not just there.
 */
export function Rolling({ text, className, duration = 2.2 }: { text: string; className?: string; duration?: number }) {
  const [leaving, setLeaving] = useState<string>();
  const shown = useRef(text);
  useEffect(() => {
    if (shown.current === text) return;
    setLeaving(shown.current);
    shown.current = text;
    const done = window.setTimeout(() => setLeaving(undefined), 320);
    return () => window.clearTimeout(done);
  }, [text]);
  return (
    <span className={cn("rolling", className)} aria-live="polite">
      {leaving !== undefined && <span key={`out:${leaving}`} className="rolling-out" aria-hidden="true">{leaving}</span>}
      <span key={text} className="rolling-in"><TextShimmer duration={duration}>{text}</TextShimmer></span>
    </span>
  );
}
