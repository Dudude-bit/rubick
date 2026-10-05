import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Gauge, Lock, X, type LucideIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ErrorDetails } from "@/components/ui/error-details";
import { UnreadNamespaces } from "../-list/UnreadNamespaces";
import { cn } from "@/lib/utils";
import { commands } from "@/lib/commands";
import { useT } from "@/i18n/useT";
import { absenceOf, type MetricsAbsence } from "@/lib/metrics-absence";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { useMetricsNoticeStore } from "@/stores/metricsNoticeStore";
import type { MetricsStatus, UnreadNamespace } from "@/generated/types";

interface MetricsStatusBannerProps {
  status?: MetricsStatus | null;
  /** Namespaces of a selection whose samples were not read while others were. */
  unread?: readonly UnreadNamespace[];
  onRetry?: () => void;
  className?: string;
}

/**
 * A missing or refused metrics API is a fact about the cluster that only an
 * admin can change, so it is said calmly, once per cluster if the reader
 * wants, and never in the red a broken workload wears.
 */
const NOTICE: Record<
  MetricsAbsence,
  {
    icon: LucideIcon;
    variant: "info" | "warn";
    title: "metricsNotInstalled" | "metricsForbidden" | "metricsError";
    body:
      | "metricsNotInstalledBody"
      | "metricsForbiddenBody"
      | "metricsErrorBody";
  }
> = {
  notInstalled: {
    icon: Gauge,
    variant: "info",
    title: "metricsNotInstalled",
    body: "metricsNotInstalledBody",
  },
  forbidden: {
    icon: Lock,
    variant: "info",
    title: "metricsForbidden",
    body: "metricsForbiddenBody",
  },
  error: {
    icon: AlertTriangle,
    variant: "warn",
    title: "metricsError",
    body: "metricsErrorBody",
  },
};

const NONE_HIDDEN: readonly MetricsAbsence[] = [];

export function MetricsStatusBanner({
  status,
  unread,
  onRetry,
  className,
}: MetricsStatusBannerProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const checking = useIsFetching({ queryKey: queryKeys.metrics.all() }) > 0;
  const context = useClusterStore((s) => s.currentContext);
  const hidden =
    useMetricsNoticeStore((s) => (context ? s.hidden[context] : undefined)) ??
    NONE_HIDDEN;
  const hide = useMetricsNoticeStore((s) => s.hide);
  const absence = absenceOf(status);

  if (!status) return null;
  if (absence === null) {
    return unread?.length ? (
      <UnreadNamespaces
        unread={unread}
        label={t("cluster", "podMetricsLabel")}
        onRetry={onRetry}
      />
    ) : null;
  }
  if (hidden.includes(absence)) return null;

  const { icon: Icon, variant, title, body } = NOTICE[absence];
  const details = status.message?.trim();

  return (
    <Alert variant={variant} role="status" className={cn("mb-4", className)}>
      <Icon className="h-4 w-4" aria-hidden="true" />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <AlertTitle>{t("cluster", title)}</AlertTitle>
          <AlertDescription className="text-fg-mut">
            {t("cluster", body)}
          </AlertDescription>
          <div className="mt-1 flex flex-wrap items-start gap-x-3 gap-y-1">
            <button
              type="button"
              disabled={checking}
              onClick={() =>
                void commands.recheckMetrics().finally(
                  () =>
                    void queryClient.refetchQueries({
                      queryKey: queryKeys.metrics.all(),
                    })
                )
              }
              className="text-[11px] text-info hover:underline disabled:text-fg-fnt disabled:no-underline"
            >
              {checking
                ? t("cluster", "metricsChecking")
                : t("cluster", "metricsCheckAgain")}
            </button>
            {details && <ErrorDetails text={details} />}
          </div>
        </div>
        {context && (
          <button
            type="button"
            aria-label={t("cluster", "metricsHideForCluster")}
            title={t("cluster", "metricsHideForCluster")}
            onClick={() => hide(context, absence)}
            className="flex-none rounded p-0.5 text-fg-fnt transition-colors hover:bg-hover hover:text-fg"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </Alert>
  );
}
