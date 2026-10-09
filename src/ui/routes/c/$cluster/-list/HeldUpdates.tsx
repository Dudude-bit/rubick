import { ArrowUpToLine } from "lucide-react";

import { useT } from "@/i18n/useT";

/** What arrived while a live list held still, one click from being shown. */
export function HeldUpdates({ n, onShow }: { n: number; onShow: () => void }) {
  const t = useT();
  if (n === 0) return null;
  return (
    <button
      type="button"
      onClick={onShow}
      title={t("hints", "eventsHeld")}
      className="inline-flex h-6 items-center gap-1.5 rounded px-1.5 text-[11px] text-info transition-colors hover:bg-hover"
    >
      <ArrowUpToLine className="h-3 w-3" aria-hidden="true" />
      {t("count", "eventsWaiting", { n })}
    </button>
  );
}
