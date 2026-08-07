import { Link } from "react-router-dom";

import { ClusterList } from "@/components/cluster/ClusterList";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * What a page shows when the window is not on a cluster.
 *
 * It used to be one grey sentence — `Connect to a cluster to view Pods` —
 * which named the state and then stopped, leaving the reader to go and
 * find a control the app could simply have offered. The clusters are
 * already known here, so this is the same list the front door is, and
 * connecting is one click from wherever the reader happened to be.
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
  const contexts = useClusterStore((s) => s.contexts);
  const connect = useClusterStore((s) => s.connect);

  return (
    <div className="flex h-full justify-center px-6 py-12">
      <div className="w-full max-w-[420px]">
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">
          No cluster is connected
        </h2>
        <p className="mt-[3px] text-xs text-fg-mut">
          {resourceLabel
            ? `${resourceLabel} are read from a cluster, and this window is not on one yet.`
            : "This window is not on a cluster yet."}
        </p>

        {contexts.length > 0 ? (
          <div className="mt-5">
            <ClusterList onSelect={connect} autoFocus={false} />
          </div>
        ) : (
          <p className="mt-4 text-[11px] text-fg-fnt">
            Your kubeconfig lists no clusters either.{" "}
            <Link
              to="/"
              className="text-fg-mut underline decoration-dotted underline-offset-2 hover:text-fg"
            >
              See where it was read from
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}
