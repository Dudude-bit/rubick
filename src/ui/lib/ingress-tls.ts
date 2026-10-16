import type { IngressTls } from "@/integrations";

/**
 * Whether one host of an Ingress is served over TLS, `null` where that is not
 * known: `spec.tls` and what the controllers said, read one way everywhere.
 *
 * `spec.tls` wins over a controller that only adds to it, a cloud naming its
 * certificate in an annotation, and loses to one whose answer replaces it:
 * Traefik reads that field for certificates only.
 */
export function hostTls(
  spec: boolean,
  said: IngressTls | null,
  unread: boolean
): boolean | null {
  if (said?.replacesSpec) return said.terminated;
  if (spec) return true;
  if (said) return said.terminated;
  return unread ? null : false;
}

/** {@link hostTls} for one host of an Ingress a route edge names. */
export type RouteTls = (
  ingress: { namespace: string | null; name: string },
  host: string,
  spec: boolean
) => boolean | null;
