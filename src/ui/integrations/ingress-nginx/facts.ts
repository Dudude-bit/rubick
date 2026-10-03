/**
 * What ingress-nginx is doing for this cluster right now.
 *
 * The classes it claims matter as much as the host count, for the same
 * reason they do on Traefik's row: an Ingress naming a class nothing claims
 * is correct YAML with no events and no error, and is simply never served.
 * Two controllers in one cluster — which is what installing nginx beside
 * k3d's Traefik makes — is exactly when that goes wrong.
 */

import { integrationPagePath } from "../paths";
import type { VendorFact } from "../registry";
import { countHosts, fetchRouteSources } from "./data";
import { CONTROLLER } from "./model";

export async function facts(): Promise<VendorFact[]> {
  // `fetchRouteSources` already resolves the class binding, so the pane reads
  // the cluster once rather than twice.
  const sources = await fetchRouteSources();
  const hosts = countHosts(sources);

  const served = sources.classes.filter(
    (ingressClass) => ingressClass.controller === CONTROLLER
  );

  const lines: VendorFact[] = [
    { say: { key: "factHosts", values: { n: hosts } } },
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
          // Running, and no Ingress can reach it by class. Worth a colour:
          // it is the state that looks like nothing is wrong.
          say: { key: "factNoIngressClass" },
          tone: "warn",
        }
  );

  if (hosts > 0) {
    lines.push({
      say: { key: "factShowThem" },
      to: integrationPagePath("ingress-nginx"),
    });
  }

  return lines;
}
