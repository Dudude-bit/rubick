import { Unknown } from "@/components/ui/unknown";
import { useT } from "@/i18n/useT";
import { formatWhen } from "@/lib/utils";

/** Rows a failed re-read left on screen, said to be from the last read that answered. */
export function StaleRows({
  label,
  since,
  error,
  onRetry,
}: {
  /** What the rows are, as it reads inside a sentence. */
  label: string;
  since: number;
  error: unknown;
  onRetry?: () => void;
}) {
  const t = useT();
  return (
    <Unknown
      className="mb-2"
      question={t("empty", "staleRows", {
        label,
        time: formatWhen(since, "clock"),
      })}
      error={error}
      onRetry={onRetry}
    />
  );
}
