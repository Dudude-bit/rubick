import { Activity, Bell, Plug } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { DetailTabs } from "@/components/resources/DetailTabs";
import { viewGlyph, type DetailTab } from "@/components/resources/detail-tab";
import { useT } from "@/i18n/useT";
import { useWakeOnVisit } from "@/hooks/useClusterForwards";
import Connection from "./connection";
import Alerts from "./alerts/Alerts";
import Monitors from "./monitors/Monitors";
import { rowsOfPicture, usePicture } from "./monitors/data";

/**
 * One row, two questions: what the operator was told to scrape, and what
 * the address really scrapes. The Monitors tab exists when the operator's
 * kinds do; the Connection tab always, because it is where "not connected"
 * is said.
 */
export default function PrometheusPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  // The tunnel died with the last app instance; opening this page is as
  // deliberate as pressing the sidebar row, so it wakes the saved forward.
  useWakeOnVisit("prometheus");
  const picture = usePicture();

  const operatorHere =
    picture.data !== undefined &&
    (picture.data.serviceMonitors.state !== "absent" ||
      picture.data.podMonitors.state !== "absent");
  const rows = picture.data ? rowsOfPicture(picture.data) : null;
  const attention = rows?.filter((row) => row.worst !== null) ?? [];
  const worst: "err" | "warn" | null = attention.some(
    (row) => row.worst === "err"
  )
    ? "err"
    : attention.length > 0
      ? "warn"
      : null;

  const firing =
    picture.data?.alertRules.state === "read"
      ? picture.data.alertRules.rules.reduce(
          (n, rule) =>
            n + rule.alerts.filter((a) => a.state === "firing").length,
          0
        )
      : null;
  const alertsMark: DetailTab["mark"] =
    firing !== null && firing > 0
      ? {
          shows: "severity",
          tone: "err",
          says: t("alerts", "rowFiring", { n: firing }),
        }
      : picture.data?.rules.state === "read"
        ? { shows: "count", of: picture.data.rules.items.length }
        : null;

  const tabs: DetailTab[] = [
    ...(picture.data === undefined || operatorHere
      ? [
          {
            id: "monitors",
            label: t("monitors", "tabMonitors"),
            glyph: viewGlyph(Activity),
            mark:
              worst !== null
                ? {
                    shows: "severity" as const,
                    tone: worst,
                    says: t("monitors", "needAttention", {
                      n: attention.length,
                      total: rows?.length ?? 0,
                    }),
                  }
                : rows
                  ? { shows: "count" as const, of: rows.length }
                  : null,
            content: <Monitors />,
          },
        ]
      : []),
    ...(picture.data !== undefined && picture.data.rules.state !== "absent"
      ? [
          {
            id: "alerts",
            label: t("alerts", "tabAlerts"),
            glyph: viewGlyph(Bell),
            mark: alertsMark,
            content: <Alerts />,
          },
        ]
      : []),
    {
      id: "connection",
      label: t("monitors", "tabConnection"),
      glyph: viewGlyph(Plug),
      mark:
        picture.data?.targets.state === "notConnected"
          ? {
              shows: "severity" as const,
              tone: "warn" as const,
              says: t("monitors", "notConnectedShort"),
            }
          : null,
      content: <Connection />,
    },
  ];

  const tab = params.get("tab") ?? tabs[0].id;
  return (
    <DetailTabs
      tabs={tabs}
      activeTab={tab}
      onTabChange={(next) => {
        const updated = new URLSearchParams(params);
        updated.set("tab", next);
        setParams(updated, { replace: true });
      }}
    />
  );
}
