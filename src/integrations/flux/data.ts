/**
 * What the Flux page reads, and what it costs.
 *
 * Six cluster-wide list calls in parallel, in two queries. Reconcilers and
 * their sources share one: a `Kustomization` reporting `Ready` while its
 * `GitRepository` has not fetched for a week is what this page exists to
 * show, and neither list says it alone. The controllers' own workloads are a
 * separate query because only one tab needs them.
 *
 * Every source kind is optional — a source-only Flux install has no
 * `helmreleases` CRD at all — so a kind the API server does not serve reads
 * as none of that kind, not as a failed read. A kind it would not list is
 * the opposite, and is carried as unread.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import type { CustomResourceInfo } from "@/generated/types";
import type { Saying } from "@/i18n/say";
import { ERROR_CODES, errorCode, errorToShow } from "@/lib/error-utils";
import { failureOf, listOrFailure } from "../ingress";
import { fluxPicture, type FluxPicture, type KindUnread } from "./model";

export const KUSTOMIZATIONS_CRD = "kustomizations.kustomize.toolkit.fluxcd.io";
export const HELM_RELEASES_CRD = "helmreleases.helm.toolkit.fluxcd.io";

/**
 * The source kinds a reconciler can name, and their CRDs.
 *
 * `HelmChart` is deliberately absent: Flux creates one *itself* for every
 * HelmRelease, so listing them would put an object in Sources for every row in
 * Reconcilers that nobody wrote and nobody can fix.
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

/**
 * A kind this API server does not serve is none of that kind, not a failure.
 * Any other failure — a refusal above all — is a list nobody read.
 */
async function listOptional(
  kind: string,
  crd: string,
  unread: KindUnread[]
): Promise<CustomResourceInfo[]> {
  try {
    return await commands.listCustomResources(crd, null, null, null);
  } catch (error) {
    if (errorCode(error) !== ERROR_CODES.NOT_FOUND) {
      unread.push({ kind, crd, reason: errorToShow(error) });
    }
    return [];
  }
}

export async function fetchPicture(): Promise<FluxPicture> {
  const unread: KindUnread[] = [];
  const [kustomizations, helmReleases, ...sources] = await Promise.all([
    commands.listCustomResources(KUSTOMIZATIONS_CRD, null, null, null),
    listOptional("HelmRelease", HELM_RELEASES_CRD, unread),
    ...SOURCE_KINDS.map(([kind, crd]) => listOptional(kind, crd, unread)),
  ]);
  return fluxPicture(
    kustomizations,
    helmReleases,
    SOURCE_KINDS.map(([kind], index) => ({ kind, objects: sources[index] })),
    unread
  );
}

export const PICTURE_KEY = ["flux", "picture"] as const;

/**
 * How many things Flux is reconciling — the sidebar's number, read off the
 * same picture the page draws. Reconcilers rather than every Flux object: a
 * cluster with one Kustomization and four sources is reconciling one thing.
 *
 * Sharing the page's query rather than listing on its own costs four extra
 * lists a minute where Flux is installed and nobody is looking at the page,
 * and nothing at all where somebody is — the page reads the same key.
 */
export function countReconcilers(picture: FluxPicture): number | null {
  if (picture.unread.some((read) => read.kind === "HelmRelease")) return null;
  return picture.reconcilers.length;
}

export function usePicture() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, ...PICTURE_KEY],
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

export interface FluxControllers {
  controllers: FluxController[];
  /** Why the list is empty when it could not be read; null when it was. */
  unread: Saying | null;
}

export async function fetchControllers(): Promise<FluxControllers> {
  const read = await listOrFailure(
    commands.listDeployments({
      namespace: null,
      labelSelector: CONTROLLER_SELECTOR,
      fieldSelector: null,
      limit: null,
    })
  );
  return {
    controllers: read.items
      .map((deployment) => ({
        name: deployment.name,
        namespace: deployment.namespace,
        image: deployment.containers[0]?.image ?? null,
        ready: deployment.replicas.ready,
        desired: deployment.replicas.desired,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    unread: failureOf(read),
  };
}

export function useControllers() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, "flux", "controllers"],
    queryFn: fetchControllers,
    staleTime: FLUX_STALE,
  });
}
