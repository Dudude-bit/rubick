import { useState } from "react";
import { AlertTriangle, Info, Layers } from "lucide-react";

import { rulesTable, type Rule } from "../../-object/rbac";
import { WordTable } from "../../-object/WordTable";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section";
import { TextSkeleton } from "@/components/ui/skeleton";
import { Unknown } from "@/components/ui/unknown";
import type { OwnRules } from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { openNamespacePicker } from "@/lib/read-deadline";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * "What can I do here", answered by the cluster for the signed-in user, one
 * namespace at a time: RBAC grants per namespace, so a window on every
 * namespace is asked to pick one rather than answered for an arbitrary one.
 */
export function MyAccess() {
  const t = useT();
  const { scope } = useNamespaceScope();
  const [picked, setPicked] = useState<string | null>(null);
  const namespace =
    picked && scope.includes(picked) ? picked : (scope[0] ?? null);

  return (
    <div className="flex max-w-4xl flex-col gap-[18px]">
      <SectionHeader
        title={t("myAccess", "title")}
        description={t("myAccess", "description")}
      />
      {scope.length > 1 && (
        <div
          role="tablist"
          aria-label={t("cluster", "namespaces")}
          className="flex flex-wrap gap-1.5"
        >
          {scope.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === namespace}
              onClick={() => setPicked(name)}
              className={cn(
                "rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors",
                name === namespace
                  ? "border-info bg-sel text-fg"
                  : "border-hair text-fg-mut hover:bg-hover"
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {namespace ? (
        <RulesIn namespace={namespace} />
      ) : (
        <Alert variant="info">
          <Layers aria-hidden />
          <div className="flex flex-col items-start gap-2">
            <p>{t("myAccess", "perNamespace")}</p>
            <Button size="sm" variant="outline" onClick={openNamespacePicker}>
              {t("action", "chooseNamespace")}
            </Button>
          </div>
        </Alert>
      )}
    </div>
  );
}

const asRule = (rule: OwnRules["rules"][number]): Rule => ({
  apiGroups: rule.apiGroups,
  resources: rule.resources,
  resourceNames: rule.resourceNames,
  nonResourceURLs: rule.nonResourceUrls,
  verbs: rule.verbs,
});

function RulesIn({ namespace }: { namespace: string }) {
  const t = useT();
  const isConnected = useClusterStore((state) => state.isConnected);
  const review = useLiveQuery({
    queryKey: queryKeys.ownRules(namespace),
    queryFn: () => commands.reviewOwnRules(namespace),
    enabled: isConnected,
    refresh: "steady",
  });

  if (review.error && !review.data)
    return (
      <Unknown
        question={t("myAccess", "couldNotAsk", { namespace })}
        error={review.error}
        onRetry={() => void review.refetch()}
      />
    );
  if (!review.data) return <TextSkeleton lines={6} />;
  const { rules, incomplete, evaluationError } = review.data;
  return (
    <div className="flex flex-col gap-3">
      {(incomplete || evaluationError) && (
        <Alert variant="warn">
          <AlertTriangle aria-hidden />
          <div className="flex flex-col gap-1">
            <p>
              {incomplete
                ? t("myAccess", "incomplete")
                : t("myAccess", "evaluationError")}
            </p>
            {evaluationError && (
              <p className="select-text wrap-break-word font-mono text-[11px] text-fg-mut">
                {evaluationError}
              </p>
            )}
          </div>
        </Alert>
      )}
      <SectionHeader
        title={t("myAccess", "rulesIn", { namespace })}
        count={incomplete ? undefined : rules.length}
      />
      <WordTable
        table={rulesTable(rules.map(asRule), t)}
        emptyMessage={
          incomplete ? t("myAccess", "noneListed") : t("myAccess", "none")
        }
      />
      <p className="flex items-start gap-1.5 text-[11px] text-fg-fnt">
        <Info className="mt-px h-3 w-3 flex-none" aria-hidden />
        {t("myAccess", "caveat")}
      </p>
    </div>
  );
}
