import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { claimedByLayer, claimedByTarget } from "../-shell/useCopyLink";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { commands } from "@/lib/commands";
import { servedObjectLink } from "@/lib/links";
import { scopeCacheKey } from "@/lib/namespace-scope";
import { queryKeys } from "@/lib/query-keys";
import { useLineage } from "./ownership";
import type { ServedResource } from "./served";

/**
 * Alt and the arrows move along ownership the way they move through a file
 * tree: up to the owner, down to the first thing owned, sideways to the
 * owner's other objects of this kind. A key that has nowhere to go does
 * nothing; it never guesses.
 */
export function useOwnershipKeys(
  served: ServedResource | null,
  name: string,
  namespace: string | null | undefined
): void {
  const lineage = useLineage(served, name, namespace).data;
  const navigate = useNavigate();
  const client = useQueryClient();
  const scope = useNamespaceScope();

  useEffect(() => {
    if (!lineage) return;
    const dependentsOf = (uid: string) =>
      client.query({
        queryKey: queryKeys.dependents(uid, scopeCacheKey(scope.scope)),
        queryFn: () => commands.listDependents(uid, scope.wire),
      });
    const owner = lineage.ancestors[0];

    const onKey = async (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey)
        return;
      if (claimedByTarget(event.target) || claimedByLayer(event.target)) return;
      const go = (link: ReturnType<typeof servedObjectLink>) => {
        if (link) void navigate(link);
      };
      if (event.key === "ArrowUp" && owner) {
        event.preventDefault();
        go(servedObjectLink(owner));
      } else if (event.key === "ArrowDown" && lineage.uid) {
        event.preventDefault();
        const first = (await dependentsOf(lineage.uid)).dependents[0];
        if (first) go(servedObjectLink(first));
      } else if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        owner &&
        lineage.uid
      ) {
        event.preventDefault();
        const siblings = (await dependentsOf(owner.uid)).dependents;
        const self = siblings.find((entry) => entry.uid === lineage.uid);
        const same = siblings.filter((entry) => entry.kind === self?.kind);
        const at = same.findIndex((entry) => entry.uid === lineage.uid);
        const next = same[at + (event.key === "ArrowRight" ? 1 : -1)];
        if (at !== -1 && next) go(servedObjectLink(next));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lineage, client, navigate, scope.scope, scope.wire]);
}
