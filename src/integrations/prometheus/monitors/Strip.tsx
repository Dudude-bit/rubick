import { cn } from "@/lib/utils";
import type { Beat } from "./model";

/** An hour of `up`, a cell per minute: green, red, or a gap where nothing was sampled. */
export function Strip({
  cells,
  height,
}: {
  cells: ReadonlyArray<Beat>;
  height: string;
}) {
  return (
    <div className={cn("flex gap-px", height)} aria-hidden>
      {cells.map((cell, index) => (
        <i
          key={index}
          className={cn(
            "flex-1 rounded-[1px]",
            cell === "up" ? "bg-ok" : cell === "down" ? "bg-err" : "bg-hair"
          )}
        />
      ))}
    </div>
  );
}
