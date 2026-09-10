import { Pin, PinOff } from "lucide-react";

import { DetailAction } from "@/components/resources/detail-blocks";
import { useToast } from "@/components/ui/use-toast";
import { MAX_PINNED_PER_CONTEXT, pinKey } from "@/lib/my-services";
import { useClusterStore } from "@/stores/clusterStore";
import { usePinnedServicesStore } from "@/stores/pinnedServicesStore";
import { useT } from "@/i18n/useT";

/**
 * The only way onto the home page, and the only way off it.
 *
 * A refusal at the cap says which cluster is full rather than dropping the
 * oldest thing somebody chose to keep an eye on: which one to give up is
 * their call.
 */
export function PinAction({
  kind,
  namespace,
  name,
}: {
  kind: string;
  /** Undefined while the route params are not resolved; nothing to pin yet. */
  namespace: string | undefined;
  name: string | undefined;
}) {
  const t = useT();
  const { toast } = useToast();
  const context = useClusterStore((s) => s.currentContext);
  const pins = usePinnedServicesStore((s) => s.pins);
  const pin = usePinnedServicesStore((s) => s.pin);
  const unpin = usePinnedServicesStore((s) => s.unpin);

  const key = namespace && name ? pinKey({ kind, namespace, name }) : null;
  const pinned = pins.some(
    (entry) => entry.context === context && pinKey(entry) === key
  );

  if (!context || !namespace || !name || key === null) return null;

  return (
    <DetailAction
      label={pinned ? t("services", "unpin") : t("services", "pin")}
      icon={pinned ? PinOff : Pin}
      onClick={() => {
        if (pinned) {
          unpin(context, key);
          return;
        }
        const outcome = pin({
          context,
          kind,
          namespace,
          name,
          pinnedAt: Date.now(),
        });
        if (outcome === "full") {
          toast({
            title: t("services", "pinsFull", { n: MAX_PINNED_PER_CONTEXT }),
            description: t("services", "pinsFullHint"),
            variant: "destructive",
          });
        }
      }}
    />
  );
}
