/**
 * What ingress-nginx is doing for this cluster right now.
 *
 * The classes it claims matter as much as the host count, for the same
 * reason they do on Traefik's row: an Ingress naming a class nothing claims
 * is correct YAML with no events and no error, and is simply never served.
 * Two controllers in one cluster — which is what installing nginx beside
 * k3d's Traefik makes — is exactly when that goes wrong.
 */

import { commands } from "@/lib/commands";

import { integrationPagePath } from "../paths";
import { plural } from "../kit";
import type { VendorFact } from "../registry";
import { countHosts } from "./data";
import { CONTROLLER } from "./model";

export async function facts(): Promise<VendorFact[]> {
  const [hosts, classes] = await Promise.all([
    countHosts(),
    commands.resolveIngressClass(null),
  ]);

  const served = classes.available.filter(
    (ingressClass) => ingressClass.controller === CONTROLLER
  );

  const lines: VendorFact[] = [{ text: plural(hosts, "host") }];

  lines.push(
    served.length > 0
      ? {
          text: `serves ${served.length === 1 ? "class" : "classes"} ${served
            .map((ingressClass) => ingressClass.name)
            .join(", ")}`,
        }
      : {
          // Running, and no Ingress can reach it by class. Worth a colour:
          // it is the state that looks like nothing is wrong.
          text: "claims no IngressClass",
          tone: "warn",
        }
  );

  if (hosts > 0) {
    lines.push({ text: "Show them", to: integrationPagePath("ingress-nginx") });
  }

  return lines;
}
