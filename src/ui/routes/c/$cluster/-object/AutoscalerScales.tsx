import { EyeOff } from "lucide-react";

import { ResourceRef } from "@/components/object/ResourceRef";
import { Skeleton } from "@/components/ui/skeleton";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import { useT } from "@/i18n/useT";
import { autoscalerRange } from "@/lib/governance";
import { crdInGroup } from "@/lib/links";
import { KeyValueList } from "./detail-kv";
import { scaleTargetOf, specOf, type ScaleTarget } from "./scale-target";

/** The scale target as a link, in the group its `apiVersion` names. */
export function ScaleTargetRef({
  target,
  namespace,
}: {
  target: ScaleTarget;
  namespace: string | null;
}) {
  const { crdFor } = useCrdIndex();
  const group = target.apiVersion?.includes("/")
    ? target.apiVersion.split("/")[0]
    : "";
  const crd = target.apiVersion
    ? crdInGroup({ kind: target.kind, group }, crdFor)
    : undefined;
  return (
    <ResourceRef
      kind={target.kind}
      name={target.name}
      namespace={namespace}
      crd={crd}
    />
  );
}

/** What an autoscaler scales and between which bounds, the same on its page and in its peek. */
export function AutoscalerScales({
  object,
  namespace,
  isLoading,
}: {
  object: unknown;
  namespace: string | null;
  isLoading: boolean;
}) {
  const t = useT();
  if (isLoading)
    return (
      <div aria-hidden="true" className="py-[7px]">
        <Skeleton className="h-2.5 w-48" />
      </div>
    );
  if (!object)
    return (
      <p className="flex items-center gap-1.5 text-xs text-warn">
        <EyeOff className="size-3.5 shrink-0" aria-hidden />
        {t("readings", "hpaScaleUnread")}
      </p>
    );
  const target = scaleTargetOf(object);
  if (!target)
    return (
      <p className="text-xs text-fg">{t("readings", "hpaNamesNoTarget")}</p>
    );
  const spec = specOf(object);
  const max = typeof spec.maxReplicas === "number" ? spec.maxReplicas : null;
  const min = typeof spec.minReplicas === "number" ? spec.minReplicas : 1;
  return (
    <KeyValueList
      items={[
        {
          label: t("columns", "hpaScales"),
          value: (
            <>
              <ScaleTargetRef target={target} namespace={namespace} />
              {max !== null && (
                <span className="text-fg-fnt">
                  {" "}
                  · {autoscalerRange({ minReplicas: min, maxReplicas: max }, t)}
                </span>
              )}
            </>
          ),
        },
      ]}
    />
  );
}
