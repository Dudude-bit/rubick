import { Replace } from "lucide-react";

import { ResourceRef } from "@/components/object/ResourceRef";
import type { PodInfo } from "@/generated/types";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

/** That a pod's controller already started another in its place, naming it, as the Overview's "already replaced" says. */
export function ReplacedNote({
  pod,
  className,
}: {
  pod: Pick<PodInfo, "namespace" | "ownerReferences" | "status">;
  className?: string;
}) {
  const t = useT();
  if (pod.status.gone !== "replaced") return null;
  const owner = pod.ownerReferences.find((ref) => ref.controller);
  return (
    <p
      className={cn("flex items-start gap-2 text-xs text-fg-mut", className)}
      data-testid="replaced-note"
    >
      <Replace className="mt-0.5 h-3 w-3 flex-none" aria-hidden="true" />
      <span className="min-w-0">
        {owner
          ? parts(t("readings", "podReplaced"), {
              owner: (
                <ResourceRef
                  kind={owner.kind}
                  name={owner.name}
                  namespace={pod.namespace}
                  showKind={false}
                />
              ),
            })
          : t("statusMeaning", "replaced")}
      </span>
    </p>
  );
}
