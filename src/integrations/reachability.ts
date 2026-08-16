/**
 * Why an address a configured integration was given could not be reached —
 * where the shape of the address is itself the answer.
 *
 * The request goes out of **this machine**. It is a plain HTTP client in the
 * app's own process: no port-forward, no tunnel, nothing routed through the
 * cluster's API server. So the address has to be one this laptop can resolve
 * and reach, and the commonest way to get that wrong is the one the app used
 * to suggest in its own placeholder — `http://prometheus.monitoring:9090`.
 *
 * That is a *cluster-internal* name. It is fully qualified inside the
 * cluster, CoreDNS answers it there, and nothing outside has ever heard of
 * it. Typed here it produces `dns error: failed to lookup address
 * information: Name or service not known`, which is true, unhelpful, and
 * says nothing about the one thing that would fix it.
 *
 * So the shape is recognised and named. Nothing here guesses at a working
 * address — it says why this one cannot work and what the two ordinary ways
 * out are.
 */

/**
 * Suffixes a cluster DNS name ends in, and the bare `namespace` form.
 *
 * `svc.cluster.local` is the default cluster domain and the one every chart
 * writes; a cluster installed with `--cluster-domain` uses another and is not
 * matched here, which is the right way round — a missed diagnosis leaves the
 * transport's own message, and a wrong one sends somebody to change a URL
 * that was fine.
 */
const CLUSTER_SUFFIXES = [
  ".svc.cluster.local",
  ".svc.cluster",
  ".svc",
] as const;

/** What a DNS failure looks like from `reqwest`, whichever layer names it. */
const DNS_FAILURE =
  /dns error|failed to lookup address|name or service not known|nodename nor servname|no such host|temporary failure in name resolution/i;

export type Unreachable =
  | { kind: "cluster-dns"; host: string }
  | { kind: "no-scheme"; host: string }
  | null;

/** The host part of whatever was typed, however malformed the rest is. */
function hostOf(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  try {
    return new URL(trimmed).hostname;
  } catch {
    // No scheme is the other common mistake, and `new URL` refuses it
    // outright rather than telling us the host — so take it by hand.
    const withoutPath = trimmed.split("/")[0];
    const host = withoutPath.split(":")[0];
    return host === "" ? null : host;
  }
}

/**
 * Whether this address is one only the cluster can resolve.
 *
 * Two shapes, and both are what a Helm chart's README hands somebody:
 * `prometheus.monitoring.svc.cluster.local` and the short
 * `prometheus.monitoring` that works from a pod in the same cluster because
 * of the search domains in its `resolv.conf`.
 *
 * The short form is the delicate one — `grafana.example.com` has exactly the
 * same shape — so it is only claimed when the reader has **also** just been
 * told the name does not resolve. A public host that does not resolve is a
 * different problem with a different sentence, and it keeps the transport's.
 */
export function unreachable(url: string, reason: string): Unreachable {
  const host = hostOf(url);
  if (host === null) return null;

  const lower = host.toLowerCase();
  if (CLUSTER_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return { kind: "cluster-dns", host };
  }

  if (!DNS_FAILURE.test(reason)) return null;

  // `name.namespace` with a label that is not a public TLD: nothing outside
  // a cluster resolves it, and it did not resolve.
  const labels = lower.split(".");
  if (labels.length === 2 && labels.every((label) => label.length > 0)) {
    return { kind: "cluster-dns", host };
  }
  if (labels.length === 1) {
    return { kind: "cluster-dns", host };
  }

  return null;
}

/**
 * The sentence to show instead of the transport's, where there is one.
 *
 * Deliberately does not replace the original: it is appended to it by the
 * caller, because `dns error: … Name or service not known` is still what
 * happened and somebody searching for it should find it in the app.
 */
export function explain(found: NonNullable<Unreachable>): string {
  switch (found.kind) {
    case "cluster-dns":
      return `${found.host} is a name only the cluster can resolve — this app runs on your machine and asks from here, not from inside the cluster. Either give it an address that reaches it from here (an Ingress hostname, a LoadBalancer address), or forward the port and use that: kubectl port-forward -n <namespace> svc/<service> 9090:9090, then http://localhost:9090.`;
    case "no-scheme":
      return `${found.host} has no scheme — write http:// or https:// in front of it.`;
  }
}
