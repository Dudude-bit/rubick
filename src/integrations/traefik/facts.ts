/**
 * What Traefik is doing for this cluster right now.
 *
 * The IngressClasses matter as much as the route count: an Ingress that
 * names a class nothing claims is correct YAML with no events and no
 * error, and is simply never served. Saying which classes this proxy
 * answers for is the shortest form of "why is my Ingress not picked up".
 */

import { commands } from "@/lib/commands";

import { crdObjectsPath, plural } from "../kit";
import type { VendorFact } from "../registry";

/**
 * `traefik.containo.us` is the whole of what a cluster still on v2 serves,
 * so listing the v3 group there fails rather than returning nothing. The
 * rename is vendor knowledge and this is the only place it is handled.
 */
const GROUPS: readonly string[] = ["traefik.io", "traefik.containo.us"];

/** Every version of Traefik writes this into `spec.controller`. */
const CONTROLLER = "traefik.io/ingress-controller";

async function countIn(group: string, kindPlural: string): Promise<number> {
  const objects = await commands.listCustomResources(
    `${kindPlural}.${group}`,
    null,
    null,
    null
  );
  return objects.length;
}

export async function facts(): Promise<VendorFact[]> {
  let group = GROUPS[0];
  let routes: number;
  try {
    routes = await countIn(group, "ingressroutes");
  } catch (error) {
    group = GROUPS[1];
    // Only the group rename is recovered from. If the fallback fails too
    // the row says it could not read them, which is the honest answer and
    // not a zero.
    try {
      routes = await countIn(group, "ingressroutes");
    } catch {
      throw error;
    }
  }

  const [middlewares, classes] = await Promise.all([
    countIn(group, "middlewares"),
    commands.resolveIngressClass(null),
  ]);

  const served = classes.available.filter(
    (ingressClass) => ingressClass.controller === CONTROLLER
  );

  const lines: VendorFact[] = [
    {
      text: `${plural(routes, "IngressRoute")} · ${plural(middlewares, "middleware")}`,
    },
  ];

  lines.push(
    served.length > 0
      ? {
          text: `serves ${served.length === 1 ? "class" : "classes"} ${served
            .map((ingressClass) => ingressClass.name)
            .join(", ")}`,
        }
      : {
          // Traefik is running and no Ingress can reach it by class. Worth
          // a colour: it is the state that looks like nothing is wrong.
          text: "claims no IngressClass",
          tone: "warn",
        }
  );

  if (routes > 0) {
    lines.push({
      text: "Show them",
      to: crdObjectsPath(`ingressroutes.${group}`),
    });
  }

  return lines;
}
