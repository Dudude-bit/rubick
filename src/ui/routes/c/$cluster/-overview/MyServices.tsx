import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Pin } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { listLink } from "@/lib/links";
import { pinKey, pinsOf } from "@/lib/my-services";
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
  const ordered = useMemo(() => pinsOf(pins, context), [pins, context]);

  if (!context) return null;

  return (
    <Section>
      <SectionHeader
        title={t("services", "myServices")}
        count={ordered.length > 0 ? ordered.length : undefined}
      />
      {ordered.length === 0 ? (
        // Plain words, not the dashed box: in this app a dashed border is
        // what "could not be read" wears, and the home page opened with one
        // over a list that is simply empty.
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="flex min-w-0 items-start gap-1.5 text-xs text-fg-mut">
            <Pin
              aria-hidden="true"
              className="mt-px h-3.5 w-3.5 flex-none text-info"
            />
            {t("services", "noneYetHint")}
          </p>
          <Link
            {...listLink("Deployment")}
            className="inline-flex flex-none items-center gap-1 text-xs text-info hover:underline"
          >
            {t("services", "pickOneToPin")}
            <ArrowRight aria-hidden="true" className="h-3 w-3" />
          </Link>
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
