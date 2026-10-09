import { Bell } from "lucide-react";

import { errorToShow } from "@/lib/error-utils";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportFinding } from "@/lib/report";
import type { StatusRole } from "@/lib/status-role";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { T } from "@/i18n/useT";
import { rowWords } from "./words";
import type { Picture } from "../monitors/data";
import type { RuleGroup, RuleRow } from "./model";

const ROLE: Record<RuleGroup, StatusRole | null> = {
  firing: "err",
  broken: "err",
  pending: "warn",
  unchecked: "neutral",
  quiet: null,
};

/**
 * Why the rule objects are not known: the picture refused, still loading, or
 * the PrometheusRule list refused. `null` once read, or where the kind is not
 * served, which is a real "there are none".
 */
export function rulesUnread(
  picture: Pick<Picture, "rules"> | undefined,
  error: unknown,
  t: T
): string | null {
  if (error) return errorToShow(error);
  if (!picture) return t("share", "stillReading");
  return picture.rules.state === "unread" ? picture.rules.reason : null;
}

/** Every rule object the ladder draws in anything but green. */
export function alertsSection(
  rows: RuleRow[] | null,
  unread: string | null,
  t: T
): PlacedSection | null {
  const shell = {
    id: "prometheus-alerts",
    order: ORDER.own,
    title: t("alerts", "tabAlerts"),
    icon: iconSvg(Bell),
  };
  if (unread !== null)
    return {
      ...shell,
      count: null,
      unread,
      body: { type: "findings", items: [] },
    };
  if (!rows) return null;
  const found: ReportFinding[] = rows.flatMap((row) => {
    const role = ROLE[row.group];
    return role === null
      ? []
      : [
          {
            title: row.object.name,
            detail: rowWords(row, t),
            role,
            ref: refOf({
              kind: "PrometheusRule",
              name: row.object.name,
              namespace: row.object.namespace,
            }),
          },
        ];
  });
  if (found.length === 0) return null;
  return {
    ...shell,
    count: found.length,
    body: { type: "findings", items: found },
  };
}
