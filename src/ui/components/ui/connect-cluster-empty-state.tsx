import { Link } from "@tanstack/react-router";

import { ClusterList } from "@/components/cluster/ClusterList";
import { useClusterFilter } from "@/hooks/useClusterFilter";
import { useOpenCluster } from "@/hooks/useOpenCluster";
import { EmptyPage } from "@/components/ui/empty-page";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";

/**
 * What a page shows when the window is not on a cluster.
 *
 * The clusters are already known here, so this is the same list the front
 * door shows, and connecting is one click from wherever the reader was
 * rather than a sentence naming a control they have to go and find.
 *
 * Focus is deliberately not taken: this is a pane inside a page, not the
 * screen, and a list that grabs the caret would fight the tab strip.
 */
export function ConnectClusterEmptyState({
  resourceLabel,
}: {
  /** What this page would have shown, in its own plural. */
  resourceLabel?: string;
}) {
  const t = useT();
  const contexts = useClusterStore((s) => s.contexts);
  const openCluster = useOpenCluster();
  // Its own needle: this pane and the front door are never on screen at the
  // same time, so there is nothing to share a box with.
  const cluster = useClusterFilter();

  return (
    <EmptyPage
      title={t("empty", "noClusterIsConnected")}
      body={
        resourceLabel
          ? // Callers hand this label in whichever case their page title
            // uses, and it starts a sentence here.
            t("empty", "kindReadFromCluster", {
              kind: `${resourceLabel[0].toUpperCase()}${resourceLabel.slice(1)}`,
            })
          : t("empty", "notOnClusterYet")
      }
    >
      {contexts.length > 0 ? (
        <div className="w-full">
          <ClusterList
            contexts={cluster.shown}
            total={cluster.total}
            filter={cluster.filter}
            onFilterChange={cluster.setFilter}
            query={cluster.query}
            inputRef={cluster.inputRef}
            onSelect={openCluster}
            autoFocus={false}
          />
        </div>
      ) : (
        <p className="text-caption text-fg-fnt">
          {t("empty", "kubeconfigListsNoClusters")}{" "}
          <Link
            to="/"
            className="text-fg-mut underline decoration-dotted underline-offset-2 hover:text-fg"
          >
            {t("empty", "seeWhereReadFrom")}
          </Link>
          .
        </p>
      )}
    </EmptyPage>
  );
}
