import { Activity, Bell, Plug } from "lucide-react";

import { DetailTabs } from "@/components/resources/DetailTabs";
import { viewGlyph, type DetailTab } from "@/components/resources/detail-tab";
import { useSearchParam } from "@/hooks/useSearchParam";
import { useT } from "@/i18n/useT";
import { useWakeOnVisit } from "@/hooks/useClusterForwards";
import Connection from "./connection";
import Alerts from "./alerts/Alerts";
import Monitors from "./monitors/Monitors";
import { alertsMark, monitorMark, usePicture } from "./monitors/data";

/**
 * One row, two questions: what the operator was told to scrape, and what
 * the address really scrapes. The Monitors tab exists when the operator's
 * kinds do; the Connection tab always, because it is where "not connected"
 * is said.
 */
export default function PrometheusPage() {
  const t = useT();
  const [chosenTab, setTab] = useSearchParam("tab");
  // The tunnel died with the last app instance; opening this page is as
  // deliberate as pressing the sidebar row, so it wakes the saved forward.
  useWakeOnVisit("prometheus");
  const picture = usePicture();

  const operatorHere =
    picture.data !== undefined &&
    (picture.data.serviceMonitors.state !== "absent" ||
      picture.data.podMonitors.state !== "absent");
  const mark = picture.data ? monitorMark(picture.data) : null;

  // The same rows the page draws, so the tab says what the page says: the
  // mark was built from the firing alerts alone, and a rule object nothing
  // picks up — or one Prometheus cannot load — left a plain count on a tab
  // whose page is all red.
  const alerts = picture.data ? alertsMark(picture.data) : null;
  const alertsTabMark: DetailTab["mark"] =
    alerts?.shows === "severity"
      ? {
          shows: "severity",
          tone: alerts.tone,
          says:
            alerts.firing > 0
              ? t("alerts", "rowFiring", { n: alerts.firing })
              : t("alerts", "markBroken", { n: alerts.broken }),
        }
      : alerts?.shows === "unchecked"
        ? {
            shows: "unchecked",
            says: t("alerts", "markUnchecked", { n: alerts.of }),
          }
        : alerts?.shows === "count"
          ? { shows: "count", of: alerts.of }
          : null;

  const tabs: DetailTab[] = [
    ...(picture.data === undefined || operatorHere
      ? [
          {
            id: "monitors",
            label: t("monitors", "tabMonitors"),
            glyph: viewGlyph(Activity),
            mark:
              mark?.shows === "severity"
                ? {
                    shows: "severity" as const,
                    tone: mark.tone,
                    says:
                      mark.total === null
                        ? t("monitors", "needAttentionSomeUnread", {
                            n: mark.n,
                          })
                        : t("monitors", "needAttention", {
                            n: mark.n,
                            total: mark.total,
                          }),
                  }
                : mark?.shows === "count"
                  ? { shows: "count" as const, of: mark.of }
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
            mark: alertsTabMark,
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

  const tab = chosenTab || tabs[0].id;
  return <DetailTabs tabs={tabs} activeTab={tab} onTabChange={setTab} />;
}
