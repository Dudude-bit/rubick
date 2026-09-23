import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { UnreadNamespaces } from "@/components/resources/UnreadNamespaces";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/useT";
import type { MetricsStatus, UnreadNamespace } from "@/generated/types";
import { AlertTriangle, ShieldAlert, Wrench } from "lucide-react";

interface MetricsStatusBannerProps {
  status?: MetricsStatus | null;
  /** Namespaces of a selection whose samples were not read while others were. */
  unread?: readonly UnreadNamespace[];
  onRetry?: () => void;
  className?: string;
}

export function MetricsStatusBanner({
  status,
  unread,
  onRetry,
  className,
}: MetricsStatusBannerProps) {
  const t = useT();
  if (!status) return null;
  if (status.status === "available") {
    return unread?.length ? (
      <UnreadNamespaces
        unread={unread}
        label={t("cluster", "podMetricsLabel")}
        onRetry={onRetry}
      />
    ) : null;
  }

  const details = status.message?.trim();

  const config = (() => {
    switch (status.status) {
      case "notInstalled":
        return {
          title: t("cluster", "metricsNotInstalled"),
          description: t("cluster", "metricsNotInstalledBody"),
          icon: Wrench,
          variant: "default" as const,
        };
      case "forbidden":
        return {
          title: t("cluster", "metricsForbidden"),
          description: t("cluster", "metricsForbiddenBody"),
          icon: ShieldAlert,
          variant: "destructive" as const,
        };
      case "error":
      default:
        return {
          title: t("cluster", "metricsError"),
          description: t("cluster", "metricsErrorBody"),
          icon: AlertTriangle,
          variant: "destructive" as const,
        };
    }
  })();

  const description = details
    ? `${config.description} ${t("cluster", "metricsDetails", { details })}`
    : config.description;

  const Icon = config.icon;

  return (
    <Alert variant={config.variant} className={cn("mb-4", className)}>
      <Icon className="h-4 w-4" />
      <AlertTitle>{config.title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}
