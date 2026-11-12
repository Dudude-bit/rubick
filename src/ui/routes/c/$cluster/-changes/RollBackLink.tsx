import { Undo2 } from "lucide-react";

import { ReasonTip } from "@/components/object/detail-blocks";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

/** "Roll back to this" on an older revision, greyed with the reason where the cluster refuses it. */
export function RollBackLink({
  onClick,
  denied,
  className,
}: {
  onClick: () => void;
  denied?: string;
  className?: string;
}) {
  const t = useT();
  return (
    <ReasonTip reason={denied}>
      <button
        type="button"
        onClick={() => !denied && onClick()}
        aria-disabled={denied ? true : undefined}
        className={cn(
          "inline-flex items-center gap-1 rounded text-info focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info",
          denied ? "cursor-default opacity-40" : "hover:underline",
          className
        )}
      >
        <Undo2 className="h-3 w-3" aria-hidden="true" />
        {t("action", "rollBackToThis")}
      </button>
    </ReasonTip>
  );
}
