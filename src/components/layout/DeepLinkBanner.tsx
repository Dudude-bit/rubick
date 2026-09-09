import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Link2, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDeepLinkStore } from "@/stores/deepLinkStore";
import { useT } from "@/i18n/useT";

/**
 * What the reader needs to know about the link that brought them here, until
 * they say they have read it or go somewhere else.
 */
export function DeepLinkBanner() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const arrival = useDeepLinkStore((s) => s.arrival);
  const dismiss = useDeepLinkStore((s) => s.dismiss);

  // Leaving the page the link opened is reading the banner; it should not
  // follow the reader around the app.
  const arrivedAt = arrival ? arrival.link.path.split("?")[0] : null;
  useEffect(() => {
    if (
      arrival?.status === "live" &&
      arrivedAt &&
      location.pathname !== arrivedAt
    ) {
      dismiss();
    }
  }, [arrival, arrivedAt, location.pathname, dismiss]);

  if (!arrival) return null;

  const when = arrival.link.capturedAt
    ? arrival.link.capturedAt.toLocaleString()
    : null;

  if (arrival.status === "live") {
    return (
      <div
        role="status"
        className="flex items-start gap-2 border-b border-hair bg-hover px-4 py-2 text-xs text-fg-mid"
      >
        <Link2
          className="mt-0.5 h-3.5 w-3.5 flex-none text-info"
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1">
          {when
            ? t("cluster", "linkOpenedAt", { when })
            : t("cluster", "linkOpened")}
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("cluster", "linkDismiss")}
          className="rounded p-1 text-fg-fnt hover:text-fg"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-hair bg-hover px-4 py-2 text-xs text-fg-mid"
    >
      <TriangleAlert
        className="mt-0.5 h-3.5 w-3.5 flex-none text-warn"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-fg">
          {t("cluster", "linkContextMissing", {
            context: arrival.link.context,
          })}
        </p>
        <p className="mt-0.5 text-fg-mut">
          {arrival.known.length > 0
            ? t("cluster", "linkContextMissingKnown", {
                known: arrival.known.join(", "),
              })
            : t("cluster", "linkContextMissingNone")}
        </p>
        <div className="mt-2 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              dismiss();
              navigate("/settings/clusters");
            }}
          >
            {t("cluster", "linkOpenClusters")}
          </Button>
          <Button variant="outline" size="sm" onClick={dismiss}>
            {t("cluster", "linkDismiss")}
          </Button>
        </div>
      </div>
    </div>
  );
}
