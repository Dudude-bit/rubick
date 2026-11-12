import { TriangleAlert } from "lucide-react";

import { useT } from "@/i18n/useT";

/**
 * The block every confirmation on a critical cluster opens with. Loud on
 * purpose: the point is to notice which cluster this is before reading
 * what the button does.
 */
export function CriticalNotice({ context }: { context: string }) {
  const t = useT();
  return (
    <div
      role="alert"
      className="rounded-md border border-err/50 bg-err/10 px-3 py-2 text-xs text-fg"
    >
      <p className="flex items-center gap-2 font-semibold uppercase tracking-[0.05em] text-err">
        <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
        {t("cluster", "criticalNoticeTitle")}
      </p>
      <p className="mt-1">{t("cluster", "criticalNoticeBody", { context })}</p>
    </div>
  );
}
