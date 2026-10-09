import { Stamp } from "lucide-react";

import type { T } from "@/i18n/useT";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportFinding } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { IssuerRow, UnreadKind } from "./model";

/**
 * The issuers the Issuers tab would draw in anything but green: not ready,
 * no status yet, and a kind it could not list. With nothing read at all the
 * whole section is unread, never an empty list.
 */
export function issuersSection(
  rows: readonly IssuerRow[],
  loading: boolean,
  unread: readonly UnreadKind[],
  t: T
): PlacedSection | null {
  const shell = {
    id: "cert-manager-issuers",
    order: ORDER.own,
    title: "Issuers",
    icon: iconSvg(Stamp),
  };
  const refused = (kind: UnreadKind) =>
    `${t("empty", "crdCouldNotBeListed", { crd: kind.crd })}: ${kind.reason}`;
  if (loading || (rows.length === 0 && unread.length > 0))
    return {
      ...shell,
      count: null,
      unread: loading
        ? t("share", "stillReading")
        : unread.map(refused).join("; "),
      body: { type: "findings", items: [] },
    };
  const found: ReportFinding[] = [
    ...unread.map((kind) => ({
      title: t("empty", "crdCouldNotBeListed", { crd: kind.crd }),
      detail: kind.reason,
      role: "warn" as const,
    })),
    ...rows.flatMap((row) =>
      row.ready === true
        ? []
        : [
            {
              title: row.name,
              detail:
                row.ready === null ? t("empty", "noStatusYet") : row.message,
              role: row.ready === null ? ("warn" as const) : ("err" as const),
              ref: refOf({
                kind: row.kind,
                name: row.name,
                namespace: row.namespace,
              }),
            },
          ]
    ),
  ];
  if (found.length === 0) return null;
  return {
    ...shell,
    count: found.length,
    body: { type: "findings", items: found },
  };
}
