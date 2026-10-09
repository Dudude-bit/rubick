import { StatusBadge } from "@/components/ui/status-badge";
import { useT } from "@/i18n/useT";
import { cronStatusWord } from "@/lib/status-words";

/** A CronJob's Active or Suspended, in the reader's words, coloured by the code. */
export function CronStatusBadge({ suspend }: { suspend: boolean }) {
  const t = useT();
  return (
    <StatusBadge status={suspend ? "Suspended" : "Active"}>
      {cronStatusWord(suspend, t)}
    </StatusBadge>
  );
}
