import { T } from "@/i18n/T";
import { cn } from "@/lib/utils";

/** A value the cluster really has none of, said in the catalogue's word and never as a glyph. */
export function None({ className }: { className?: string }) {
  return (
    <span className={cn("text-fg-fnt", className)}>
      <T section="empty" k="noneLower" />
    </span>
  );
}
