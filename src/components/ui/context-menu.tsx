import { ContextMenu as Primitive } from "@base-ui/react/context-menu";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One line of a right-click menu. */
export interface MenuEntry {
  label: string;
  onSelect: () => void;
  /** Something that cannot be taken back: shown in the warning color, below a line. */
  danger?: boolean;
  disabled?: boolean;
}

/**
 * The menu that opens where the person right-clicks `children`. Entries that are `false` or
 * undefined are left out, so a caller can list them with plain conditions; "-" draws a line.
 * With nothing to offer there is no menu, and the right click does what it always does.
 */
export function RightClick({ items, children }: { items: (MenuEntry | "-" | false | undefined)[]; children: ReactNode }) {
  const shown = items.filter((i): i is MenuEntry | "-" => Boolean(i));
  // No line first, last, or twice in a row.
  const tidy = shown.filter((item, i) => item !== "-" || (i > 0 && i < shown.length - 1 && shown[i - 1] !== "-"));
  if (!tidy.some((i) => i !== "-")) return <>{children}</>;
  return (
    <Primitive.Root>
      {/* The wrapper takes no room of its own: the menu belongs to whatever is inside it. */}
      <Primitive.Trigger className="contents">{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Positioner className="isolate z-50 outline-none" sideOffset={2}>
          <Primitive.Popup className="z-50 min-w-44 origin-(--transform-origin) overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            {tidy.map((item, i) =>
              item === "-" ? (
                <Primitive.Separator key={`line-${i}`} className="-mx-1 my-1 h-px bg-border" />
              ) : (
                <Primitive.Item
                  key={item.label}
                  disabled={item.disabled}
                  onClick={item.onSelect}
                  className={cn(
                    "flex cursor-default items-center rounded-md px-2 py-1 text-[13px] outline-none select-none data-highlighted:bg-accent data-disabled:opacity-40",
                    item.danger && "text-destructive data-highlighted:bg-destructive/10",
                  )}
                >
                  {item.label}
                </Primitive.Item>
              ),
            )}
          </Primitive.Popup>
        </Primitive.Positioner>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
