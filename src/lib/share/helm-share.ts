import { Boxes, History, Info } from "lucide-react";

import type { HelmReleaseDetail, HelmRevision } from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { InstalledObject } from "@/lib/helm-manifest";
import { iconSvg } from "@/lib/icon-svg";
import type { ReportValue } from "@/lib/report";
import { ORDER, refOf, type PlacedSection } from "@/lib/report-parts";
import { statusRole, type StatusRole } from "@/lib/status-role";
import { formatDate } from "@/lib/utils";

export function helmStatusOf(release: HelmReleaseDetail): {
  text: string;
  role: StatusRole;
} {
  return { text: release.status, role: statusRole(release.status) };
}

export function helmFactsSection(
  release: HelmReleaseDetail,
  t: T
): PlacedSection {
  const rows: { label: string; values: ReportValue[] }[] = [
    {
      label: t("columns", "chart"),
      values: [
        { text: `${release.chart}:${release.chartVersion}`, mono: true },
      ],
    },
    {
      label: t("columns", "appVersion"),
      values: [{ text: release.appVersion || "–", mono: true }],
    },
    {
      label: t("columns", "revision"),
      values: [{ text: String(release.revision), mono: true }],
    },
    {
      label: t("columns", "namespace"),
      values: [{ text: release.namespace, mono: true }],
    },
  ];
  return {
    id: "helm-facts",
    order: ORDER.own,
    title: t("action", "releaseHeading"),
    icon: iconSvg(Info),
    body: { type: "facts", rows },
  };
}

const MAX_HISTORY = 50;

export function helmHistorySection(
  history: HelmRevision[],
  t: T
): PlacedSection | null {
  if (history.length === 0) return null;
  const kept = history.slice(0, MAX_HISTORY);
  return {
    id: "helm-history",
    order: ORDER.own,
    title: t("action", "revisionsHeading"),
    icon: iconSvg(History),
    count: history.length,
    body: {
      type: "table",
      columns: [
        t("columns", "rev"),
        t("columns", "status"),
        t("columns", "chart"),
        t("columns", "app"),
        t("columns", "updated"),
        t("columns", "description"),
      ],
      rows: kept.map((rev) => ({
        cells: [
          { text: String(rev.revision), mono: true },
          { text: rev.status, role: statusRole(rev.status) },
          { text: rev.chart, mono: true },
          { text: rev.appVersion || "–" },
          { text: formatDate(rev.updated) ?? "–" },
          { text: rev.description || "–" },
        ],
      })),
      more:
        history.length > kept.length
          ? t("share", "rowsMore", { n: history.length - kept.length })
          : null,
    },
  };
}

const MAX_RESOURCES = 200;

/** Never the release's values: they routinely carry passwords and API keys. */
export function helmResourcesSection(
  installed: InstalledObject[],
  t: T
): PlacedSection | null {
  if (installed.length === 0) return null;
  const kept = installed.slice(0, MAX_RESOURCES);
  return {
    id: "helm-resources",
    order: ORDER.own,
    title: t("action", "installedByRelease"),
    icon: iconSvg(Boxes),
    count: installed.length,
    body: {
      type: "table",
      columns: [
        t("columns", "kind"),
        t("columns", "name"),
        t("columns", "namespace"),
      ],
      rows: kept.map((object) => ({
        cells: [
          { text: object.kind },
          {
            text: object.name,
            ref: refOf({
              kind: object.kind,
              name: object.name,
              namespace: object.namespace,
            }),
          },
          { text: object.namespace ?? "–" },
        ],
      })),
      more:
        installed.length > kept.length
          ? t("share", "rowsMore", { n: installed.length - kept.length })
          : null,
    },
  };
}
