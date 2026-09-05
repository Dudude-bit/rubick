/**
 * What the Ingresses in front of this object say about themselves.
 *
 * The neighbourhood answer knows which Ingress routes to which Service, on
 * which host and path, and whether `spec.tls` covers that host — so a
 * Deployment page could name *which hostname* reached it and never *what
 * certificate it is served under*. This adds the other half, from the reads
 * the Ingress page already makes: the Ingress objects, the class each asks
 * for, the certificates behind their Secrets, and why those certificates
 * look the way they do.
 *
 * All four are optional to the surface. What is not optional is the
 * difference between not having read something and having failed to — they
 * draw the same nothing, so failures come back as their own list
 * ({@link UnreadIngress}).
 *
 * Cost: one `get_ingress` per Ingress fronting this object, one or two on
 * any real workload, plus one class resolution per distinct class name.
 * Both share the Ingress detail page's query keys, so a reader arriving
 * from there pays for neither.
 */

import { useQueries } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { ResourceType } from "@/lib/resource-registry";
import { STALE_TIMES } from "@/lib/refresh";
import type { RoutedIngress } from "@/lib/connections";
import {
  useCertificateIssuance,
  type Issuance,
} from "./useCertificateIssuance";
import { useTlsCertificates } from "./useTlsCertificates";
import type {
  ObjectRef,
  ResourceConnections,
  TlsCertificate,
} from "@/generated/types";

const refKey = (ref: {
  kind: string;
  namespace: string | null;
  name: string;
}) => `${ref.kind}/${ref.namespace ?? "-"}/${ref.name}`;

/**
 * A read that came back a failure, which is a third thing from a read that
 * has not come back and from one that came back empty.
 *
 * The chain draws the same nothing for a pending read and a failed one — no
 * address under the Ingress hop, no certificate hop, no controller hop.
 * That is honest while a read is in flight, because {@link RoutedIngress}
 * is simply not there yet; for a failed read it is honest and permanent,
 * because `retryTransient` will not ask a verdict twice, so a refused read
 * stays refused for as long as the page is open.
 *
 * So the failure comes out beside the answers rather than being folded into
 * them. A surface may draw it or not, but nothing may state the *absence*
 * of an address, a certificate or a controller on the strength of one.
 */
export interface UnreadIngress {
  /** The Ingress the read was about. */
  ingress: ObjectRef;
  /** Which of its two reads failed: the object, or the class it asks for. */
  what: "ingress" | "class";
  /** The API server's own sentence, with this app's framing taken off. */
  reason: string;
}

export interface IngressRouting {
  routing: Map<string, RoutedIngress>;
  certificates: Map<string, TlsCertificate>;
  issuance: Issuance;
  /** Reads that failed. Empty on every page where nothing did. */
  unread: UnreadIngress[];
}

/**
 * A verdict from the API server: forbidden, unauthorized, no such object.
 *
 * Deliberately not `error-utils`' `isRetryable`, which asks the opposite
 * question by substring over the whole message — and every error about an
 * `ingresses.networking.k8s.io` object contains the word "network", so a flat
 * refusal to read an Ingress reads as a network blip there.
 */
const VERDICT = /(forbidden|unauthorized|not ?found)/i;

/**
 * Ask again only where asking again can change the answer.
 *
 * A verdict is the same the second time, one wasted request per Ingress on
 * the page. A failure to reach one at all is not, and these reads are the
 * difference between a workload page that names the certificate it is served
 * under and one that says nothing about it until somebody reopens the page —
 * so a blip is worth exactly one more ask.
 */
const retryTransient = (attempts: number, error: Error): boolean =>
  attempts < 1 && !VERDICT.test(error.message);

/** Every Ingress that routes to something in this neighbourhood, once each. */
function frontingIngresses(
  conns: ResourceConnections | undefined
): ObjectRef[] {
  if (!conns || conns.subject.kind === "Ingress") return [];
  const seen = new Set<string>();
  return conns.edges.flatMap((edge) => {
    if (edge.relation.verb !== "routes") return [];
    if (edge.from.kind !== "Ingress") return [];
    if (edge.from.existence === "missing") return [];
    const key = refKey(edge.from);
    if (seen.has(key)) return [];
    seen.add(key);
    return [edge.from];
  });
}

export function useIngressRouting(
  conns: ResourceConnections | undefined
): IngressRouting {
  const ingresses = frontingIngresses(conns);

  const read = useQueries({
    queries: ingresses.map((ingress) => ({
      // The Ingress detail page's own key, so the two share one cache entry
      // and arriving from there costs nothing. `useResourceDetail`'s shape —
      // singular, lowercased — and deliberately not
      // `queryKeys.resourceDetail`, which is plural-first and belongs to the
      // lists (`peek-actions.ts` documents the same split): the wrong one
      // here looks like sharing and quietly fetches the Ingress twice.
      queryKey: [
        ResourceType.Ingress.toLowerCase(),
        ingress.namespace ?? "",
        ingress.name,
      ],
      queryFn: () => commands.getIngress(ingress.name, ingress.namespace),
      staleTime: STALE_TIMES.resourceDetail,
      retry: retryTransient,
    })),
  });

  // One resolution per class rather than per Ingress: four Ingresses asking
  // for `nginx` is one question, and `resolve_ingress_class` reads every
  // IngressClass in the cluster to answer it.
  //
  // Built only from reads that have come back. `null` is itself a real class
  // name here — "this Ingress names none" — so a pending `getIngress` must
  // contribute nothing: standing in for it would fire
  // `resolve_ingress_class(null)` and hand back the cluster's default
  // controller before this app knows what the Ingress asked for.
  const classNames = [
    ...new Set(
      read.flatMap((result) => (result.data ? [result.data.className] : []))
    ),
  ];

  const bindings = useQueries({
    queries: classNames.map((className) => ({
      queryKey: ["ingress-class", className],
      queryFn: () => commands.resolveIngressClass(className),
      staleTime: STALE_TIMES.resourceDetail,
      retry: retryTransient,
    })),
  });

  /**
   * The class resolution for one Ingress, or nothing where there is not one
   * yet — never asked about, still in flight, or failed, which the caller
   * tells apart by the result's own `error`.
   *
   * A real answer is never folded into that: an Ingress that genuinely names
   * no class gets back the `IngressClassBinding` the cluster gave it,
   * `requested: null` and all, with `viaDefault` saying whether the default
   * controller picked it up.
   */
  const classResult = (className: string | null) => {
    const index = classNames.indexOf(className);
    return index === -1 ? undefined : bindings[index];
  };

  const routing = new Map<string, RoutedIngress>();
  const unread: UnreadIngress[] = [];
  const secretNames: string[] = [];
  ingresses.forEach((ingress, index) => {
    const result = read[index];
    const info = result?.data;
    if (!info) {
      // A refused or broken read leaves this Ingress out of `routing`, which
      // is right — an empty `addresses` here would say "nothing publishes it",
      // a claim this app has not read anything to back. It is the *silence*
      // that has to be accounted for, and that is what `unread` is.
      if (result?.error) {
        unread.push({
          ingress,
          what: "ingress",
          reason: errorToShow(result.error),
        });
      }
      return;
    }
    const tls = info.tlsConfigs.flatMap((config) =>
      config.secretName
        ? [{ secretName: config.secretName, hosts: config.hosts }]
        : []
    );
    secretNames.push(...tls.map((entry) => entry.secretName));
    const binding = classResult(info.className);
    if (binding?.error) {
      unread.push({
        ingress,
        what: "class",
        reason: errorToShow(binding.error),
      });
    }
    routing.set(refKey(ingress), {
      tls,
      binding: binding?.data ?? null,
      addresses: info.loadBalancerIps,
    });
  });

  // Every routing Ingress is in the subject's own namespace — an Ingress can
  // only name a Service beside it — so one namespace covers all of them.
  const namespace = conns?.subject.namespace ?? undefined;
  const certificates = useTlsCertificates(namespace, secretNames);
  const issuance = useCertificateIssuance(namespace, secretNames);

  return {
    routing,
    certificates: certificates.data ?? new Map(),
    issuance,
    unread,
  };
}
