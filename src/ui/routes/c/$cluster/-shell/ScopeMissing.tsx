import { ArrowRight, CircleOff } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useNamespaceList } from "@/hooks/useClusterSummary";
import { listWords } from "@/i18n/say";
import { useT } from "@/i18n/useT";
import { openNamespacePicker } from "@/lib/read-deadline";
import { EmptyPage } from "@/components/ui/empty-page";
import { useClusterStore } from "@/stores/clusterStore";

/** Namespaces the cluster has whose names hold a missing one, or are held in it: "lena" for lena-sandbox. */
function nearNames(
  missing: readonly string[],
  names: readonly string[]
): string[] {
  return names
    .filter((name) =>
      missing.some(
        (gone) => name !== gone && (name.includes(gone) || gone.includes(name))
      )
    )
    .slice(0, 3);
}

function Choices({ missing }: { missing: readonly string[] }) {
  const t = useT();
  const list = useNamespaceList();
  const scope = useClusterStore((s) => s.namespaceScope);
  const setScope = useClusterStore((s) => s.setNamespaceScope);
  const near = nearNames(
    missing,
    (list.data ?? []).map((ns) => ns.name)
  ).filter((name) => !scope.includes(name));
  const kept = scope.filter((name) => !missing.includes(name));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={openNamespacePicker}>
        {t("action", "chooseNamespace")}
      </Button>
      {near.length > 0 && (
        <span className="text-xs text-fg-mut">
          {t("cluster", "scopeMissingNear")}
        </span>
      )}
      {near.map((name) => (
        <Button
          key={name}
          size="sm"
          variant="ghost"
          className="font-mono text-info"
          onClick={() => void setScope([...kept, name])}
        >
          {name}
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Button>
      ))}
    </div>
  );
}

/**
 * The page in place of one that reads the scope, when no namespace of it
 * exists: every list would be empty and every count 0, which is what a quiet
 * namespace looks like and not what a missing one is.
 */
export function ScopeMissingPage({ missing }: { missing: readonly string[] }) {
  const t = useT();
  const said = { n: missing.length, names: listWords(missing, t) };
  return (
    <EmptyPage
      testId="scope-missing-page"
      icon={CircleOff}
      title={t("cluster", "scopeMissingTitle", said)}
      body={t("cluster", "scopeMissingBody", said)}
    >
      <Choices missing={missing} />
    </EmptyPage>
  );
}

/** Above a page that still has something to show: the namespaces of the scope that are not there. */
export function ScopeMissingNotice({
  missing,
}: {
  missing: readonly string[];
}) {
  const t = useT();
  return (
    <Alert variant="warn" className="mb-3" data-testid="scope-missing">
      <CircleOff aria-hidden="true" />
      <div className="flex flex-col gap-1.5">
        <p>
          {t("cluster", "scopeMissingNotice", {
            n: missing.length,
            names: listWords(missing, t),
          })}
        </p>
        <Choices missing={missing} />
      </div>
    </Alert>
  );
}
