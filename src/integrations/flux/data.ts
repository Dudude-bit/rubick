/**
 * What the Flux page reads, and what it costs.
 *
 * Six cluster-wide list calls, made in parallel and split into two queries:
 * the reconcilers and their sources are one picture and are useless apart —
 * a `Kustomization` reporting `Ready` while its `GitRepository` has not
 * fetched for a week is precisely the state this page exists to show, and it
 * cannot be drawn from either list alone. The controllers' own workloads are
 * a separate query, because only one tab needs them.
 *
 * Every one of the source kinds is optional. A source-only Flux install has
 * no `helmreleases` CRD at all, and a page that reported "could not read
 * them" on a perfectly good install would be calling a supported
 * configuration broken — so a kind the API server does not serve reads as
 * *none of those exist*, which is what it means.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import type { CustomResourceInfo } from "@/generated/types";
import { fluxPicture, type FluxPicture } from "./model";

export const KUSTOMIZATIONS_CRD = "kustomizations.kustomize.toolkit.fluxcd.io";
export const HELM_RELEASES_CRD = "helmreleases.helm.toolkit.fluxcd.io";

/**
 * The source kinds a reconciler can name, and their CRDs.
 *
 * `HelmChart` is deliberately absent. Flux creates one *itself* for every
 * HelmRelease, so listing them would put an object in Sources for every row in
 * Reconcilers that nobody wrote and nobody can fix — inventory that reads as
 * configuration.
 */
export const SOURCE_KINDS: ReadonlyArray<[kind: string, crd: string]> = [
  ["GitRepository", "gitrepositories.source.toolkit.fluxcd.io"],
  ["OCIRepository", "ocirepositories.source.toolkit.fluxcd.io"],
  ["HelmRepository", "helmrepositories.source.toolkit.fluxcd.io"],
  ["Bucket", "buckets.source.toolkit.fluxcd.io"],
];

/** Every Flux controller carries this on its own workload. */
const CONTROLLER_SELECTOR = "app.kubernetes.io/part-of=flux";

export const FLUX_STALE = 60_000;

/** A kind this API server does not serve is none of that kind, not a failure. */
function listOptional(crd: string): Promise<CustomResourceInfo[]> {
  return commands
    .listCustomResources(crd, null, null, null)
    .catch((): CustomResourceInfo[] => []);
}

export async function fetchPicture(): Promise<FluxPicture> {
  const [kustomizations, helmReleases, ...sources] = await Promise.all([
    commands.listCustomResources(KUSTOMIZATIONS_CRD, null, null, null),
    listOptional(HELM_RELEASES_CRD),
    ...SOURCE_KINDS.map(([, crd]) => listOptional(crd)),
  ]);
  return fluxPicture(
    kustomizations,
    helmReleases,
    SOURCE_KINDS.map(([kind], index) => ({ kind, objects: sources[index] }))
  );
}

export const PICTURE_KEY = ["flux", "picture"] as const;

/**
 * How many things Flux is reconciling — the sidebar's number, read off the
 * same picture the page draws.
 *
 * Reconcilers rather than every Flux object: the page lists what is being
 * applied, and a cluster with one Kustomization and four sources is
 * reconciling one thing.
 *
 * This used to be its own two list calls, which was cheaper in isolation and
 * more expensive in practice — the reader who opened the page paid for those
 * two lists twice. Sharing the page's query costs four extra lists a minute on
 * a cluster that has Flux and nobody looking at it, and nothing at all on one
 * where somebody is.
 */
export function countReconcilers(picture: FluxPicture): number {
  return picture.reconcilers.length;
}

export function usePicture() {
  return useQuery({
    queryKey: PICTURE_KEY,
    queryFn: fetchPicture,
    staleTime: FLUX_STALE,
  });
}

export interface FluxController {
  name: string;
  namespace: string;
  image: string | null;
  ready: number;
  desired: number;
}

export function useControllers() {
  return useQuery({
    queryKey: ["flux", "controllers"],
    queryFn: async (): Promise<FluxController[]> => {
      const deployments = await commands
        .listDeployments({
          namespace: null,
          labelSelector: CONTROLLER_SELECTOR,
          fieldSelector: null,
          limit: null,
        })
        .catch(() => []);
      return deployments
        .map((deployment) => ({
          name: deployment.name,
          namespace: deployment.namespace,
          image: deployment.containers[0]?.image ?? null,
          ready: deployment.replicas.ready,
          desired: deployment.replicas.desired,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    staleTime: FLUX_STALE,
  });
}
