/**
 * What follows "Prometheus did not answer" anywhere on a page: a way to ask
 * it again, and its Connection tab. A probe's answer is cached and never
 * retried behind the reader's back, so without this a supplier that came
 * back is still reported gone until somebody opens its integration.
 */
import { Link } from "@tanstack/react-router";

import type { CapabilityKey, CapabilityState } from "@/integrations";
import { useT } from "@/i18n/useT";

export function AskAgain<K extends CapabilityKey>({
  power,
}: {
  power: Extract<CapabilityState<K>, { state: "unreachable" }>;
}) {
  const t = useT();
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={power.askAgain}
        disabled={power.asking}
        className="text-info hover:underline disabled:text-fg-fnt disabled:no-underline"
        data-testid="ask-supplier-again"
      >
        {power.asking ? t("action", "probing") : t("action", "askAgain")}
      </button>
      <Link {...power.settings} className="text-info hover:underline">
        {t("action", "supplierConnection", { vendor: power.vendor })}
      </Link>
    </span>
  );
}
