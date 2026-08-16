/**
 * Which CRD defines a kind, asked of the cluster rather than guessed.
 *
 * A custom resource is addressed by its CRD's name — `<plural>.<group>` — and
 * every place that wants to link to one holds the two halves that are *not*
 * enough to build it: a group and a kind. The plural cannot be derived. Naive
 * lowercase-and-add-an-s is right for `Application` and wrong for the objects
 * a cluster is most likely to have several of: `NetworkPolicy` pluralises to
 * `networkpolicies`, `Ingress` to `ingresses`, `Gateway` to `gateways` but
 * `GatewayClass` to `gatewayclasses`. A CRD may also declare any plural it
 * likes. So the answer is read from the API server, which is the only thing
 * that knows.
 *
 * One query for the whole app: every surface that resolves a reference shares
 * this cache entry, and the list is nearly static — a CRD arrives when an
 * operator is installed, not while somebody is reading a page.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";

/** Ten minutes: installing an operator is not a thing that happens mid-read. */
const CRDS_STALE_MS = 10 * 60_000;

const key = (group: string, kind: string) => `${group}/${kind}`;

/**
 * The group half of an `apiVersion`. `argoproj.io/v1alpha1` → `argoproj.io`;
 * a core object's `v1` has no group at all, which is the correct answer for
 * the caller — nothing in the core API is a custom resource.
 */
export function groupOf(apiVersion: string | null | undefined): string {
  if (!apiVersion) return "";
  const slash = apiVersion.indexOf("/");
  return slash === -1 ? "" : apiVersion.slice(0, slash);
}

/**
 * `(group, kind)` → the CRD's name, or `null` for anything this cluster has
 * no CRD for.
 *
 * `null` is the ordinary answer, not a failure: most references are to core
 * kinds, and a reference the cluster cannot resolve draws as text rather than
 * as a link to a page that would 404.
 */
export type CrdLookup = (
  group: string | null | undefined,
  kind: string
) => string | null;

export function useCrdIndex(): { crdFor: CrdLookup; isLoading: boolean } {
  const isConnected = useClusterStore((state) => state.isConnected);

  const { data, isLoading } = useQuery({
    queryKey: ["crd-index"],
    queryFn: () => commands.listCrds(null),
    enabled: isConnected,
    staleTime: CRDS_STALE_MS,
    // A cluster with no CRDs is a real cluster; not answering is not worth a
    // retry storm behind a reference nobody may click.
    retry: false,
  });

  const byGroupAndKind = useMemo(() => {
    const index = new Map<string, string>();
    for (const group of data ?? []) {
      for (const crd of group.crds) {
        index.set(key(crd.group, crd.kind), crd.name);
      }
    }
    return index;
  }, [data]);

  const crdFor = useMemo<CrdLookup>(
    () => (group, kind) =>
      group ? (byGroupAndKind.get(key(group, kind)) ?? null) : null,
    [byGroupAndKind]
  );

  return { crdFor, isLoading };
}
