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
      aria-label={spell(shortcut)}
      className={cn(
        "rounded border border-hair px-1 py-px font-mono text-[10px] text-fg-fnt",
        className
      )}
      {...props}
    >
      {formatShortcut(shortcut)}
    </kbd>
  );
}
