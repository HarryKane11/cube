import { useMemo, useState } from "react";
import { SmileIcon } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { COMMON, codeOf, nameOfCode } from "@/lib/emoji";
import { cn } from "@/lib/utils";
import { useCube } from "@/state/store";

/** An emoji as it is shown: an ordinary one as text, one of the workspace's own (`:name:`) as its picture. */
export function EmojiGlyph({ code, size = 16 }: { code: string; size?: number }) {
  const name = nameOfCode(code);
  const picture = useCube((s) => (name ? s.emojis[name] : undefined));
  if (picture) return <img src={picture} width={size} height={size} alt={code} title={code} draggable={false} className="inline-block flex-none object-contain" />;
  return <span className="leading-none" style={{ fontSize: size * 0.94 }} data-notranslate>{code}</span>;
}

/**
 * The button that opens every emoji there is to react with: the ordinary ones, and under them
 * the workspace's own, which can be searched by name.
 */
export function EmojiPicker({ onPick, onOpenChange, className, beside }: { onPick: (code: string) => void; /** Hears when the emoji come up and go away: whatever holds the button must stay on screen meanwhile, or they have nothing to stand by. */ onOpenChange?: (open: boolean) => void; className?: string; /** Beside the reactions a message already has: a smaller face with a plus, opening toward the text. */ beside?: boolean }) {
  const emojis = useCube((s) => s.emojis);
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [query, setQuery] = useState("");
  const names = useMemo(() => Object.keys(emojis).sort(), [emojis]);
  const found = query.trim() ? names.filter((n) => n.includes(query.trim().toLowerCase().replace(/:/g, ""))) : names;
  const pick = (code: string) => {
    onPick(code);
    setOpen(false);
    setQuery("");
  };
  const cell = "flex size-8 items-center justify-center rounded-lg hover:bg-accent";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger aria-label="Add a reaction" title="Add a reaction" className={className}>
        <SmileIcon width={beside ? 15 : 16} height={beside ? 15 : 16} />
        {beside && <span className="-ml-0.5 text-[11px] font-bold leading-none" aria-hidden="true" data-notranslate>+</span>}
      </PopoverTrigger>
      <PopoverContent side="top" align={beside ? "start" : "end"} className="w-[292px] gap-2 p-2">
        {open && (
          <>
            <div className="grid grid-cols-8 gap-0.5" role="group" aria-label="Emoji">
              {COMMON.map((e) => (
                <button type="button" key={e} className={cell} aria-label={`React with ${e}`} onClick={() => pick(e)}>
                  <span className="text-[18px] leading-none" data-notranslate>{e}</span>
                </button>
              ))}
            </div>
            {names.length > 0 && (
              <>
                <input aria-label="Find an emoji" placeholder="Find an emoji" value={query} onChange={(e) => setQuery(e.target.value)} autoCapitalize="off" spellCheck={false} className="selectable h-8 rounded-lg border bg-transparent px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                <div className={cn("grid max-h-[168px] grid-cols-8 gap-0.5 overflow-y-auto")} role="group" aria-label="This workspace's emoji">
                  {found.slice(0, 240).map((n) => (
                    <button type="button" key={n} className={cell} aria-label={`React with ${codeOf(n)}`} title={codeOf(n)} onClick={() => pick(codeOf(n))}>
                      <img src={emojis[n]} width={22} height={22} alt="" draggable={false} className="object-contain" />
                    </button>
                  ))}
                  {!found.length && <span className="col-span-8 px-1 py-2 text-xs text-muted-foreground">Nothing matches.</span>}
                </div>
              </>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
