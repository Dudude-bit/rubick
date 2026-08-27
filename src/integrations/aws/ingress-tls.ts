/**
 * Whether an ALB Ingress serves a host over TLS.
 *
 * The AWS Load Balancer Controller **does not read `spec.tls` at all** — the
 * certificate is an ACM ARN in an annotation, or one the controller
 * discovers in ACM by matching the Ingress's own hostnames. So every ALB
 * Ingress in the app read as plain HTTP, on the list, on its page, in the
 * peek and in the traffic chain of every workload behind it, and every URL
 * offered for one was `http://`.
 *
 * Discovery is the case worth being careful about. The controller looks in
 * ACM, which this app cannot see, so an Ingress with no `certificate-arn` may
 * still be serving HTTPS — and claiming it is not would be the same wrong
 * sentence in the other direction. What settles it without guessing is the
 * listener set: `listen-ports` naming HTTPS, or an `ssl-redirect` that only
 * does anything when there is a listener to redirect to.
 */

import { commands } from "@/lib/commands";
import type { Saying } from "@/i18n/say";
import type { IngressTls } from "../registry";

const PREFIX = "alb.ingress.kubernetes.io/";
const CERTIFICATE_ARN = `${PREFIX}certificate-arn`;
const LISTEN_PORTS = `${PREFIX}listen-ports`;
const SSL_REDIRECT = `${PREFIX}ssl-redirect`;
const INGRESS_CLASS_ANNOTATION = "kubernetes.io/ingress.class";

/** The classes this controller answers to, by name. */
const ALB_CLASSES = new Set(["alb"]);

export function claimsIngress(ingress: {
  className: string | null;
  annotations: Record<string, string>;
}): boolean {
  const annotated = ingress.annotations[INGRESS_CLASS_ANNOTATION];
  if (annotated !== undefined) return ALB_CLASSES.has(annotated);
  return ingress.className !== null && ALB_CLASSES.has(ingress.className);
}

/** The last segment of an ACM ARN, which is what a reader recognises. */
function certificateLabel(arn: string): Saying {
  const first = arn.split(",")[0]?.trim() ?? arn;
  const tail = first.split("/").pop();
  return tail
    ? { key: "awsAcmNamed", values: { name: tail } }
    : { key: "awsAcmCertificate" };
}

/**
 * Whether the listener set includes an HTTPS one.
 *
 * `listen-ports` is JSON — `[{"HTTP": 80}, {"HTTPS": 443}]` — and its default
 * when unset is HTTP on 80 alone. So an Ingress that names no HTTPS listener
 * and no certificate is genuinely serving plain HTTP, and that is worth
 * saying rather than staying silent about.
 */
function listensOnHttps(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        Object.keys(entry).some((key) => key.toUpperCase() === "HTTPS")
    );
  } catch {
    return null;
  }
}

export async function ingressTls(
  wanted: Array<{ namespace: string; name: string; hosts: string[] }>
): Promise<IngressTls[][]> {
  // One `get` per Ingress the caller named, and never one per host. A list
  // page asks for every row at once; a detail page asks for one.
  return Promise.all(wanted.map((input) => answerFor(input).catch(() => [])));
}

async function answerFor(input: {
  namespace: string;
  name: string;
  hosts: string[];
}): Promise<IngressTls[]> {
  const ingress = await commands.getIngress(input.name, input.namespace);
  if (!claimsIngress(ingress)) return [];

  const arn = ingress.annotations[CERTIFICATE_ARN];
  const https = listensOnHttps(ingress.annotations[LISTEN_PORTS]);
  const redirects = ingress.annotations[SSL_REDIRECT] !== undefined;

  const answer = (terminated: boolean, by: Saying): IngressTls[] =>
    input.hosts.map((host) => ({ host, terminated, by }));

  if (arn !== undefined && arn !== "")
    return answer(true, certificateLabel(arn));
  if (https === true || redirects) {
    // No ARN written down, and the listener set says HTTPS. The controller
    // discovers the certificate in ACM by hostname, which this app cannot
    // read — so the fact is stated and its source is not invented.
    return answer(true, { key: "awsAcmDiscovered" });
  }
  if (https === false) return answer(false, { key: "awsHttpOnly" });
  // Nothing said either way. `spec.tls` keeps the last word rather than this
  // guessing at a certificate in an account it cannot see.
  return [];
}
