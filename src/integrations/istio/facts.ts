/**
 * What Istio is doing for this cluster right now.
 *
 * The row that had a name and no facts gets them, and they are the three
 * objects the chain is made of rather than a count of every CRD the mesh
 * installs — a reader looking at this row is asking what is routed here, not
 * how many kinds Istio defined.
 */

import { integrationPagePath } from "../paths";
import { plural } from "../kit";
import type { VendorFact } from "../registry";
import { fetchMesh } from "./data";
import { hostGroups } from "./model";

export async function facts(): Promise<VendorFact[]> {
  const mesh = await fetchMesh();
  const groups = hostGroups({ ...mesh, services: [], published: [] });

  const lines: VendorFact[] = [
    {
      text: `${plural(mesh.gateways.length, "Gateway")} · ${plural(
        mesh.virtualServices.length,
        "VirtualService"
      )} · ${plural(mesh.destinationRules.length, "DestinationRule")}`,
    },
  ];

  // Only the findings that need no cluster reads: what is behind a route
  // takes two more list calls, and this row is glanced at rather than
  // studied. The page says the rest.
  const unreachable = groups.filter((group) =>
    group.findings.some((finding) => finding.kind === "noGateway")
  ).length;

  if (unreachable > 0) {
    lines.push({
      text: `${plural(unreachable, "host")} no Gateway serves`,
      tone: "err",
    });
  } else if (groups.length > 0) {
    lines.push({ text: `${plural(groups.length, "host")} routed` });
  }

  if (groups.length > 0) {
    lines.push({ text: "Show them", to: integrationPagePath("istio") });
  }

  return lines;
}
