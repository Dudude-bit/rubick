/**
 * What Traefik is doing for this cluster right now.
 *
 * The IngressClasses matter as much as the route count: an Ingress that
 * names a class nothing claims is correct YAML with no events and no
 * error, and is simply never served. Saying which classes this proxy
 * answers for is the shortest form of "why is my Ingress not picked up".
 *
 * The row counts *hosts* rather than IngressRoutes, because that is what
 * "Show them" now opens onto. A k3d cluster's Traefik commonly owns no
 * IngressRoute at all and serves a dozen plain Ingresses, and a row reading
 * "0 IngressRoutes · Show them" over a page with a dozen hosts on it would
 * be the pane contradicting the screen it links to.
 */

import { integrationPagePath } from "../paths";
import type { VendorFact } from "../registry";
import { countHosts, fetchRouteSources } from "./data";
import { CONTROLLER } from "./model";

export async function facts(): Promise<VendorFact[]> {
  // One read for all three. The pane used to ask for the routes, the
  // middlewares and the class binding separately, two of which this already
  // contains.
  const sources = await fetchRouteSources();
  const hosts = countHosts(sources);
  const middlewares = sources.middlewares;

  const served = sources.classes.filter(
    (ingressClass) => ingressClass.controller === CONTROLLER
  );

  const lines: VendorFact[] = [
    {
      say: [
        { key: "factHosts", values: { n: hosts } },
        { key: "factMiddlewares", values: { n: middlewares.length } },
      ],
    },
  ];

  lines.push(
    served.length > 0
      ? {
          say: {
            key: "factServesClasses",
            values: {
              n: served.length,
              names: served.map((ingressClass) => ingressClass.name).join(", "),
            },
          },
        }
      : {
          // Traefik is running and no Ingress can reach it by class. Worth
          // a colour: it is the state that looks like nothing is wrong.
          say: { key: "factNoIngressClass" },
          tone: "warn",
        }
  );

  if (hosts > 0) {
    lines.push({
      say: { key: "factShowThem" },
      to: integrationPagePath("traefik"),
    });
  }

  return lines;
}
