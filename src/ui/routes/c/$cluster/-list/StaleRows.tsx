import { useShareCaveat } from "@/components/share/screen-share";
import { Unknown } from "@/components/ui/unknown";
import { useT } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import { utcMoment } from "@/lib/report-parts";
import { formatWhen } from "@/lib/utils";

/**
 * Rows, or an object, a failed re-read left on screen, said to be from the
 * last read that answered. Said again in whatever the screen shares, since
 * the file is stamped with the moment of sharing and its reader sees no
 * notice: `shared={false}` where the screen's own section already says it.
 */
export function StaleRows({
  label,
  since,
  error,
  onRetry,
  object = false,
  shared = true,
  className = "mb-2",
}: {
  /** What the rows are, or which object, as it reads inside a sentence. */
  label: string;
  since: number;
  error: unknown;
  onRetry?: () => void;
  object?: boolean;
  shared?: boolean;
  className?: string;
}) {
  const t = useT();
  useShareCaveat(
    shared
      ? `${t("share", "staleRead", { label, time: utcMoment(since) })} (${errorToShow(error)})`
      : null
  );
  return (
    <Unknown
      className={className}
      question={t("empty", object ? "staleObject" : "staleRows", {
        label,
        time: formatWhen(since, "clock"),
      })}
      error={error}
      onRetry={onRetry}
    />
  );
}
