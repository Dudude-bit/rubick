import { Activity, Search } from "lucide-react";

import { iconSvg } from "@/lib/icon-svg";
import type { ReportFinding, ReportValue } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import type { StatusRole } from "@/lib/status-role";
import type { T } from "@/i18n/useT";
import { selectorWords, type MonitorRow } from "./model";
import { rowTone, rowWords, unknowableWords, type RowTone } from "./words";

const LADDER_ROLE_OF_ROW_TONE: Record<RowTone, StatusRole> = {
  err: "err",
  warn: "warn",
  ok: "ok",
  none: "err",
  mut: "pending",
};

/** The ladder as the reader sees it: every monitor, its group's tone, the same sentence the row draws. */
export function ladderSection(
  rows: MonitorRow[] | null,
  t: T
): PlacedSection | null {
  if (!rows || rows.length === 0) return null;
  const items: ReportFinding[] = rows.map((row) => ({
    title: row.monitor.name,
    detail: rowWords(row, t),
    role: LADDER_ROLE_OF_ROW_TONE[rowTone(row)],
    ref: refOf({
      kind: row.monitor.kind,
      name: row.monitor.name,
      namespace: row.monitor.namespace,
    }),
  }));
  return {
    id: "prometheus-monitors-ladder",
    order: ORDER.own,
    title: t("monitors", "tabMonitors"),
    icon: iconSvg(Activity),
    count: items.length,
    body: { type: "findings", items },
  };
}

const DETAIL_ROLE_OF_ROW_TONE: Record<
  RowTone,
  "ok" | "warn" | "err" | "pending"
> = {
  err: "err",
  warn: "warn",
  ok: "ok",
  none: "err",
  mut: "pending",
};

function factsSection(
  row: MonitorRow,
  verdict: { head: string },
  t: T
): PlacedSection {
  const { monitor } = row;
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("monitors", "tabMonitors"),
      values: [
        {
          text: `${monitor.kind} ${monitor.namespace}/${monitor.name}`,
          ref: refOf({
            kind: monitor.kind,
            name: monitor.name,
            namespace: monitor.namespace,
          }),
        },
      ],
    },
    {
      label: t("monitors", "selects"),
      values: [{ text: selectorWords(monitor.selector) || "{}", mono: true }],
    },
    {
      label: t("monitors", "endpoints"),
      values: monitor.endpoints.map((endpoint) => ({
        text: `${endpoint.port ?? "?"} ${endpoint.path}${
          endpoint.interval ? ` · ${endpoint.interval}` : ""
        }`,
        mono: true,
      })),
    },
    {
      label: t("monitors", "pickedUpBy"),
      values:
        row.pickedUp.state !== "noKind" && row.pickedUp.by.length > 0
          ? row.pickedUp.by.map((name) => ({ text: name, mono: true }))
          : [
              {
                text:
                  row.pickedUp.state === "noKind"
                    ? t("monitors", "prometheusKindAbsent")
                    : row.pickedUp.state === "unknown"
                      ? unknowableWords(row.pickedUp.why, t)
                      : t("monitors", "notPickedUp"),
                role:
                  row.pickedUp.state === "judged"
                    ? ("err" as const)
                    : ("warn" as const),
              },
            ],
    },
    {
      label: t("share", "sectionVerdict"),
      values: [
        { text: verdict.head, role: DETAIL_ROLE_OF_ROW_TONE[rowTone(row)] },
      ],
    },
  ];
  return {
    id: "prometheus-monitor-facts",
    order: ORDER.own,
    title: monitor.name,
    icon: iconSvg(Search),
    body: { type: "facts", rows },
  };
}

function targetsTableSection(row: MonitorRow, t: T): PlacedSection {
  const { scrape } = row;
  const unread =
    scrape.state === "notConnected"
      ? t("monitors", "notConnected")
      : scrape.state === "unanswered"
        ? t("monitors", "unanswered", { reason: scrape.reason })
        : null;
  const rows =
    scrape.state === "read"
      ? scrape.targets.map((target) => ({
          cells: [
            {
              text: target.health,
              role:
                target.health === "up"
                  ? ("ok" as const)
                  : target.health === "down"
                    ? ("err" as const)
                    : ("neutral" as const),
            },
            { text: target.scrapeUrl, mono: true },
            target.lastScrape
              ? { text: target.lastScrape, at: target.lastScrape }
              : { text: "" },
            { text: target.lastError || "–" },
          ],
        }))
      : [];
  return {
    id: "prometheus-monitor-targets",
    order: ORDER.own,
    title: t("monitors", "targets"),
    icon: iconSvg(Search),
    count: rows.length,
    unread,
    body: {
      type: "table",
      columns: [
        t("monitors", "health"),
        t("monitors", "scrapeUrl"),
        t("monitors", "lastScrape"),
        t("monitors", "lastError"),
      ],
      rows,
      more: null,
    },
  };
}

export function monitorDetailSections(
  row: MonitorRow,
  verdict: { head: string },
  t: T
): PlacedSection[] {
  return [factsSection(row, verdict, t), targetsTableSection(row, t)];
}
