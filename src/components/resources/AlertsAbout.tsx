import { useMemo } from "react";
import { Bell } from "lucide-react";
import { Link } from "react-router-dom";

import { normalizeTauriError } from "@/lib/error-utils";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useNow } from "@/hooks/useNow";
import { useT } from "@/i18n/useT";
import { alertsCanBeAbout, useCapabilityState } from "@/integrations";
import { cn, formatSince } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * The alerts firing about this object, where something evaluates alerting
 * rules for the cluster. Nothing is drawn without one: an empty block
 * would read as "no alerts", and no evaluator is not that.
 */
export function AlertsAbout({
  kind,
  name,
  namespace,
  className,
}: {
  kind: string;
  name: string;
  namespace: string | null;
  className?: string;
}) {
  const t = useT();
  const now = useNow();
  const context = useClusterStore((state) => state.currentContext);
  const power = useCapabilityState("alerts.about");
  const ready = power.state === "ready";
  const use = ready
    ? (power as Extract<typeof power, { state: "ready" }>).use
    : null;
  // Where the supplier discusses alerts at length, in the supplier's own
  // words. Spelling the route here would name a vendor from outside the
  // seam, and would still point at Prometheus once a second one answers.
  const page = ready
    ? (power as Extract<typeof power, { state: "ready" }>).page
    : null;
  // A kind no evaluator labels is not a kind with nothing firing: no block,
  // and no "could not be read" either.
  const speaks = alertsCanBeAbout(kind);
  // Keyed on the cluster and nothing else: the evaluator hands over every
  // alerting rule it has, and one read answers every object a reader opens
  // rather than one per page, per peek and per poll.
  const alerts = useLiveQuery({
    refresh: "resourceList",
    queryKey: [context, "alerts-about"],
    queryFn: () => use!.read(),
    enabled: speaks && use !== null,
    staleTime: 30_000,
  });
  const read = alerts.data;
  const about = useMemo(
    () =>
      use === null || read === undefined
        ? null
        : use.pick(read, { kind, name, namespace }),
    [use, read, kind, name, namespace]
  );
  // A read that failed is not a workload with nothing firing about it. The
  // block drew byte-identical nothing for both, on the page where "no alert"
  // is the fact a reader leans on.
  if (!speaks) return null;
  if (alerts.error)
    return (
      <p className={cn("text-[11.5px] text-warn", className)}>
        {t("alerts", "aboutUnread", {
          reason: normalizeTauriError(alerts.error),
        })}
      </p>
    );
  if (power.state === "unreachable")
    return (
      <p className={cn("text-[11.5px] text-fg-fnt", className)}>
        {t("alerts", "aboutUnreachable", { reason: power.reason })}
      </p>
    );
  if (!ready || about === null || about.length === 0) return null;
  const firing = about.filter((a) => a.state === "firing");
  const pending = about.filter((a) => a.state === "pending");
  return (
    <section
      className={cn(
        "rounded-lg border px-3.5 py-3",
        className,
        firing.length > 0
          ? "border-err/45 bg-err/7"
          : "border-warn/45 bg-warn/7"
      )}
    >
      <p
        className={cn(
          "flex items-center gap-2 text-[12.5px] font-semibold",
          firing.length > 0 ? "text-err" : "text-warn"
        )}
      >
        <Bell className="size-3.5" aria-hidden />
        {firing.length > 0
          ? t("alerts", "aboutFiring", { n: firing.length })
          : t("alerts", "aboutPending", { n: pending.length })}
        {page !== null && (
          <Link
            to={page}
            className="ml-auto text-[11px] font-normal text-info hover:underline"
          >
            {t("alerts", "openAlerts")}
          </Link>
        )}
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {about.map((alert, index) => (
          <li
            key={`${alert.rule}-${index}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-xs"
          >
            <span className="min-w-0">
              <span className="font-mono text-fg">{alert.rule}</span>
              {alert.severity && (
                <span className="ml-1.5 font-mono text-[10.5px] text-fg-fnt">
                  {alert.severity}
                </span>
              )}
              {alert.state === "pending" && (
                <span className="ml-1.5 font-mono text-[10.5px] text-warn">
                  pending
                </span>
              )}
              {alert.summary && (
                <span className="block text-fg-mut">{alert.summary}</span>
              )}
              {alert.via.label !== "namespace" && alert.via.value !== name && (
                <span className="block font-mono text-[10.5px] text-fg-fnt">
                  {alert.via.label}={alert.via.value}
                </span>
              )}
            </span>
            <span className="whitespace-nowrap text-[11px] tabular-nums text-fg-fnt">
              {alert.activeAt
                ? t("monitors", "scrapedAgo", {
                    ago: formatSince(Date.parse(alert.activeAt), now),
                  })
                : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
