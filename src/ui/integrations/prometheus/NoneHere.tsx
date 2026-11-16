import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useT } from "@/i18n/useT";
import { useClusterStore } from "@/stores/clusterStore";

export function NoneHere({
  inCluster,
  inScope,
}: {
  inCluster: string;
  inScope: string;
}) {
  const t = useT();
  const { isAll } = useNamespaceScope();
  const setScope = useClusterStore((state) => state.setNamespaceScope);
  return (
    <EmptyState
      className="py-6"
      action={
        isAll ? undefined : (
          <Button variant="outline" size="sm" onClick={() => void setScope([])}>
            {t("monitors", "showAllNamespaces")}
          </Button>
        )
      }
    >
      {isAll ? inCluster : inScope}
    </EmptyState>
  );
}
