import { Unknown } from "@/components/ui/unknown";
import { useT } from "@/i18n/useT";
import { formatWhen } from "@/lib/utils";

/** Rows, or an object, a failed re-read left on screen, said to be from the last read that answered. */
export function StaleRows({
  label,
  since,
  error,
  onRetry,
  object = false,
  className = "mb-2",
}: {
  /** What the rows are, or which object, as it reads inside a sentence. */
  label: string;
  since: number;
  error: unknown;
  onRetry?: () => void;
  object?: boolean;
  className?: string;
}) {
  const t = useT();
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
