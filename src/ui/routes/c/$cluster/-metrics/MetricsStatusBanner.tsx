import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { Lock, TriangleAlert, X } from "lucide-react";

import { ErrorDetails } from "@/components/ui/error-details";
import { HeldLines } from "../-list/HeldLines";
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
    title: "metricsNotInstalled" | "metricsForbidden" | "metricsError";
    body:
      | "metricsNotInstalledBody"
      | "metricsForbiddenBody"
      | "metricsErrorBody";
  }
> = {
  notInstalled: {
    title: "metricsNotInstalled",
    body: "metricsNotInstalledBody",
  },
  forbidden: { title: "metricsForbidden", body: "metricsForbiddenBody" },
  error: { title: "metricsError", body: "metricsErrorBody" },
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
  if (absence !== "error" && hidden.includes(absence)) return null;

  const { title, body } = NOTICE[absence];
  const Glyph = absence === "forbidden" ? Lock : TriangleAlert;
  const details = status.message?.trim();

  return (
    <div
      role="status"
      className={cn(
        "mb-4 flex items-start gap-3 rounded-md border border-dashed border-hair px-3 py-2 text-xs",
        className
      )}
    >
      <Glyph
        className="mt-0.5 h-3.5 w-3.5 flex-none text-warn"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        {/* Above a list, so a peek opening beside it must not wrap them
              onto more lines and move the rows under the pointer. */}
        <p className="text-fg">
          <HeldLines>{t("cluster", title)}</HeldLines>
        </p>
        <p className="text-fg-mut">
          <HeldLines>{t("cluster", body)}</HeldLines>
        </p>
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
            className="text-caption text-info hover:underline disabled:text-fg-fnt disabled:no-underline"
          >
            {checking
              ? t("cluster", "metricsChecking")
              : t("cluster", "metricsCheckAgain")}
          </button>
          {details && <ErrorDetails text={details} />}
        </div>
      </div>
      {context && absence !== "error" && (
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
  );
}
