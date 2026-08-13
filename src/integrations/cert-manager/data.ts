/**
 * What the cert-manager page reads, and what it costs.
 *
 * Two queries, not the one this used to be. `Certificate` is the whole of
 * what a sidebar count needs — `certificateRows` puts down exactly one row
 * per certificate whatever the other three kinds say, so `.length` on the
 * raw list is always the row count, and the walk that explains *why* one is
 * stuck is not part of that arithmetic. Splitting the read the way Traefik's
 * page does turns the sidebar's number into one cluster-wide list instead of
 * six, on every cluster with cert-manager installed and nobody looking at
 * this page. Opening the page does not pay for the split: it asks for the
 * same key the row already primed, so that list is never read twice.
 *
 * The other four are one query together, because they answer to a different
 * rule than the count does. A `Certificate` saying `Ready=False` with the
 * sentence that explains it sitting on a `Challenge` three objects below is
 * exactly the state this page exists to show, and it cannot be drawn from
 * the certificates alone — so once the page needs the walk at all, it needs
 * every kind the walk can reach, still fetched together.
 *
 * ## Absent, and unread
 *
 * A kind the API server does not serve reads as *none of those exist*, which
 * is what it means: a cert-manager install with no ACME issuer has no
 * `orders` or `challenges` CRD at all, and a page reporting "could not read
 * them" on a perfectly good CA-only install would be calling a supported
 * configuration broken.
 *
 * That is the only failure allowed to become an empty list. A denial and a
 * broken connection are *not* absences, and the four kinds are not equally
 * optional: `issuers` and `clusterissuers` ship with every install, so a
 * kubeconfig without cluster-scoped `list clusterissuers` gets nothing back
 * about a cluster that may be signing everything it has — and swallowing that
 * is how this page came to tell such a reader, in as many words, that no
 * ClusterIssuer existed. So the three are told apart here and the page says
 * which it is looking at.
 *
 * `Certificate` itself stays unwrapped altogether: its CRD is what detection
 * is, so any failure to list it is the page's failure and it says so instead
 * of drawing an empty list.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import type { CustomResourceInfo } from "@/generated/types";

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
}

async function fetchWalkSources(): Promise<WalkSources> {
  const [requests, orders, challenges, issuers, clusterIssuers] =
    await Promise.all([
      readKind("CertificateRequest", REQUESTS_CRD),
      readKind("Order", ORDERS_CRD),
      readKind("Challenge", CHALLENGES_CRD),
      readKind("Issuer", ISSUERS_CRD),
      readKind("ClusterIssuer", CLUSTER_ISSUERS_CRD),
    ]);
  return { requests, orders, challenges, issuers, clusterIssuers };
}

export function usePicture(): {
  data: CertPicture | undefined;
  isPending: boolean;
  error: Error | null;
} {
  const certificates = useQuery({
    queryKey: CERTIFICATES_KEY,
    queryFn: fetchCertificates,
    staleTime: CERT_MANAGER_STALE,
  });
  const walk = useQuery({
    queryKey: WALK_SOURCES_KEY,
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
      challenges.items
    );
    return {
      certificates: rows,
      issuers: issuerRows(issuers.items, clusterIssuers.items, rows),
      acme: orders.served || challenges.served,
      unread: [requests, orders, challenges, issuers, clusterIssuers].flatMap(
        (read) => read.unread ?? []
      ),
    };
  }, [certificates.data, walk.data]);

  return {
    data,
    isPending: certificates.isPending || walk.isPending,
    error: certificates.error ?? walk.error,
  };
}
