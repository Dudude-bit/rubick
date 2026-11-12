/**
 * What the cert-manager page reads, and what it costs.
 *
 * Two queries. `Certificate` alone is what the sidebar count needs —
 * `certificateRows` puts down one row per certificate whatever the other
 * kinds say, so `.length` on the raw list is the row count. The sidebar
 * therefore costs one cluster-wide list instead of six, and opening the page
 * costs nothing extra: it asks for the key the row already primed.
 *
 * The other four go together, because a `Certificate` saying `Ready=False`
 * has the sentence explaining it on a `Challenge` three objects below. Once
 * the walk is needed at all, every kind it can reach is needed.
 *
 * A kind the API server does not serve reads as *none of those exist*: a
 * CA-only install has no `orders` or `challenges` CRD, and reporting "could
 * not read them" would call a supported configuration broken. That is the
 * only failure allowed to become an empty list.
 *
 * A denial is not an absence. `issuers` and `clusterissuers` ship with every
 * install, so a kubeconfig without cluster-scoped `list clusterissuers` must
 * not be told that no ClusterIssuer exists. `Certificate` stays unwrapped
 * altogether: its CRD is what detection is, so failing to list it is the
 * page's failure and it says so.
 */

import { useMemo } from "react";

import { useT } from "@/i18n/useT";
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { ERROR_CODES, errorCode, errorToShow } from "@/lib/error-utils";
import type { CustomResourceInfo, IngressInfo } from "@/generated/types";

import {
  CERTIFICATES_CRD,
  CHALLENGES_CRD,
  CLUSTER_ISSUERS_CRD,
  INGRESSES,
  ISSUERS_CRD,
  ORDERS_CRD,
  REQUESTS_CRD,
  certificateRows,
  issuerRows,
  type CertPicture,
  type UnreadKind,
} from "./model";

/** The sidebar's own key — shared with the page, so opening it after the row
 *  has already been drawn costs nothing for this half of the picture. */
export const CERTIFICATES_KEY = ["cert-manager", "certificates"] as const;
const WALK_SOURCES_KEY = ["cert-manager", "walk-sources"] as const;

/**
 * A minute, matching the Integrations pane. The page is opened and read, not
 * watched: a renewal takes minutes to move and nothing here is a number that
 * changes while somebody looks at it.
 */
export const CERT_MANAGER_STALE = 60_000;

/** One kind, and what came back when this cluster was asked for it. */
export interface KindRead {
  /** Every object the API server served. Empty where it served none — and
   *  empty where it was never asked, which {@link unread} is what tells
   *  apart. */
  items: CustomResourceInfo[];
  /** Set where the read failed. `items` is then empty and means nothing. */
  unread: UnreadKind | null;
  /** False only where the API server said it serves no such kind. A read that
   *  failed says nothing either way and leaves this alone. */
  served: boolean;
}

/**
 * A kind the API server does not serve, as against one it would not or could
 * not answer for, told apart by the error's code and never by its words: a
 * 403 may end in `clusterrole "x" not found`, and filing that as "not served"
 * says a cluster has no Issuer because nobody was allowed to look. A code
 * this does not recognise counts as a failed read.
 */
async function readKind(kind: string, crd: string): Promise<KindRead> {
  try {
    return {
      items: await commands.listCustomResources(crd, null, null, null),
      unread: null,
      served: true,
    };
  } catch (error) {
    if (errorCode(error) === ERROR_CODES.NOT_FOUND) {
      return { items: [], unread: null, served: false };
    }
    return {
      items: [],
      unread: { kind, crd, reason: errorToShow(error) },
      served: true,
    };
  }
}

export function fetchCertificates(): Promise<CustomResourceInfo[]> {
  return commands.listCustomResources(CERTIFICATES_CRD, null, null, null);
}

interface WalkSources {
  requests: KindRead;
  orders: KindRead;
  challenges: KindRead;
  issuers: KindRead;
  clusterIssuers: KindRead;
  /**
   * What mounts the Secrets these certificates write, so a row can say which
   * hostnames it is serving. A `Certificate` names nothing that uses it — the
   * reference runs the other way — and without this the page could say thirty
   * days were left and not which address would stop working.
   */
  ingresses: { items: IngressInfo[] | null; unread: UnreadKind | null };
}

/** The Ingresses, or `null` and why: a failed list is not "none mounts it". */
async function readIngresses(): Promise<WalkSources["ingresses"]> {
  try {
    return { items: await commands.listIngresses(null), unread: null };
  } catch (error) {
    return {
      items: null,
      unread: {
        kind: "Ingress",
        crd: INGRESSES,
        reason: errorToShow(error),
      },
    };
  }
}

async function fetchWalkSources(): Promise<WalkSources> {
  const [requests, orders, challenges, issuers, clusterIssuers, ingresses] =
    await Promise.all([
      readKind("CertificateRequest", REQUESTS_CRD),
      readKind("Order", ORDERS_CRD),
      readKind("Challenge", CHALLENGES_CRD),
      readKind("Issuer", ISSUERS_CRD),
      readKind("ClusterIssuer", CLUSTER_ISSUERS_CRD),
      // A failure here costs the page the hosts column and nothing else, so
      // it is not allowed to take the certificates down with it.
      readIngresses(),
    ]);
  return { requests, orders, challenges, issuers, clusterIssuers, ingresses };
}

export function usePicture(): {
  data: CertPicture | undefined;
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const t = useT();
  // The context first, the page's key after — the same composed key the
  // sidebar row uses, so the two still share one cache entry and cluster B
  // never reads cluster A's certificates.
  const context = useClusterStore((state) => state.currentContext);
  const certificates = useQuery({
    queryKey: [context, ...CERTIFICATES_KEY],
    queryFn: fetchCertificates,
    staleTime: CERT_MANAGER_STALE,
  });
  const walk = useQuery({
    queryKey: [context, ...WALK_SOURCES_KEY],
    queryFn: fetchWalkSources,
    staleTime: CERT_MANAGER_STALE,
  });

  const data = useMemo((): CertPicture | undefined => {
    if (!certificates.data || !walk.data) return undefined;
    const { requests, orders, challenges, issuers, clusterIssuers } = walk.data;
    const rows = certificateRows(
      certificates.data,
      requests.items,
      orders.items,
      challenges.items,
      t,
      walk.data.ingresses.items,
      // Only a cluster with no routing CRDs at all may be told a certificate
      // is used by nothing: a Traefik `IngressRoute` mounts Secrets too, and
      // this page must not import Traefik to find out. Left false, the row
      // says "no Ingress mounts it" — which is exactly what was checked.
      false
    );
    return {
      certificates: rows,
      issuers: issuerRows(issuers.items, clusterIssuers.items, rows),
      acme: orders.served || challenges.served,
      unread: [
        requests,
        orders,
        challenges,
        issuers,
        clusterIssuers,
        walk.data.ingresses,
      ].flatMap((read) => read.unread ?? []),
    };
  }, [certificates.data, walk.data, t]);

  return {
    data,
    isPending: certificates.isPending || walk.isPending,
    error: certificates.error ?? walk.error,
    refetch: () => {
      void certificates.refetch();
      void walk.refetch();
    },
  };
}
