import { cn } from "@/lib/utils";
import { formatShortcut, isMac } from "@/lib/platform";

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  /** Logical shortcut, e.g. `mod+K`. Never write platform glyphs here. */
  shortcut: string;
}

/** Screen readers announce "command" as a symbol, so spell the modifiers. */
function spell(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => {
      switch (part.toLowerCase()) {
        case "mod":
          return isMac() ? "Command" : "Control";
        case "ctrl":
          return "Control";
        case "shift":
          return "Shift";
        case "alt":
          return isMac() ? "Option" : "Alt";
        default:
          return part;
      }
    })
    .join(" ");
}

export function Kbd({ shortcut, className, ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        "rounded border border-hair px-1 py-px font-mono text-[10px] text-fg-fnt",
        className
      )}
      {...props}
    >
      {/* WAI-ARIA 1.2 forbids aria-label on <kbd>'s implicit generic
          role, so browsers/AT drop it — spell the modifiers in a
          visually hidden span instead. */}
      <span aria-hidden="true">{formatShortcut(shortcut)}</span>
      <span className="sr-only">{spell(shortcut)}</span>
    </kbd>
  );
}
