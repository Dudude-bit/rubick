/**
 * Everything the app knows about a specific vendor's product, and the only
 * door into it.
 *
 * Kubernetes core is what the kubeconfig already reaches and what every
 * cluster answers for. This tree is the rest: cert-manager, Traefik, Istio,
 * Flux, and the three clouds' spellings of the facts their nodes already
 * carry. A surface asks for a facet and gets an implementation or nothing.
 * It never learns which vendor answered, or whether one did.
 *
 * The name is `integrations/` and it spans all three tiers, including tier
 * one, which is neither detected nor configured. What decides that
 * something lives here is not the tier but one question: *is this knowledge
 * about a specific vendor's product?* See `registry.ts` for the rest of the
 * rule and for what is deliberately outside it.
 *
 * ## Adding a vendor
 *
 * Two files, both in this tree, and nothing anywhere else:
 *
 * 1. `src/integrations/<id>/index.ts` — `defineVendor({ … })` with the
 *    facets it has. Put anything bulky beside it in the same folder:
 *    `crd.ts` for a page of column definitions, a client, a config form.
 * 2. `src/integrations/index.ts` — one import and one entry in
 *    {@link VENDORS}.
 *
 * That is the whole procedure. No surface is edited, no switch statement
 * grows a case, nothing is registered at startup, and no test outside this
 * tree changes — every consumer reads the facet through a derivation below,
 * so a new vendor's labels, columns and marks appear wherever the existing
 * ones already do.
 *
 * Two exceptions, both of which stay inside the tree: a genuinely new
 * *capability* (as opposed to a new supplier of an existing one) adds a key
 * to `Capabilities` in `registry.ts` and needs a surface written to consume
 * it; and a new cluster *flavour* adds a member to `ClusterProvider` there
 * too, because that union is what keeps the mark table exhaustive.
 */

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { commands } from "@/lib/commands";
import aws from "./aws";
import azure from "./azure";
import certManager from "./cert-manager";
import flux from "./flux";
import googleCloud from "./google-cloud";
import istio from "./istio";
import k3s from "./k3s";
import karpenter from "./karpenter";
import minikube from "./minikube";
import traefik from "./traefik";
import type {
  CapabilityKey,
  Capabilities,
  ClusterProvider,
  CrdView,
  Flavour,
  Vendor,
} from "./registry";

export type { CapabilityKey, Capabilities, ClusterProvider, CrdView, Vendor };

/**
 * Every vendor that ships in the binary.
 *
 * A list, not a plugin API: third parties loading code into the app is a
 * different product with a different threat model. Order is meaningful and
 * is the only tie-break in the tree — where two vendors could claim the
 * same node label or the same context name, the earlier one wins, so the
 * more specific vendor goes first.
 */
const VENDORS: Vendor[] = [
  certManager,
  traefik,
  flux,
  istio,
  k3s,
  aws,
  googleCloud,
  karpenter,
  azure,
  minikube,
];

/**
 * What is installed in the connected cluster.
 *
 * One CRD list per cluster, and it does not change while the app is open
 * often enough to be worth polling — an install is a deliberate act, and a
 * reader who has just done one can switch context or reopen.
 */
function useDetected() {
  return useQuery({
    queryKey: ["in-cluster-extensions"],
    queryFn: commands.detectInClusterExtensions,
    staleTime: 5 * 60_000,
  });
}

/**
 * The implementation of a capability, or `null`.
 *
 * `null` is not an error state and the caller must not draw it as one: it
 * is the answer for the majority of clusters, and every surface that asks
 * owes a whole page without it.
 */
export function useCapability<K extends CapabilityKey>(
  key: K
): Capabilities[K] | null {
  const { data } = useDetected();
  if (!data) return null;
  const installed = new Set(
    data.filter((entry) => entry.installed).map((entry) => entry.id)
  );
  const found = VENDORS.find(
    (vendor) =>
      installed.has(vendor.id) && vendor.provides && key in vendor.provides
  );
  return (found?.provides?.[key] as Capabilities[K] | undefined) ?? null;
}

export interface IntegrationStatus {
  vendor: Vendor;
  installed: boolean;
  version: string | null;
}

/**
 * Every vendor whose *capabilities* this cluster could supply, and whether
 * it has them — for the one screen that is allowed to name them.
 *
 * Only vendors with `provides` appear. A vendor whose whole contribution is
 * a CRD view or a node-label spelling has no row here and should not: there
 * is nothing to install for it, nothing to connect, and nothing a reader
 * could do with the knowledge that the app understands Istio's columns.
 */
export function useIntegrations(): {
  statuses: IntegrationStatus[];
  isPending: boolean;
  error: Error | null;
} {
  const { data, isPending, error } = useDetected();
  return {
    statuses: VENDORS.filter((vendor) => vendor.provides).map((vendor) => {
      const detected = data?.find((entry) => entry.id === vendor.id);
      return {
        vendor,
        installed: detected?.installed ?? false,
        version: detected?.version ?? null,
      };
    }),
    isPending,
    error,
  };
}

/**
 * The vendor view for a custom resource's API group, or `null` for the
 * thousands of CRDs nobody here has heard of — which get the CRD's own
 * printer columns, exactly as they did before this tree existed.
 *
 * No detection call: reaching a `cert-manager.io` list page requires the
 * group to exist, so the group is the detection.
 */
export function useCrdView(group: string, kind: string): CrdView | null {
  return useMemo(() => crdViewFor(group, kind), [group, kind]);
}

function crdViewFor(group: string, kind: string): CrdView | null {
  return (
    VENDORS.find((vendor) => vendor.crd?.matches(group, kind))?.crd ?? null
  );
}

/**
 * Every label a vendor uses to name the pool a node was made by, in
 * registry order, so the first hit is the more specific vendor's.
 *
 * Flattened once at module load rather than per node: a forty-node list
 * asks this question forty times and the answer cannot change.
 */
export const NODE_POOL_LABELS: readonly string[] = VENDORS.flatMap(
  (vendor) => vendor.nodeLabels?.pool ?? []
);

/**
 * Every label that means "the cloud may take this node back", with the
 * value that means yes.
 *
 * Only "yes" is listed. `capacityType=ON_DEMAND` and `priority=regular`
 * exist and are not read, because nothing in the app ever states that a
 * node is *not* spot.
 */
export const NODE_SPOT_LABELS: ReadonlyArray<
  readonly [key: string, value: string]
> = VENDORS.flatMap((vendor) => vendor.nodeLabels?.spot ?? []);

/**
 * The cloud that writes a given `spec.providerID` scheme, or `null`.
 *
 * A scheme no vendor here claims is left unnamed rather than guessed at —
 * and plenty of clusters have one, k3s and RKE2 included.
 */
export function cloudOfProviderScheme(scheme: string): string | null {
  const match = VENDORS.find(
    (vendor) => vendor.nodeLabels?.providerScheme?.[0] === scheme
  );
  return match?.nodeLabels?.providerScheme?.[1] ?? null;
}

/**
 * Every flavour a kubeconfig context can be recognised as, in registry
 * order — which is the order they are tested in, most specific vendor
 * first. Deliberately not exported: nothing outside needs the list, only
 * the two answers below.
 */
const FLAVOURS: readonly Flavour[] = VENDORS.flatMap(
  (vendor) => vendor.flavours ?? []
);

/**
 * The flavour whose vendor claims this context name, or `null` for the
 * generic case — a cluster run by somebody this app has never heard of,
 * which is a perfectly ordinary thing for a cluster to be.
 */
export function flavourOfContext(context: string): Flavour | null {
  const name = context.toLowerCase();
  // "aks" inside "peaks-cluster" is not Azure, so markers are matched as
  // whole segments of a name that separates words with -, _, . or :.
  const hasWord = (word: string) =>
    new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`).test(name);
  return FLAVOURS.find((flavour) => flavour.claims(name, hasWord)) ?? null;
}

/** The flavour a provider id names, for the surfaces that hold one already. */
export function flavourOf(provider: ClusterProvider): Flavour | null {
  return FLAVOURS.find((flavour) => flavour.id === provider) ?? null;
}
