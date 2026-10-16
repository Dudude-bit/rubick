import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { useT } from "@/i18n/useT";
import { cn, formatDate } from "@/lib/utils";

/** When a failed pod failed, said beside its word: the pod's age is not the failure's. */
export function EndedAgo({
  at,
  className,
}: {
  at: string;
  className?: string;
}) {
  const t = useT();
  const ago = useRealtimeAge(at);
  return (
    <span
      className={cn("text-[11px] text-fg-mut", className)}
      title={formatDate(at) ?? undefined}
      data-testid="ended-ago"
    >
      {t("readings", "podEndedAgo", { ago })}
    </span>
  );
}
