import { Turtle } from "lucide-react";
import { useState } from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { STALL_WARN, useStalls } from "./useStalls";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settingsStore";

/**
 * "Why is this slow", answered from what the app can measure for free.
 * Drawn only while there is something to say: a stall in the last minute.
 * A row that said "no stalls" all day would be the app praising itself.
 *
 * It is about the app, not the cluster, so it never wears the red the
 * problem count beside it does: grey, and amber only past `STALL_WARN`.
 */
export function StallIndicator() {
  const t = useT();
  const report = useStalls();
  const [open, setOpen] = useState(false);
  const openSettings = useSettingsStore((state) => state.openSettings);
  if (report.stalls.length === 0) return null;
  const longest = report.longest?.ms ?? 0;
  const heavy =
    longest >= STALL_WARN.longestMs || report.stalls.length >= STALL_WARN.count;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <button
              type="button"
              aria-label={t("slow", "panel")}
              className={cn(
                "flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] transition-colors hover:bg-hover",
                heavy ? "text-warn" : "text-fg-fnt hover:text-fg-mut"
              )}
            >
              <Turtle className="h-3 w-3" aria-hidden />
              <span className="tabular-nums">
                {t("slow", "stalls", { n: report.stalls.length })}
              </span>
            </button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" className="max-w-[300px]">
          {t("slow", "tooltip")}
        </TooltipContent>
      </Tooltip>
      <SheetContent className="flex w-[400px] flex-col gap-0 p-0 sm:w-[460px]">
        <SheetHeader className="flex-none px-3 py-2">
          <SheetTitle>{t("slow", "title")}</SheetTitle>
          <SheetDescription>{t("slow", "hint")}</SheetDescription>
        </SheetHeader>
        <dl className="flex flex-col gap-3 px-3 py-3 text-xs">
          <Fact
            label={t("slow", "stallsLabel")}
            value={t("slow", "stallsValue", {
              n: report.stalls.length,
              longest: Math.round(longest),
            })}
            note={
              report.source === "frame-gap"
                ? t("slow", "sourceFrameGap")
                : t("slow", "sourceLongTask")
            }
          />
          <Fact
            label={t("slow", "listsLabel")}
            value={
              report.lists.length === 0
                ? t("slow", "noBigList")
                : report.lists
                    .map((list) =>
                      list.label === null
                        ? t("slow", "listRowsPlain", { n: list.rows })
                        : t("slow", "listRows", {
                            n: list.rows,
                            label: list.label,
                          })
                    )
                    .join(", ")
            }
            note={report.lists.length > 0 ? t("slow", "listsWhy") : undefined}
          />
          <Fact
            label={t("slow", "answerLabel")}
            value={
              report.largest === null
                ? t("slow", "noBigAnswer")
                : t("slow", "answerRows", {
                    n: report.largest.rows,
                    command: report.largest.name,
                  })
            }
            note={report.largest !== null ? t("slow", "answerWhy") : undefined}
          />
        </dl>
        <div className="border-t border-hair px-3 py-3 text-xs text-fg-mut">
          {/* Said whenever both rows came back empty: they are fed by the
              table and the command wrapper and by nothing else, so "nothing
              over a thousand" is a fact about what was counted and not about
              what was on screen. A log buffer blocking the thread reaches
              neither. */}
          {report.lists.length === 0 && report.largest === null && (
            <p className="mb-2 text-fg-fnt">{t("slow", "notCounted")}</p>
          )}
          <p>{t("slow", "whatToDo")}</p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openSettings("diagnostics");
            }}
            className="mt-2 text-info hover:underline"
          >
            {t("slow", "openRecorder")}
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Fact({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[.07em] text-fg-fnt">
        {label}
      </dt>
      <dd className="mt-0.5 text-fg">{value}</dd>
      {note && <dd className="mt-0.5 text-[11px] text-fg-fnt">{note}</dd>}
    </div>
  );
}
