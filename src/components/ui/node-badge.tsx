import { cn } from "@/lib/utils";

interface NodeBadgeProps {
  /** The node name to display */
  nodeName: string;
  className?: string;
  /** Max width before truncation (default: max-w-[200px]) */
  maxWidth?: string;
}

/**
 * A node name in a table cell.
 *
 * Was a hue-hashed pill. The pill made a machine name look like a status,
 * and a table of them turned into confetti; the node column is context,
 * not a signal, so it now reads as quiet monospace text like the mock.
 */
export function NodeBadge({
  nodeName,
  className,
  maxWidth = "max-w-[200px]",
}: NodeBadgeProps) {
  return (
    <span
      className={cn(
        "inline-block truncate align-bottom font-mono text-fg-mut",
        maxWidth,
        className
      )}
      title={nodeName}
    >
      {nodeName}
    </span>
  );
}
