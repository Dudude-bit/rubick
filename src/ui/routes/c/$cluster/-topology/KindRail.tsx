import { Lock } from "lucide-react";

import { KindIcon } from "@/components/object/KindIcon";
import { Checkbox } from "@/components/ui/checkbox";
import type { MapKindState } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";
import { readingWords } from "./model";

export interface RailRow {
  kind: string;
  /** Across the scope; `null` where a namespace did not count it. */
  count: number | null;
  /** How many of them the map uses, for the kinds drawn only where used. */
  used: number | null;
  reading: MapKindState["reading"] | null;
  hidden: boolean;
}

/** The kinds on the map, each with its count and how it was read, to show or hide. */
export function KindRail({
  rows,
  onToggle,
}: {
  rows: readonly RailRow[];
  onToggle: (kind: string) => void;
}) {
  const t = useT();
  return (
    <ul
      className="flex w-56 flex-none flex-col gap-0.5 overflow-y-auto scrollbar-lane pr-1"
      aria-label={t("topology", "kindsTitle")}
    >
      {rows.map((row) => {
        const words = readingWords(row.reading, t);
        const served = row.reading?.says !== "notServed";
        const locked =
          row.reading?.says === "refused" || row.reading?.says === "failed";
        const id = `map-kind-${row.kind}`;
        const count =
          row.used !== null
            ? row.count !== null
              ? t("topology", "usedOf", { used: row.used, of: row.count })
              : t("topology", "used", { used: row.used })
            : row.count !== null
              ? String(row.count)
              : "";
        return (
          <li
            key={row.kind}
            className={cn(
              "flex flex-col rounded-md px-1.5 py-1 text-[11.5px]",
              row.hidden && "opacity-60"
            )}
          >
            <span className="flex items-center gap-1.5">
              {served ? (
                <Checkbox
                  id={id}
                  checked={!row.hidden}
                  onCheckedChange={() => onToggle(row.kind)}
                />
              ) : (
                <span className="h-3.5 w-3.5 flex-none" />
              )}
              <KindIcon kind={row.kind} crd={null} className="h-3 w-3" />
              <label
                htmlFor={id}
                className="min-w-0 flex-1 truncate text-fg-mid"
              >
                {row.kind}
              </label>
              {locked && (
                <Lock className="h-3 w-3 flex-none text-warn" aria-hidden />
              )}
              <span className="flex-none tabular-nums text-fg-fnt">
                {served ? count : ""}
              </span>
            </span>
            {words && (
              <span
                className={cn(
                  "pl-9 text-[10.5px]",
                  locked ? "text-warn" : "text-fg-fnt"
                )}
              >
                {words}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
