import { commands } from "@/lib/commands";
import type { IngressTls } from "../registry";
import { BACKING_NOT_READ } from "../ingress";
import { fetchController } from "./data";
import { allRoutes, routeIsSecure } from "./model";

/**
 * Whether Traefik serves these Ingresses' hosts over TLS, which `spec.tls`
 * does not settle: Traefik loads a certificate from that field and makes a
 * router TLS only through `router.tls` or a TLS entry point. So the answer
 * replaces the field's rather than adding to it, and only for the Ingresses
 * Traefik claims.
 */
export async function ingressTls(
  wanted: Array<{ namespace: string; name: string; hosts: string[] }>
): Promise<IngressTls[][]> {
  const [ingresses, binding, controller] = await Promise.all([
    commands.listIngresses(null),
    commands.resolveIngressClass(null),
    fetchController().catch(() => null),
  ]);
  // Unread entry points leave a router that does not ask for TLS itself
  // unknown, never plain.
  const entryPoints = controller?.entryPoints ?? [];
  const routes = allRoutes({
    ingresses,
    ingressRoutes: [],
    middlewares: [],
    classes: binding.available,
    ...BACKING_NOT_READ,
    entryPoints,
  });

  return wanted.map((input) =>
    input.hosts.flatMap((host): IngressTls[] => {
      const mine = routes.filter(
        (route) =>
          route.source.namespace === input.namespace &&
          route.source.name === input.name &&
          route.clause.host === host
      );
      if (mine.length === 0) return [];
      const verdicts = mine.map((route) => routeIsSecure(route, entryPoints));
      const terminated = verdicts.includes(true)
        ? true
        : verdicts.includes(null)
          ? null
          : false;
      const secret = mine.find((route) => route.tlsSecret)?.tlsSecret;
      return [
        {
          host,
          terminated,
          by:
            terminated === false
              ? { key: "traefikTlsNotServed" }
              : secret
                ? { key: "verbatimLine", values: { said: secret } }
                : { key: "traefikPickedCertificate" },
          replacesSpec: true,
        },
      ];
    })
  );
}
