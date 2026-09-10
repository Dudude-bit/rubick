import { useMemo } from "react";

import { Section, SectionHeader } from "@/components/ui/section";
import { pinKey } from "@/lib/my-services";
import { useClusterStore } from "@/stores/clusterStore";
import { usePinnedServicesStore } from "@/stores/pinnedServicesStore";
import { useT } from "@/i18n/useT";

import { ServiceCard } from "./ServiceCard";

/**
 * The first block on the home page: the services a person said were theirs.
 *
 * Membership is never inferred. Nothing here reads what was opened recently,
 * what carries the label somebody's platform team agreed on, or what looks
 * important — a service is here because a human pressed Pin, and it leaves
 * when they press it again. That rule is what makes the block worth trusting
 * at eight in the morning, and a test holds the page to it.
 *
 * The list belongs to the cluster, not to the namespace selector: what is
 * mine stays mine when I narrow the scope to look at something else.
 */
export function MyServices() {
  const t = useT();
  const context = useClusterStore((s) => s.currentContext);
  const pins = usePinnedServicesStore((s) => s.pins);
  const unpin = usePinnedServicesStore((s) => s.unpin);
  const ordered = useMemo(
    () =>
      pins
        .filter((pin) => pin.context === context)
        .sort((a, b) => a.pinnedAt - b.pinnedAt),
    [pins, context]
  );

  if (!context) return null;

  return (
    <Section>
      <SectionHeader
        title={t("services", "myServices")}
        count={ordered.length > 0 ? ordered.length : undefined}
      />
      {ordered.length === 0 ? (
        <div className="rounded border border-dashed border-hair px-4 py-5 text-center">
          <p className="text-xs text-fg-mut">{t("services", "noneYet")}</p>
          <p className="mt-1 text-[11px] text-fg-fnt">
            {t("services", "noneYetHint")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {ordered.map((pin) => (
            <ServiceCard
              key={pinKey(pin)}
              pin={pin}
              onUnpin={() => unpin(context, pinKey(pin))}
            />
          ))}
        </div>
      )}
    </Section>
  );
}
