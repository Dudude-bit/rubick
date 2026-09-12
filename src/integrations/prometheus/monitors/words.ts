import type { T } from "@/i18n/useT";
import type { MonitorRow } from "./model";

/** The tone a row is drawn in, as one word so every reader of it agrees. */
export type RowTone = "err" | "warn" | "ok" | "none" | "mut";

export function rowTone(row: MonitorRow): RowTone {
  if (row.findings[0]?.kind === "selectsNothing") return "none";
  if (row.worst === "err") return "err";
  if (row.worst === "warn") return "warn";
  return row.scrape.state === "read" ? "ok" : "mut";
}

export const DOT: Record<RowTone, string> = {
  err: "bg-err",
  warn: "bg-warn",
  ok: "bg-ok",
  none: "border-[1.5px] border-err",
  mut: "border-[1.5px] border-fg-fnt",
};

export const SELECTED: Record<RowTone, string> = {
  err: "bg-err/8 ring-1 ring-inset ring-err/40",
  warn: "bg-warn/8 ring-1 ring-inset ring-warn/40",
  ok: "bg-ok/8 ring-1 ring-inset ring-ok/40",
  none: "bg-err/8 ring-1 ring-inset ring-err/40",
  mut: "bg-sel outline-dashed outline-1 -outline-offset-1 outline-fg-fnt",
};

export const RING: Record<RowTone, string> = {
  err: "shadow-[0_0_0_3px] shadow-err/25",
  warn: "shadow-[0_0_0_3px] shadow-warn/25",
  ok: "shadow-[0_0_0_3px] shadow-ok/25",
  none: "shadow-[0_0_0_3px] shadow-err/25",
  mut: "shadow-[0_0_0_3px] shadow-fg-fnt/25",
};

export const WORDS: Record<RowTone, string> = {
  err: "text-err",
  warn: "text-warn",
  ok: "text-ok",
  none: "text-err",
  mut: "text-fg-mut",
};

/** The row's answer in a few words. */
export function rowWords(row: MonitorRow, t: T): string {
  const worst = row.findings[0];
  switch (worst?.kind) {
    case "selectsNothing":
      return t("monitors", "rowSelectsNothing");
    case "notPickedUp":
      return t("monitors", "rowNotPickedUp");
    case "targetsDown":
      return t("monitors", "rowDownOf", {
        down: worst.down,
        total: worst.total,
      });
    case "noTargets":
      return t("monitors", "rowNoTargets");
    case "selectionUnread":
    case "pickedUpUnknown":
      return t("monitors", "rowUnknown");
  }
  if (row.scrape.state !== "read") return t("monitors", "rowNotChecked");
  return t("monitors", "rowUp", { n: row.scrape.up });
}
