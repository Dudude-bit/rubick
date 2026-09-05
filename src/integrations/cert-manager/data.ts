/**
 * What the cert-manager page reads, and what it costs.
 *
 * Two queries. `Certificate` alone is what the sidebar count needs —
 * `certificateRows` puts down one row per certificate whatever the other
 * kinds say, so `.length` on the raw list is the row count. That split makes
 * the sidebar one cluster-wide list instead of six on every install where
 * nobody has this page open, and opening it costs nothing extra: it asks for
 * the key the row already primed.
 *
 * The other four go together, because a `Certificate` saying `Ready=False`
 * with the sentence explaining it on a `Challenge` three objects below is
 * what this page exists to show. Once the walk is needed at all, every kind
 * it can reach is needed.
 *
 * ## Absent, and unread
 *
 * A kind the API server does not serve reads as *none of those exist*: a
 * CA-only install has no `orders` or `challenges` CRD, and reporting "could
 * not read them" would call a supported configuration broken. That is the
 * only failure allowed to become an empty list.
 *
 * A denial is not an absence. `issuers` and `clusterissuers` ship with every
 * install, so a kubeconfig without cluster-scoped `list clusterissuers` gets
 * nothing back about a cluster that may be signing everything it has — which
 * is how this page once told such a reader that no ClusterIssuer existed.
 * `Certificate` stays unwrapped altogether: its CRD is what detection is, so
 * failing to list it is the page's failure and it says so.
 */

import { useMemo } from "react";

import { useT } from "@/i18n/useT";
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { errorToShow } from "@/lib/error-utils";
import type { CustomResourceInfo, IngressInfo } from "@/generated/types";

import {
  CERTIFICATES_CRD,
  CHALLENGES_CRD,
  CLUSTER_ISSUERS_CRD,
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
 * not answer for.
 *
 * The message is the only signal there is: a Tauri command's rejection
 * crosses the IPC boundary as a string, so the 404 that
 * `list_custom_resources` gets while looking the CRD up arrives here as text.
 * A denial says "forbidden" and a dead connection says neither, which is
 * exactly the line that has to be drawn — and drawing it in the safe
 * direction is deliberate: a message this does not recognise counts as a
 * failed read, so the page says it could not read rather than that there was
 * nothing there.
 */
const NOT_SERVED = /not ?found/i;

async function readKind(kind: string, crd: string): Promise<KindRead> {
  try {
    return {
      items: await commands.listCustomResources(crd, null, null, null),
      unread: null,
      served: true,
    };
  } catch (error) {
    const reason = errorToShow(error);
    if (NOT_SERVED.test(reason)) {
      return { items: [], unread: null, served: false };
    }
    return { items: [], unread: { kind, crd, reason }, served: true };
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
  ingresses: IngressInfo[];
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
      commands.listIngresses(null).catch((): IngressInfo[] => []),
    ]);
  return { requests, orders, challenges, issuers, clusterIssuers, ingresses };
}

export function usePicture(): {
  data: CertPicture | undefined;
  isPending: boolean;
  error: Error | null;
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
      walk.data.ingresses,
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
      unread: [requests, orders, challenges, issuers, clusterIssuers].flatMap(
        (read) => read.unread ?? []
      ),
    };
  }, [certificates.data, walk.data, t]);

  return {
    data,
    isPending: certificates.isPending || walk.isPending,
    error: certificates.error ?? walk.error,
  };
}
